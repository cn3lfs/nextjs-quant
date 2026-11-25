import { isDeepStrictEqual } from "node:util";
import {
  strategyObjectSchema,
  usesStrategyBook,
  type StrategyObjectInput,
  type StrategyRule,
} from "trading-strategies";
import { z } from "zod";
import type { ShadowRegistration } from "../alerts/shadow";
import { AlertRepository } from "../db/alert-repository";
import type { PaperRepository } from "../db/paper-repository";
import {
  DIAGNOSE_BOOK_PRESETS,
  buildStrategy,
  isNativeStrategyKey,
  isPitStrategyKey,
  isStrategyKey,
} from "../research/diagnose/strategy-specs";
import {
  registerPaperAccount,
  registerPaperAccountSchema,
} from "./registration";

const strategyKeySchema = z.string().trim().min(1);
const symbolsSchema = z
  .array(z.string().regex(/^(sh|sz|bj)\d{6}$/, "无效的 A 股证券代码"))
  .min(1, "至少需要一个证券代码")
  .refine(
    (symbols) => new Set(symbols).size === symbols.length,
    "证券代码须唯一",
  );

export const promoteResearchStrategySchema = registerPaperAccountSchema
  .pick({ name: true, initial: true })
  .extend({ strategyKey: strategyKeySchema, symbols: symbolsSchema })
  .strict();

export const watchResearchShadowSchema = z.union([
  z.object({ strategyKey: strategyKeySchema, symbols: symbolsSchema }).strict(),
  z
    .object({
      strategy: strategyObjectSchema,
      symbols: symbolsSchema.optional(),
    })
    .strict(),
]);

const paperRuleKinds = new Set<StrategyRule["kind"]>([
  "study-rule",
  "dual-ma",
  "double-breakout",
  "formula",
  "theory-screener",
]);
const shadowRuleKinds = new Set<StrategyRule["kind"]>([
  ...paperRuleKinds,
  "chan-third-buy",
  "chan-native",
]);

function buildProspectiveStrategy(
  key: string,
  symbols: string[],
  target: "纸面账户" | "影子收盘提醒",
): StrategyObjectInput {
  if (Object.hasOwn(DIAGNOSE_BOOK_PRESETS, key))
    throw new Error(`${target}仅接受单条策略，${key} 的组合分仓需要独立适配`);
  if (key === "hold")
    throw new Error("hold 是研究对照，不能登记为前向信号策略");
  if (!isStrategyKey(key))
    throw new Error(`不支持的研究策略 ${key}，请使用已登记的可做多策略`);
  if (isPitStrategyKey(key))
    throw new Error(`${target}尚未接入 ${key} 所需的时点（PIT）财务数据`);
  if (target === "纸面账户" && isNativeStrategyKey(key))
    throw new Error(`纸面账户尚未接入 ${key} 所需的原生缠论观测`);
  return buildStrategy(
    key,
    symbols,
    symbols.length > 1 ? "portfolio" : "single",
  );
}

function assertRuleKinds(
  strategy: StrategyObjectInput,
  supported: ReadonlySet<StrategyRule["kind"]>,
  target: string,
) {
  for (const rule of [strategy.entry, strategy.exit.rule])
    if (rule && !supported.has(rule.kind))
      throw new Error(`${target}尚未接入 ${rule.kind} 规则所需的前向输入`);
}

export function promoteResearchToPaper(
  raw: unknown,
  repo?: PaperRepository,
  now = Date.now(),
) {
  const { name, initial, strategyKey, symbols } =
    promoteResearchStrategySchema.parse(raw);
  if (strategyKey.startsWith("screener:f11-"))
    throw new Error(
      "F11 龙头策略依赖情绪周期门控和涨停四池前向观察，纯日线输入不足以登记纸面自动推进。请走 sentimentRegimeSnapshot 做前向观察。",
    );
  const strategy = buildProspectiveStrategy(strategyKey, symbols, "纸面账户");
  assertRuleKinds(strategy, paperRuleKinds, "纸面账户");
  return registerPaperAccount(
    {
      name,
      initial,
      market: "cn-equity",
      currency: "CNY",
      sleeve: "diag",
      candidates: [
        { ...strategy, id: `paper-${strategyKey.replaceAll(":", "-")}` },
      ],
    },
    repo,
    now,
  );
}

export function watchResearchInShadow(raw: unknown, repo?: AlertRepository) {
  const input = watchResearchShadowSchema.parse(raw);
  const strategy =
    "strategy" in input
      ? input.strategy
      : buildProspectiveStrategy(
          input.strategyKey,
          [...input.symbols].sort(),
          "影子收盘提醒",
        );
  if (
    strategy.market !== "cn-equity" ||
    !["day", "week"].includes(strategy.period)
  )
    throw new Error("研究影子收盘提醒仅支持 A 股日线或周线策略");
  if (usesStrategyBook(strategy))
    throw new Error("研究影子收盘提醒不支持依赖同版本纸面组合决策的策略");
  assertRuleKinds(strategy, shadowRuleKinds, "影子收盘提醒");

  const fixedSymbols =
    strategy.universe.kind === "symbols"
      ? strategy.universe.symbols
      : undefined;
  const symbols = symbolsSchema.parse(fixedSymbols ?? input.symbols);
  if (symbols.some((symbol) => symbol.startsWith("bj")))
    throw new Error("影子收盘提醒目前仅支持沪深证券代码");
  if (
    fixedSymbols &&
    input.symbols &&
    !isDeepStrictEqual([...fixedSymbols].sort(), [...input.symbols].sort())
  )
    throw new Error("影子提醒证券池须与策略版本的固定证券池一致");

  const alerts = repo ?? new AlertRepository();
  const { id: strategyId, version } = strategy;
  const identity = `${strategyId}:${version}`;
  return alerts.atomic(() => {
    if (alerts.state<{ live: boolean }>(`strategy:${identity}`)?.live)
      throw new Error("策略版本已开启实盘提醒，请先在提醒设置中关闭");

    alerts.strategies.saveStrategy(strategy);
    const shadowKey = `shadow:${identity}`;
    const existing = alerts.state<ShadowRegistration>(shadowKey);
    if (!fixedSymbols) {
      const universeKey = `universe:${identity}`;
      const configured = alerts.state<string[]>(universeKey);
      if (configured || existing?.active) {
        if (
          !configured ||
          !isDeepStrictEqual([...configured].sort(), [...symbols].sort())
        )
          throw new Error("影子提醒证券池已登记，调整证券池须使用新策略版本");
      } else alerts.saveState(universeKey, symbols);
    }
    if (!existing?.active) {
      const registration: ShadowRegistration = existing
        ? { ...existing, active: true }
        : {
            active: true,
            startedAt: Date.now(),
            status: "shadow-candidate",
            trialSharpes: [],
            neighbors: [],
            sizing: "legacy",
            completeMarketCycles: 0,
            lowZoneCorroborated: false,
          };
      alerts.saveState(shadowKey, registration);
    }
    return {
      strategyId,
      version,
      mode: "shadow" as const,
      symbolCount: symbols.length,
      alreadyWatched: existing?.active === true,
    };
  });
}
