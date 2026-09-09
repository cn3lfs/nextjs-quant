import { build } from "esbuild";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  sharp = require(
    require.resolve("sharp", { paths: [require.resolve("next/package.json")] }),
  );
await build({
  entryPoints: ["src/server/worker.ts"],
  outfile: "runtime/worker.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
});
await build({
  entryPoints: ["electron/main.ts"],
  outfile: "desktop/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  target: "node22",
});
await sharp(
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="#287f96"/><path d="M10 38h12l6-20 10 32 6-20h10" fill="none" stroke="white" stroke-width="4"/></svg>',
  ),
)
  .png()
  .toFile("desktop/icon.png");
