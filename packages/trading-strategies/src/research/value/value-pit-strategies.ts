import { dailyBarEpoch } from "../../theory-input.js";

export type ValuePitCandidate = {
  symbol: string;
  asOf: string;
  availableAt: string;
  isFinancial?: boolean;
  price: number | null;
  marketCap: number | null;
  enterpriseValue: number | null;
  ebit: number | null;
  investedCapital: number | null;
  peTtm: number | null;
  netProfitGrowthYoY: number | null;
  operatingCashFlow: number | null;
  netIncome: number | null;
  roa: number | null;
  priorRoa: number | null;
  cfoToAssets: number | null;
  leverage: number | null;
  priorLeverage: number | null;
  currentRatio: number | null;
  priorCurrentRatio: number | null;
  grossMargin: number | null;
  priorGrossMargin: number | null;
  assetTurnover: number | null;
  priorAssetTurnover: number | null;
  /** Realized cash per share over the trailing year, through the snapshot ex-date cutoff. */
  ttmCashDividendPerShare: number | null;
  volatility60d: number | null;
};

type Factor = { symbol: string; first: number; second: number };
type Ranked = { symbol: string; score: number; tie: number };
const finite = (n: number | null): n is number =>
  n !== null && Number.isFinite(n);
const positive = (n: number | null): n is number => finite(n) && n > 0;

/** Stable byte passes order IEEE-754 keys in linear time. Keys may be signed. */
function numericOrder<T>(rows: readonly T[], key: (row: T) => number): T[] {
  if (rows.length < 32) return [...rows].sort((a, b) => key(a) - key(b));
  const view = new DataView(new ArrayBuffer(8));
  let keyed = rows.map((row) => {
    const value = key(row);
    view.setFloat64(0, value === 0 ? 0 : value); // Give -0 and +0 the same rank.
    const hi = view.getUint32(0),
      lo = view.getUint32(4);
    const negative = hi >= 0x80000000;
    return {
      row,
      hi: negative ? ~hi : hi ^ 0x80000000,
      lo: negative ? ~lo : lo,
    };
  });
  for (let pass = 0; pass < 8; pass++) {
    const buckets: (typeof keyed)[] = Array.from({ length: 256 }, () => []);
    for (const item of keyed) {
      const word = pass < 4 ? item.lo : item.hi;
      buckets[(word >>> (8 * (pass % 4))) & 255]!.push(item);
    }
    keyed = buckets.flat();
  }
  return keyed.map((item) => item.row);
}

/** @internal Shared by the pool and PIT rankers. Numeric keys run from most to least significant. */
export function orderCrossSection<T extends { symbol: string }>(
  input: readonly T[],
  ...keys: ((row: T) => number)[]
): T[] {
  const compare = (a: T, b: T) => a.symbol.localeCompare(b.symbol);
  let rows = [...input];
  // Exchange tickers are short ASCII keys. Each position has a bounded alphabet.
  // Verify the result against the caller's collation for nonstandard symbol labels.
  if (
    rows.length >= 32 &&
    rows.every((r) => /^[a-z0-9]{1,16}$/i.test(r.symbol))
  ) {
    const width = rows.reduce((n, r) => Math.max(n, r.symbol.length), 0);
    for (let i = width - 1; i >= 0; i--) {
      const buckets = new Map<string, T[]>();
      for (const row of rows) {
        const ch = row.symbol[i] ?? "";
        const bucket = buckets.get(ch);
        if (bucket) bucket.push(row);
        else buckets.set(ch, [row]);
      }
      rows = [...buckets.keys()]
        .sort((a, b) => a.localeCompare(b))
        .flatMap((ch) => buckets.get(ch)!);
    }
    if (rows.some((r, i) => i > 0 && compare(rows[i - 1]!, r) > 0))
      rows.sort(compare);
  } else rows.sort(compare);
  for (let i = keys.length - 1; i >= 0; i--)
    rows = numericOrder(rows, keys[i]!);
  return rows;
}

/** Use competition ranks (1,1,3). Tied factors contribute the same rank. */
function combinedRanks(factors: Factor[]): Ranked[] {
  const totals = new Map<string, number>();
  for (const field of ["first", "second"] as const) {
    const sorted = numericOrder(factors, (row) => row[field]);
    let rank = 0;
    sorted.forEach((row, i) => {
      if (!i || row[field] !== sorted[i - 1]![field]) rank = i + 1;
      totals.set(row.symbol, (totals.get(row.symbol) ?? 0) + rank);
    });
  }
  return factors.map(({ symbol }) => ({
    symbol,
    score: totals.get(symbol)!,
    tie: 0,
  }));
}

/** Pick the latest visible snapshot, then its latest visible vintage. Ambiguous
 * duplicate vintages fail closed. A future revision cannot hide a usable row. */
