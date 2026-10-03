import type { CollectContext, CollectResult } from "./types";
import { collectLinux, discoverLinuxServices } from "./linux";
import { collectMac } from "./mac";
import { collectWindows, discoverWindowsServices } from "./windows";
import { collectDocker } from "./docker";
import { collectProxmox } from "./proxmox";
import { collectUpdates } from "./updates";

/**
 * Route a poll to the right collector(s) from the target's os + capabilities.
 *
 * Transport is derived: `hypervisor` means the Proxmox API (its own token) and
 * supersedes SSH — a Proxmox node's stats + guests all come from the API.
 * Otherwise the base OS collector runs over SSH, and `docker` (if enabled)
 * adds container inventory over the same SSH login.
 *
 * The base OS collector gathers cpu/memory/disk (and load on Unix) in one
 * round-trip regardless of which of those toggles are on; the capability set
 * governs what the UI shows and what's alertable, while `docker`/`hypervisor`
 * are the toggles that actually turn extra collection on.
 */
export async function collect(
  ctx: CollectContext,
  os: string,
  capabilities: readonly string[],
): Promise<CollectResult> {
  if (capabilities.includes("hypervisor")) {
    return collectProxmox(ctx);
  }

  const base =
    os === "mac"
      ? await collectMac(ctx)
      : os === "windows"
        ? await collectWindows(ctx)
        : await collectLinux(ctx);
  if (!base.ok) return base;

  if (capabilities.includes("docker")) {
    try {
      const d = await collectDocker(ctx);
      if (d.ok) {
        base.entities = [...base.entities, ...d.entities];
        const dm = d.target.metrics as { counts?: unknown };
        (base.target.metrics as Record<string, unknown>).docker =
          dm.counts ?? { containers: d.entities.length };
      }
    } catch {
      // Docker add-on is best-effort; host metrics still report if it fails.
    }
  }

  if (capabilities.includes("updates")) {
    try {
      const u = await collectUpdates(ctx, os);
      if (u.ok) {
        const um = u.target.metrics as { updates?: unknown };
        (base.target.metrics as Record<string, unknown>).updates = um.updates ?? null;
      }
    } catch {
      // Updates add-on is best-effort; host metrics still report if it fails.
    }
  }

  return base;
}

/**
 * On-demand service inventory for the target's host — not part of the regular
 * poll cycle, used by the detail page's "discover" picker. macOS's launchd
 * model doesn't map onto the same active/inactive check the `services`
 * capability uses, so it isn't offered there (see INFRA_CAPABILITY_DEFS).
 */
export async function discoverServices(
  ctx: CollectContext,
  os: string,
): Promise<Array<{ name: string; active: boolean; status: string }>> {
  if (os === "windows") return discoverWindowsServices(ctx);
  if (os === "mac") return [];
  return discoverLinuxServices(ctx);
}
