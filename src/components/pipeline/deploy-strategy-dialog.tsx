"use client";

import { ArrowRight, Robot } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import {
  listTheoryScreenerSpecs,
  studyNames,
  studyStrategies,
  venueBindingSchema,
} from "trading-strategies";
import { validateScreenFormula } from "trading-strategies/formula/formula-screen";
import { z } from "zod";
import { StateBanner } from "~/components/panels";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { useWorkbenchNotify } from "~/components/workbench/workbench-notify";
import { api, type RouterInputs } from "~/trpc/react";

export type DeploymentCreateInput = RouterInputs["deploymentCreate"];
export type StrategySpecInput = DeploymentCreateInput["strategySpec"];
export type UniverseSpecInput = DeploymentCreateInput["universeSpec"];
export type VenueBindingInput = DeploymentCreateInput["venueBinding"];
export type DeployProvenanceInput = DeploymentCreateInput["provenance"];

type DeployMarket = DeploymentCreateInput["market"];
type StrategyKind = StrategySpecInput["kind"];
type StudyStrategyId = Extract<
  StrategySpecInput,
  { kind: "study-rule" }
>["strategyId"];
type PairId = Extract<StrategySpecInput, { kind: "pair-switch" }>["pairId"];
type UniverseKind = UniverseSpecInput["kind"];
type ValueStrategyId =
  | "value-magic-formula-pit"
  | "value-fscore-local8-pit"
  | "value-dividend-lowvol-pit"
  | "value-garp-pit";
type GateKind = NonNullable<DeploymentCreateInput["regimeGate"]>["kind"];
type CryptoInterval = 5 | 15 | 30 | 60 | 240 | 1440;
type RpsPeriod = 10 | 20 | 50 | 120;

/** A page-level starting point: the dialog still validates and builds the rest. */
export type DeployStrategyPreset = {
  name?: string;
  description?: string;
  market?: DeployMarket;
  strategySpec?: StrategySpecInput;
  universeSpec?: UniverseSpecInput;
  maxSymbolWeight?: number;
  riskPolicy?: DeploymentCreateInput["riskPolicy"];
  provenance?: Partial<DeployProvenanceInput>;
};

type FormState = {
  name: string;
  market: DeployMarket;
  strategyKind: StrategyKind;
  studyStrategyId: StudyStrategyId;
  screenerMethodId: string;
  screenerHoldBars: string;
  etfStrategyId:
    "etf-dual-momentum" | "etf-sector-rotation" | "etf-risk-budget";
  macroCadence: "month-end" | "quarter-end";
  pairId: PairId;
  valueStrategyId: ValueStrategyId;
  alphaCompositeId: string;
  alphaTopN: string;
  alphaCadence: NonNullable<
    Extract<StrategySpecInput, { kind: "alpha-composite" }>["rebalanceCadence"]
  >;
  cryptoFast: string;
  cryptoSlow: string;
  cryptoPeriod: "5m" | "15m" | "30m" | "1h" | "4h" | "day";
  chanProfile: "first" | "second" | "third" | "hold-cash";
  formulaName: string;
  formulaSource: string;
  doubleBreakoutVolumeRatio: string;
  universeKind: UniverseKind;
  fixedSymbols: string;
  watchlistMaxSymbols: string;
  etfPool: "full" | "legacy-long-history" | "pair-only";
  rpsPeriod: RpsPeriod;
  rpsMin: string;
  rpsMaxSymbols: string;
  scanMethodId: string;
  scanMaxSymbols: string;
  valueTopK: string;
  formulaScreenName: string;
  formulaScreenSource: string;
  formulaScreenParameters: string;
  formulaScreenMaxSymbols: string;
  poolMode: "accumulate" | "replace";
  missedDays: string;
  hardEvictMa: string;
  hardEvictDrawdown: string;
  maxPoolSize: string;
  gateKind: GateKind;
  gateBenchmark: string;
  gateUnlockDays: string;
  maxSymbolWeight: string;
  maxTotalExposure: string;
  maxGap: string;
  drawdownPause: string;
  scheduleKind: "post_close_auto" | "manual_only" | "crypto_interval";
  cryptoInterval: CryptoInterval;
  channel: "sim" | "live";
  cnSimVenue: "local_sim" | "ths_mock";
  simAccountId: string;
  cryptoAccountId: string;
  cryptoVenue: "binance" | "okx" | "bybit";
  liveBroker: Extract<VenueBindingInput, { kind: "cn_broker_live" }>["broker"];
  liveAccountId: string;
  liveEndpointUrl: string;
  cryptoLiveAccountId: string;
  cryptoLiveVenue: "binance" | "okx" | "bybit";
};

const marketOptions: readonly { value: DeployMarket; label: string }[] = [
  { value: "cn-equity", label: "A 股" },
  { value: "crypto", label: "数字货币" },
];

const strategyKindOptions: readonly {
  value: StrategyKind;
  label: string;
}[] = [
  { value: "double-breakout", label: "双突破（量价突破）" },
  { value: "study-rule", label: "研究规则（均线/动量/指标）" },
  { value: "theory-screener", label: "理论选股器（缠论/形态）" },
  { value: "etf-rotation", label: "ETF 轮动配置" },
  { value: "macro-clock", label: "宏观时钟轮动" },
  { value: "pair-switch", label: "配对切换（相对价值）" },
  { value: "value-pit", label: "价值洼地（PIT）" },
  { value: "alpha-composite", label: "因子复合（Alpha Lab）" },
  { value: "crypto-dual-ma", label: "数字货币双均线" },
  { value: "chan-native", label: "缠论原生买卖点" },
  { value: "multi-book", label: "多策略组合 core-4" },
  { value: "formula", label: "自定义公式" },
];

const studyOptions = studyStrategies
  .filter((id) => id !== "hold")
  .map((value) => ({ value, label: studyNames[value] }));

const screenerMethodOptions = listTheoryScreenerSpecs()
  .filter(({ direction }) => direction !== "short")
  .map(({ id, label }) => ({ value: id, label }));

const etfOptions = [
  { value: "etf-dual-momentum", label: "多资产双动量" },
  { value: "etf-sector-rotation", label: "行业 ETF 相对强弱轮动" },
  { value: "etf-risk-budget", label: "股债金风险预算配置" },
] as const;

const pairOptions = [
  { value: "hs300-zz500", label: "沪深300 / 中证500 风格切换" },
  { value: "dividend-chinext", label: "红利 / 创业板 价值成长切换" },
  { value: "gold-treasury", label: "黄金 / 国债 避险资产切换" },
] as const;

const valueOptions: readonly { value: ValueStrategyId; label: string }[] = [
  { value: "value-magic-formula-pit", label: "神奇公式（PIT）" },
  { value: "value-fscore-local8-pit", label: "F-Score 本地八因子" },
  { value: "value-dividend-lowvol-pit", label: "高股息低波动" },
  { value: "value-garp-pit", label: "GARP 成长价值" },
];