function rankPit(
  candidates: readonly ValuePitCandidate[],
  asOf: string,
  topK: number,
  strategyId: string,
  disclosure: string,
  factors: (c: ValuePitCandidate) => [number, number] | null,
  method: "combined" | "highest" | "lowest",
) {
  const symbols = new Set(candidates.map((c) => c.symbol));
  const visible = new Map<
    string,
    { row: ValuePitCandidate; ambiguous: boolean }
  >();
  if (dailyBarEpoch(asOf) !== null) {
    for (const row of candidates) {
      if (
        !row.symbol ||
        row.asOf > asOf ||
        row.availableAt > asOf ||
        dailyBarEpoch(row.asOf) === null ||
        dailyBarEpoch(row.availableAt) === null
      )
        continue;
      const prev = visible.get(row.symbol);
      if (
        !prev ||
        row.asOf > prev.row.asOf ||
        (row.asOf === prev.row.asOf && row.availableAt > prev.row.availableAt)
      )
        visible.set(row.symbol, { row, ambiguous: false });
      else if (
        row.asOf === prev.row.asOf &&
        row.availableAt === prev.row.availableAt
      )
        prev.ambiguous = true;
    }
  }
  const eligible: Factor[] = [];
  for (const [symbol, { row, ambiguous }] of visible) {
    const values = ambiguous ? null : factors(row);
    if (!values || !values.every(Number.isFinite)) continue;
    symbols.delete(symbol);
    eligible.push({ symbol, first: values[0], second: values[1] });
  }
  const ranked =
    method === "combined"
      ? combinedRanks(eligible)
      : eligible.map(({ symbol, first, second }) => ({
          symbol,
          score: first,
          tie: second,
        }));
  const sorted = orderCrossSection(
    ranked,
    (r) => (method === "highest" ? -r.score : r.score),
    (r) => -r.tie,
  );
  const selected = sorted.slice(
    0,
    Number.isSafeInteger(topK) && topK >= 0 ? topK : 0,
  );
  return {
    strategyId,
    asOf,
    weights: Object.fromEntries(
      selected.map((r) => [r.symbol, 1 / selected.length]),
    ) as Record<string, number>,
    scores: Object.fromEntries(
      sorted.map((r) => [r.symbol, r.score]),
    ) as Record<string, number>,
    excluded: orderCrossSection([...symbols].map((symbol) => ({ symbol }))).map(
      (r) => r.symbol,
    ),
    disclosure,
  };
}

export function rankMagicFormulaPit(
  candidates: readonly ValuePitCandidate[],
  asOf: string,
  topK = 10,
) {
  return rankPit(
    candidates,
    asOf,
    topK,
    "value-magic-formula-pit",
    "非金融股 EBIT/企业价值与 EBIT/投入资本的降序名次和，分数越小越优。",
    (c) => {
      if (
        c.isFinancial !== false ||
        !positive(c.ebit) ||
        !positive(c.enterpriseValue) ||
        !positive(c.investedCapital)
      )
        return null;
      return [-c.ebit / c.enterpriseValue, -c.ebit / c.investedCapital];
    },
    "combined",
  );
}

export function rankFScoreLocal8Pit(
  candidates: readonly ValuePitCandidate[],
  asOf: string,
  { minScore = 6, topK = 10 }: { minScore?: number; topK?: number } = {},
) {
  return rankPit(
    candidates,
    asOf,
    topK,
    "value-fscore-local8-pit",
    "本地财报 8 分制 F-Score，缺少发行事件证据，第 9 项股权发行指标不计入。",
    (c) => {
      const {
        roa,
        priorRoa,
        cfoToAssets,
        leverage,
        priorLeverage,
        currentRatio,
        priorCurrentRatio,
        grossMargin,
        priorGrossMargin,
        assetTurnover,
        priorAssetTurnover,
      } = c;
      if (
        !finite(roa) ||
        !finite(priorRoa) ||
        !finite(cfoToAssets) ||
        !finite(leverage) ||
        !finite(priorLeverage) ||
        !finite(currentRatio) ||
        !finite(priorCurrentRatio) ||
        !finite(grossMargin) ||
        !finite(priorGrossMargin) ||
        !finite(assetTurnover) ||
        !finite(priorAssetTurnover)
      )
        return null;
      const score = [
        roa > 0,
        cfoToAssets > 0,
        roa > priorRoa,
        cfoToAssets > roa,
        leverage < priorLeverage,
        currentRatio > priorCurrentRatio,
        grossMargin > priorGrossMargin,
        assetTurnover > priorAssetTurnover,
      ].filter(Boolean).length;
      return score >= minScore ? [score, cfoToAssets] : null;
    },
    "highest",
  );
}

export function rankDividendLowVolPit(
  candidates: readonly ValuePitCandidate[],
  asOf: string,
  topK = 10,
) {
  return rankPit(
    candidates,
    asOf,
    topK,
    "value-dividend-lowvol-pit",
    "近 12 个月已除息现金股息率降序、60 日波动率升序的名次和，要求经营现金流为正。",
    (c) => {
      if (
        !positive(c.price) ||
        !positive(c.ttmCashDividendPerShare) ||
        !positive(c.volatility60d) ||
        !positive(c.operatingCashFlow)
      )
        return null;
      return [-c.ttmCashDividendPerShare / c.price, c.volatility60d];
    },
    "combined",
  );
}

export function rankGarpPit(
  candidates: readonly ValuePitCandidate[],
  asOf: string,
  topK = 10,
) {
  return rankPit(
    candidates,
    asOf,
    topK,
    "value-garp-pit",
    "PEG 使用决策日可见的历史盈利增速代理，未采用分析师前瞻一致预期。",
    (c) => {
      if (
        !positive(c.peTtm) ||
        c.peTtm > 40 ||
        !positive(c.netProfitGrowthYoY) ||
        c.netProfitGrowthYoY <= 0.1 ||
        c.netProfitGrowthYoY > 1.5 ||
        !positive(c.operatingCashFlow) ||
        !positive(c.netIncome)
      )
        return null;
      const coverage = c.operatingCashFlow / c.netIncome;
      return Number.isFinite(coverage) && coverage >= 0.7
        ? [c.peTtm / (c.netProfitGrowthYoY * 100), 0]
        : null;
    },
    "lowest",
  );
}
