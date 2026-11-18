import {
  technicalMethodIds,
  type TechnicalMethodId,
} from "trading-strategies/research/technical/research-technical-methods";
import { volumeStudyBindings, wyckoffStudyBindings } from "trading-strategies";
import {
  canslimHighIds,
  type CanslimHighId,
} from "trading-strategies/research/canslim/research-canslim-strategies";
import type { WyckoffId } from "trading-strategies/research/wyckoff/research-wyckoff";

/** Both markets use the same frozen daily inputs. A binding still declares
 * its markets explicitly so enumeration and coverage cannot silently add a
 * market that has no source or execution evidence. */
export const methodPoolMarkets = ["cn-equity", "crypto"] as const;
export type MethodPoolMarket = (typeof methodPoolMarkets)[number];

/** Readers accept the frozen pre-identity format as well as the complete
 * execution-dependency format, so old checkpoints stay readable. */
export const methodPoolRegistrationVersions = [
  "theory-study-ten-2",
  "theory-study-ten-3",
] as const;

export function isMethodPoolRegistrationVersion(version: string): boolean {
  return (methodPoolRegistrationVersions as readonly string[]).includes(
    version,
  );
}

/** The binding kind is deliberately separate from run evidence: a bound
 * strategy can be "not-run", and a proxy never becomes a direct source run. */
export const methodPoolBindingKinds = [
  "entry-experiment",
  "source-exit",
  "proxy",
  "protected",
] as const;
export type MethodPoolBindingKind = (typeof methodPoolBindingKinds)[number];

export type MethodPoolBinding = {
  readonly preset: string;
  readonly strategyId: string;
  readonly kind: MethodPoolBindingKind;
  readonly markets: readonly MethodPoolMarket[];
  readonly note?: string;
};

const bothMarkets = methodPoolMarkets;

/** Explicit source exits; entry-only divergences, fractional sizing and
 * minute-dependent methods stay out of the original-exit replay. */
export const technicalSourceExitPresets = [
  "sw-macd-negative",
  "sw-macd-red",
  "sw-macd-green",
  "sw-macd-top",
  "sw-macd-double-top",
  "sw-kdj-zone",
  "sw-kdj-range",
  "sw-rsi-state",
  "sw-rsi-neutral",
  "sw-rsi-top",
  "sw-boll-squeeze",
  "sw-boll-expand",
  "sw-boll-upper",
  "sw-boll-lower",
  "sw-support-20",
  "sw-support-60",
  "sw-support-120",
  "sw-support-250",
  "sw-volume-up-up",
  "sw-volume-up-down",
  "sw-volume-down-up",
  "sw-volume-down-down",
  "sw-volume-top",
  "sw-volume-bottom",
  "sw-volume-breakout",
  "sw-direction",
  "sw-bear-order",
  "sw-tangle",
] as const satisfies readonly TechnicalMethodId[];

/** Reasons a technical preset has no original-exit replay. Keys are presets
 * rather than comments so coverage can report the binding gap without parsing
 * prose. */
export const technicalSourceExitExclusions: Partial<
  Record<TechnicalMethodId, string>
> = {
  "sw-macd-bottom": "原法只有底部反转入场，没有可独立回放的出场",
  "sw-macd-double-bottom": "原法只有连续底部反转入场，没有可独立回放的出场",
  "sw-rsi-bottom": "原法只有 RSI 底部反转入场，没有可独立回放的出场",
  "sw-intraday-ratio": "需要分钟输入，日线回放不能替代",
  "sw-confluence": "原法含半仓/全仓选择，不接统一权重账本",
  "sw-kdj-size": "原法含半仓/全仓选择，不接统一权重账本",
};

/** Reasons a technical preset has no five-bar entry experiment. Exit-only and
 * sizing/intraday rules are not entry signals under the shared adapter. */
export const technicalEntryStudyExclusions: Partial<
  Record<TechnicalMethodId, string>
> = {
  "sw-macd-negative": "原法仅作退出",
  "sw-macd-green": "原法仅作退出",
  "sw-macd-top": "原法为顶部风险/退出信号",
  "sw-macd-double-top": "原法为连续顶部风险/退出信号",
  "sw-rsi-top": "原法为顶部风险/退出信号",
  "sw-boll-lower": "原法仅作退出",
  "sw-volume-down-up": "原法仅作退出",
  "sw-volume-top": "原法为高位风险/退出信号",
  "sw-bear-order": "原法仅作退出",
  "sw-intraday-ratio": "需要分钟输入",
  "sw-kdj-size": "原法含半仓/全仓选择，不接统一权重账本",
  "sw-confluence": "原法含半仓/全仓选择，不接统一权重账本",
};

