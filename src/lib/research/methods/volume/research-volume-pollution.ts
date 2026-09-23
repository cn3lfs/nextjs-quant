import type { Bar } from "../../../domain";
export const volumePollutionProfiles = {
  "vp-limit-book": ["VP-limit-orderbook", "一字板封单与开板替代"],
  "vp-limit-reseal-path": ["VP-limit-reseal", "换手回封与一字后续"],
  "vp-limit-roundtrip-half": ["VP-limit-roundtrip", "天地地天极端情绪半仓"],
  "vp-limit-stages": ["VP-limit-sequence", "首板中继加速节奏"],
  "vp-limit-wick-exit": ["VP-limit-failed-wick", "炸板放量长上影退出"],
  "vp-settlement-evidence": ["VP-settlement-by-market", "历史品种结算准入"],
  "vp-block-clean": ["VP-block-volume-remove", "核实大宗过户后扣除"],
  "vp-auction-exclude": ["VP-index-etf-auction", "指数申赎尾盘污染排除"],
  "vp-ipo-own": ["VP-ipo-own-history", "上市60日内自身均量半仓"],
  "vp-resumption-normal": ["VP-resumption-calendar", "复牌首周隔离后正常化"],
  "vp-order-shape-risk": ["VP-fake-order-shape", "规整挂单滞涨过滤"],
  "vp-trade-size-risk": ["VP-fake-trade-size", "笔均量异常过滤"],
  "vp-isolated-news-confirm": ["VP-isolated-news", "孤量消息和次日延续确认"],
  "vp-event-lhb-filter": ["VP-event-lhb", "可得龙虎榜短期风险过滤"],
  "vp-event-unlock-filter": ["VP-event-unlock", "解禁首日供给冲击过滤"],
  "vp-event-merger-half": ["VP-event-merger", "重组窗口形态半仓"],
  "vp-event-index-filter": ["VP-event-index", "纳入剔除一次性量能过滤"],
  "vp-event-seasonal-filter": ["VP-event-seasonal", "季末最后三交易日量能过滤"],
  "vp-pollution-six": ["VP-pollution-sequence", "六步失真排查组合"],
} as const;
export type VolumePollutionId = keyof typeof volumePollutionProfiles;
export const volumePollutionIds = Object.keys(
  volumePollutionProfiles,
) as VolumePollutionId[];
export function isVolumePollution(id: string): id is VolumePollutionId {
  return Object.hasOwn(volumePollutionProfiles, id);
}
export const volumePollutionBoundary =
  "量能失真工程v1，共用涨幅>2%且当量/前5根均量≥1.5买、跌幅<-2%卖；各具名过滤单独对照，连续成立只首日入场，退出优先。证据按研究日15:00已知时点过滤，盘后龙虎榜必须下一日才可用；事件完整覆盖空数组才等于无事件。盘口逐次涨跌停价序列必须覆盖交易时段、封单份额/实际量/开板数，替代量能：封单量≥实际量且零开板的一字涨停才给观察买信号，成交仍下一合法开盘；一字跌停退出；回封需真实开板再封，天地/地天各按路径识别并半仓；首板≥1.5倍、中继换手[3,15]%并回封、至少第三板加速<1倍且封单≥量。炸板放量且上影≥全幅40%退出。结算仅沪深股票/境内股票ETF的有来源T+1可执行，T+0/指数/外部市场明确不适用；不修改现有T+1账本。大宗输入核实已含统计且量额扣除配平，对前5根及当日全段扣除后重判；未包含统计不重复减。指数申赎再平衡事件且14:57-15:00量占比≥50%禁入。IPO仅完整上市以来1至59个历史交易日均量，至少一个历史日，半仓且不用普通换手/60日极值。复牌前停牌至少5交易日，首5个交易日禁入，第6日起当量≤停前20有效日均量2倍才恢复。规整挂单比例≥80%且价变幅≤1%和量比≥1.5过滤；笔均量≥此前5日笔均量3倍且价变幅≤1%过滤，均只是风险假设。孤量候选前量<0.8倍、候选≥2.5倍；次日收盘不低于候选且量≥候选日前5均量并有完整消息覆盖/已验证催化才确认，异常量来源必须排除。龙虎榜游资事件披露后两交易日禁入；解禁生效日且流通股数增加/量增禁入；重组公告后五交易日半仓；指数纳入与剔除生效日均禁入并保留方向；季末最后三交易日且量比≥1.5禁入。六步严格按盘口、股本、过户尾盘、上市复牌、孤量盘口、常规顺序，任一必要证据缺失不可用；股本影响走历史换手归一，不能填默认false。盘中证据限2000-01-04至2022-11-30；收盘研究下一开盘执行，非真实历史接入或业绩。";
