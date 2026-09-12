import type Database from "better-sqlite3";
import { z } from "zod";
import type { Bar } from "~/lib/domain";
import { reviewTrades, type TradeReviewInput } from "~/lib/trade-review";
import { classifyCode } from "~/lib/delivery-import";
import {
  reviewTradeNav,
  type TradeReviewNavInput,
} from "~/lib/trade-review-nav";
import {
  reviewAttribution,
  type AttributionDimensions,
} from "~/lib/trade-review-attribution";
import { DeliveryStore, type ImportBatch } from "./delivery-store";
import {
  readTradeReviewSnapshot,
  type PriceScaleEvidence,
  type TradeReviewSnapshot,
} from "./trade-review-market";
import { readIndustryBlocks } from "./industry-blocks";
import { RpsStore } from "./rps-store";

const optionsSchema = z.object({
  account: z.string().trim().min(1),
  tdxRoot: z.string().default(""),
  blocksRoot: z.string().optional(),
  tradingDays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1),
  openingCash: z.number().finite().optional(),
  annualRiskFreeRate: z.number().finite().gt(-1).default(0.02),
  rpsPeriod: z.number().int().positive().default(250),
  benchmark: z.enum(["sh000300", "sh000001"]).default("sh000300"),
});
type Evidence = { source: string; key: string; hash: string };
export type TradeReviewReplayInput = {
  version: 1;
  account: string;
  trades: TradeReviewInput;
  nav: Omit<TradeReviewNavInput, "fills" | "cashFlows" | "bars">;
  dimensions: AttributionDimensions;
  batches: ImportBatch[];
  sources: Evidence[];
  warnings: string[];
  priceDiagnostics?: Record<string, PriceScaleEvidence>;
  rpsPeriod: number;
};
export type TradeReviewDependencies = {
  readSnapshot?: (
    root: string,
    symbol: string,
    period: "day",
  ) => Promise<TradeReviewSnapshot>;
  readBlocks?: typeof readIndustryBlocks;
  dimensions?: AttributionDimensions;
  subscriptions?: TradeReviewInput["subscriptions"];
  exRightsEvents?: TradeReviewInput["exRightsEvents"];
  flowValuations?: TradeReviewNavInput["flowValuations"];
};