export const wyckoffEntryStudyPresets = [
  "wy-spring-daily",
  "wy-sos-jac-daily",
  "wy-lps-daily",
  "wy-reaccumulation-daily",
  "wy-trend-pullback-daily",
] as const satisfies readonly WyckoffId[];

export const wyckoffEntryStudyExclusions = {
  "wy-sos-daily": "完整出场代理 research-wyckoff 已覆盖，不重复五根实验",
  "wy-ut-exit-daily": "原法仅作退出",
  "wy-sow-lpsy-daily": "原法仅作退出/减仓",
  "wy-ice-exit-daily": "原法仅作退出",
  "wy-week-day-hour": "需要周/日/小时多周期输入",
  "wy-dual-rs": "需要历史行业/市场相对强弱输入",
  "wy-target-pf": "需要 P&F 目标假设",
  "wy-target-time": "需要原文时间列数目标假设",
  "wy-target-width": "需要原文宽度目标假设",
  "wy-score-half-kelly": "含阶段评分/训练仓位选择",
  "wy-vp-daily-estimate": "日线估算 VP 不是可成交的完整规则",
} as const satisfies Partial<Record<WyckoffId, string>>;

function entryBindingsForTechnical() {
  return technicalMethodIds
    .filter((preset) => !technicalEntryStudyExclusions[preset])
    .map((preset): MethodPoolBinding => ({
      preset,
      strategyId: `entry5-${preset}`,
      kind: "entry-experiment",
      markets: bothMarkets,
      note: "源入场事件，固定五根已完成持有期",
    }));
}

function entryBindingsForWyckoff() {
  return wyckoffEntryStudyPresets.map((preset): MethodPoolBinding => ({
    preset,
    strategyId: `entry5-${preset}`,
    kind: "entry-experiment",
    markets: bothMarkets,
    note: "威科夫日线入场事件，固定五根已完成持有期",
  }));
}

function entryBindingsForCanslim() {
  return canslimHighIds.map((preset: CanslimHighId): MethodPoolBinding => ({
    preset,
    strategyId: `entry5-${preset}`,
    kind: "entry-experiment",
    markets: bothMarkets,
    note: "CANSLIM 高点接近度入场事件，固定五根已完成持有期",
  }));
}

function sourceExitBindings() {
  return technicalSourceExitPresets.map((preset): MethodPoolBinding => ({
    preset,
    strategyId: `source-${preset}`,
    kind: "source-exit",
    markets: bothMarkets,
    note: "原预设日线进出场，信号后下一合法开盘成交",
  }));
}

function proxyBindings() {
  const bindings: MethodPoolBinding[] = [
    {
      preset: "sw-double-prior20",
      strategyId: "research-breakout",
      kind: "proxy",
      markets: bothMarkets,
      note: "复用双突破完整序列的代理，不是预设直接回放",
    },
    {
      preset: "vp-up-expanded-confirm",
      strategyId: "research-volume-price",
      kind: "proxy",
      markets: bothMarkets,
      note: "复用价涨量增候选/确认与通用收盘退出的代理",
    },
    {
      preset: "wy-sos-daily",
      strategyId: "research-wyckoff",
      kind: "proxy",
      markets: bothMarkets,
      note: "复用威科夫完整进出场的代理",
    },
  ];
  for (const [strategyId, preset] of Object.entries(volumeStudyBindings))
    bindings.push({
      preset,
      strategyId,
      kind: "protected",
      markets: bothMarkets,
      note: "同一量价规则的保护版代理",
    });
  for (const [strategyId, preset] of Object.entries(wyckoffStudyBindings))
    bindings.push({
      preset,
      strategyId,
      kind: "protected",
      markets: bothMarkets,
      note: "同一威科夫规则的保护版代理",
    });
  return bindings;
}

/** Single preset -> strategy -> market table used by enumeration, runners and
 * coverage. Entry experiments, original exits and proxies remain distinct. */
export const methodPoolBindings: readonly MethodPoolBinding[] = [
  ...entryBindingsForTechnical(),
  ...entryBindingsForWyckoff(),
  ...entryBindingsForCanslim(),
  {
    preset: "canslim-high-98",
    strategyId: "research-growth",
    kind: "entry-experiment",
    markets: bothMarkets,
    note: "CANSLIM 98% 入口的研究对象，固定五根持有期",
  },
  ...sourceExitBindings(),
  ...proxyBindings(),
];

const validKinds = new Set<MethodPoolBindingKind>(methodPoolBindingKinds);