export function volumePollutionDefinition(id: VolumePollutionId) {
  return {
    label: `量价 · ${volumePollutionProfiles[id][1]}`,
    family: "量价失真排查",
    signal: "technical" as const,
    version: `${id}-engineering-1`,
    sources: [
      "volume-price-analysis/references/vp-astock-caveats.md",
      "volume-price-analysis/references/vp-indicators.md",
    ],
    description: volumePollutionBoundary,
  };
}
export type PollutionEvidence = {
  date: string;
  availableAt: string;
  source: string;
  limit?: {
    up: number;
    down: number;
    path: { at: string; price: number }[];
    complete: boolean;
    openCount: number;
    sealShares: number;
    volumeShares: number;
    boards: number;
    turnover: number;
  };
  settlement?: {
    kind: "stock" | "stock-etf" | "index";
    market: "sh" | "sz" | "other";
    days: 0 | 1;
    source: string;
  };
  block?: {
    complete: boolean;
    included: boolean;
    shares: number;
    amount: number;
    totalShares: number;
    totalAmount: number;
    scope: string;
  };
  auction?: {
    complete: boolean;
    last3Shares: number;
    totalShares: number;
    indexRebalance: boolean;
    etfCreation: boolean;
  };
  listing?: { date: string; tradingDates: string[]; complete: boolean };
  resumption?: {
    complete: boolean;
    date: string | null;
    suspendedSessions: number;
    sessionsSince: number;
    beforeVolumes: number[];
  };
  orders?: { complete: boolean; regularFraction: number };
  trades?: { count: number; volumeShares: number };
  news?: {
    complete: boolean;
    catalystVerified: boolean;
    volumeAuthentic: boolean;
  };
  events?: {
    complete: boolean;
    items: {
      kind: "lhb" | "unlock" | "merger" | "index-in" | "index-out";
      availableAt: string;
      effectiveDate: string;
      ageSessions: number;
      speculative?: boolean;
      oldFloat?: number;
      newFloat?: number;
    }[];
  };
  seasonal?: { complete: boolean; quarterEndDistance: number };
  float?: { complete: boolean; shares: number; volumeShares: number };
};
const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;
const nonnegative = (n: unknown): n is number => finite(n) && n >= 0;
const valid = (b: Bar) =>
  [b.open, b.high, b.low, b.close, b.volume].every(positive) &&
  b.high >= Math.max(b.open, b.close) &&
  b.low <= Math.min(b.open, b.close);
