import {
  strategyObjectSchema,
  studyWarmup,
  volumeStudyBindings,
  wyckoffStudyBindings,
  type StrategyObjectInput,
} from "trading-strategies";
import type { DiagnoseMode } from "./types";

/** The five adapter families approved for the first diagnostic batch. */
const ADAPTER_STRATEGY_KEYS = [
  "dual-ma",
  "turtle",
  "rsi2",
  "double-breakout",
  "formula",
] as const;

/**
 * Research volume-price studies accepted as signal keys. The literal list is
 * checked against the catalog binding record, so a typo or a removed study id
 * fails type checking instead of surfacing as an unknown-key runtime error.
 */
const VOLUME_STUDY_STRATEGY_KEYS = [
  "research-volume-price-protected",
  "research-volume-flat-expanded",
  "research-volume-up-contracted",
  "research-volume-down-contracted",
  "research-volume-up-normal",
  "research-volume-flat-contracted",
  "research-volume-breakout-15",
  "research-volume-breakout-20",
  "research-volume-average-cross",
] as const satisfies readonly (keyof typeof volumeStudyBindings)[];

/** Research Wyckoff studies accepted as signal keys, checked against the catalog. */
const WYCKOFF_STUDY_STRATEGY_KEYS = [
  "research-wy-spring-protected",
  "research-wy-sos-protected",
  "research-wy-jac-protected",
  "research-wy-lps-protected",
  "research-wy-reaccumulation-protected",
  "research-wy-trend-pullback-protected",
] as const satisfies readonly (keyof typeof wyckoffStudyBindings)[];

export const STUDY_STRATEGY_KEYS = [
  ...VOLUME_STUDY_STRATEGY_KEYS,
  ...WYCKOFF_STUDY_STRATEGY_KEYS,
] as const;

export const SIGNAL_STRATEGY_KEYS = [
  ...ADAPTER_STRATEGY_KEYS,
  ...STUDY_STRATEGY_KEYS,
] as const;
/** `hold` is the ledger/accounting control, not a strategy. */
export const CONTROL_KEYS = ["hold"] as const;

export type StudyStrategyKey = (typeof STUDY_STRATEGY_KEYS)[number];
export type SignalStrategyKey = (typeof SIGNAL_STRATEGY_KEYS)[number];
export type ControlKey = (typeof CONTROL_KEYS)[number];
export type StrategyKey = SignalStrategyKey | ControlKey;
export const STRATEGY_KEYS: readonly StrategyKey[] = [
  ...SIGNAL_STRATEGY_KEYS,
  ...CONTROL_KEYS,
];

export const isStrategyKey = (value: string): value is StrategyKey =>
  (STRATEGY_KEYS as readonly string[]).includes(value);

const isStudyStrategyKey = (key: StrategyKey): key is StudyStrategyKey =>
  (STUDY_STRATEGY_KEYS as readonly StrategyKey[]).includes(key);

/**
 * Bars that must precede the scored window. The study rules use their catalog
 * warmup; the remaining absolute-price rules settle on 250 trading days (the
 * plan's one-year approximation). The returned bar count is converted to a
 * concrete date by run.ts from the symbol's own daily series.
 */
export function warmupBarsFor(key: StrategyKey): number {
  if (key === "hold") return 0;
  if (isStudyStrategyKey(key)) return studyWarmup(key);
  if (key === "turtle" || key === "rsi2")
    return studyWarmup(key as "turtle" | "rsi2");
  return 250;
}

const FORMULA_ENTRY = "选股:C>REF(HHV(H,N1),1) AND V>MA(V,20);";
/** `选股:` is the single output marker the parser requires on both sides. */
const FORMULA_EXIT = "选股:C<MA(C,20);";

