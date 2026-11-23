import {
  createExtendedStudyRule,
  studyStrategies,
  studyWarmup,
  strategyObjectSchema,
  type StrategyObjectInput,
  type StudyStrategy,
} from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
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
 * Deterministic, causally valid daily probe. A catalog id is accepted as a
 * diagnostic signal only when its study rule can be built from this series;
 * account-state rules (`ma`, `breakout`, ...) return null. The probe is fixed
 * so the accepted set does not depend on run order or live data.
 */
const STUDY_PROBE_BARS: readonly Bar[] = (() => {
  let state = 20240101;
  const random = () =>
    (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  let close = 30;
  return Array.from({ length: 400 }, (_, index) => {
    const open = close;
    close = Math.max(1, open * (1 + (random() - 0.5) * 0.06));
    const high = Math.max(open, close) * (1 + random() * 0.02);
    const low = Math.min(open, close) * (1 - random() * 0.02);
    const volume = Math.round(1000 * (0.6 + random() * 1.8));
    return {
      date: new Date(Date.UTC(2016, 0, 1 + index)).toISOString().slice(0, 10),
      open,
      high,
      low,
      close,
      volume,
      amount: close * volume,
    };
  });
})();

/** Memoized probe result so module load builds each catalog rule at most once. */
const studyRuleAvailability = new Map<string, boolean>();
function hasExecutableStudyRule(id: StudyStrategy): boolean {
  const cached = studyRuleAvailability.get(id);
  if (cached !== undefined) return cached;
  let available = false;
  try {
    available = createExtendedStudyRule(id, STUDY_PROBE_BARS) !== null;
  } catch {
    available = false;
  }
  studyRuleAvailability.set(id, available);
  return available;
}

/**
 * Every fixed catalog study whose rule `createExtendedStudyRule` can run is a
 * diagnostic signal key. `hold` is catalogued too, but it stays the ledger
 * control and must never be routed through a study rule.
 */
export type StudyStrategyKey = Exclude<StudyStrategy, "hold">;
export const STUDY_STRATEGY_KEYS: readonly StudyStrategyKey[] =
  studyStrategies.filter(
    (id): id is StudyStrategyKey => id !== "hold" && hasExecutableStudyRule(id),
  );

export type SignalStrategyKey =
  (typeof ADAPTER_STRATEGY_KEYS)[number] | StudyStrategyKey;

/** Adapter keys stay first; ids shared with the study catalog appear once. */
export const SIGNAL_STRATEGY_KEYS: readonly SignalStrategyKey[] = Array.from(
  new Set<SignalStrategyKey>([
    ...ADAPTER_STRATEGY_KEYS,
    ...STUDY_STRATEGY_KEYS,
  ]),
);

/** `hold` is the ledger/accounting control, not a strategy. */
export const CONTROL_KEYS = ["hold"] as const;

export type ControlKey = (typeof CONTROL_KEYS)[number];
export type StrategyKey = SignalStrategyKey | ControlKey;
export const STRATEGY_KEYS: readonly StrategyKey[] = [
  ...SIGNAL_STRATEGY_KEYS,
  ...CONTROL_KEYS,
];

export const isStrategyKey = (value: string): value is StrategyKey =>
  (STRATEGY_KEYS as readonly string[]).includes(value);

const STUDY_KEY_SET = new Set<string>(STUDY_STRATEGY_KEYS);
const isStudyStrategyKey = (key: StrategyKey): key is StudyStrategyKey =>
  STUDY_KEY_SET.has(key);

/**
 * Bars that must precede the scored window. Accepted study rules use their
 * catalog warmup; the adapter rules keep their approved values (`turtle` and
 * `rsi2` are catalog studies too, the remaining three settle on 250 trading
 * days). The returned bar count is converted to a concrete date by run.ts from
 * the symbol's own daily series.
 */
export function warmupBarsFor(key: StrategyKey): number {
  if (key === "hold") return 0;
  if (key === "turtle" || key === "rsi2") return studyWarmup(key);
  if (isStudyStrategyKey(key)) return studyWarmup(key);
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
