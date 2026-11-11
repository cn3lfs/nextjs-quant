import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  factorCatalog,
  localDataFactorCatalog,
} from "trading-strategy-core/factors";
import { financialCatalog } from "trading-strategy-core/financial";
import { correlation } from "../../packages/trading-strategy-core/src/factors/statistics.js";
import {
  csi800ClassicFactors,
  classicRanks,
} from "../../packages/trading-strategies/src/csi800-factors.js";
import { csi800ForwardReturn } from "../../packages/trading-strategies/src/csi800-signal.js";
import type { ClassicWeek } from "../../packages/trading-strategies/src/csi800-composite.js";
import type { ClassicPriceInput } from "./csi800-factor-data.js";

const mean = (values: number[]) =>
  values.length ? values.reduce((s, v) => s + v / values.length, 0) : null;
function describe(values: number[]) {
  const average = mean(values);
  const sd =
    average !== null && values.length >= 2
      ? Math.sqrt(
          values.reduce((s, v) => s + (v - average) ** 2, 0) /
            (values.length - 1),
        )
      : null;
  return {
    count: values.length,
    mean: average,
    standardDeviation: sd,
    positiveFraction: values.length
      ? values.filter((v) => v > 0).length / values.length
      : null,
    icir: average !== null && sd !== null && sd > 0 ? average / sd : null,
    icirAnnualized: false,
  };
}
export function classicFactorInventory() {
  const selected = new Set(
    csi800ClassicFactors.flatMap((f) => (f.spec ? [f.spec.id] : [])),
  );
  const valueIds = new Set([
    "earnings-yield",
    "book-to-price",
    "sales-to-price",
    "cashflow-yield",
  ]);
  const usedFields = new Set([35, 40, 63, 74, 75, 95, 96, 107, 271]);
  return [
    ...factorCatalog.map((f) => ({
      namespace: "technical",
      id: f.id,
      label: f.label,
      classification: selected.has(f.id)
        ? "main-composite"
        : f.unit === "价格" || f.unit === "成交量"
          ? "absolute-level-or-input"
          : "related-or-experimental",
      reason: selected.has(f.id)
        ? "经典经济家族中调用既有实现，窗口写入研究字典"
        : "本批先验证经典固定家族；同源窗口或实验特征不因数量多而额外加权",
      usedBy: csi800ClassicFactors
        .filter((s) => s.spec?.id === f.id)
        .map((s) => s.id),
    })),
    ...localDataFactorCatalog.map((f) => ({
      namespace: "local-data",
      id: f.id,
      label: f.label,
      classification: valueIds.has(f.id)
        ? "main-composite"
        : f.id === "GP16-0"
          ? "valuation-input"
          : f.dependencies.includes("block-series") ||
              f.dependencies.includes("market-series")
            ? "not-cross-sectional-stock-factor"
            : f.dependencies.includes("benchmark")
              ? "benchmark-definition-differs"
              : "separate-input-evidence-needed",
      reason:
        valueIds.has(f.id) || f.id === "GP16-0"
          ? "同日GP16市值与可见报告组成估值；缺同日值不前填"
          : "保留现有能力，未作为本批经典溢价输入；需独立证明历史覆盖、时点及经济方向后另立实验",
    })),
    ...financialCatalog.map((f) => ({
      namespace: f.namespace,
      id: f.code,
      label: f.label,
      classification:
        f.mappingStatus !== "mapped"
          ? "unverified-semantics"
          : f.namespace === "FN" && usedFields.has(f.id)
            ? "main-composite-input"
            : f.timing === "forecast" || f.timing === "flash"
              ? "not-historical-actual"
              : "not-in-fixed-classic-model",
      reason:
        f.mappingStatus !== "mapped"
          ? "不从未知字段猜业务含义"
          : "按既定29项字典与可见性选择；未采用不等于不存在",
    })),
  ];
}

