import { realpathSync } from "node:fs";
import { relative } from "node:path";
import {
  compileFormula,
  type FormulaRpsPoint,
} from "trading-strategies/formula/tdx-formula";
import { rankRps, rpsPeriods } from "quant-rps";
import { completedBarFilter } from "~/lib/completed-bars";
import type { Bar } from "trading-strategy-core/bars";
import { forwardReturn } from "~/lib/research/factor-evaluation";
import {
  alphaBenchmarks,
  type AlphaExperiment,
  type AlphaPanel,
  type AlphaEvaluationInput,
} from "~/lib/research/alpha-experiment";
import {
  MarketPanelStore,
  type MarketPanelHandle,
  type MarketPanelSlice,
} from "../../market/market-panel";

export async function pinnedPanel(root: string, id?: string) {
  const store = new MarketPanelStore(root);
  // An unpinned request is for the full local market. The latest pointer can also
  // belong to an explicitly restricted symbol list or an older source generation.
  // build() reuses the verified snapshot when the full inventory is unchanged.
  if (!id) return store.build();
  const physicalRoot = realpathSync.native(root);
  const handle = store.open(id);
  if (relative(physicalRoot, handle.manifest.root) === "") return handle;
  handle.close();
  throw new Error("冻结面板来源与请求目录不一致");
}

const builtins: Record<
  string,
  { source: string; parameters: Record<string, number> }
> = {
  momentum: { source: "X:C/REF(C,N)-1;", parameters: { N: 20 } },
  reversal: { source: "X:1-C/REF(C,N);", parameters: { N: 5 } },
  volatility: { source: "X:STD(C/REF(C,1)-1,N);", parameters: { N: 20 } },
};
export function compileFactors(c: AlphaExperiment) {
  return c.factors.map((f) => {
    if (!f.formula && (f.factorId === "turnover" || f.factorId === "amount"))
      return f.factorId;
    const builtin = builtins[f.factorId];
    const program = compileFormula(f.formula ?? builtin!.source, {
      ...(f.formula ? {} : builtin!.parameters),
      ...f.parameters,
    });
    if (program.outputCount < 1) throw new Error("因子公式必须声明输出");
    return program;
  });
}
export function barAt(
  row: Pick<
    MarketPanelSlice,
    "openAtoms" | "highAtoms" | "lowAtoms" | "closeAtoms" | "amount" | "volume"
  >,
  i: number,
  date: string,
  scale: number,
  factor = 1,
): Bar {
  return {
    date,
    open: (row.openAtoms[i]! / scale) * factor,
    high: (row.highAtoms[i]! / scale) * factor,
    low: (row.lowAtoms[i]! / scale) * factor,
    close: (row.closeAtoms[i]! / scale) * factor,
    amount: row.amount[i]!,
    volume: row.volume[i]!,
  };
}
/** Transpose lossless panel fields; expand only one stock at a time to TDX bars. */
function formulaHistory(first: number, last: number) {
  const length = Math.max(0, last - first + 1);
  return {
    first,
    openAtoms: new Int32Array(length),
    highAtoms: new Int32Array(length),
    lowAtoms: new Int32Array(length),
    closeAtoms: new Int32Array(length),
    adjustment: new Float32Array(length),
    amount: new Float64Array(length),
    volume: new Float64Array(length),
  };
}

type FormulaStock = {
  series: { symbol: string };
  scale: number;
  history: ReturnType<typeof formulaHistory> | null;
};

function formulaRpsReturn(stock: FormulaStock, t: number, period: number) {
  const h = stock.history;
  if (!h) return NaN;
  const end = t - h.first,
    start = end - period;
  if (!(h.volume[end]! > 0 && h.volume[start]! > 0)) return NaN;
  return forwardReturn(
    (h.closeAtoms[start]! / stock.scale) * h.adjustment[start]!,
    (h.closeAtoms[end]! / stock.scale) * h.adjustment[end]!,
  );
}

