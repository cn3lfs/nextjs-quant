import { execFileSync } from "node:child_process";
execFileSync(
  "powershell",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "scripts/build-tdx-import.ps1",
  ],
  { stdio: "inherit", windowsHide: true },
);
import { build } from "esbuild";
import { createRequire } from "node:module";
import {
  copyFile,
  mkdir,
  cp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
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
const maEngineHash = createHash("sha256");
for (const file of [
  ...(await readdir("packages/quant-backtest/src", { recursive: true }))
    .filter((file) => file.endsWith(".ts"))
    .sort()
    .map((file) => `packages/quant-backtest/src/${file.replaceAll("\\", "/")}`),
  ...(await readdir("packages/trading-strategies/src", { recursive: true }))
    .filter((file) => file.endsWith(".ts"))
    .sort()
    .map(
      (file) => `packages/trading-strategies/src/${file.replaceAll("\\", "/")}`,
    ),
  "packages/trading-strategy-core/src/indicators.ts",
  "packages/trading-strategy-core/src/money.ts",
  "packages/trading-strategy-core/src/costs.ts",
  "packages/trading-strategy-core/src/market-rules.ts",
  ...(
    await readdir("packages/trading-strategy-core/src/factors", {
      recursive: true,
    })
  )
    .filter((file) => file.endsWith(".ts"))
    .sort()
    .map(
      (file) =>
        `packages/trading-strategy-core/src/factors/${file.replaceAll("\\", "/")}`,
    ),
  "pnpm-lock.yaml",
]) {
  maEngineHash.update(file).update(await readFile(file));
}
const validationIdentity = createHash("sha256");
for (const directory of [
  "packages/quant-performance/src",
  "src/server/research",
]) {
  const files = (await readdir(directory, { recursive: true }))
    .filter(
      (file) =>
        file.endsWith(".ts") &&
        (directory.startsWith("packages/") || file.startsWith("validation-")),
    )
    .sort();
  for (const file of files) {
    const path = `${directory}/${file.replaceAll("\\", "/")}`;
    validationIdentity.update(path).update(await readFile(path));
  }
}
for (const file of [
  "src/lib/backtest/backtest-overfit.ts",
  "src/lib/backtest/multiple-testing.ts",
  "src/lib/backtest/daily-performance.ts",
  "src/server/research/index-context.ts",
  "src/server/strategies/strategy-center-native.ts",
  "src/server/data-sources/tdx/local-financial-files.ts",
  "pnpm-lock.yaml",
])
  validationIdentity.update(file).update(await readFile(file));
const validationBuildHash = validationIdentity.digest("hex");
await writeFile(
  "runtime/research-validation-identity.json",
  JSON.stringify({ hash: validationBuildHash }),
);
await build({
  entryPoints: ["src/server/jobs/worker.ts"],
  define: {
    __MA_BASELINE_BUILD_HASH__: JSON.stringify(maEngineHash.digest("hex")),
    __RESEARCH_VALIDATION_BUILD_HASH__: JSON.stringify(validationBuildHash),
  },
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
await build({
  entryPoints: ["electron/preload.ts"],
  outfile: "desktop/preload.cjs",
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

// Do not carry the retired sample-research executor into an incremental package.
await rm(new URL("../runtime/research-worker.cjs", import.meta.url), {
  force: true,
});