const universeKindOptions: readonly {
  value: UniverseKind;
  label: string;
}[] = [
  { value: "watchlist", label: "自选股" },
  { value: "fixed-symbols", label: "固定标的列表" },
  { value: "theory-screener-scan", label: "理论选股器扫描" },
  { value: "rps-filter", label: "RPS 强度过滤" },
  { value: "etf-pool", label: "ETF 池" },
  { value: "value-pit-topn", label: "价值洼地 Top-N" },
  { value: "formula-screen", label: "公式选股" },
];

const gateOptions: readonly { value: GateKind; label: string }[] = [
  { value: "none", label: "不启用市场门控" },
  { value: "oneil-market-direction", label: "欧奈尔市场方向（分布日）" },
  { value: "dow-dual-index", label: "道氏双指数确认" },
  { value: "sentiment-regime", label: "情绪状态门控" },
  { value: "macro-clock-filter", label: "宏观时钟过滤" },
];

const channelLabels: Record<VenueBindingInput["kind"], string> = {
  local_sim: "本地模拟盘",
  ths_mock: "同花顺模拟",
  crypto_sim: "数字货币模拟",
  cn_broker_live: "A 股实盘",
  crypto_live: "数字货币实盘",
};

const brokerOptions = [
  { value: "qmt", label: "QMT" },
  { value: "ptrade", label: "PTrade" },
  { value: "xtquant", label: "XtQuant" },
  { value: "ths_live", label: "同花顺实盘（桥接）" },
  { value: "http_bridge", label: "HTTP 桥接" },
] as const;

const cryptoVenueOptions = [
  { value: "binance", label: "Binance" },
  { value: "okx", label: "OKX" },
  { value: "bybit", label: "Bybit" },
] as const;

const cryptoSimAccounts = {
  binance: [
    { value: "binance-demo", label: "Binance 模拟盘" },
    { value: "binance-testnet", label: "Binance 测试网" },
  ],
  okx: [{ value: "okx-demo", label: "OKX 模拟盘" }],
  bybit: [{ value: "bybit-demo", label: "Bybit 模拟盘" }],
} as const;

function defaultForm(): FormState {
  return {
    name: "双突破 · 策略运行台",
    market: "cn-equity",
    strategyKind: "double-breakout",
    studyStrategyId: "sma200",
    screenerMethodId: "f02-dow-swing-break",
    screenerHoldBars: "25",
    etfStrategyId: "etf-dual-momentum",
    macroCadence: "month-end",
    pairId: "hs300-zz500",
    valueStrategyId: "value-magic-formula-pit",
    alphaCompositeId: "",
    alphaTopN: "10",
    alphaCadence: "weekly",
    cryptoFast: "20",
    cryptoSlow: "60",
    cryptoPeriod: "1h",
    chanProfile: "third",
    formulaName: "",
    formulaSource: "",
    doubleBreakoutVolumeRatio: "",
    universeKind: "watchlist",
    fixedSymbols: "",
    watchlistMaxSymbols: "50",
    etfPool: "full",
    rpsPeriod: 20,
    rpsMin: "80",
    rpsMaxSymbols: "50",
    scanMethodId: "f02-dow-swing-break",
    scanMaxSymbols: "20",
    valueTopK: "15",
    formulaScreenName: "",
    formulaScreenSource: "",
    formulaScreenParameters: "",
    formulaScreenMaxSymbols: "20",
    poolMode: "accumulate",
    missedDays: "5",
    hardEvictMa: "",
    hardEvictDrawdown: "",
    maxPoolSize: "50",
    gateKind: "none",
    gateBenchmark: "sh000300",
    gateUnlockDays: "10",
    maxSymbolWeight: "20",
    maxTotalExposure: "95",
    maxGap: "2",
    drawdownPause: "8",
    scheduleKind: "post_close_auto",
    cryptoInterval: 60,
    channel: "sim",
    cnSimVenue: "local_sim",
    simAccountId: "",
    cryptoAccountId: "binance-demo",
    cryptoVenue: "binance",
    liveBroker: "qmt",
    liveAccountId: "",
    liveEndpointUrl: "",
    cryptoLiveAccountId: "",
    cryptoLiveVenue: "binance",
  };
}

function formFromStrategySpec(
  spec: StrategySpecInput,
): Pick<FormState, "strategyKind"> & Partial<FormState> {
  switch (spec.kind) {
    case "study-rule":
      return { strategyKind: spec.kind, studyStrategyId: spec.strategyId };
    case "theory-screener":
      return {
        strategyKind: spec.kind,
        screenerMethodId: spec.methodId,
        screenerHoldBars: String(spec.holdBars ?? 25),
      };
    case "etf-rotation":
      return { strategyKind: spec.kind, etfStrategyId: spec.config.strategyId };
    case "macro-clock":
      return {
        strategyKind: spec.kind,
        macroCadence: spec.rebalanceCadence ?? "month-end",
      };
    case "pair-switch":
      return { strategyKind: spec.kind, pairId: spec.pairId };
    case "value-pit":
      return { strategyKind: spec.kind, valueStrategyId: spec.strategyId };
    case "alpha-composite":
      return {
        strategyKind: spec.kind,
        alphaCompositeId: spec.compositeId,
        alphaTopN: String(spec.topN ?? 10),
        alphaCadence: spec.rebalanceCadence ?? "weekly",
      };
    case "crypto-dual-ma":
      return {
        strategyKind: spec.kind,
        cryptoFast: String(spec.fast),
        cryptoSlow: String(spec.slow),
        cryptoPeriod: spec.period,
        market: "crypto",
      };
    case "chan-native":
      return { strategyKind: spec.kind, chanProfile: spec.profile };
    case "formula":
      return {
        strategyKind: spec.kind,
        formulaName: spec.name,
        formulaSource: spec.source,
      };
    case "double-breakout":
      return {
        strategyKind: spec.kind,
        doubleBreakoutVolumeRatio:
          spec.minVolumeRatio === undefined ? "" : String(spec.minVolumeRatio),
      };
    case "multi-book":
      return { strategyKind: spec.kind };
  }
}