function buildFormulaRps(
  stocks: readonly FormulaStock[],
  periods: readonly number[],
  last: number,
  onProgress?: (percent: number, phase: string) => void,
) {
  const counts = periods.map(() => new Uint32Array(last + 1));
  // Average one-based ranks are integers or half-integers, exact in Float32.
  const ranks = stocks.map((s) =>
    periods.map(() =>
      new Float32Array(s.history?.volume.length ?? 0).fill(NaN),
    ),
  );
  for (let t = periods[0]!; t <= last; t++) {
    if (t % 128 === 0)
      onProgress?.(40 + Math.floor((15 * t) / (last + 1)), "计算公式 RPS");
    for (const [p, period] of periods.entries()) {
      if (t < period) break;
      const eligible = stocks.flatMap((stock, j) => {
        const ret = formulaRpsReturn(stock, t, period);
        return Number.isFinite(ret)
          ? [{ symbol: stock.series.symbol, return: ret, j }]
          : [];
      });
      counts[p]![t] = eligible.length;
      const bySymbol = rankRps(eligible);
      for (const { symbol, j } of eligible)
        ranks[j]![p]![t - stocks[j]!.history!.first] =
          bySymbol.get(symbol)!.rank;
    }
  }
  return {
    point(
      j: number,
      stock: FormulaStock,
      date: string,
      t: number,
    ): FormulaRpsPoint {
      return {
        date,
        periods,
        values: periods.map((period, p) => {
          const rank = ranks[j]![p]![t - stock.history!.first]!;
          return Number.isFinite(rank)
            ? {
                return: formulaRpsReturn(stock, t, period),
                rank,
                rps: (1 - rank / counts[p]![t]!) * 100,
              }
            : null;
        }),
      };
    },
    release(j: number) {
      ranks[j] = [];
    },
  };
}

function fillTurnover(
  handle: MarketPanelHandle,
  symbol: string,
  days: readonly string[],
  volume: Float64Array,
  values: Float64Array,
) {
  // GBBQ is sorted by effective date. Its floatSharesAfter is already in shares,
  // as is daily volume. A later event cannot supply an earlier denominator.
  const events = handle.events(symbol, days.at(-1)!).flatMap((event) => {
    if (event.kind !== "gbbq") return [];
    const shares = event.raw.floatSharesAfter;
    return shares !== undefined && Number.isFinite(shares) && shares > 0
      ? [{ date: event.availableFrom, shares }]
      : [];
  });
  let cursor = 0;
  let shares: number | undefined;
  for (const [i, day] of days.entries()) {
    while (cursor < events.length && events[cursor]!.date <= day)
      shares = events[cursor++]!.shares;
    if (!Number.isFinite(values[i]) && volume[i]! > 0 && shares !== undefined)
      values[i] = volume[i]! / shares;
  }
}

const canonicalCalendarSymbols = [
  "sh000001",
  "sh000300",
  "sh000906",
  "sz399001",
] as const;

export function alphaPanelDates(
  handle: MarketPanelHandle,
  index?: string,
): readonly string[] {
  if (!index) return handle.manifest.dates;
  if (index === "index-union") {
    const merged = new Set<string>();
    for (const symbol of canonicalCalendarSymbols) {
      const entry = handle.manifest.symbols.find(
        (s) => s.kind === "index" && s.symbol === symbol,
      );
      if (!entry) continue;
      const row = handle.sliceSymbol(symbol, entry.firstDate, entry.lastDate);
      for (let i = 0; i < row.dates.length; i++) {
        if (row.closeAtoms[i]! > 0) merged.add(row.dates[i]!);
      }
    }
    if (!merged.size) throw new Error("冻结面板缺少可用的交易日历指数");
    return [...merged].sort();
  }
  const entry = handle.manifest.symbols.find(
    (s) => s.kind === "index" && s.symbol === index,
  );
  if (!entry) throw new Error("冻结面板缺少指定的交易日历指数 " + index);
  const row = handle.sliceSymbol(index, entry.firstDate, entry.lastDate);
  return row.dates.filter((_, i) => row.closeAtoms[i]! > 0);
}

