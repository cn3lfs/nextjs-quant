import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { runClassicMatrix } from "./lib/csi800-factor-matrix.js";
import { runClassicDiagnostics } from "./lib/csi800-factor-diagnostics.js";
import {
  loadClassicInputs,
  buildClassicPanel,
  saveCompressed,
  csiHash,
} from "./lib/csi800-factor-data.js";

if (!process.env.QUANT_DATA_DIR) throw new Error("先设置隔离QUANT_DATA_DIR");
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i],
    value = process.argv[i + 1];
  if (
    !key ||
    !["--input", "--financial", "--out", "--root", "--phase"].includes(key) ||
    !value ||
    args.has(key)
  )
    throw new Error(
      "参数只支持 --input/--financial/--out/--root/--phase value",
    );
  args.set(key, value);
}
if (!args.has("--input")) throw new Error("必须提供 --input 冻结价格路径");
const out = resolve(args.get("--out") ?? process.env.QUANT_DATA_DIR);
await mkdir(out);
const startedAt = new Date().toISOString();
const inputs = await loadClassicInputs(
  args.get("--input")!,
  args.get("--financial"),
  args.get("--root") ?? "E:/new_tdx64",
  out,
);
const panel = buildClassicPanel(inputs.price, inputs.financial);
const archive = await saveCompressed(
  join(out, "factor-panel.json.gz"),
  panel.weeks,
);
await saveCompressed(join(out, "financial-evidence.json.gz"), panel.evidence);
await writeFile(
  join(out, "coverage.json"),
  JSON.stringify(
    {
      common: panel.common,
      issues: inputs.financial.issues,
      reportCounts: Object.fromEntries(
        Object.entries(inputs.financial.reports).map(([s, r]) => [s, r.length]),
      ),
      seriesSources: inputs.financial.seriesSources,
    },
    null,
    2,
  ),
);
const files = [
  "packages/trading-strategies/src/study-decision.ts",
  "packages/trading-strategies/src/csi800-model.ts",
  "packages/trading-strategies/src/ma-cross.ts",
  "packages/quant-backtest/src/csi800-study.ts",
  "packages/trading-strategies/src/csi800-signal.ts",
  "packages/trading-strategies/src/csi800-factors.ts",
  "packages/trading-strategies/src/csi800-composite.ts",
  "scripts/lib/csi800-factor-data.ts",
  "scripts/lib/csi800-factor-matrix.ts",
  "scripts/lib/csi800-factor-diagnostics.ts",
  "src/server/data-sources/tdx/local-financial-files.ts",
  "packages/trading-strategy-core/src/financial/metrics.ts",
  "packages/trading-strategy-core/src/factors/catalog.ts",
  "packages/trading-strategy-core/src/factors/market-style.ts",
  "packages/trading-strategy-core/src/factors/trend.ts",
  "packages/trading-strategy-core/src/factors/statistics.ts",
  "packages/trading-strategy-core/src/indicators.ts",
  "packages/tstdx/src/local/financial-files.ts",
  "packages/tstdx/src/financial-data/model.ts",
  "packages/tstdx/src/financial-data/catalog.ts",
  "packages/tstdx/src/financial-data/catalog-source.ts",
  "packages/tstdx/src/financial-series.ts",
  "scripts/research-csi800-factors.ts",
  "pnpm-lock.yaml",
];
const codeHashes = Object.fromEntries(
  await Promise.all(files.map(async (f) => [f, csiHash(await readFile(f))])),
);
await writeFile(
  join(out, "manifest.json"),
  JSON.stringify(
    {
      version: "csi800-classics-1",
      startedAt,
      completedAt: new Date().toISOString(),
      inputs: inputs.manifest,
      panel: archive,
      codeHashes,
      commonStart: panel.common.start,
      firstSignal: panel.common.firstSignal,
      status: "data-prepared",
    },
    null,
    2,
  ),
);
console.log(
  `数据准备完成：${out}；共同起点 ${panel.common.start ?? "不满足覆盖门槛"}`,
);
if ((args.get("--phase") ?? "all") !== "data") {
  if (!panel.common.start || !panel.common.firstSignal)
    throw new Error("共同覆盖不足，不生成联合策略业绩");
  await runClassicMatrix(
    inputs.price,
    panel.weeks,
    panel.common.start,
    panel.common.firstSignal,
    panel.riskAt,
    out,
  );
  await runClassicDiagnostics(
    inputs.price,
    panel.weeks,
    panel.common.firstSignal,
    out,
  );
  const completed = JSON.parse(
    await readFile(join(out, "manifest.json"), "utf8"),
  );
  await writeFile(
    join(out, "manifest.json"),
    JSON.stringify(
      {
        ...completed,
        status: "research-complete",
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`主矩阵及压力实验完成：${out}`);
}