function formFromUniverseSpec(
  spec: UniverseSpecInput,
): Pick<FormState, "universeKind"> & Partial<FormState> {
  switch (spec.kind) {
    case "fixed-symbols":
      return {
        universeKind: spec.kind,
        fixedSymbols: spec.symbols.join(", "),
      };
    case "watchlist":
      return {
        universeKind: spec.kind,
        watchlistMaxSymbols: String(spec.maxSymbols ?? 50),
      };
    case "etf-pool":
      return { universeKind: spec.kind, etfPool: spec.pool ?? "full" };
    case "rps-filter":
      return {
        universeKind: spec.kind,
        rpsPeriod: spec.period,
        rpsMin: String(spec.minRps),
        rpsMaxSymbols: String(spec.maxSymbols ?? 20),
      };
    case "theory-screener-scan":
      return {
        universeKind: spec.kind,
        scanMethodId: spec.methodId,
        scanMaxSymbols: String(spec.maxSymbols ?? 20),
      };
    case "value-pit-topn":
      return {
        universeKind: spec.kind,
        valueStrategyId: spec.strategyId,
        valueTopK: String(spec.topK ?? 15),
      };
    case "formula-screen":
      return {
        universeKind: spec.kind,
        formulaScreenName: spec.formulaName,
        formulaScreenSource: spec.source,
        formulaScreenParameters: spec.parameters
          ? JSON.stringify(spec.parameters)
          : "",
        formulaScreenMaxSymbols: String(spec.maxSymbols ?? 20),
      };
  }
}

function presetPercent(fraction: number | undefined, fallback: string) {
  return fraction === undefined
    ? fallback
    : String(Number((fraction * 100).toFixed(8)));
}

function formFromPreset(preset: DeployStrategyPreset | undefined): FormState {
  const base = defaultForm();
  if (!preset) return base;
  const fromStrategy: Partial<FormState> = preset.strategySpec
    ? formFromStrategySpec(preset.strategySpec)
    : {};
  const fromUniverse: Partial<FormState> = preset.universeSpec
    ? formFromUniverseSpec(preset.universeSpec)
    : {};
  const risk = preset.riskPolicy;
  const next: FormState = {
    ...base,
    ...fromStrategy,
    ...fromUniverse,
    ...(preset.name ? { name: preset.name } : {}),
    ...(preset.market ? { market: preset.market } : {}),
    maxSymbolWeight: presetPercent(
      risk?.maxSymbolWeight ?? preset.maxSymbolWeight,
      base.maxSymbolWeight,
    ),
    maxTotalExposure: presetPercent(
      risk?.maxTotalExposure,
      base.maxTotalExposure,
    ),
    maxGap: presetPercent(risk?.maxGapPct, base.maxGap),
    drawdownPause: presetPercent(risk?.drawdownPausePct, base.drawdownPause),
  };
  const market = preset.market ?? fromStrategy.market ?? next.market;
  next.market = market;
  if (market === "crypto" && !preset.universeSpec)
    next.universeKind = "fixed-symbols";
  next.channel = "sim";
  next.scheduleKind =
    market === "crypto"
      ? next.strategyKind === "crypto-dual-ma"
        ? "crypto_interval"
        : "manual_only"
      : "post_close_auto";
  return next;
}

