/** @type {import('next').NextConfig} */
const nextConfig = {
  // `next build` and `next dev` share ./.next by default, so running a build
  // while the dev server is up overwrites its webpack runtime and chunk files.
  // The dev process keeps serving from an in-memory module graph that now
  // points at chunks which no longer exist, and every route 500s with
  // "Cannot find module './NNNN.js'" until .next is deleted and dev restarted.
  // `npm run build:check` sets NEXT_BUILD_DIR so a verification build lands
  // somewhere else and leaves the running dev server alone.
  distDir: process.env.NEXT_BUILD_DIR || '.next',
  serverExternalPackages: ['better-sqlite3'],
  async redirects() {
    return [
      { source: '/captain', destination: '/admin/redeem', permanent: false },
      { source: '/captain/redeem', destination: '/admin/redeem', permanent: false },
      { source: '/bouncer', destination: '/admin/issue', permanent: false },
      { source: '/cashier', destination: '/admin/cashier', permanent: false },
    ];
  },
};

export default nextConfig;
