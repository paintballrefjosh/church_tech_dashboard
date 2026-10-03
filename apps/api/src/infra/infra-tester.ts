import { Injectable } from "@nestjs/common";
import type { CreateInfraTargetInput } from "@church/shared";
import { collect } from "./collectors/dispatch";
import { type CollectContext } from "./collectors/types";

export interface TestResult {
  ok: boolean;
  message: string;
  hostKey?: string | null;
  summary?: Record<string, unknown>;
}

/**
 * One-shot connectivity test for the Add/Edit dialog. Runs the real collector
 * against the supplied (usually unsaved) connection details so the operator gets
 * the same code path they'll get when polling. Credentials are used in-memory
 * and never persisted here. The secret must be present in the payload (a blank
 * secret on an edit means "unchanged", which this ad-hoc path can't resolve).
 */
@Injectable()
export class InfraTester {
  async test(input: CreateInfraTargetInput): Promise<TestResult> {
    if (!input.host?.trim()) return { ok: false, message: "Host is required" };
    const cred = input.credential;
    if (!cred || !cred.secret) {
      return { ok: false, message: "Enter credentials (including the secret) to run a test." };
    }

    const ctx: CollectContext = {
      targetId: "test",
      host: input.host.trim(),
      options: (input.options as CollectContext["options"]) ?? {},
      credential: {
        authType: cred.authType,
        username: cred.username ?? null,
        secret: cred.secret ?? null,
        extra: cred.extra ?? null,
        caCert: cred.caCert ?? null,
      },
      knownHostKey: null,
      prev: null,
    };

    const result = await collect(ctx, input.os, input.capabilities ?? []);

    if (!result.ok) {
      return { ok: false, message: result.error ?? "Probe failed", hostKey: result.hostKey };
    }

    const summary: Record<string, unknown> = {
      cpuPct: result.target.cpuPct,
      memPct: result.target.memPct,
      diskPctMax: result.target.diskPctMax,
      entities: result.entities.length,
    };
    const counts = (result.target.metrics as { counts?: unknown }).counts;
    if (counts) summary.counts = counts;

    return {
      ok: true,
      message: `Reached ${input.host} (${input.os}).`,
      hostKey: result.hostKey ?? null,
      summary,
    };
  }
}
