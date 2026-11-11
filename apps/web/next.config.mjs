/** @type {import('next').NextConfig} */
// One id for the whole build, set by the build (compose passes BUILD_ID), the same on every
// node that runs this release. Next would otherwise invent a random build id on every build.
// `deploymentId` makes the browser send the id as an `x-deployment-id` header and add
// `?dpl=<id>` to its script and style URLs. Self-hosted Next does nothing else with it (it
// does not reload on a mismatch), but a load balancer can route on it to keep a browser on
// the build that served its page during a rolling upgrade.
const buildId = process.env.BUILD_ID && process.env.BUILD_ID !== "dev" ? process.env.BUILD_ID : undefined;

const nextConfig = {
  output: "standalone",
  generateBuildId: async () => buildId ?? null,
  ...(buildId ? { deploymentId: buildId } : {}),
  poweredByHeader: false,
  // The app never uses next/image, so its optimizer (/_next/image, a server-side fetcher with a history of RCE, SSRF
  // and DoS advisories) is switched off; Caddy also answers 404 for the path.
  images: { unoptimized: true },
  reactStrictMode: true,
  // Allow building inside the docker context without writing to other workspace dirs.
  outputFileTracingRoot: process.env.MONOREPO_ROOT || undefined,
  // IPAM and DNS moved out of the Monitoring tabs to their own pages
  // (2026-10-04). Keep bookmarks, old notification links and not-yet-resynced
  // search results working; the query string (?zone=, ?view=) carries over.
  async redirects() {
    return [
      { source: "/monitoring/ipam", destination: "/ipam", permanent: false },
      // Signage events became one-time entries on the Schedule (2026-11-11).
      { source: "/signage/events", destination: "/signage/schedules", permanent: false },
      { source: "/monitoring/ipam/:path*", destination: "/ipam/:path*", permanent: false },
      { source: "/monitoring/dns", destination: "/dns", permanent: false },
      { source: "/monitoring/dns/:path*", destination: "/dns/:path*", permanent: false },
      // The switch models pages became Device profiles, its own page in the IT menu (2026-10-25).
      { source: "/monitoring/network-cisco/models", destination: "/device-profiles", permanent: false },
      { source: "/monitoring/network-cisco/models/:path*", destination: "/device-profiles/:path*", permanent: false },
      { source: "/monitoring/network/models", destination: "/device-profiles", permanent: false },
      { source: "/monitoring/network/models/:path*", destination: "/device-profiles/:path*", permanent: false },
      { source: "/monitoring/infra/models", destination: "/device-profiles", permanent: false },
      { source: "/monitoring/infra/models/:path*", destination: "/device-profiles/:path*", permanent: false },
      // Module settings moved into the modules (docs/module-settings.md, 2026-11-08).
      { source: "/admin/settings/printers", destination: "/printers/settings", permanent: false },
      { source: "/admin/settings/propresenter", destination: "/propresenter/settings", permanent: false },
      { source: "/admin/settings/livestreams", destination: "/livestreams/settings", permanent: false },
      { source: "/admin/settings/planning_center", destination: "/planning-center/settings", permanent: false },
      { source: "/admin/settings/helpdesk", destination: "/tickets/settings", permanent: false },
      { source: "/admin/checklists/:path*", destination: "/checklists/manage/:path*", permanent: false },
      { source: "/admin/settings/assistant", destination: "/assistant/settings", permanent: false },
      { source: "/admin/assistant", destination: "/assistant/usage", permanent: false },
      { source: "/admin/settings/monitoring", destination: "/monitoring/settings", permanent: false },
      { source: "/admin/ticket-categories", destination: "/tickets/categories", permanent: false },
      { source: "/admin/planning-center", destination: "/planning-center/links", permanent: false },
    ];
  },
  experimental: {
    // Server actions are enabled by default in 15; keep this for future tuning.
  },
};

export default nextConfig;