export function assertMethodPoolBinding(
  binding: MethodPoolBinding,
): MethodPoolBinding {
  if (!binding.preset || !binding.strategyId)
    throw new Error("Method pool binding needs a preset and strategy id");
  if (!validKinds.has(binding.kind))
    throw new Error(`Unknown method pool binding kind: ${binding.kind}`);
  if (!binding.markets.length)
    throw new Error(`Method pool binding has no market: ${binding.strategyId}`);
  if (binding.markets.some((market) => !methodPoolMarkets.includes(market)))
    throw new Error(
      `Method pool binding has an unknown market: ${binding.strategyId}`,
    );
  if (new Set(binding.markets).size !== binding.markets.length)
    throw new Error(
      `Method pool binding repeats a market: ${binding.strategyId}`,
    );
  return binding;
}

for (const binding of methodPoolBindings) assertMethodPoolBinding(binding);

const bindingsByPreset = new Map<string, MethodPoolBinding[]>();
const bindingsByStrategy = new Map<string, MethodPoolBinding>();
for (const binding of methodPoolBindings) {
  bindingsByPreset.set(binding.preset, [
    ...(bindingsByPreset.get(binding.preset) ?? []),
    binding,
  ]);
  if (bindingsByStrategy.has(binding.strategyId))
    throw new Error(`Duplicate method pool strategy: ${binding.strategyId}`);
  bindingsByStrategy.set(binding.strategyId, binding);
}

export function methodPoolBindingsForPreset(
  preset: string,
): readonly MethodPoolBinding[] {
  return bindingsByPreset.get(preset) ?? [];
}

export function bindingForStrategy(
  strategyId: string,
): MethodPoolBinding | undefined {
  return bindingsByStrategy.get(strategyId);
}

export function isEntryStudyStrategy(strategyId: string): boolean {
  const binding = bindingsByStrategy.get(strategyId);
  if (binding) return binding.kind === "entry-experiment";
  // Old evidence keeps its meaning even if a preset is later unbound.
  return strategyId.startsWith("entry5-") || strategyId === "research-growth";
}

/** The binding role of a recorded strategy. Unbound strategies keep their own
 * identity instead of being guessed into a proxy or a direct run. */
export type MethodPoolStrategyRole = MethodPoolBindingKind | "unbound";

export function methodPoolRoleForStrategy(
  strategyId: string,
): MethodPoolStrategyRole {
  const binding = bindingsByStrategy.get(strategyId);
  if (binding) return binding.kind;
  return isEntryStudyStrategy(strategyId) ? "entry-experiment" : "unbound";
}

export function entryStudyStrategyIds(): string[] {
  return methodPoolBindings
    .filter((binding) => binding.kind === "entry-experiment")
    .map((binding) => binding.strategyId);
}

export function entryStudyPresets(): string[] {
  return methodPoolBindings
    .filter(
      (binding) =>
        binding.kind === "entry-experiment" &&
        binding.strategyId.startsWith("entry5-"),
    )
    .map((binding) => binding.preset);
}

export function sourceExitPresets(): TechnicalMethodId[] {
  return methodPoolBindings
    .filter((binding) => binding.kind === "source-exit")
    .map((binding) => binding.preset as TechnicalMethodId);
}

export function entryStudyBindingsForPreset(
  preset: string,
): readonly MethodPoolBinding[] {
  return methodPoolBindingsForPreset(preset).filter(
    (binding) => binding.kind === "entry-experiment",
  );
}

/** Run evidence for a preset: original exits plus proxy/protected variants. */
export function portfolioBindingsForPreset(
  preset: string,
): readonly MethodPoolBinding[] {
  return methodPoolBindingsForPreset(preset).filter(
    (binding) => binding.kind !== "entry-experiment",
  );
}

export function bindingSupportsMarket(
  binding: MethodPoolBinding,
  market: string,
): market is MethodPoolMarket {
  return binding.markets.includes(market as MethodPoolMarket);
}

export function assertBindingMarket(
  binding: MethodPoolBinding,
  market: string,
): MethodPoolMarket {
  if (!bindingSupportsMarket(binding, market))
    throw new Error(
      `Method pool binding ${binding.strategyId} has no ${market} market`,
    );
  return market;
}

/** Strategies without a binding (baseline, RPS, low-volatility or legacy
 * study rules) keep their caller-provided markets. A bound strategy is only
 * enumerated for markets it declares. */
export function strategySupportsMarket(
  strategyId: string,
  market: string,
): boolean {
  const binding = bindingForStrategy(strategyId);
  return binding ? bindingSupportsMarket(binding, market) : true;
}
