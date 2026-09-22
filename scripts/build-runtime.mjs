import { build } from "esbuild";
import { createRequire } from "node:module";
import { copyFile, mkdir, cp } from "node:fs/promises";
import { dirname } from "node:path";
await build({
  entryPoints: ["src/server/data-sources/westock/westock-preload.ts"],
  outfile: "runtime/westock-preload.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
});
await build({
  entryPoints: ["src/server/portfolio/discipline-worker.ts"],
  outfile: "runtime/discipline-worker.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
});
await build({
  entryPoints: ["src/server/jobs/workflow-runner.ts"],
  outfile: "runtime/workflow-runner.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["better-sqlite3", "koffi"],
  target: "node22",
});
await build({
  entryPoints: ["src/server/screening/rps-worker.ts"],
  outfile: "runtime/rps-worker.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["better-sqlite3"],
  target: "node22",
});
const czscRequire = createRequire(import.meta.url);
const koffiRoot = dirname(czscRequire.resolve("koffi"));
const koffiRequire = createRequire(czscRequire.resolve("koffi"));
// The worker is an independent Node entrypoint. Carry both the JS loader and
// its optional native package; Next tracing cannot infer koffi's dynamic load.
await cp(koffiRoot, "runtime/node_modules/koffi", {
  recursive: true,
  dereference: true,
});
await cp(
  dirname(koffiRequire.resolve("@koromix/koffi-win32-x64")),
  "runtime/node_modules/@koromix/koffi-win32-x64",
  { recursive: true, dereference: true },
);
await mkdir("runtime/czsc", { recursive: true });
await copyFile("vendor/czsc/CZSC64.dll", "runtime/czsc/CZSC64.dll");
await build({
  entryPoints: ["src/server/strategies/chan/czsc-worker.ts"],
  outfile: "runtime/czsc-worker.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["koffi"],
  target: "node22",
});
const require = createRequire(import.meta.url),
  sharp = require(
    require.resolve("sharp", { paths: [require.resolve("next/package.json")] }),
  );
await build({
  entryPoints: ["src/server/jobs/worker.ts"],
  external: ["better-sqlite3"],
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

await build({
  entryPoints: ["src/server/monitoring/signal-ledger-worker.ts"],
  outfile: "runtime/signal-ledger-worker.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["better-sqlite3", "koffi"],
  target: "node22",
});

await build({
  entryPoints: ["src/server/monitoring/intraday-worker.ts"],
  outfile: "runtime/intraday-worker.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["better-sqlite3", "koffi"],
  target: "node22",
});

await build({
  entryPoints: ["src/server/backtest/research-worker.ts"],
  outfile: "runtime/research-worker.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["better-sqlite3", "koffi"],
  target: "node22",
});