export function loadAlphaPanel(
  h: MarketPanelHandle,
  input: AlphaEvaluationInput,
  c: AlphaExperiment,
  programs: ReturnType<typeof compileFactors>,
  now: number,
  onProgress?: (percent: number, phase: string) => void,
): AlphaPanel {
  const completed = completedBarFilter("day", now);
  const union = h.manifest.dates.filter(completed);
  const requestedDates = union.filter(
    (d) => d >= input.start && d <= input.end,
  );
  if (!requestedDates.length) throw new Error("面板无已收盘的评估交易日");
  let dates = union;
  let calendarIndex: AlphaPanel["calendarIndex"];
  const matchedIndices: (typeof canonicalCalendarSymbols)[number][] = [];
  const mergedIndexDates = new Set<string>();
  for (const index of canonicalCalendarSymbols) {
    if (
      !h.manifest.symbols.some((s) => s.kind === "index" && s.symbol === index)
    )
      continue;
    const sessions = alphaPanelDates(h, index).filter(completed);
    if (
      sessions.length > 0 &&
      sessions[0]! <= requestedDates[0]! &&
      sessions.at(-1)! >= requestedDates.at(-1)!
    ) {
      matchedIndices.push(index);
      for (const d of sessions) mergedIndexDates.add(d);
    }
  }
  if (matchedIndices.length === 1) {
    dates = [...mergedIndexDates].sort();
    calendarIndex = matchedIndices[0];
  } else if (matchedIndices.length > 1) {
    dates = [...mergedIndexDates].sort();
    calendarIndex = "index-union";
  }
  const first = dates.findIndex((d) => d >= input.start),
    after = dates.findIndex((d) => d > input.end),
    last = (after < 0 ? dates.length : after) - 1;
  if (first < 0 || last < first) throw new Error("面板无已收盘的评估交易日");
  // Recursive TDX formulas need the full observed prefix. Retain only the evaluation, IC training, liquidity and maturity windows.
  const start = Math.max(
      0,
      first - c.icirWindow - c.icirHorizon - c.liquidityWindow,
    ),
    end = Math.min(
      dates.length - 1,
      last + Math.max(...c.horizons, c.icirHorizon),
    );
  const calendar = dates.slice(start, end + 1),
    length = calendar.length;
  const absent = () => new Float64Array(length).fill(NaN);
  const indexCloses: Record<string, Float64Array> = {};
  const indices = h.manifest.symbols.flatMap((s, j) => {
    if (s.kind !== "index" || !alphaBenchmarks.some((b) => b.id === s.symbol))
      return [];
    const close = absent();
    indexCloses[s.symbol] = close;
    return [{ j, scale: s.priceScale, close }];
  });
  const directFields = programs.flatMap((p, k) =>
    typeof p === "string" ? [{ field: p, k }] : [],
  );
  const turnover = directFields.find(({ field }) => field === "turnover");
  const needsHistory = programs.some((p) => typeof p !== "string");
  // A stock's first or last record can fall outside the index calendar.
  let next = 0;
  const nextSession = new Map(
    h.manifest.dates.map((d) => {
      while (next < dates.length && dates[next]! < d) next++;
      return [d, next] as const;
    }),
  );
  const stocks = h.manifest.symbols.flatMap((s, j) => {
    if (s.kind !== "stock") return [];
    const first = nextSession.get(s.firstDate)!,
      tail = nextSession.get(s.lastDate)!,
      final = Math.min(last, dates[tail] === s.lastDate ? tail : tail - 1);
    const history = needsHistory ? formulaHistory(first, final) : null;
    const series = {
      symbol: s.symbol,
      previousTradingDays: 0,
      close: absent(),
      amount: absent(),
      volume: absent(),
      marketCap: new Float32Array(length).fill(NaN),
      industry: new Uint16Array(length),
      factors: programs.map(absent),
    };
    return [{ j, scale: s.priceScale, series, history }];
  });
  // Sequential cross-sections share MarketPanelHandle's verified 32-day chunk.
  // A per-symbol full-history scan would read and hash each multi-symbol tile repeatedly.
  for (let t = 0; t <= end; t++) {
    if (t % 128 === 0)
      onProgress?.(Math.floor((40 * t) / (end + 1)), "顺序读取不可变面板");
    const row = h.crossSection(dates[t]!),
      out = t - start;
    for (const { j, scale, close } of indices)
      if (out >= 0 && row.valid[j]) close[out] = row.closeAtoms[j]! / scale;
    for (const { j, scale, series, history } of stocks) {
      const vol = row.volume[j]!,
        amount = row.amount[j]!,
        adjust = row.adjFactor[j]!;
      if (out >= 0) {
        series.marketCap[out] = row.marketCap[j]!;
        series.industry[out] = row.industryCode[j]!;
        series.volume[out] = vol;
        series.amount[out] = amount;
        if (vol > 0) series.close[out] = (row.closeAtoms[j]! / scale) * adjust;
        for (const { k, field } of directFields)
          series.factors[k]![out] =
            field === "amount" ? amount : row.turnover[j]!;
      }
      if (!(vol > 0)) continue;
      if (out < 0) series.previousTradingDays++;
      if (!history || t > last) continue;
      const at = t - history.first;
      history.openAtoms[at] = row.openAtoms[j]!;
      history.highAtoms[at] = row.highAtoms[j]!;
      history.lowAtoms[at] = row.lowAtoms[j]!;
      history.closeAtoms[at] = row.closeAtoms[j]!;
      history.adjustment[at] = adjust;
      history.amount[at] = amount;
      history.volume[at] = vol;
    }
  }
  const periods = rpsPeriods.filter((period) => {
    const field = new RegExp(`\\bRPS${period}\\b`, "i");
    return c.factors.some(({ formula }) => formula && field.test(formula));
  });
  const formulaRps = periods.length
    ? buildFormulaRps(stocks, periods, last, onProgress)
    : null;
  const formulaProgress = formulaRps ? 55 : 40;
  for (const [j, stock] of stocks.entries()) {
    if (j % 32 === 0)
      onProgress?.(
        formulaProgress +
          Math.floor(((78 - formulaProgress) * j) / stocks.length),
        "计算股票因子",
      );
    if (turnover)
      fillTurnover(
        h,
        stock.series.symbol,
        calendar,
        stock.series.volume,
        stock.series.factors[turnover.k]!,
      );
    const history = stock.history;
    if (!history) continue;
    const bars: Bar[] = [],
      positions: number[] = [],
      rps: FormulaRpsPoint[] = [];
    for (let i = 0; i < history.volume.length; i++) {
      if (!(history.volume[i]! > 0)) continue;
      const t = history.first + i;
      bars.push(
        barAt(history, i, dates[t]!, stock.scale, history.adjustment[i]!),
      );
      positions.push(t - start);
      if (formulaRps) rps.push(formulaRps.point(j, stock, dates[t]!, t));
    }
    for (const [k, program] of programs.entries()) {
      if (typeof program === "string") continue;
      const values = program.evaluate(bars, rps).outputs[0]!.values;
      for (let i = 0; i < positions.length; i++)
        if (positions[i]! >= 0)
          stock.series.factors[k]![positions[i]!] = values[i] ?? NaN;
    }
    stock.history = null;
    formulaRps?.release(j);
  }
  const securities = stocks.map((s) => s.series);
  if (!securities.length) throw new Error("冻结面板不含股票");
  return {
    panelId: h.snapshotId,
    calendar,
    calendarIndex,
    calendarSource: calendarIndex ? "index" : "panel-union",
    securities,
    indexCloses,
  };
}