/** Replay uses exported evidence only, never a live database or clock. */
export function replayTradeReview(input: TradeReviewReplayInput) {
  if (input.version !== 1) throw new Error("不支持的复盘版本");
  const trades = reviewTrades(input.trades);
  const nav = reviewTradeNav({
    ...input.nav,
    fills: input.trades.fills,
    cashFlows: input.trades.cashFlows ?? [],
    bars: input.trades.bars ?? {},
  });
  // R4 intentionally adopts statement balances. Independently retain the cash
  // path WITHOUT those anchors; discrepancies must never become invented flows.
  const projected = reviewTradeNav({
    ...input.nav,
    openingCash: nav.openingCash,
    fills: input.trades.fills.map((f) => ({ ...f, balanceCash: null })),
    cashFlows: input.trades.cashFlows ?? [],
    bars: input.trades.bars ?? {},
  });
  // Use R4's statement event order for reconciliation, including same-day rows.
  let cash: number | null = nav.openingCash;
  const residuals = nav.replay.flatMap((event) => {
    const f = input.trades.fills[event.originalOrder];
    if (!f) {
      const flow =
        input.trades.cashFlows?.[
          event.originalOrder - input.trades.fills.length
        ];
      cash =
        cash !== null && flow && Number.isFinite(flow.amount)
          ? cash + flow.amount
          : null;
      return flow?.balanceCash === null || flow?.balanceCash === undefined
        ? []
        : [
            {
              eventIndex: event.originalOrder,
              date: event.date,
              rowIndex: flow.rowIndex,
              statementCash: flow.balanceCash,
              projectedCash: cash,
              value: cash === null ? null : flow.balanceCash - cash,
              reason: cash === null ? "资金发生额缺失" : null,
            },
          ];
    }
    const out =
      f.instrument === "reverseRepo" ? f.kind === "sell" : f.kind === "buy";
    const delta =
      f.netAmount ??
      (f.fees.total === null
        ? null
        : (out ? -f.amount : f.amount) - f.fees.total);
    cash =
      cash !== null && delta !== null && Number.isFinite(delta)
        ? cash + delta
        : null;
    return f.balanceCash === null
      ? []
      : [
          {
            eventIndex: event.originalOrder,
            date: event.date,
            rowIndex: f.rowIndex,
            statementCash: f.balanceCash,
            projectedCash: cash,
            value: cash === null ? null : f.balanceCash - cash,
            reason: cash === null ? "资金发生额缺失" : null,
          },
        ];
  });
  const pendingRows = input.batches.flatMap((b) =>
    b.payload.unresolved.map((row) => ({ batchId: b.id, ...row })),
  );
  const missingMarketData = [
    ...new Set(
      input.trades.fills
        .filter((f) => f.instrument !== "reverseRepo")
        .map((f) => f.symbol ?? f.code),
    ),
  ]
    .sort()
    .flatMap((security) => {
      const points = trades.tradePoints.filter(
        (p) => p.security === security && p.dataReason,
      );
      const days = nav.days.filter(
        (d) =>
          d.positions[security] &&
          !input.trades.bars?.[security]?.some(
            (b) => b.date === d.date && Number.isFinite(b.close) && b.close > 0,
          ),
      );
      const noBars = !input.trades.bars?.[security]?.length;
      return noBars || points.length || days.length
        ? [
            {
              security,
              reason: "因缺行情无法分析",
              details: [
                ...new Set([
                  ...(input.priceDiagnostics?.[security]?.reason
                    ? [input.priceDiagnostics[security]!.reason!]
                    : []),
                  ...points.map((p) => p.dataReason!),
                  ...days.map((d) => `${d.date} 缺持仓日收盘价`),
                  ...(noBars ? ["缺日线"] : []),
                ]),
              ],
            },
          ]
        : [];
    });
  return {
    version: 1 as const,
    account: input.account,
    replayInput: input,
    basis: {
      attribution: "描述性分组，不声称因果，不等同因子分析",
      prices: "未复权；缺行情留空；除权证据未提供时为未知",
      rps: `买入日收盘RPS${input.rpsPeriod}，精确日期匹配；仅事后描述，不是买入时已知信号`,
      membership: "当前文件成分，不冒充买入日历史成分；组间样本可重叠",
      cash: `R4净值采用柜台余额；残差独立展示，不产生平账流水；推算现金不采用后续柜台余额；${nav.basis.reverseRepo}`,
      openingCash:
        input.nav.openingCash === undefined
          ? "沿用R4首笔余额反推，否则假设0；不是完整账本证明"
          : "调用方提供期初现金",
      costMethods: "移动加权与FIFO并列；openingUnknown收益留空",
    },
    trades,
    nav,
    projectedCashDays: projected.days.map((d) => ({
      date: d.date,
      cash: d.cash,
    })),
    attribution: {
      movingAverage: reviewAttribution(
        trades.movingAverage.closedRounds,
        input.dimensions,
      ),
      fifo: reviewAttribution(trades.fifo.closedRounds, input.dimensions),
    },
    reverseRepo: trades.reverseRepo,
    unexplainedCashResidual: residuals.at(-1) ?? {
      value: null,
      reason: "无柜台资金余额可核对",
    },
    cashResiduals: residuals,
    missingMarketData,
    priceDiagnostics: input.priceDiagnostics ?? {},
    pendingRows,
    excludedCashFlows: pendingRows.filter((r) =>
      r.reason.includes("失败/作废"),
    ),
    exceptions: trades.exceptions,
    warnings: input.warnings,
  };
}