const timestamp = (s: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(s) &&
  Number.isFinite(Date.parse(s));
export function pollutionEvidenceAt(
  rows: readonly PollutionEvidence[],
  date: string,
) {
  const selected = rows.filter((e) => e.date === date);
  const e = selected.length === 1 ? selected[0] : undefined;
  return e &&
    e.source.trim() &&
    timestamp(e.availableAt) &&
    e.availableAt <= `${date}T15:00:00+08:00`
    ? e
    : undefined;
}
export function pollutionLimitState(
  e: PollutionEvidence | undefined,
  date: string,
) {
  const l = e?.limit;
  if (
    date < "2000-01-04" ||
    date > "2022-11-30" ||
    !l?.complete ||
    !positive(l.up) ||
    !positive(l.down) ||
    l.up <= l.down ||
    !nonnegative(l.sealShares) ||
    !positive(l.volumeShares) ||
    !Number.isInteger(l.openCount) ||
    l.openCount < 0 ||
    !Number.isInteger(l.boards) ||
    l.boards < 0 ||
    !nonnegative(l.turnover) ||
    l.path.length < 2 ||
    l.path.some(
      (p, i) =>
        !timestamp(p.at) ||
        !p.at.startsWith(date) ||
        p.at > `${date}T15:00:00+08:00` ||
        p.at < `${date}T09:30:00+08:00` ||
        !positive(p.price) ||
        p.price > l.up ||
        p.price < l.down ||
        (i > 0 && p.at <= l.path[i - 1]!.at),
    )
  )
    return null;
  const prices = l.path.map((p) => p.price);
  let openings = 0;
  for (let j = 1; j < prices.length; j++)
    if (prices[j - 1] === l.up && prices[j] !== l.up) openings++;
  if (
    openings !== l.openCount ||
    !l.path[0]!.at.includes("T09:30:00") ||
    !l.path.at(-1)!.at.includes("T15:00:00")
  )
    return null;
  const firstUp = prices.indexOf(l.up),
    firstDown = prices.indexOf(l.down);
  return {
    oneUp: prices.every((v) => v === l.up),
    oneDown: prices.every((v) => v === l.down),
    reseal: openings > 0 && prices.at(-1) === l.up,
    failed: firstUp >= 0 && prices.at(-1) !== l.up,
    roundtrip:
      firstUp >= 0 && firstDown >= 0
        ? firstUp < firstDown
          ? "up-down"
          : "down-up"
        : null,
    sealed: prices.at(-1) === l.up,
    ...l,
  };
}
export function cleanBlockVolume(e: PollutionEvidence | undefined) {
  const b = e?.block;
  if (
    !b?.complete ||
    !b.scope.trim() ||
    ![b.shares, b.amount].every(nonnegative) ||
    ![b.totalShares, b.totalAmount].every(positive) ||
    b.shares > b.totalShares ||
    b.amount > b.totalAmount ||
    typeof b.included !== "boolean"
  )
    return null;
  return {
    shares: b.totalShares - (b.included ? b.shares : 0),
    amount: b.totalAmount - (b.included ? b.amount : 0),
    scope: b.scope,
  };
}
type Verdict = {
  allow: boolean;
  exit: boolean;
  fraction: number;
  reason: string | null;
  trace: string[];
  ratio?: number;
  entry?: boolean;
};
const unknown = (field: string): Verdict => ({
  allow: false,
  exit: false,
  fraction: 1,
  reason: `待数据：${field}`,
  trace: [],
});
export function pollutionDecision(
  id: VolumePollutionId,
  bars: readonly Bar[],
  i: number,
  rows: readonly PollutionEvidence[],
): Verdict {
  const b = bars[i]!,
    p = bars[i - 1],
    e = pollutionEvidenceAt(rows, b.date),
    prior = bars.slice(Math.max(0, i - 5), i);
  const mean = prior.length
      ? prior.reduce((s, v) => s + v.volume, 0) / prior.length
      : NaN,
    ratio = b.volume / mean,
    change = p ? b.close / p.close - 1 : NaN;
  const v: Verdict = {
    allow: true,
    exit: false,
    fraction: 1,
    reason: null,
    trace: [id],
  };
  if (!p || !valid(b) || !valid(p)) return unknown("至少两根有效量价");
  if (id === "vp-pollution-six") {
    if (
      !e?.float?.complete ||
      !positive(e.float.shares) ||
      !positive(e.float.volumeShares)
    )
      return unknown("六步股本/实际股数覆盖");
    const stages: VolumePollutionId[] = [
      "vp-limit-book",
      "vp-block-clean",
      "vp-auction-exclude",
      "vp-ipo-own",
      "vp-resumption-normal",
      "vp-order-shape-risk",
      "vp-trade-size-risk",
      "vp-isolated-news-confirm",
    ];
    const limit = pollutionLimitState(e, b.date);
    if (!limit) return unknown("六步盘口");
    const floats = bars
      .slice(Math.max(0, i - 5), i + 1)
      .map((x) => pollutionEvidenceAt(rows, x.date)?.float);
    if (
      floats.length !== 6 ||
      floats.some(
        (f) => !f?.complete || !positive(f.shares) || !positive(f.volumeShares),
      )
    )
      return unknown("六步完整换手基准");
    const turns = floats.map((f) => f!.volumeShares / f!.shares);
    v.ratio = turns[5]! / (turns.slice(0, 5).reduce((s, n) => s + n, 0) / 5);
    for (const stage of stages) {
      if (stage === "vp-limit-book" && !limit.oneUp && !limit.oneDown) {
        v.trace.push("盘口非一字");
        continue;
      }
      if (
        stage === "vp-ipo-own" &&
        e?.listing?.complete &&
        e.listing.tradingDates.length >= 60
      ) {
        v.trace.push("上市满60交易日");
        continue;
      }
      if (stage === "vp-isolated-news-confirm") {
        if (
          !e?.news?.complete ||
          typeof e.news.volumeAuthentic !== "boolean" ||
          typeof e.news.catalystVerified !== "boolean"
        )
          return unknown("六步消息检索与量真实性");
        const candidate =
          i >= 6 &&
          bars[i - 1]!.volume >=
            2.5 *
              (bars.slice(i - 6, i - 1).reduce((s, x) => s + x.volume, 0) / 5);
        if (!candidate) {
          v.trace.push("无前日巨量候选");
          continue;
        }
      }
      const r = pollutionDecision(stage, bars, i, rows);
      v.trace.push(...r.trace);
      if (r.reason) return { ...r, trace: v.trace };
      // The book replaces volume semantics for a one-price board; still require all
      // later evidence, but do not reimpose ordinary expansion through cleanup.
      if (stage === "vp-limit-book" && r.entry !== undefined) v.entry = r.entry;
      if (stage !== "vp-block-clean" || (!limit.oneUp && !limit.oneDown))
        v.allow &&= r.allow;
      v.exit ||= r.exit;
      v.fraction = Math.min(v.fraction, r.fraction);
      if (stage === "vp-block-clean" && r.ratio !== undefined) {
        // A simultaneous float change cannot reuse an unadjusted share-volume ratio.
        const clean = bars
          .slice(i - 5, i + 1)
          .map((x) => cleanBlockVolume(pollutionEvidenceAt(rows, x.date))!);
        const cleanTurns = clean.map((c, j) => c.shares / floats[j]!.shares);
        v.ratio =
          cleanTurns[5]! /
          (cleanTurns.slice(0, 5).reduce((s, n) => s + n, 0) / 5);
      }
    }
    return v;
  }
  if (id.startsWith("vp-limit-")) {
    const l = pollutionLimitState(e, b.date);
    if (
      !l ||
      l.path[0]!.price !== b.open ||
      l.path.at(-1)!.price !== b.close ||
      l.path.some((p) => p.price < b.low || p.price > b.high)
    )
      return unknown(
        "历史限制价/完整逐次盘口路径、封单实际股数/开板/板次与当日OHLC一致",
      );
    v.trace.push(
      l.roundtrip ??
        (l.reseal
          ? "reseal"
          : l.oneUp
            ? "one-up"
            : l.oneDown
              ? "one-down"
              : "ordinary"),
    );
    if (id === "vp-limit-book") {
      v.allow = l.oneUp && l.sealShares >= l.volumeShares && l.openCount === 0;
      v.entry = v.allow;
      v.exit = l.oneDown;
    }
    if (id === "vp-limit-reseal-path") {
      v.allow = l.reseal && l.turnover >= 3 && l.turnover <= 15;
      v.entry = v.allow;
    }
    if (id === "vp-limit-roundtrip-half") {
      v.fraction = l.roundtrip ? 0.5 : 1;
    }
    if (id === "vp-limit-stages") {
      v.allow =
        l.sealed &&
        (l.boards === 1
          ? ratio >= 1.5
          : l.boards === 2
            ? l.reseal && l.turnover >= 3 && l.turnover <= 15
            : l.boards >= 3 && ratio < 1 && l.sealShares >= l.volumeShares);
      v.entry = v.allow;
    }
    if (id === "vp-limit-wick-exit") {
      v.exit =
        l.failed &&
        ratio >= 1.5 &&
        b.high > b.low &&
        (b.high - Math.max(b.open, b.close)) / (b.high - b.low) >= 0.4;
      v.allow = !v.exit;
    }
    return v;
  }
  if (id === "vp-settlement-evidence") {
    const s = e?.settlement;
    if (!s?.source.trim()) return unknown("历史证券品种/市场/结算天数");
    if (s.market === "other" || s.kind === "index" || s.days !== 1)
      return {
        ...v,
        allow: false,
        reason: "不适用：现有执行仅沪深T+1股票/股票ETF",
      };
    return v;
  }
  if (id === "vp-block-clean") {
    const cleaned = bars
      .slice(Math.max(0, i - 5), i + 1)
      .map((x) => cleanBlockVolume(pollutionEvidenceAt(rows, x.date)));
    if (
      cleaned.length !== 6 ||
      cleaned.some((c) => !c || c.scope !== cleaned[0]?.scope || c.shares <= 0)
    )
      return unknown("六根同统计口径大宗核实/原总量额/可扣除量额");
    v.ratio =
      cleaned[5]!.shares /
      (cleaned.slice(0, 5).reduce((s, c) => s + c!.shares, 0) / 5);
    v.allow = v.ratio >= 1.5;
    return v;
  }
  if (id === "vp-auction-exclude") {
    const a = e?.auction;
    if (
      b.date < "2000-01-04" ||
      b.date > "2022-11-30" ||
      !a?.complete ||
      !positive(a.totalShares) ||
      !nonnegative(a.last3Shares) ||
      a.last3Shares > a.totalShares ||
      typeof a.indexRebalance !== "boolean" ||
      typeof a.etfCreation !== "boolean"
    )
      return unknown("14:57至15:00实际量与指数/ETF事件覆盖");
    v.allow = !(
      (a.indexRebalance || a.etfCreation) &&
      a.last3Shares / a.totalShares >= 0.5
    );
    return v;
  }
  if (id === "vp-ipo-own") {
    const l = e?.listing;
    if (
      !l?.complete ||
      !/^\d{4}-\d{2}-\d{2}$/.test(l.date) ||
      l.tradingDates[0] !== l.date ||
      l.tradingDates.at(-1) !== b.date ||
      l.tradingDates.some((d, j) => j > 0 && d <= l.tradingDates[j - 1]!)
    )
      return unknown("首次上市日期及上市以来完整交易日历");
    if (l.tradingDates.length >= 60)
      return { ...v, allow: false, reason: "不适用：已上市60交易日" };
    const history = l.tradingDates
      .slice(0, -1)
      .map((d) => bars.find((x) => x.date === d));
    if (!history.length || history.some((x) => !x || !valid(x)))
      return unknown("上市以来自身完整量能");
    v.ratio =
      b.volume / (history.reduce((s, x) => s + x!.volume, 0) / history.length);
    v.fraction = 0.5;
    v.allow = v.ratio >= 1.5;
    return v;
  }
  if (id === "vp-resumption-normal") {
    const r = e?.resumption;
    if (
      !r?.complete ||
      !Number.isInteger(r.suspendedSessions) ||
      r.suspendedSessions < 0 ||
      !Number.isInteger(r.sessionsSince) ||
      r.sessionsSince < 0
    )
      return unknown("历史停复牌事实与交易日历");
    if (r.date === null) return v;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || r.date > b.date)
      return unknown("复牌有效日");
    if (r.suspendedSessions < 5) return v;
    if (r.beforeVolumes.length !== 20 || !r.beforeVolumes.every(positive))
      return unknown("停牌前20有效交易日量");
    v.allow =
      r.sessionsSince >= 5 &&
      b.volume <= 2 * r.beforeVolumes.reduce((s, n) => s + n / 20, 0);
    return v;
  }
  if (id === "vp-order-shape-risk") {
    const o = e?.orders;
    if (
      b.date < "2000-01-04" ||
      b.date > "2022-11-30" ||
      !o?.complete ||
      !nonnegative(o.regularFraction) ||
      o.regularFraction > 1
    )
      return unknown("历史挂单规整比例/覆盖");
    v.allow = !(
      o.regularFraction >= 0.8 &&
      Math.abs(change) <= 0.01 &&
      ratio >= 1.5
    );
    return v;
  }
  if (id === "vp-trade-size-risk") {
    const trades = bars
      .slice(Math.max(0, i - 5), i + 1)
      .map((x) => pollutionEvidenceAt(rows, x.date)?.trades);
    if (
      b.date < "2000-01-04" ||
      b.date > "2022-11-30" ||
      trades.length !== 6 ||
      trades.some(
        (t) =>
          !t ||
          !Number.isSafeInteger(t.count) ||
          t.count <= 0 ||
          !positive(t.volumeShares),
      )
    )
      return unknown("六日真实成交笔数及成交股数");
    const averages = trades.map((t) => t!.volumeShares / t!.count);
    v.allow = !(
      Math.abs(change) <= 0.01 &&
      averages[5]! >= 3 * averages.slice(0, 5).reduce((s, n) => s + n / 5, 0)
    );
    return v;
  }
  if (id === "vp-isolated-news-confirm") {
    const n = e?.news;
    if (
      !n?.complete ||
      typeof n.catalystVerified !== "boolean" ||
      typeof n.volumeAuthentic !== "boolean" ||
      i < 6
    )
      return unknown("完整消息覆盖/催化核验/量真实性及候选前5根");
    const before = bars.slice(i - 6, i - 1),
      base = before.reduce((s, x) => s + x.volume / 5, 0);
    v.allow =
      before.length === 5 &&
      before.every(valid) &&
      before.at(-1)!.volume < 0.8 * base &&
      p.volume >= 2.5 * base &&
      b.volume >= base &&
      b.close >= p.close &&
      n.catalystVerified &&
      n.volumeAuthentic;
    v.entry = v.allow;
    return v;
  }
  if (id === "vp-event-seasonal-filter") {
    const s = e?.seasonal;
    if (
      !s?.complete ||
      !Number.isInteger(s.quarterEndDistance) ||
      s.quarterEndDistance < 0
    )
      return unknown("当时已知季度末交易日距离");
    v.allow = !(s.quarterEndDistance <= 2 && ratio >= 1.5);
    return v;
  }
  const events = e?.events;
  if (
    !events?.complete ||
    events.items.some(
      (x) =>
        !timestamp(x.availableAt) ||
        x.availableAt > `${b.date}T15:00:00+08:00` ||
        !/^\d{4}-\d{2}-\d{2}$/.test(x.effectiveDate) ||
        !Number.isInteger(x.ageSessions) ||
        x.ageSessions < 0,
    )
  )
    return unknown("完整事件覆盖、公告可得时刻/生效日/交易日龄");
  for (const event of events.items) {
    if (id === "vp-event-lhb-filter" && event.kind === "lhb") {
      if (typeof event.speculative !== "boolean")
        return unknown("龙虎榜游资归类");
      if (event.speculative && event.ageSessions <= 1) v.allow = false;
    }
    if (
      id === "vp-event-unlock-filter" &&
      event.kind === "unlock" &&
      event.effectiveDate === b.date
    ) {
      if (!positive(event.oldFloat) || !positive(event.newFloat))
        return unknown("解禁前后实际流通股数");
      if (event.newFloat > event.oldFloat && ratio >= 1.5) v.allow = false;
    }
    if (
      id === "vp-event-merger-half" &&
      event.kind === "merger" &&
      event.ageSessions <= 4
    )
      v.fraction = 0.5;
    if (
      id === "vp-event-index-filter" &&
      (event.kind === "index-in" || event.kind === "index-out") &&
      event.effectiveDate === b.date
    ) {
      v.allow = false;
      v.trace.push(event.kind);
    }
  }
  return v;
}
export function researchVolumePollutionSeries(
  id: VolumePollutionId,
  bars: readonly Bar[],
  evidence: readonly PollutionEvidence[] = [],
) {
  let active = false;
  return bars.map((b, i) => {
    const prior = bars.slice(Math.max(0, i - 5), i),
      p = bars[i - 1],
      result = pollutionDecision(id, bars, i, evidence);
    const ratio =
      result.ratio ??
      b.volume / (prior.reduce((s, x) => s + x.volume, 0) / prior.length);
    const ready =
      (prior.length === 5 || id === "vp-ipo-own") &&
      prior.every(valid) &&
      valid(b) &&
      !!p;
    const entry =
      ready &&
      !result.reason &&
      result.allow &&
      (result.entry ?? (b.close > p!.close * 1.02 && ratio >= 1.5));
    const exit =
      ready && !result.reason && (result.exit || b.close < p!.close * 0.98);
    const trigger = entry && !active;
    active = entry;
    return {
      date: b.date,
      entry: trigger && !exit,
      exit,
      entryFraction: result.fraction,
      reason: ready ? result.reason : "量价基准不足",
      values: {
        close: b.close,
        ratio: Number.isFinite(ratio) ? ratio : null,
      } as Record<string, number | null>,
      pollution: result,
      historyStart: bars[0]!.date,
    };
  });
}
