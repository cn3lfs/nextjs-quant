/** @type {import('next').NextConfig} */
const config = {
  output: "standalone",
  // Invalidates the persisted client query cache whenever a new build ships.
  env: { NEXT_PUBLIC_CACHE_BUSTER: String(Date.now()) },
  serverExternalPackages: ["better-sqlite3", "koffi"],
  outputFileTracingIncludes: { "/*": ["./runtime/**/*"] },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};
export default config;