export async function buildTradeReviewSnapshot(
  options: unknown,
  db: Database.Database,
  dependencies: TradeReviewDependencies = {},
) {
  const o = optionsSchema.parse(options);
  const store = new DeliveryStore(db);
  const ledger = db.transaction(() => ({
    fills: store.fills(o.account),
    cashFlows: store.cashFlows(o.account),
    batches: store.batches().filter((b) => b.account === o.account),
  }))();
  const bars: Record<string, Bar[]> = {};
  const sources: Evidence[] = [];
  const warnings: string[] = [];
  const priceDiagnostics: Record<string, PriceScaleEvidence> = {};
  const reader = dependencies.readSnapshot ?? readTradeReviewSnapshot;
  let benchmark: Bar[] | undefined;
  for (const security of [
    ...new Set([
      ...ledger.fills
        .filter((f) => f.instrument !== "reverseRepo")
        .map((f) => f.symbol ?? f.code),
      o.benchmark,
    ]),
  ].sort()) {
    try {
      const snapshot = await reader(o.tdxRoot, security, "day");
      sources.push({
        source: snapshot.source,
        key: security,
        hash: snapshot.hash,
      });
      if (snapshot.priceScale) {
        const evidence = { ...snapshot.priceScale };
        const kind = classifyCode(security);
        if (kind.instrument === "convertible") {
          // R12 local .day price units: Shanghai per hand, Shenzhen per bond.
          // Confirm statement quantities independently using gross amount, never
          // fees/net proceeds. Do not silently multiply ambiguous quantities.
          const factor = kind.market === "sh" ? 10 : 1;
          const fills = ledger.fills.filter(
            (f) => (f.symbol ?? f.code) === security,
          );
          if (
            fills.some((f) => {
              const expected = f.price * f.quantity * factor;
              return (
                !(expected > 0) ||
                !Number.isFinite(expected) ||
                Math.abs(f.amount - expected) > Math.max(0.05, expected * 0.005)
              );
            })
          ) {
            evidence.trusted = false;
            evidence.reason = `价格口径不可信：可转债数量单位无法确认（${evidence.priceUnit}；成交金额与数量×成交价×${factor}不符）`;
          }
        }
        priceDiagnostics[security] = evidence;
        warnings.push(
          `${security}：价格除数 ${evidence.divisor}；${evidence.priceUnit}；校验 ${evidence.checkedBars} 根；最大均价偏离 ${evidence.maxDeviation ?? "无有效依据"} 倍${evidence.reason ? `；${evidence.reason}` : ""}`,
        );
        if (!evidence.trusted) continue;
      }
      bars[security] = snapshot.bars;
      if (security === o.benchmark) benchmark = snapshot.bars;
    } catch {
      warnings.push(`${security}：日线不可用`);
    }
  }
  const dimensions: AttributionDimensions = { ...dependencies.dimensions };
  for (const category of ["industry", "concept"] as const) {
    const field = category === "industry" ? "industries" : "concepts";
    if (dimensions[field] !== undefined || !o.blocksRoot) continue;
    try {
      const blocks = await (dependencies.readBlocks ?? readIndustryBlocks)(
        o.blocksRoot,
        undefined,
        category,
      );
      const mapping: Record<string, string[]> = {};
      for (const file of blocks.files) {
        sources.push({ source: category, key: file.file, hash: file.hash });
        for (const member of file.members)
          (mapping[member] ??= []).push(file.name);
      }
      dimensions[field] = mapping;
    } catch {
      warnings.push(`${category}：成分不可用，归入未知`);
    }
  }
  if (dimensions.rps === undefined) {
    const rps: Record<string, Record<string, number | null>> = {};
    const rpsStore = new RpsStore(db);
    for (const security of [
      ...new Set(ledger.fills.map((f) => f.symbol ?? f.code)),
    ].sort()) {
      try {
        rps[security] = {};
        for (const day of rpsStore.curve(security)) {
          if (
            !ledger.fills.some(
              (f) =>
                (f.symbol ?? f.code) === security && f.tradeDate === day.date,
            )
          )
            continue;
          rps[security]![day.date] =
            day.values[day.periods.indexOf(o.rpsPeriod)]?.rps ?? null;
          sources.push({
            source: "rps_values",
            key: `${security}/${day.date}/${o.rpsPeriod}`,
            hash: day.inputHash,
          });
        }
      } catch {
        warnings.push(`${security}：RPS不可用，归入未知`);
        delete rps[security];
      }
    }
    dimensions.rps = rps;
  }
  return replayTradeReview({
    version: 1,
    account: o.account,
    trades: {
      fills: ledger.fills,
      cashFlows: ledger.cashFlows,
      bars,
      tradingDays: o.tradingDays,
      subscriptions: dependencies.subscriptions,
      exRightsEvents: dependencies.exRightsEvents,
    },
    nav: {
      tradingDays: o.tradingDays,
      openingCash: o.openingCash,
      annualRiskFreeRate: o.annualRiskFreeRate,
      benchmark,
      flowValuations: dependencies.flowValuations,
    },
    dimensions,
    batches: ledger.batches,
    sources,
    warnings,
    priceDiagnostics,
    rpsPeriod: o.rpsPeriod,
  });
}

export function exportTradeReview(
  snapshot: ReturnType<typeof replayTradeReview>,
) {
  return JSON.stringify(snapshot, null, 2);
}

/** U3: sort the complete set before slicing; never mutate export evidence. */
export function pageTradeReviewDrawdowns(
  segments: ReturnType<typeof reviewTradeNav>["segments"],
  input: {
    pageIndex: number;
    pageSize: number;
    sort:
      | "peakDate"
      | "troughDate"
      | "recoveryDate"
      | "drawdown"
      | "drawdownTradingDays"
      | "recoveryTradingDays"
      | "underwaterTradingDays";
    desc: boolean;
  },
) {
  const rows = segments
    .flatMap((segment, segmentIndex) =>
      segment.drawdowns.map((row) => ({
        ...row,
        basis: segment.wbtStats.basis,
        segmentStart: segment.start,
        segmentEnd: segment.end,
        id: `${segmentIndex}:${row.peakDate}`,
      })),
    )
    .sort((a, b) => {
      const status = Number(a.recovered) - Number(b.recovered);
      if (status) return status;
      const x = a[input.sort],
        y = b[input.sort];
      if (x === null || y === null) {
        if (x !== y) return x === null ? 1 : -1;
      } else {
        const order =
          typeof x === "number" && typeof y === "number"
            ? x - y
            : String(x).localeCompare(String(y));
        if (order) return input.desc ? -order : order;
      }
      return a.peakDate.localeCompare(b.peakDate) || a.id.localeCompare(b.id);
    });
  return {
    // U3 §1 says export-only, but the old UI received nested full arrays.
    // Remove them from the page projection; export retains the source snapshot.
    segments: segments.map(({ drawdowns: _drawdowns, ...segment }) => segment),
    drawdowns: rows.slice(
      input.pageIndex * input.pageSize,
      (input.pageIndex + 1) * input.pageSize,
    ),
    drawdownCount: rows.length,
  };
}
