/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // Allow building inside the docker context without writing to other workspace dirs.
  outputFileTracingRoot: process.env.MONOREPO_ROOT || undefined,
  experimental: {
    // Server actions are enabled by default in 15; keep this for future tuning.
  },
};

export default nextConfig;