/** Diagnostic labels are computed here, outside the scoring/target interfaces. */
export async function runClassicDiagnostics(
  price: ClassicPriceInput,
  weeks: ClassicWeek[],
  firstSignal: string,
  out: string,
) {
  const stocks = new Map(price.stocks.map((s) => [s.symbol, s]));
  const calendar = price.benchmark.map((b) => b.date),
    indices = new Map(calendar.map((d, i) => [d, i]));
  const observations: {
    date: string;
    entry: string;
    exit: string;
    phase: string;
    factors: {
      id: string;
      coverage: number;
      constant: boolean;
      ic: number | null;
      quintiles: (number | null)[];
      groupCounts: number[];
    }[];
  }[] = [];
  const correlations = new Map<string, number[]>();
  let progress = 0;
  for (const week of weeks) {
    if (week.date < firstSignal) continue;
    const i = indices.get(week.date)!,
      entry = calendar[i + 1],
      exit = calendar[i + 21];
    const phase =
      week.date < "2023-01-01"
        ? "development"
        : week.date < "2025-01-01"
          ? "validation"
          : "observation";
    const phaseEnd =
      phase === "development"
        ? "2022-12-31"
        : phase === "validation"
          ? "2024-12-31"
          : price.end;
    const ranks = csi800ClassicFactors.map((factor, j) =>
      classicRanks(
        week.rows.map((r) =>
          r.values[j] === null ? null : r.values[j]! * factor.direction,
        ),
      ),
    );
    for (let a = 0; a < ranks.length; a++)
      for (let b = a + 1; b < ranks.length; b++) {
        const pairs = week.rows.flatMap((_, k) =>
          ranks[a]![k] !== null && ranks[b]![k] !== null
            ? [[ranks[a]![k]!, ranks[b]![k]!]]
            : [],
        );
        if (pairs.length < 20) continue;
        const value = correlation(
          pairs.map((p) => p[0]!),
          pairs.map((p) => p[1]!),
        );
        if (value === null) continue;
        const key = `${phase}:${csi800ClassicFactors[a]!.id}:${csi800ClassicFactors[b]!.id}`;
        const values = correlations.get(key) ?? [];
        values.push(value);
        correlations.set(key, values);
      }
    if (!entry || !exit || exit > phaseEnd) continue;
    const benchmarkReturn =
      price.benchmark[i + 21]!.open / price.benchmark[i + 1]!.open - 1;
    const labels = week.rows.map((r) =>
      csi800ForwardReturn(stocks.get(r.symbol)!, entry, exit),
    );
    const factors = csi800ClassicFactors.map((f, j) => {
      const pairs = week.rows.flatMap((r, k) =>
        r.values[j] !== null && labels[k] !== null
          ? [
              {
                value: r.values[j]! * f.direction,
                label: labels[k]!,
                rank: ranks[j]![k]!,
              },
            ]
          : [],
      );
      const x = classicRanks(pairs.map((p) => p.value)),
        y = classicRanks(pairs.map((p) => p.label));
      const constant =
        pairs.length > 0 && pairs.every((p) => p.value === pairs[0]!.value);
      const ic =
        pairs.length >= 20 && !constant
          ? correlation(x as number[], y as number[])
          : null;
      const groups = Array.from({ length: 5 }, () => [] as number[]);
      if (!constant)
        for (const p of pairs)
          groups[Math.min(4, Math.floor((p.rank + 0.5) * 5))]!.push(
            p.label - benchmarkReturn,
          );
      return {
        id: f.id,
        coverage: pairs.length,
        constant,
        ic,
        quintiles: groups.map(mean),
        groupCounts: groups.map((g) => g.length),
      };
    });
    observations.push({ date: week.date, entry, exit, phase, factors });
    if (++progress % 50 === 0) console.log(`因子IC/相关诊断 ${progress}周`);
  }
  const summaries = ["development", "validation", "observation"].flatMap(
    (phase) =>
      csi800ClassicFactors.map((f) => {
        const rows = observations.filter((r) => r.phase === phase);
        const all = rows.flatMap((r) => {
          const p = r.factors.find((p) => p.id === f.id)!;
          return p.ic === null ? [] : [p.ic];
        });
        let previousExit = "";
        const nonoverlap: number[] = [];
        for (const row of rows) {
          if (row.entry < previousExit) continue;
          const p = row.factors.find((p) => p.id === f.id)!;
          if (p.ic !== null) {
            nonoverlap.push(p.ic);
            previousExit = row.exit;
          }
        }
        return {
          phase,
          id: f.id,
          all: describe(all),
          nonoverlap: describe(nonoverlap),
        };
      }),
  );
  await writeFile(
    join(out, "factor-diagnostics.json"),
    JSON.stringify({
      label:
        "next-open to 21st-open economic return; groups benchmark-relative; no cost; not portfolio performance",
      observations,
      summaries,
      correlations: [...correlations].map(([key, values]) => ({
        key,
        ...describe(values),
      })),
    }),
  );
  await writeFile(
    join(out, "factor-inventory.json"),
    JSON.stringify(classicFactorInventory(), null, 2),
  );
  return {
    observations: observations.length,
    factors: csi800ClassicFactors.length,
    summaries,
  };
}