function parseInteger(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

function parseDecimal(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function requireInteger(
  raw: string,
  label: string,
  min: number,
  max: number,
): number {
  const value = parseInteger(raw);
  if (value === null || value < min || value > max)
    throw new Error(`${label}须为 ${min}–${max} 的整数`);
  return value;
}

function requireFraction(
  raw: string,
  label: string,
  min: number,
  max: number,
): number {
  const percent = parseDecimal(raw);
  if (percent === null || percent <= 0 || percent > 100)
    throw new Error(`${label}须为 0–100 之间的百分比`);
  const fraction = percent / 100;
  if (fraction < min || fraction > max) throw new Error(`${label}超出允许范围`);
  return fraction;
}

function composeStrategy(
  form: FormState,
  preset?: StrategySpecInput,
): StrategySpecInput {
  switch (form.strategyKind) {
    case "double-breakout": {
      const ratio = parseDecimal(form.doubleBreakoutVolumeRatio);
      if (
        form.doubleBreakoutVolumeRatio.trim() &&
        (ratio === null || ratio <= 0)
      )
        throw new Error("双突破量比下限须为正数");
      return {
        kind: "double-breakout",
        ...(ratio === null ? {} : { minVolumeRatio: ratio }),
      };
    }
    case "study-rule":
      return {
        kind: "study-rule",
        strategyId: form.studyStrategyId,
        parameters:
          preset?.kind === "study-rule" &&
          preset.strategyId === form.studyStrategyId
            ? preset.parameters
            : undefined,
      };
    case "theory-screener": {
      const sameMethod =
        preset?.kind === "theory-screener" &&
        preset.methodId === form.screenerMethodId;
      return {
        kind: "theory-screener",
        methodId: form.screenerMethodId,
        holdBars: requireInteger(form.screenerHoldBars, "持有周期", 1, 250),
        ...(sameMethod && {
          minScore: preset.minScore,
          useScreenerStops: preset.useScreenerStops,
        }),
      };
    }
    case "etf-rotation":
      return {
        kind: "etf-rotation",
        config:
          preset?.kind === "etf-rotation" &&
          preset.config.strategyId === form.etfStrategyId
            ? preset.config
            : { strategyId: form.etfStrategyId },
      };
    case "macro-clock":
      return { kind: "macro-clock", rebalanceCadence: form.macroCadence };
    case "pair-switch":
      return { kind: "pair-switch", pairId: form.pairId };
    case "value-pit":
      return {
        kind: "value-pit",
        strategyId: form.valueStrategyId,
        rebalanceCadence: "month-end",
      };
    case "alpha-composite": {
      const compositeId = form.alphaCompositeId.trim();
      if (!compositeId) throw new Error("请填写因子复合组合 ID");
      return {
        kind: "alpha-composite",
        compositeId,
        topN: requireInteger(form.alphaTopN, "因子持仓数", 1, 50),
        rebalanceCadence: form.alphaCadence,
      };
    }
    case "crypto-dual-ma": {
      const fast = requireInteger(form.cryptoFast, "快线周期", 2, 120);
      const slow = requireInteger(form.cryptoSlow, "慢线周期", 3, 250);
      if (fast >= slow) throw new Error("快线周期必须短于慢线周期");
      return {
        kind: "crypto-dual-ma",
        fast,
        slow,
        period: form.cryptoPeriod,
      };
    }
    case "chan-native":
      return { kind: "chan-native", profile: form.chanProfile };
    case "multi-book":
      return { kind: "multi-book", preset: "core-4" };
    case "formula": {
      const name = form.formulaName.trim();
      const source = form.formulaSource.trim();
      if (!name || !source) throw new Error("请填写公式名称与公式源码");
      const sameFormula =
        preset?.kind === "formula" && preset.source.trim() === source;
      return {
        kind: "formula",
        name,
        source,
        ...(sameFormula && { parameters: preset.parameters }),
      };
    }
  }
}

function composeUniverse(form: FormState): UniverseSpecInput {
  switch (form.universeKind) {
    case "fixed-symbols": {
      const symbols = [
        ...new Map(
          form.fixedSymbols
            .split(/[\s,，;；]+/)
            .map((symbol) => symbol.trim())
            .filter(Boolean)
            .map((symbol) => [symbol.toUpperCase(), symbol] as const),
        ).values(),
      ];
      if (!symbols.length) throw new Error("请填写固定标的代码");
      if (symbols.length > 200) throw new Error("固定标的不能超过 200 只");
      return { kind: "fixed-symbols", symbols };
    }
    case "watchlist":
      return {
        kind: "watchlist",
        maxSymbols: requireInteger(
          form.watchlistMaxSymbols,
          "自选股容量上限",
          1,
          200,
        ),
      };
    case "etf-pool":
      return { kind: "etf-pool", pool: form.etfPool };
    case "rps-filter": {
      const minRps = parseDecimal(form.rpsMin);
      if (minRps === null || minRps < 0 || minRps > 100)
        throw new Error("RPS 下限须为 0–100");
      return {
        kind: "rps-filter",
        period: form.rpsPeriod,
        minRps,
        maxSymbols: requireInteger(form.rpsMaxSymbols, "RPS 选股数量", 1, 100),
      };
    }
    case "theory-screener-scan":
      return {
        kind: "theory-screener-scan",
        methodId: form.scanMethodId,
        maxSymbols: requireInteger(
          form.scanMaxSymbols,
          "选股器扫描数量",
          1,
          100,
        ),
      };
    case "value-pit-topn":
      return {
        kind: "value-pit-topn",
        strategyId: form.valueStrategyId,
        topK: requireInteger(form.valueTopK, "价值洼地 Top-N", 1, 50),
      };
    case "formula-screen": {
      const formulaName = form.formulaScreenName.trim();
      const source = form.formulaScreenSource.trim();
      if (!formulaName || !source)
        throw new Error("请填写选股公式名称与公式源码");
      let rawParameters: unknown = {};
      if (form.formulaScreenParameters.trim()) {
        try {
          rawParameters = JSON.parse(form.formulaScreenParameters);
        } catch {
          throw new Error('选股公式参数须为 JSON 对象，例如 {"N1":5,"N2":20}');
        }
      }
      const parsedParameters = z
        .record(z.number().finite())
        .safeParse(rawParameters);
      if (!parsedParameters.success)
        throw new Error("选股公式参数须为数值键值对");
      const { parameters } = validateScreenFormula({
        name: formulaName,
        source,
        parameters: parsedParameters.data,
      });
      return {
        kind: "formula-screen",
        formulaName,
        source,
        parameters,
        maxSymbols: requireInteger(
          form.formulaScreenMaxSymbols,
          "公式选股数量",
          1,
          100,
        ),
      };
    }
  }
}

function composeVenue(form: FormState): VenueBindingInput {
  if (form.channel === "live") {
    if (form.market === "crypto") {
      const accountId = form.cryptoLiveAccountId.trim();
      if (!accountId) throw new Error("请填写实盘账户 ID");
      return {
        kind: "crypto_live",
        venue: form.cryptoLiveVenue,
        accountId,
      };
    }
    const accountId = form.liveAccountId.trim();
    if (!accountId) throw new Error("请填写实盘账户 ID");
    const endpoint = form.liveEndpointUrl.trim();
    if (form.liveBroker === "ths_live") {
      if (!endpoint) throw new Error("请填写同花顺实盘桥接 URL");
      const result = venueBindingSchema.safeParse({
        kind: "cn_broker_live",
        broker: form.liveBroker,
        accountId,
        endpointUrl: endpoint,
      });
      if (!result.success)
        throw new Error(
          "同花顺实盘桥接须使用 HTTPS 或本机 HTTP，地址不能含凭据、查询参数或片段",
        );
      return result.data;
    }
    if (endpoint) {
      let parsed: URL;
      try {
        parsed = new URL(endpoint);
      } catch {
        throw new Error("桥接 URL 不是合法的 HTTP(S) 地址");
      }
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        throw new Error("桥接 URL 不能包含凭据、查询参数或片段");
    }
    return {
      kind: "cn_broker_live",
      broker: form.liveBroker,
      accountId,
      ...(endpoint ? { endpointUrl: endpoint } : {}),
    };
  }
  if (form.market === "crypto") {
    const accountId = form.cryptoAccountId.trim();
    if (!accountId) throw new Error("请填写数字货币模拟账户 ID");
    return { kind: "crypto_sim", venue: form.cryptoVenue, accountId };
  }
  if (form.cnSimVenue === "ths_mock")
    return { kind: "ths_mock", accountTag: "default" };
  const simAccountId = form.simAccountId.trim();
  if (!simAccountId) throw new Error("请选择本地模拟账户");
  return { kind: "local_sim", simAccountId };
}

function composeSchedule(form: FormState): DeploymentCreateInput["schedule"] {
  if (form.scheduleKind === "manual_only") return { kind: "manual_only" };
  if (form.scheduleKind === "crypto_interval")
    return { kind: "crypto_interval", intervalMinutes: form.cryptoInterval };
  return { kind: "post_close_auto" };
}

function composePoolPolicy(form: FormState) {
  const missedDays = requireInteger(
    form.missedDays,
    "连续未命中宽限天数",
    0,
    60,
  );
  const hardEvictMa = form.hardEvictMa.trim()
    ? requireInteger(form.hardEvictMa, "跌破均线硬淘汰天数", 5, 250)
    : null;
  const hardEvictDrawdown = form.hardEvictDrawdown.trim()
    ? requireFraction(form.hardEvictDrawdown, "入池回撤硬淘汰", 0, 0.95)
    : null;
  if (hardEvictDrawdown !== null && hardEvictDrawdown >= 0.95)
    throw new Error("入池回撤硬淘汰须小于 95%");
  const maxPoolSize = requireInteger(
    form.maxPoolSize,
    "监控池容量上限",
    1,
    500,
  );
  return {
    missedDays,
    hardEvictMa,
    hardEvictDrawdown,
    maxPoolSize,
  };
}

function composeResearchConfig(form: FormState, preset?: DeployStrategyPreset) {
  return {
    market: form.market,
    strategySpec: composeStrategy(form, preset?.strategySpec),
    universeSpec: composeUniverse(form),
    poolPolicy: composePoolPolicy(form),
    regimeGate: {
      kind: form.gateKind,
      benchmark: form.gateBenchmark.trim() || "sh000300",
      unlockAvoidanceDays: requireInteger(
        form.gateUnlockDays,
        "解禁回避天数",
        0,
        30,
      ),
    },
    riskPolicy: {
      ...preset?.riskPolicy,
      maxSymbolWeight: requireFraction(form.maxSymbolWeight, "单票上限", 0, 1),
      maxTotalExposure: requireFraction(
        form.maxTotalExposure,
        "最大总仓位",
        0,
        1,
      ),
      maxGapPct: requireFraction(form.maxGap, "开盘跳空上限", 0.005, 0.2),
      drawdownPausePct: requireFraction(
        form.drawdownPause,
        "回撤暂停阈值",
        0,
        0.5,
      ),
    },
  };
}

function researchFingerprint(form: FormState, preset?: DeployStrategyPreset) {
  try {
    return JSON.stringify(composeResearchConfig(form, preset));
  } catch {
    return null;
  }
}

function frozenArchiveId(provenance: DeployStrategyPreset["provenance"]) {
  if (provenance?.sourceKind !== "lab-backtest" || !provenance.sourceRefId)
    return null;
  // A strategy-library entry without a backtest uses its version as the source.
  try {
    const note = z
      .object({ strategy: z.string() })
      .safeParse(JSON.parse(provenance.note ?? "{}"));
    if (note.data?.strategy === provenance.sourceRefId) return null;
  } catch {
    // Older handoffs may carry a plain-text note.
  }
  return provenance.sourceRefId;
}

function composeInput(
  form: FormState,
  preset: DeployStrategyPreset | undefined,
  derivedFromArchiveId: string | null,
): DeploymentCreateInput {
  const name = form.name.trim();
  if (!name) throw new Error("请填写策略名称");
  const missedDays = requireInteger(
    form.missedDays,
    "连续未命中宽限天数",
    0,
    60,
  );
  const hardEvictMa = form.hardEvictMa.trim()
    ? requireInteger(form.hardEvictMa, "跌破均线硬淘汰天数", 5, 250)
    : null;
  const hardEvictDrawdown = form.hardEvictDrawdown.trim()
    ? requireFraction(form.hardEvictDrawdown, "入池回撤硬淘汰", 0, 0.95)
    : null;
  if (hardEvictDrawdown !== null && hardEvictDrawdown >= 0.95)
    throw new Error("入池回撤硬淘汰须小于 95%");
  const maxPoolSize = requireInteger(
    form.maxPoolSize,
    "监控池容量上限",
    1,
    500,
  );
  const createdFromRoute =
    typeof window === "undefined" ? "/" : window.location.pathname;
  const provenance: DeployProvenanceInput = {
    sourceKind: "manual",
    createdFromRoute,
    ...preset?.provenance,
  };
  if (derivedFromArchiveId) {
    // The provenance contract stores annotations in note. It uses sourceKind
    // and sourceRefId to resolve executable frozen research.
    const note = JSON.stringify({
      modifiedFromFrozen: true,
      derivedFromArchiveId,
    });
    provenance.sourceKind = "manual";
    provenance.sourceRefId = null;
    provenance.buildHash = null;
    provenance.note =
      note.length <= 500 ? note : JSON.stringify({ modifiedFromFrozen: true });
  }
  return {
    name,
    status: "draft",
    executionMode: "shadow",
    ...composeResearchConfig(form, preset),
    venueBinding: composeVenue(form),
    poolPolicy: {
      mode: form.poolMode,
      eviction: {
        maxConsecutiveMissedDays: missedDays,
        hardEvictBelowMaDays: hardEvictMa,
        hardEvictMaxDrawdownPct: hardEvictDrawdown,
        maxPoolSize,
        maxWatchDays: null,
      },
    },
    schedule: composeSchedule(form),
    provenance,
  };
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-sub text-nc-text-3">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-nc-text-4">{hint}</span>}
    </div>
  );
}

