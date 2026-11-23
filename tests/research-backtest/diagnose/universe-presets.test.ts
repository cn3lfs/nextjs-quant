import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseArgs } from "../../../scripts/backtest-diagnose";
import { writeReport } from "../../../scripts/lib/backtest-diagnose/report";
import {
  CHAN_CORE_7_SYMBOLS,
  CORE_12_SYMBOLS,
  CORE_5_SYMBOLS,
  resolveUniversePreset,
  UNIVERSE_PRESETS,
} from "../../../scripts/lib/backtest-diagnose/universe-presets";

it("freezes the ordered 12-stock validation pool and both subsets with full metadata", () => {
  expect(CORE_5_SYMBOLS).toEqual([
    "sh600519",
    "sz000001",
    "sh601318",
    "sz000333",
    "sz300750",
  ]);
  expect(CORE_12_SYMBOLS).toEqual([
    ...CORE_5_SYMBOLS,
    "sz300308",
    "sh688981",
    "sz300274",
    "sz002594",
    "sh600276",
    "sh601899",
    "sz000858",
  ]);
  expect(CHAN_CORE_7_SYMBOLS).toEqual([
    ...CORE_5_SYMBOLS,
    "sh688981",
    "sz300308",
  ]);
  expect(new Set(CORE_12_SYMBOLS).size).toBe(12);
  for (const {
    id,
    label,
    symbols,
    metadata,
    survivorBiasDisclosure,
  } of Object.values(UNIVERSE_PRESETS)) {
    expect(resolveUniversePreset(id)).toBe(UNIVERSE_PRESETS[id]);
    expect(label).not.toBe("");
    expect(Object.keys(metadata)).toEqual(symbols);
    expect(Object.isFrozen(symbols)).toBe(true);
    expect(Object.isFrozen(metadata)).toBe(true);
    for (const symbol of symbols) {
      expect(CORE_12_SYMBOLS).toContain(symbol);
      expect(UNIVERSE_PRESETS["core-12"].metadata[symbol]).toMatchObject({
        group: expect.stringMatching(/基线回归|理论扩展/),
        name: expect.stringMatching(/\S/),
        board: expect.stringMatching(/主板|创业板|科创板/),
        role: expect.stringMatching(/\S/),
      });
    }
    expect(survivorBiasDisclosure).toMatch(/幸存者偏差.*退市/);
  }
});

it.each(["core-13", "constructor", "__proto__"])(
  "rejects the unknown preset %s",
  (name) => {
    expect(() => resolveUniversePreset(name)).toThrow(
      `未知诊断证券池：${name}`,
    );
  },
);

it("writes the core-12 identity, members and survivor-bias disclosure to report.md", async () => {
  const outDir = await mkdtemp(join(process.env.QUANT_DATA_DIR!, "pool-"));
  try {
    const { pool, symbols } = parseArgs([
      "--tdx-root",
      outDir,
      "--pool",
      "core-12",
    ]);
    expect(symbols).toEqual(CORE_12_SYMBOLS);
    expect(pool?.members?.map(({ symbol }) => symbol)).toEqual(symbols);
    expect(pool?.survivorBiasDisclosure).toMatch(
      /幸存者偏差.*退市.*历史 ST.*首次披露财报版本/,
    );
    const path = await writeReport(outDir, [], pool);
    expect(path).toBe(join(outDir, "report.md"));
    const report = await readFile(path, "utf8");
    expect(report).toContain("## 样本池与口径披露");
    expect(report).toContain("- 样本池：`core-12` · 十二股分层验证池");
    expect(report).toContain("- 预设成员数：12");
    expect(report).toContain(`> ${pool?.survivorBiasDisclosure}`);
    expect(report).toContain("| sh688981 | 中芯国际 | 理论扩展 | 科创板 |");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
