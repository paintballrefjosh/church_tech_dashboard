/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
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
