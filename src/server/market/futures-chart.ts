import { createHash } from "node:crypto";
import type { Period, Snapshot } from "~/lib/domain";
import type { ChartPeriod } from "~/lib/chart/chart-view";
import type { ChartSnapshot } from "~/lib/chart/chart-snapshot";
import type { Bar } from "~/lib/domain";
import {
  futuresContract,
  futuresContracts,
  futuresSourceLabels,
  type FuturesContract,
  type FuturesSource,
} from "~/lib/market/futures";
import {
  yahooFuturesKlines,
  yahooFuturesQuotes,
} from "../data-sources/yahoo/yahoo-futures";
import {
  eastmoneyFuturesKlines,
  eastmoneyFuturesQuotes,
  type FuturesQuote,
} from "../data-sources/eastmoney/eastmoney-futures";
import {
  sinaFuturesDaily,
  sinaFuturesQuotes,
} from "../data-sources/sina/sina-futures";

type Excluded = { date: string; reason: string }[];
type Klines = {
  version: string;
  source: string;
  sourceUrl: string;
  bars: Bar[];
  excluded: Excluded;
  formingDates: string[];
  historyExhausted: boolean;
  sourceNote: string;
};
type Attempt = {
  id: Exclude<FuturesSource, "auto">;
  name: string;
  applies: (c: FuturesContract, period: ChartPeriod) => boolean;
  load: (symbol: string, period: ChartPeriod, limit: number) => Promise<Klines>;
};

/**
 * Commodity futures bypass the A-share chain like crypto does: native
 * periods, no local aggregation, adjustment or calendar. Sources in order:
 * Yahoo (foreign contracts, via the outbound proxy), Eastmoney, then Sina
 * daily bars. A failed source is skipped for a while so later requests do not
 * wait on its direct/proxy timeouts again.
 */
const attempts: Attempt[] = [
  {
    id: "yahoo",
    name: "Yahoo",
    applies: (c) => !!c.yahoo,
    load: (symbol, period, limit) =>
      yahooFuturesKlines({ symbol, period, limit }),
  },
  {
    id: "eastmoney",
    name: "东方财富",
    applies: (c) => !!c.secid,
    load: async (symbol, period, limit) => ({
      ...(await eastmoneyFuturesKlines({ symbol, period, limit })),
      excluded: [],
      formingDates: [],
    }),
  },
  {
    id: "sina",
    name: "新浪",
    applies: (c, period) => !!c.sina && period === "day",
    load: async (symbol, _period, limit) => {
      const sina = await sinaFuturesDaily(symbol, limit);
      return {
        ...sina,
        formingDates: [],
        sourceNote: `${sina.version}；新浪日线（国内主连可能滞后一日，境外合约无成交量），未做换月调整`,
      };
    },
  },
];
const BACKOFF_MS = 5 * 60000;
const downUntil = new Map<string, { until: number; reason: string }>();

export async function futuresKlines(
  symbol: string,
  period: ChartPeriod,
  limit: number,
  pick: FuturesSource = "auto",
) {
  const contract = futuresContract(symbol);
  if (!contract) throw new Error("不支持的期货品种");
  // A manual pick runs only that source, with no backoff and no fallback.
  if (pick !== "auto") {
    const attempt = attempts.find((a) => a.id === pick)!;
    if (!attempt.applies(contract, period))
      throw new Error(
        `${futuresSourceLabels[pick]}不支持${contract.name}的该周期，请换数据源或选「自动」`,
      );
    const result = await attempt.load(symbol, period, limit);
    return { ...result, sourceErrors: [] as string[] };
  }
  const usable = attempts.filter((a) => a.applies(contract, period));
  const errors: string[] = [];
  for (const [index, attempt] of usable.entries()) {
    const down = downUntil.get(attempt.name);
    // Never skip the last usable source; a stale failure must not hide data.
    if (down && Date.now() < down.until && index < usable.length - 1) {
      errors.push(`${attempt.name}：近期不可用，已跳过（${down.reason}）`);
      continue;
    }
    try {
      const result = await attempt.load(symbol, period, limit);
      downUntil.delete(attempt.name);
      return {
        ...result,
        sourceNote: [result.sourceNote, ...errors].join("；"),
        sourceErrors: errors,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取失败";
      downUntil.set(attempt.name, {
        until: Date.now() + BACKOFF_MS,
        reason: message,
      });
      errors.push(`${attempt.name}：${message}`);
    }
  }
  throw new Error(
    errors.join("；") || "该周期没有可用数据源（新浪备用源只有日线）",
  );
}

const volumeUnit = "成交量单位 手（合约）；境外合约无成交额";

export async function futuresSnapshot(
  symbol: string,
  period: Period,
  pick: FuturesSource = "auto",
): Promise<Snapshot> {
  const result = await futuresKlines(symbol, period, 2000, pick);
  const hash = createHash("sha256")
    .update(JSON.stringify({ symbol, period, pick, bars: result.bars }))
    .digest("hex");
  return {
    id: `snapshot-futures-${hash}`,
    symbol,
    name: futuresContract(symbol)!.name,
    period,
    source: result.source,
    adjustment: "none",
    createdAt: Date.now(),
    bars: result.bars,
    hash,
    sourceUrl: result.sourceUrl,
    volumeUnit,
    sourceNote: result.sourceNote,
    sourceErrors: result.sourceErrors,
    sourceVersions: [result.version],
    futuresSource: pick,
  };
}

export async function futuresChartSnapshot(
  source: Snapshot,
  period: ChartPeriod,
  limit: number,
): Promise<ChartSnapshot> {
  const result = await futuresKlines(
    source.symbol,
    period,
    limit,
    source.futuresSource,
  );
  const hash = createHash("sha256")
    .update(
      JSON.stringify({ period, source: result.source, bars: result.bars }),
    )
    .digest("hex");
  return {
    ...source,
    period,
    adjustment: "none",
    source: result.source,
    sourceUrl: result.sourceUrl,
    volumeUnit,
    bars: result.bars,
    hash,
    createdAt: Date.now(),
    formingDates: result.formingDates,
    excluded: result.excluded,
    historyExhausted: result.historyExhausted,
    sourceNote: result.sourceNote,
    sourceErrors: result.sourceErrors,
    sourceVersions: [result.version],
    id: `chart-snapshot-${source.symbol}-${period}-${hash.slice(0, 20)}`,
  };
}

/**
 * Latest quotes: Yahoo for foreign contracts, plus one batched Eastmoney
 * request (Sina when it fails) for the rest and for any Yahoo miss.
 */
export async function futuresQuotes(): Promise<FuturesQuote[]> {
  const [yahoo, domestic] = await Promise.all([
    yahooFuturesQuotes(),
    eastmoneyFuturesQuotes().catch(() => sinaFuturesQuotes()),
  ]);
  return futuresContracts.map((c) => {
    const y = yahoo.find((q) => q.symbol === c.symbol);
    if (y && !y.error) return y as FuturesQuote;
    return (
      domestic.find((q) => q.symbol === c.symbol && !q.error) ?? {
        symbol: c.symbol,
        error: y?.error ?? "无报价",
      }
    );
  });
}
