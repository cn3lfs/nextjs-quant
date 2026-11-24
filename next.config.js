import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, matchesGlob } from "node:path";

const traceExcludes = [
  "./release/**/*",
  "./.test-data/**/*",
  "./test-results/**/*",
  "./tests/**/*",
  "./docs/**/*",
  "./.git/**/*",
  "./.codex-runs/**/*",
  "./src/**/*",
  "./electron/**/*",
  "./scripts/**/*",
  "./packages/**/*",
  "./desktop/**/*",
  "./research/**/*",
];

/** @type {import('next').NextConfig} */
const config = {
  output: "standalone",
  // Invalidates the persisted client query cache whenever a new build ships.
  env: { NEXT_PUBLIC_CACHE_BUSTER: String(Date.now()) },
  serverExternalPackages: ["better-sqlite3", "koffi"],
  outputFileTracingIncludes: { "/*": ["./runtime/**/*"] },
  outputFileTracingExcludes: { "**": traceExcludes },
  compiler: {
    // Turbopack emits the instrumentation NFT outside the route exclude pass.
    // Apply the same project-relative rules before Next copies standalone files.
    async runAfterProductionCompile({ projectDir, distDir }) {
      if (!process.env.TURBOPACK) return;
      const serverDir = join(distDir, "server");
      const path = join(serverDir, "instrumentation.js.nft.json");
      /** @type {{files: string[]}} */
      const trace = JSON.parse(await readFile(path, "utf8"));
      const excludes = traceExcludes.map((glob) => resolve(projectDir, glob));
      const files = trace.files.filter((file) => {
        const absolute = resolve(serverDir, file);
        return !excludes.some((glob) => matchesGlob(absolute, glob));
      });
      if (files.length !== trace.files.length)
        await writeFile(path, JSON.stringify({ ...trace, files }));
    },
  },
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
