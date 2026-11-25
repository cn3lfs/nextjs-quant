import { isDeepStrictEqual } from "node:util";
import {
  SCREENER_STRATEGY_KEYS,
  scanHandoffStrategyRules,
  theoryScreenerSpecForStrategyKey,
} from "~/lib/research/diagnose-contract";
import {
  createExtendedStudyRule,
  nativeStudyDefinition,
  studyStrategies,
  strategyRuleSchema,
  studyWarmup,
  wyckoffStudyBindings,
  strategyObjectSchema,
  type StrategyObjectInput,
  type StudyStrategy,
} from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
import {
  GROWTH_PIT_STRATEGY_KEYS,
  growthPitRulesFor,
  growthPitWarmupBars,
  isGrowthPitStrategyKey,
  type GrowthPitStrategyKey,
} from "./growth-pit";
import type { DiagnoseMode } from "./types";
import { coreBookCapacity } from "./sleeve-attribution";
import {
  NATIVE_CHAN_ZD_STOP_KEY,
  nativeChanZdStopRules,
  NATIVE_CHAN_ZD_ATR_STOP_KEY,
  nativeChanZdAtrStopRules,
  nativeChanCh04Rules,
  nativeChanCh07Rules,
  nativeChanCh12Rules,
} from "./chan-native";

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

const wyckoffFunnelStudies = {
  [wyckoffStudyBindings["research-wy-lps-protected"]]:
    "research-wy-lps-protected",
  [wyckoffStudyBindings["research-wy-reaccumulation-protected"]]:
    "research-wy-reaccumulation-protected",
  [wyckoffStudyBindings["research-wy-trend-pullback-protected"]]:
    "research-wy-trend-pullback-protected",
} as const;
type WyckoffFunnelKey = keyof typeof wyckoffFunnelStudies;
export const isWyckoffFunnelKey = (key: string): key is WyckoffFunnelKey =>
  Object.hasOwn(wyckoffFunnelStudies, key);

export const NATIVE_STRATEGY_KEYS = [
  "research-chan",
  "research-chan-first",
  "research-chan-second",
  "research-chan-third",
  "research-chan-hold-cash",
  NATIVE_CHAN_ZD_STOP_KEY,
  NATIVE_CHAN_ZD_ATR_STOP_KEY,
  "research-chan-ch04",
  "research-chan-ch07",
  "research-chan-ch12",
] as const;
export type NativeStrategyKey = (typeof NATIVE_STRATEGY_KEYS)[number];
export const isNativeStrategyKey = (
  key: StrategyKey,
): key is NativeStrategyKey =>
  (NATIVE_STRATEGY_KEYS as readonly string[]).includes(key);

export const PIT_STRATEGY_KEYS = GROWTH_PIT_STRATEGY_KEYS;
export type PitStrategyKey = GrowthPitStrategyKey;
export const isPitStrategyKey = isGrowthPitStrategyKey;

export type SignalStrategyKey =
  | (typeof ADAPTER_STRATEGY_KEYS)[number]
  | StudyStrategyKey
  | NativeStrategyKey
  | WyckoffFunnelKey
  | PitStrategyKey
  | (typeof SCREENER_STRATEGY_KEYS)[number];