function rulesFor(
  key: StrategyKey,
): Pick<StrategyObjectInput, "entry" | "exit"> {
  if (isStudyStrategyKey(key))
    return {
      entry: { kind: "study-rule", strategy: key, side: "entry" },
      exit: { rule: { kind: "study-rule", strategy: key, side: "exit" } },
    };
  switch (key) {
    case "dual-ma":
      return {
        entry: { kind: "dual-ma", fast: 5, slow: 20, side: "entry" },
        exit: {
          rule: { kind: "dual-ma", fast: 5, slow: 20, side: "exit" },
        },
      };
    case "turtle":
      return {
        entry: { kind: "study-rule", strategy: "turtle", side: "entry" },
        exit: {
          rule: { kind: "study-rule", strategy: "turtle", side: "exit" },
        },
      };
    case "rsi2":
      return {
        entry: { kind: "study-rule", strategy: "rsi2", side: "entry" },
        exit: { rule: { kind: "study-rule", strategy: "rsi2", side: "exit" } },
      };
    case "double-breakout":
      return {
        entry: {
          kind: "double-breakout",
          side: "entry",
          filter: { direction: "long", minScore: 3, minVolumeRatio: 1.5 },
          useStructureStop: true,
        },
        exit: {
          rule: {
            kind: "double-breakout",
            side: "exit",
            filter: { direction: "short", minScore: 3 },
          },
          maxBars: 60,
        },
      };
    case "formula":
      return {
        entry: {
          kind: "formula",
          source: FORMULA_ENTRY,
          parameters: { N1: 20 },
        },
        exit: { rule: { kind: "formula", source: FORMULA_EXIT } },
      };
    case "hold":
      return { entry: { kind: "constant", value: true }, exit: {} };
  }
}

export type StrategyBuildMode = "single" | "portfolio";

/** Stable strategy identity: no content hash, no registration metadata. */
export function buildStrategy(
  key: StrategyKey,
  symbols: readonly string[],
  mode: StrategyBuildMode,
): StrategyObjectInput {
  if (!symbols.length || new Set(symbols).size !== symbols.length)
    throw new Error("诊断策略标的须唯一且非空");
  const raw: StrategyObjectInput = {
    id: `diag-${key}`,
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols: [...symbols] },
    ...rulesFor(key),
    sizing:
      mode === "single"
        ? { kind: "weight", weight: 1 }
        : { kind: "equal", positions: symbols.length },
    sleeve: "diag",
  };
  return strategyObjectSchema.parse(raw);
}

export type DiagnosePlanOptions = {
  symbols: readonly string[];
  strategies: readonly string[];
  controls: readonly string[];
  mode: DiagnoseMode | "both";
};

export type PlannedDiagnoseCell = {
  mode: DiagnoseMode;
  strategy: StrategyKey;
  symbols: string[];
};

/** Pure cell planning: used by `--plan` and by the runner, never reads data. */
export function planDiagnoseCells(
  options: DiagnosePlanOptions,
): PlannedDiagnoseCell[] {
  if (!options.symbols.length) throw new Error("至少需要一个标的");
  const unknown = [...options.strategies, ...options.controls].filter(
    (key) => !isStrategyKey(key),
  );
  if (unknown.length)
    throw new Error(`未知诊断策略：${[...new Set(unknown)].join(", ")}`);
  const signalKeys = options.strategies as SignalStrategyKey[];
  const controlKeys = options.controls as ControlKey[];
  if (!signalKeys.length && !controlKeys.length)
    throw new Error("至少需要一条策略或对照");
  const keys: StrategyKey[] = [...signalKeys, ...controlKeys];
  if (new Set(keys).size !== keys.length) throw new Error("诊断策略重复");
  const cells: PlannedDiagnoseCell[] = [];
  if (options.mode !== "portfolio")
    for (const strategy of keys)
      for (const symbol of options.symbols)
        cells.push({ mode: "per-symbol", strategy, symbols: [symbol] });
  if (options.mode !== "per-symbol")
    for (const strategy of keys)
      cells.push({
        mode: "portfolio",
        strategy,
        symbols: [...options.symbols],
      });
  return cells;
}
