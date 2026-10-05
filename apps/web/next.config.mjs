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
  reactStrictMode: true,
  // Allow building inside the docker context without writing to other workspace dirs.
  outputFileTracingRoot: process.env.MONOREPO_ROOT || undefined,
  // IPAM and DNS moved out of the Monitoring tabs to their own pages
  // (2026-10-04). Keep bookmarks, old notification links and not-yet-resynced
  // search results working; the query string (?zone=, ?view=) carries over.
  async redirects() {
    return [
      { source: "/monitoring/ipam", destination: "/ipam", permanent: false },
      { source: "/monitoring/ipam/:path*", destination: "/ipam/:path*", permanent: false },
      { source: "/monitoring/dns", destination: "/dns", permanent: false },
      { source: "/monitoring/dns/:path*", destination: "/dns/:path*", permanent: false },
    ];
  },
  experimental: {
    // Server actions are enabled by default in 15; keep this for future tuning.
  },
};

export default nextConfig;