/** Adapter keys stay first. Screener keys come from the shared long-only diagnose contract. */
export const SIGNAL_STRATEGY_KEYS: readonly SignalStrategyKey[] = Array.from(
  new Set<SignalStrategyKey>([
    ...ADAPTER_STRATEGY_KEYS,
    ...STUDY_STRATEGY_KEYS,
    ...(Object.keys(wyckoffFunnelStudies) as WyckoffFunnelKey[]),
    ...NATIVE_STRATEGY_KEYS,
    ...PIT_STRATEGY_KEYS,
    ...SCREENER_STRATEGY_KEYS,
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
  const screener = theoryScreenerSpecForStrategyKey(key);
  if (screener) return screener.warmupBars;
  if (isWyckoffFunnelKey(key)) key = wyckoffFunnelStudies[key];
  if (isPitStrategyKey(key)) return growthPitWarmupBars(key);
  if (isNativeStrategyKey(key)) return nativeStudyDefinition.warmupBars;
  if (key === "hold") return 0;
  if (key === "turtle" || key === "rsi2") return studyWarmup(key);
  if (isStudyStrategyKey(key)) return studyWarmup(key);
  return 250;
}

function rulesFor(
  key: StrategyKey,
): Pick<StrategyObjectInput, "entry" | "exit"> {
  if (isWyckoffFunnelKey(key)) key = wyckoffFunnelStudies[key];
  if (key === NATIVE_CHAN_ZD_STOP_KEY) return nativeChanZdStopRules();
  if (key === NATIVE_CHAN_ZD_ATR_STOP_KEY) return nativeChanZdAtrStopRules();
  if (key === "research-chan-ch04") return nativeChanCh04Rules();
  if (key === "research-chan-ch07") return nativeChanCh07Rules();
  if (key === "research-chan-ch12") return nativeChanCh12Rules();
  const handoffRules = scanHandoffStrategyRules(key);
  if (handoffRules) return handoffRules;
  if (isPitStrategyKey(key)) return growthPitRulesFor(key);
  if (isStudyStrategyKey(key))
    return {
      entry: { kind: "study-rule", strategy: key, side: "entry" },
      exit: { rule: { kind: "study-rule", strategy: key, side: "exit" } },
    };
  if (key === "hold")
    return { entry: { kind: "constant", value: true }, exit: {} };
  throw new Error(`缺少诊断策略规则：${key}`);
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
  book?: DiagnoseBookKey;
  family?: string;
  symbols: readonly string[];
  strategies: readonly string[];
  controls: readonly string[];
  mode: DiagnoseMode | "both";
};

export const DIAGNOSE_BOOK_PRESETS = {
  "core-4": {
    ...coreBookCapacity,
    sleeves: [
      { strategyKey: "research-chan-hold-cash", id: "chan", share: 0.25 },
      { strategyKey: "research-canslim-pit-ma50", id: "canslim", share: 0.25 },
      { strategyKey: "theory-vcp-close", id: "vcp", share: 0.25 },
      { strategyKey: "classic-ibs", id: "ibs", share: 0.25 },
    ],
    accountMaxUniqueSymbols: 10,
    accountMaxSymbolWeight: 0.1,
  },
} as const;
export type DiagnoseBookKey = keyof typeof DIAGNOSE_BOOK_PRESETS;

export type PlannedDiagnoseCell = {
  mode: DiagnoseMode;
  strategy: StrategyKey | DiagnoseBookKey;
  symbols: string[];
};

export function buildDiagnoseCellStrategies(item: PlannedDiagnoseCell) {
  if (item.strategy === "core-4")
    return DIAGNOSE_BOOK_PRESETS[item.strategy].sleeves.map(
      ({ strategyKey, id }) => ({
        ...buildStrategy(strategyKey, item.symbols, "portfolio"),
        sleeve: id,
      }),
    );
  return [
    buildStrategy(
      item.strategy,
      item.symbols,
      item.mode === "portfolio" ? "portfolio" : "single",
    ),
  ];
}

/** Family identity follows the entry rule even when the candidate/strategy is renamed. */
function entryFamily(entry: StrategyObjectInput["entry"]) {
  const rule = strategyRuleSchema.parse(entry);
  if (rule.kind === "factor")
    return {
      kind: rule.kind,
      side: rule.side,
      conditions: rule.strategy[rule.side],
    };
  return rule;
}

export function assertSharedEntryFamily(
  candidates: readonly {
    id: string;
    entries: StrategyObjectInput["entry"][];
  }[],
) {
  const entries = candidates.flatMap((c) => c.entries.map(entryFamily));
  if (entries.some((entry) => !isDeepStrictEqual(entry, entries[0])))
    throw new Error(
      `--family 候选须属于同一策略家族（入场逻辑）：${candidates.map((c) => c.id).join(", ")}`,
    );
}

export function resolveDiagnoseFamily(name: string) {
  const keys =
    name === "ch14-exits"
      ? [
          "research-chan-hold-cash",
          NATIVE_CHAN_ZD_STOP_KEY,
          NATIVE_CHAN_ZD_ATR_STOP_KEY,
        ]
      : name.trim().split(/[,\s]+/);
  if (
    keys.length < 2 ||
    new Set(keys).size !== keys.length ||
    !keys.every(
      (key): key is SignalStrategyKey => isStrategyKey(key) && key !== "hold",
    )
  )
    throw new Error("--family 需要至少两个不同的同族信号策略");
  assertSharedEntryFamily(
    keys.map((id) => ({ id, entries: [rulesFor(id).entry] })),
  );
  return keys;
}

/** Pure cell planning: used by `--plan` and by the runner, never reads data. */
export function planDiagnoseCells(
  options: DiagnosePlanOptions,
): PlannedDiagnoseCell[] {
  if (!options.symbols.length) throw new Error("至少需要一个标的");
  if (
    options.book &&
    (options.strategies.length || options.mode !== "portfolio")
  )
    throw new Error("--book 需要 portfolio 模式，且与 --strategies 互斥");
  const unknown = [...options.strategies, ...options.controls].filter(
    (key) => !isStrategyKey(key),
  );
  if (unknown.length)
    throw new Error(`未知诊断策略：${[...new Set(unknown)].join(", ")}`);
  if (
    options.family !== undefined &&
    (options.book || options.strategies.length)
  )
    throw new Error("--family 与 --book、--strategies 互斥");
  const signalKeys =
    options.family !== undefined
      ? resolveDiagnoseFamily(options.family)
      : (options.strategies as SignalStrategyKey[]);
  const controlKeys = options.controls as ControlKey[];
  if (!options.book && !signalKeys.length && !controlKeys.length)
    throw new Error("至少需要一条策略或对照");
  const keys: StrategyKey[] = [...signalKeys, ...controlKeys];
  if (new Set(keys).size !== keys.length) throw new Error("诊断策略重复");
  const cells: PlannedDiagnoseCell[] = [];
  if (options.book)
    cells.push({
      mode: "portfolio",
      strategy: options.book,
      symbols: [...options.symbols],
    });
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