function ChoiceField<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <select
        aria-label={label}
        className="h-9 w-full min-w-0 rounded-md border border-input bg-nc-field px-2 text-sm text-nc-text"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function NumberField({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        aria-label={label}
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function TextField({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2 rounded-lg border border-nc-border-soft bg-nc-inset p-3">
      <div>
        <h4 className="m-0 text-sm font-semibold text-nc-text">{title}</h4>
        {description && (
          <p className="m-0 mt-0.5 text-[11px] text-nc-text-4">{description}</p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </section>
  );
}

const cryptoIntervals: readonly { value: CryptoInterval; label: string }[] = [
  { value: 5, label: "每 5 分钟" },
  { value: 15, label: "每 15 分钟" },
  { value: 30, label: "每 30 分钟" },
  { value: 60, label: "每 1 小时" },
  { value: 240, label: "每 4 小时" },
  { value: 1440, label: "每日" },
];

const rpsPeriods: readonly { value: RpsPeriod; label: string }[] = [
  { value: 10, label: "RPS 10" },
  { value: 20, label: "RPS 20" },
  { value: 50, label: "RPS 50" },
  { value: 120, label: "RPS 120" },
];

const cryptoPeriods = [
  { value: "5m", label: "5 分钟" },
  { value: "15m", label: "15 分钟" },
  { value: "30m", label: "30 分钟" },
  { value: "1h", label: "1 小时" },
  { value: "4h", label: "4 小时" },
  { value: "day", label: "日线" },
] as const;

const chanProfiles = [
  { value: "first", label: "一类买点" },
  { value: "second", label: "二类买点" },
  { value: "third", label: "三类买点" },
  { value: "hold-cash", label: "无买点持币" },
] as const;

const cadenceOptions = [
  { value: "month-end", label: "月末调仓" },
  { value: "quarter-end", label: "季末调仓" },
] as const;

const etfPoolOptions = [
  { value: "full", label: "完整 ETF 池" },
  { value: "legacy-long-history", label: "长历史 ETF 池" },
  { value: "pair-only", label: "仅配对标的" },
] as const;

type DeployStrategyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultPreset?: DeployStrategyPreset;
  onDeployed?: (deploymentId: string) => void;
};

export function DeployStrategyDialog(props: DeployStrategyDialogProps) {
  return props.open ? <DeployStrategyForm {...props} /> : null;
}

function ThsMockVenueHint() {
  const meta = api.thsMockMeta.useQuery();
  const account = meta.data;
  const status = account?.marketCodes.length
    ? "已开户"
    : account?.hasAccount
      ? "开户待核验"
      : "未开户";
  return (
    <p className="self-end text-sub text-nc-text-3">
      {account
        ? `同花顺模拟${account.enabled ? "已开启" : "已关闭"} · ${status}。`
        : meta.isError
          ? "账户状态读取失败。"
          : "正在读取账户状态…"}{" "}
      <Link
        href="/accounts?tab=paper&channel=ths-mock"
        className="text-primary underline underline-offset-2"
      >
        前往配置同花顺模拟账户 →
      </Link>
    </p>
  );
}

function DeployStrategyForm({
  open,
  onOpenChange,
  defaultPreset,
  onDeployed,
}: DeployStrategyDialogProps) {
  const utils = api.useUtils();
  const notify = useWorkbenchNotify();
  const [preset] = useState(defaultPreset);
  const [initialForm] = useState(() => formFromPreset(preset));
  const [form, setForm] = useState(initialForm);
  const [archiveId] = useState(() => frozenArchiveId(preset?.provenance));
  const [initialFingerprint] = useState(() =>
    archiveId ? researchFingerprint(initialForm, preset) : null,
  );
  const modifiedFromFrozen =
    archiveId !== null &&
    form !== initialForm &&
    researchFingerprint(form, preset) !== initialFingerprint;
  const [error, setError] = useState("");
  const usesLocalAccount =
    form.market === "cn-equity" &&
    form.channel === "sim" &&
    form.cnSimVenue === "local_sim";
  const simAccounts = api.simAccountsList.useQuery(undefined, {
    enabled: usesLocalAccount,
  });
  const create = api.deploymentCreate.useMutation({
    onSuccess: (deployment) => {
      void utils.deploymentList.invalidate();
      if (!onDeployed) notify(`已创建「${deployment.name}」策略部署。`);
      onDeployed?.(deployment.id);
      onOpenChange(false);
    },
  });
  const patch = (next: Partial<FormState>) =>
    setForm((current) => ({ ...current, ...next }));

  const market = form.market;
  const venueKind: VenueBindingInput["kind"] =
    form.channel === "live"
      ? market === "crypto"
        ? "crypto_live"
        : "cn_broker_live"
      : market === "crypto"
        ? "crypto_sim"
        : form.cnSimVenue;
  const cnSimAccounts = (simAccounts.data ?? []).filter(
    (account) => account.status === "active" && account.market === "cn-equity",
  );
  const simAccountId =
    cnSimAccounts.find(({ id }) => id === form.simAccountId)?.id ??
    cnSimAccounts.find(({ name }) => name === "A股默认模拟账户")?.id ??
    cnSimAccounts[0]?.id ??
    "";
  const simAccountHint = simAccounts.isPending
    ? "正在读取模拟账户…"
    : simAccounts.error
      ? `模拟账户读取失败：${simAccounts.error.message}`
      : cnSimAccounts.length === 0
        ? "尚无启用的本地模拟账户，请先在账户页创建"
        : "默认选择活跃的本地模拟账户";

  const submit = () => {
    if (create.isPending) return;
    setError("");
    create.reset();
    try {
      create.mutate(
        composeInput(
          { ...form, simAccountId },
          preset,
          modifiedFromFrozen ? archiveId : null,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!create.isPending) onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={!create.isPending}
        className="max-h-[calc(100%-2rem)] lg:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Robot size={18} aria-hidden="true" />
            部署到策略运行台
          </DialogTitle>
          <DialogDescription>
            一键把策略、选股来源、监控池规则、风控与执行通道串成每日流水线。
            新部署默认进入空跑观察（只记录信号与订单意图，不发送委托）。
          </DialogDescription>
          {modifiedFromFrozen ? (
            <p role="status" className="text-sub text-nc-warn">
              已修改预设参数，本次部署不再绑定原冻结回测
            </p>
          ) : (
            preset?.description && (
              <p className="text-sub text-nc-text-3">{preset.description}</p>
            )
          )}
        </DialogHeader>

        <div className="space-y-3">
          <Section
            title="1. 策略与名称"
            description="策略决定信号口径；市场与交易通道必须匹配。"
          >
            <TextField
              label="策略名称"
              value={form.name}
              onChange={(name) => patch({ name })}
              placeholder="例如：双突破 · A 股每日"
            />
            <ChoiceField
              label="市场"
              value={form.market}
              options={marketOptions}
              onChange={(nextMarket) =>
                patch({
                  market: nextMarket,
                  channel: "sim",
                  strategyKind:
                    nextMarket === "crypto"
                      ? "crypto-dual-ma"
                      : "double-breakout",
                  universeKind:
                    nextMarket === "crypto" ? "fixed-symbols" : "watchlist",
                  fixedSymbols: "",
                  scheduleKind:
                    nextMarket === "crypto"
                      ? "crypto_interval"
                      : "post_close_auto",
                })
              }
            />
            <ChoiceField
              label="策略类型"
              value={form.strategyKind}
              options={strategyKindOptions.filter(
                ({ value }) =>
                  (value === "crypto-dual-ma") === (market === "crypto"),
              )}
              onChange={(strategyKind) => patch({ strategyKind })}
            />
            {form.strategyKind === "study-rule" && (
              <ChoiceField
                label="研究规则"
                value={form.studyStrategyId}
                options={studyOptions}
                onChange={(studyStrategyId) => patch({ studyStrategyId })}
              />
            )}
            {form.strategyKind === "theory-screener" && (
              <>
                <ChoiceField
                  label="选股器方法"
                  value={form.screenerMethodId}
                  options={screenerMethodOptions}
                  onChange={(screenerMethodId) => patch({ screenerMethodId })}
                />
                <NumberField
                  label="持有周期（bar）"
                  value={form.screenerHoldBars}
                  onChange={(screenerHoldBars) => patch({ screenerHoldBars })}
                  hint="默认 25 根日线"
                />
              </>
            )}
            {form.strategyKind === "etf-rotation" && (
              <ChoiceField
                label="ETF 轮动策略"
                value={form.etfStrategyId}
                options={etfOptions.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                onChange={(etfStrategyId) => patch({ etfStrategyId })}
              />
            )}
            {form.strategyKind === "macro-clock" && (
              <ChoiceField
                label="调仓节奏"
                value={form.macroCadence}
                options={cadenceOptions.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                onChange={(macroCadence) => patch({ macroCadence })}
              />
            )}
            {form.strategyKind === "pair-switch" && (
              <ChoiceField
                label="配对组合"
                value={form.pairId}
                options={pairOptions.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                onChange={(pairId) => patch({ pairId })}
              />
            )}
            {form.strategyKind === "value-pit" && (
              <ChoiceField
                label="价值策略"
                value={form.valueStrategyId}
                options={valueOptions}
                onChange={(valueStrategyId) => patch({ valueStrategyId })}
              />
            )}
            {form.strategyKind === "alpha-composite" && (
              <>
                <TextField
                  label="因子复合组合 ID"
                  value={form.alphaCompositeId}
                  onChange={(alphaCompositeId) => patch({ alphaCompositeId })}
                  placeholder="在 Alpha Lab 保存后得到的组合 ID"
                />
                <NumberField
                  label="因子持仓数（Top-N）"
                  value={form.alphaTopN}
                  onChange={(alphaTopN) => patch({ alphaTopN })}
                />
                <ChoiceField
                  label="调仓节奏"
                  value={form.alphaCadence}
                  options={[
                    { value: "daily", label: "每日" },
                    { value: "weekly", label: "每周" },
                    { value: "month-end", label: "月末" },
                  ]}
                  onChange={(alphaCadence) => patch({ alphaCadence })}
                />
              </>
            )}
            {form.strategyKind === "double-breakout" && (
              <NumberField
                label="量比下限（可选）"
                value={form.doubleBreakoutVolumeRatio}
                onChange={(doubleBreakoutVolumeRatio) =>
                  patch({ doubleBreakoutVolumeRatio })
                }
                placeholder="留空使用策略默认"
              />
            )}
            {form.strategyKind === "crypto-dual-ma" && (
              <>
                <NumberField
                  label="快线周期"
                  value={form.cryptoFast}
                  onChange={(cryptoFast) => patch({ cryptoFast })}
                />
                <NumberField
                  label="慢线周期"
                  value={form.cryptoSlow}
                  onChange={(cryptoSlow) => patch({ cryptoSlow })}
                />
                <ChoiceField
                  label="K 线周期"
                  value={form.cryptoPeriod}
                  options={cryptoPeriods.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  onChange={(cryptoPeriod) => patch({ cryptoPeriod })}
                />
              </>
            )}
            {form.strategyKind === "chan-native" && (
              <ChoiceField
                label="缠论买卖点"
                value={form.chanProfile}
                options={chanProfiles.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                onChange={(chanProfile) => patch({ chanProfile })}
              />
            )}
            {form.strategyKind === "formula" && (
              <>
                <TextField
                  label="公式名称"
                  value={form.formulaName}
                  onChange={(formulaName) => patch({ formulaName })}
                  placeholder="例如：my-breakout"
                />
                <TextField
                  label="公式源码"
                  value={form.formulaSource}
                  onChange={(formulaSource) => patch({ formulaSource })}
                  placeholder="通达信公式源码"
                />
              </>
            )}
          </Section>

          <Section
            title="2. 选股来源与监控池"
            description="持续累积模式会保留仍有效的在监标的，走坏才淘汰；每日全量同步会按当日选股结果替换监控池。"
          >
            <ChoiceField
              label="选股来源"
              value={form.universeKind}
              options={
                market === "crypto"
                  ? universeKindOptions.filter(
                      ({ value }) => value === "fixed-symbols",
                    )
                  : universeKindOptions
              }
              onChange={(universeKind) => patch({ universeKind })}
            />
            <ChoiceField
              label="监控池模式"
              value={form.poolMode}
              options={[
                { value: "accumulate", label: "持续累积 + 走坏淘汰" },
                { value: "replace", label: "每日全量同步替换" },
              ]}
              onChange={(poolMode) => patch({ poolMode })}
            />
            {form.universeKind === "fixed-symbols" && (
              <TextField
                label="固定标的代码"
                value={form.fixedSymbols}
                onChange={(fixedSymbols) => patch({ fixedSymbols })}
                placeholder="sh600000, sz000001"
              />
            )}
            {form.universeKind === "watchlist" && (
              <NumberField
                label="自选股容量上限"
                value={form.watchlistMaxSymbols}
                onChange={(watchlistMaxSymbols) =>
                  patch({ watchlistMaxSymbols })
                }
                hint="1–200，默认 50"
              />
            )}
            {form.universeKind === "etf-pool" && (
              <ChoiceField
                label="ETF 池"
                value={form.etfPool}
                options={etfPoolOptions.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                onChange={(etfPool) => patch({ etfPool })}
              />
            )}
            {form.universeKind === "rps-filter" && (
              <>
                <ChoiceField
                  label="RPS 周期"
                  value={String(form.rpsPeriod)}
                  options={rpsPeriods.map((option) => ({
                    value: String(option.value),
                    label: option.label,
                  }))}
                  onChange={(value) =>
                    patch({ rpsPeriod: Number(value) as RpsPeriod })
                  }
                />
                <NumberField
                  label="RPS 下限"
                  value={form.rpsMin}
                  onChange={(rpsMin) => patch({ rpsMin })}
                  hint="0–100"
                />
                <NumberField
                  label="选股数量上限"
                  value={form.rpsMaxSymbols}
                  onChange={(rpsMaxSymbols) => patch({ rpsMaxSymbols })}
                  hint="1–100"
                />
              </>
            )}
            {form.universeKind === "theory-screener-scan" && (
              <>
                <ChoiceField
                  label="扫描选股器"
                  value={form.scanMethodId}
                  options={screenerMethodOptions.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  onChange={(scanMethodId) => patch({ scanMethodId })}
                />
                <NumberField
                  label="选股数量上限"
                  value={form.scanMaxSymbols}
                  onChange={(scanMaxSymbols) => patch({ scanMaxSymbols })}
                  hint="1–100"
                />
              </>
            )}
            {form.universeKind === "value-pit-topn" && (
              <>
                <ChoiceField
                  label="价值策略"
                  value={form.valueStrategyId}
                  options={valueOptions}
                  onChange={(valueStrategyId) => patch({ valueStrategyId })}
                />
                <NumberField
                  label="Top-N"
                  value={form.valueTopK}
                  onChange={(valueTopK) => patch({ valueTopK })}
                  hint="1–50"
                />
              </>
            )}
            {form.universeKind === "formula-screen" && (
              <>
                <TextField
                  label="选股公式名称"
                  value={form.formulaScreenName}
                  onChange={(formulaScreenName) => patch({ formulaScreenName })}
                />
                <Field label="选股公式源码">
                  <Textarea
                    aria-label="选股公式源码"
                    value={form.formulaScreenSource}
                    onChange={(event) =>
                      patch({ formulaScreenSource: event.target.value })
                    }
                  />
                </Field>
                <TextField
                  label="选股公式参数（JSON，可选）"
                  value={form.formulaScreenParameters}
                  onChange={(formulaScreenParameters) =>
                    patch({ formulaScreenParameters })
                  }
                  placeholder={'{"N1":5,"N2":20}'}
                />
                <NumberField
                  label="选股数量上限"
                  value={form.formulaScreenMaxSymbols}
                  onChange={(formulaScreenMaxSymbols) =>
                    patch({ formulaScreenMaxSymbols })
                  }
                  hint="1–100"
                />
              </>
            )}
            <NumberField
              label="连续未命中宽限天数"
              value={form.missedDays}
              onChange={(missedDays) => patch({ missedDays })}
              hint="默认 5 天，0–60"
            />
            <NumberField
              label="跌破均线硬淘汰（日）"
              value={form.hardEvictMa}
              onChange={(hardEvictMa) => patch({ hardEvictMa })}
              placeholder="留空不启用，例如 20"
            />
            <NumberField
              label="入池回撤硬淘汰（%）"
              value={form.hardEvictDrawdown}
              onChange={(hardEvictDrawdown) => patch({ hardEvictDrawdown })}
              placeholder="留空不启用，例如 12"
            />
            <NumberField
              label="监控池容量上限"
              value={form.maxPoolSize}
              onChange={(maxPoolSize) => patch({ maxPoolSize })}
              hint="默认 50 只，1–500"
            />
          </Section>

          <Section
            title="3. 风控与市场门控"
            description="门控读取基准指数状态；风控在订单意图生成前拦截。"
          >
            <ChoiceField
              label="市场门控"
              value={form.gateKind}
              options={gateOptions.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              onChange={(gateKind) => patch({ gateKind })}
            />
            <TextField
              label="门控基准"
              value={form.gateBenchmark}
              onChange={(gateBenchmark) => patch({ gateBenchmark })}
              hint="默认 sh000300"
            />
            <NumberField
              label="解禁回避天数"
              value={form.gateUnlockDays}
              onChange={(gateUnlockDays) => patch({ gateUnlockDays })}
              hint="0–30，默认 10"
            />
            <NumberField
              label="单票上限（%）"
              value={form.maxSymbolWeight}
              onChange={(maxSymbolWeight) => patch({ maxSymbolWeight })}
              hint="默认 20"
            />
            <NumberField
              label="最大总仓位（%）"
              value={form.maxTotalExposure}
              onChange={(maxTotalExposure) => patch({ maxTotalExposure })}
              hint="默认 95"
            />
            <NumberField
              label="开盘跳空上限（%）"
              value={form.maxGap}
              onChange={(maxGap) => patch({ maxGap })}
              hint="0.5–20，默认 2"
            />
            <NumberField
              label="回撤暂停阈值（%）"
              value={form.drawdownPause}
              onChange={(drawdownPause) => patch({ drawdownPause })}
              hint="默认 8"
            />
          </Section>

          <Section
            title="4. 执行通道"
            description="模拟通道不连接真实券商；实盘通道仅登记账户与桥接地址，不含任何凭证明文。"
          >
            <ChoiceField
              label="通道类型"
              value={form.channel}
              options={[
                { value: "sim", label: "模拟通道" },
                { value: "live", label: "实盘通道（预留）" },
              ]}
              onChange={(channel) => patch({ channel })}
            />
            {form.channel === "sim" && market === "cn-equity" && (
              <>
                <ChoiceField
                  label="模拟通道"
                  value={form.cnSimVenue}
                  options={[
                    { value: "local_sim", label: "本地模拟盘" },
                    { value: "ths_mock", label: "同花顺模拟" },
                  ]}
                  onChange={(cnSimVenue) => patch({ cnSimVenue })}
                />
                {form.cnSimVenue === "local_sim" ? (
                  <ChoiceField
                    label="本地模拟账户"
                    hint={simAccountHint}
                    value={simAccountId}
                    options={cnSimAccounts.map((account) => ({
                      value: account.id,
                      label: account.name,
                    }))}
                    onChange={(simAccountId) => patch({ simAccountId })}
                  />
                ) : (
                  <ThsMockVenueHint />
                )}
              </>
            )}
            {form.channel === "sim" && market === "crypto" && (
              <>
                <ChoiceField
                  label="模拟交易所"
                  value={form.cryptoVenue}
                  options={cryptoVenueOptions.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  onChange={(cryptoVenue) =>
                    patch({
                      cryptoVenue,
                      cryptoAccountId: cryptoSimAccounts[cryptoVenue][0].value,
                    })
                  }
                />
                <ChoiceField
                  label="模拟账户 ID"
                  value={form.cryptoAccountId}
                  options={cryptoSimAccounts[form.cryptoVenue]}
                  onChange={(cryptoAccountId) => patch({ cryptoAccountId })}
                />
              </>
            )}
            {form.channel === "live" && market === "cn-equity" && (
              <>
                <ChoiceField
                  label="券商接入"
                  value={form.liveBroker}
                  options={brokerOptions.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  onChange={(liveBroker) => patch({ liveBroker })}
                />
                <TextField
                  label="实盘账户 ID"
                  value={form.liveAccountId}
                  onChange={(liveAccountId) => patch({ liveAccountId })}
                />
                <TextField
                  label={
                    form.liveBroker === "ths_live"
                      ? "桥接 URL"
                      : "桥接 URL（可选）"
                  }
                  value={form.liveEndpointUrl}
                  onChange={(liveEndpointUrl) => patch({ liveEndpointUrl })}
                  placeholder="https://127.0.0.1:8848"
                  hint="不得包含用户名、密码、查询参数或片段"
                />
                {form.liveBroker === "ths_live" && (
                  <p className="self-end text-sub text-nc-text-3">
                    请填写已登记的账户 ID 与桥接地址。{" "}
                    <Link
                      href="/accounts?tab=paper&channel=ths-live"
                      className="text-primary underline underline-offset-2"
                    >
                      前往管理同花顺实盘账户与 DPAPI 凭证 →
                    </Link>
                  </p>
                )}
              </>
            )}
            {form.channel === "live" && market === "crypto" && (
              <>
                <ChoiceField
                  label="实盘交易所"
                  value={form.cryptoLiveVenue}
                  options={cryptoVenueOptions.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  onChange={(cryptoLiveVenue) => patch({ cryptoLiveVenue })}
                />
                <TextField
                  label="实盘账户 ID"
                  value={form.cryptoLiveAccountId}
                  onChange={(cryptoLiveAccountId) =>
                    patch({ cryptoLiveAccountId })
                  }
                />
              </>
            )}
            <ChoiceField
              label="运行节奏"
              value={form.scheduleKind}
              options={
                market === "crypto"
                  ? [
                      { value: "crypto_interval", label: "按周期自动运行" },
                      { value: "manual_only", label: "仅手动运行" },
                    ]
                  : [
                      {
                        value: "post_close_auto",
                        label: "收盘后规划 + 开盘执行",
                      },
                      { value: "manual_only", label: "仅手动运行" },
                    ]
              }
              onChange={(scheduleKind) => patch({ scheduleKind })}
            />
            {form.scheduleKind === "crypto_interval" && (
              <ChoiceField
                label="运行间隔"
                value={String(form.cryptoInterval)}
                options={cryptoIntervals.map((option) => ({
                  value: String(option.value),
                  label: option.label,
                }))}
                onChange={(value) =>
                  patch({ cryptoInterval: Number(value) as CryptoInterval })
                }
              />
            )}
          </Section>

          <StateBanner state="info" title="部署后的默认状态" hideIcon>
            通道 {channelLabels[venueKind]} · 状态 草稿 · 执行模式 空跑观察。
            在「策略运行台」可切换为人工确认、自动模拟或自动实盘；
            实盘自动执行另需在运行台顶部单独开启实盘总开关。
          </StateBanner>

          {(error || create.error) && (
            <StateBanner state="error" title="无法创建部署">
              {error || create.error?.message}
            </StateBanner>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={create.isPending}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={
              create.isPending ||
              (usesLocalAccount && (simAccounts.isError || !simAccountId))
            }
            onClick={submit}
          >
            {create.isPending ? "正在创建…" : "创建部署"}
            <ArrowRight size={14} aria-hidden="true" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
