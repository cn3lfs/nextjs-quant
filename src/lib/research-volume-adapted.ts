import type { Bar } from "./domain";
import { ma } from "./indicators";
export const volumeAdaptedProfiles = {
  "vp-basis-amount": ["VP-amount-basis", "同币种成交额量价对照", "amount"],
  "vp-basis-adjusted": [
    "VP-adjusted-volume",
    "后复权价与逆向调整量",
    "adjusted",
  ],
  "vp-board-volume18": ["VP-board-volume", "成长板放量1.8倍", "board-volume"],
  "vp-board-price3": ["VP-board-price", "成长板价格方向3%", "board-price3"],
  "vp-board-price4": ["VP-board-price", "成长板价格方向4%", "board-price4"],
  "vp-etf-volume13": ["VP-etf-volume", "境内股票ETF量能1.3倍", "etf"],
  "vp-small-turnover": [
    "VP-small-float-turnover",
    "小流通盘活跃换手",
    "turnover",
  ],
  "vp-high-accelerate": [
    "VP-high-acceleration-filter",
    "高位排除派发后持续新高",
    "acceleration",
  ],
  "vp-profile-edge": ["VP-profile-support", "二十日十二箱HVN边缘", "profile"],
  "vp-chip-overhang": ["VP-chips-overhang", "历史套牢筹码过滤", "chips"],
  "vp-money-confirm": [
    "VP-large-money-confirm",
    "同算法大单超大单净流入确认",
    "money",
  ],
  "vp-week-day-hour": [
    "VP-multi-timeframe",
    "完成周日方向与60分钟触发",
    "multi",
  ],
  "vp-float-segment": ["VP-float-break", "流通股本变化后分段量能", "float"],
} as const;
export type VolumeAdaptedId = keyof typeof volumeAdaptedProfiles;
export const volumeAdaptedIds = Object.keys(
  volumeAdaptedProfiles,
) as VolumeAdaptedId[];
export function isVolumeAdapted(id: string): id is VolumeAdaptedId {
  return Object.hasOwn(volumeAdaptedProfiles, id);
}
export const volumeAdaptedBoundary =
  "工程v1量价适配：共用收涨严格>2%、当日量/前5根均量≥1.5入场，跌幅<-2%或失守MA20退出，连续成立只首日入场。成交额版全程使用同币种同单位amount；后复权版priceFactor与volumeFactor互为倒数、价格另加现金累计调整，禁止当今修订因子回填，仅信号转换而非成交报价。成长板历史身份为创业/科创，量阈1.8，价格阈独立3%与4%；北证留后续市场，不冒充沪深。ETF限境内股票ETF且有当日T+1证据，量阈1.3；指数无直接成交标的，仅参考，不冒充可交易指数。小盘工程定义流通市值≤50亿元且股数≤5亿，换手[3,15]%且高于前5均值，蓝筹非本预设。流通变化分段版要求当前与前5根相同流通股数，否则待新段积满5根；不把普通除权排除当作流通变更。高位为前60根低收至前收≥50%，七维洗盘/派发事实必须完整，任一派发退出，全非派发且连续两日新高才放行。筹码需同日历史算法/复权/窗口、价格质量配平，现价上方筹码≤20%且获利筹码≥50%；大单与超大单分别净流入>0，不以OBV替代。VP用前20完成日高低间均匀分配十二箱，最大箱并列取低价，前收不高于HVN上沿而当日放量突破上沿入场，失守下沿退出，明确日线近似非真实逐笔筹码。周/日均线20向上且价在其上，60分钟5/10金叉择时，必须完成的21周/21日/11小时原始序列及各窗口结束时点/日历完备证据；小时必须按最近三交易日10:30/11:30/14:00/15:00的末11根精确对齐，周内未完成周拒绝；分钟仅2000-01-04至2022-11-30。缺必要字段保留不可用，固定输入可验不表示真实历史已接入；信号日收盘回放、次日合法开盘成交、T+1及最长持有期保持。";
export function volumeAdaptedDefinition(id: VolumeAdaptedId) {
  return {
    label: `量价 · ${volumeAdaptedProfiles[id][1]}`,
    family: "量价适配",
    signal: "technical" as const,
    version: `${id}-engineering-1`,
    sources: [
      "volume-price-analysis/SKILL.md",
      "volume-price-analysis/references/vp-indicators.md",
      "volume-price-analysis/references/vp-astock-caveats.md",
      ...(id === "vp-profile-edge"
        ? ["wyckoff-trader/references/wyckoff-volume-profile.md"]
        : []),
    ],
    description: volumeAdaptedBoundary,
  };
}
export type VolumeAdaptedEvidence = {
  date: string;
  availableDate: string;
  source: string;
  amount?: { unit: "CNY"; scope: string };
  adjustment?: {
    priceFactor: number;
    volumeFactor: number;
    cashOffset: number;
    basis: string;
    complete: boolean;
  };
  instrument?: {
    kind: "stock" | "stock-etf" | "index";
    board: "main" | "chinext" | "star" | "beijing";
    settlement: "T+1" | "T+0";
    identitySource: string;
  };
  floatShares?: number;
  volumeUnit?: "shares" | "hands";
  distribution?: {
    complete: boolean;
    price: boolean;
    volume: boolean;
    intraday: boolean;
    chips: boolean;
    news: boolean;
    duration: boolean;
    recovery: boolean;
  };
  chips?: {
    method: string;
    adjustment: string;
    start: string;
    end: string;
    bins: { price: number; fraction: number }[];
  };
  money?: {
    algorithm: string;
    currency: "CNY";
    large: number;
    extraLarge: number;
  };
  periods?: {
    complete: boolean;
    calendarSource: string;
    observedAt: string;
    weekEnd: string;
    hourEnd: string;
    week: Bar[];
    hour: Bar[];
  };
};
const positive = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;
const valid = (b: Bar) =>
  [b.open, b.high, b.low, b.close, b.volume].every(positive) &&
  b.high >= Math.max(b.open, b.close) &&
  b.low <= Math.min(b.open, b.close);
export function volumeProfileBands(bars: readonly Bar[]) {
  if (bars.length !== 20 || !bars.every(valid)) return null;
  const low = Math.min(...bars.map((b) => b.low)),
    high = Math.max(...bars.map((b) => b.high));
  if (high <= low) return null;
  const width = (high - low) / 12,
    bins = Array.from({ length: 12 }, (_, i) => ({
      low: low + i * width,
      high: low + (i + 1) * width,
      volume: 0,
    }));
  for (const b of bars) {
    if (b.high === b.low) {
      bins[Math.min(11, Math.floor((b.close - low) / width))]!.volume +=
        b.volume;
      continue;
    }
    for (const bin of bins)
      bin.volume +=
        (b.volume *
          Math.max(0, Math.min(bin.high, b.high) - Math.max(bin.low, b.low))) /
        (b.high - b.low);
  }
  const hvn = bins.reduce((a, b) => (b.volume > a.volume ? b : a));
  return { bins, hvn };
}
export function adjustedVolumeBar(
  bar: Bar,
  e: VolumeAdaptedEvidence["adjustment"],
) {
  if (
    !e?.complete ||
    !e.basis.trim() ||
    !positive(e.priceFactor) ||
    !positive(e.volumeFactor) ||
    !Number.isFinite(e.cashOffset) ||
    e.cashOffset < 0 ||
    Math.abs(e.priceFactor * e.volumeFactor - 1) > 1e-10
  )
    return null;
  const price = (n: number) => n * e.priceFactor + e.cashOffset;
  return {
    ...bar,
    open: price(bar.open),
    high: price(bar.high),
    low: price(bar.low),
    close: price(bar.close),
    volume: bar.volume * e.volumeFactor,
  };
}
export function chipFractions(
  chips: VolumeAdaptedEvidence["chips"],
  date: string,
  price: number,
) {
  if (
    !chips ||
    !chips.method.trim() ||
    !chips.adjustment.trim() ||
    !/^\d{4}-\d{2}-\d{2}$/.test(chips.start) ||
    chips.start > chips.end ||
    chips.end !== date ||
    !chips.bins.length ||
    chips.bins.some(
      (b) =>
        !positive(b.price) || !Number.isFinite(b.fraction) || b.fraction < 0,
    ) ||
    Math.abs(chips.bins.reduce((s, b) => s + b.fraction, 0) - 1) > 1e-8
  )
    return null;
  return {
    overhang: chips.bins
      .filter((b) => b.price > price)
      .reduce((s, b) => s + b.fraction, 0),
    profit: chips.bins
      .filter((b) => b.price < price)
      .reduce((s, b) => s + b.fraction, 0),
  };
}
function periodDirection(rows: readonly Bar[], date: string) {
  if (
    rows.length !== 21 ||
    rows.some(
      (b, i) =>
        !valid(b) || b.date > date || (i > 0 && b.date <= rows[i - 1]!.date),
    )
  )
    return null;
  const prior = rows.slice(0, 20).reduce((s, b) => s + b.close / 20, 0),
    now = rows.slice(1).reduce((s, b) => s + b.close / 20, 0);
  return rows[20]!.close > now && now > prior;
}
export function volumePeriodGate(
  bars: readonly Bar[],
  e: VolumeAdaptedEvidence | undefined,
  date: string,
) {
  const p = e?.periods;
  if (
    date < "2000-01-04" ||
    date > "2022-11-30" ||
    !p?.complete ||
    !p.calendarSource.trim() ||
    p.observedAt !== `${date}T15:00:00+08:00` ||
    p.week.at(-1)?.date !== p.weekEnd ||
    p.hour.at(-1)?.date !== p.hourEnd ||
    p.weekEnd > date ||
    !p.hourEnd.startsWith(date) ||
    p.hourEnd > p.observedAt ||
    p.hour.length !== 11
  )
    return null;
  // Match hourly-bars/wyckoff-frames: four completed A-share session ends.
  // At the daily cutoff, the last eleven bars must be the exact trailing slots.
  const hourEnds = ["10:30", "11:30", "14:00", "15:00"];
  const expectedHours = bars
    .slice(-3)
    .flatMap((b) => hourEnds.map((t) => `${b.date}T${t}:00+08:00`))
    .slice(-11);
  if (
    expectedHours.length !== 11 ||
    p.hour.some(
      (b, j) =>
        b.date !== expectedHours[j] ||
        [0, 6].includes(new Date(b.date.slice(0, 10)).getUTCDay()),
    )
  )
    return null;
  const day = new Date(`${date}T00:00:00Z`);
  const weekday = day.getUTCDay();
  day.setUTCDate(day.getUTCDate() - ((weekday + 6) % 7));
  const monday = day.toISOString().slice(0, 10);
  if (
    [0, 6].includes(weekday) ||
    [0, 6].includes(new Date(p.weekEnd).getUTCDay()) ||
    (weekday !== 5 && p.weekEnd >= monday)
  )
    return null;
  const w = periodDirection(p.week, date),
    d = periodDirection(bars.slice(-21), date);
  if (
    w === null ||
    d === null ||
    p.hour.some(
      (b, i) =>
        !valid(b) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(b.date) ||
        b.date > p.observedAt ||
        (i > 0 && b.date <= p.hour[i - 1]!.date),
    )
  )
    return null;
  const avg = (start: number, end: number) =>
    p.hour.slice(start, end).reduce((s, b) => s + b.close, 0) / (end - start);
  return w && d && avg(5, 10) <= avg(0, 10) && avg(6, 11) > avg(1, 11);
}
export function researchVolumeAdaptedSeries(
  id: VolumeAdaptedId,
  bars: readonly Bar[],
  evidence: readonly VolumeAdaptedEvidence[] = [],
) {
  const mode = volumeAdaptedProfiles[id][2];
  const known = (date: string) => {
    const rows = evidence.filter((e) => e.date === date);
    return rows.length === 1 &&
      rows[0]!.source.trim() &&
      /^\d{4}-\d{2}-\d{2}$/.test(rows[0]!.availableDate) &&
      rows[0]!.availableDate <= date
      ? rows[0]
      : undefined;
  };
  const transformed = bars.map((b) =>
    mode === "adjusted" ? adjustedVolumeBar(b, known(b.date)?.adjustment) : b,
  );
  const averages = ma(
    transformed.map((b, i) => b ?? { ...bars[i]!, close: NaN }),
    20,
  );
  let previousEntry = false;
  return bars.map((raw, i) => {
    const b = transformed[i],
      prev = transformed[i - 1],
      e = known(raw.date),
      window = transformed.slice(Math.max(0, i - 5), i);
    let reason: string | null =
      !b ||
      !prev ||
      !valid(b) ||
      !valid(prev) ||
      window.length !== 5 ||
      window.some((v) => !v || !valid(v))
        ? "量价窗口不足或调整因子缺失无效"
        : null;
    let ratio: number | null = null,
      entry = false,
      exit = false,
      entryFraction = 1;
    let detail: unknown = null;
    const missing = (text: string) => {
      reason = `待数据：${text}`;
    };
    if (!reason && b && prev) {
      let measures = window.map((v) => v!.volume),
        current = b.volume;
      if (mode === "amount") {
        const inputs = bars.slice(i - 5, i + 1),
          meta = inputs.map((v) => known(v.date)?.amount);
        if (
          inputs.some((v) => !positive(v.amount)) ||
          meta.some(
            (v) =>
              v?.unit !== "CNY" ||
              !v.scope.trim() ||
              v.scope !== meta[0]?.scope,
          )
        )
          missing("六根同CNY单位/同统计scope的成交额");
        else {
          measures = inputs.slice(0, 5).map((v) => v.amount!);
          current = raw.amount!;
        }
      }
      if (mode === "adjusted") {
        const rows = bars.slice(0, i + 1).map((v) => known(v.date)?.adjustment);
        if (
          rows.some((v) => !v?.complete || v.basis !== e?.adjustment?.basis) ||
          transformed.slice(0, i + 1).some((v) => !v)
        )
          missing("完整历史逐日可得同basis后复权价量/现金因子");
      }
      ratio = current / (measures.reduce((s, v) => s + v, 0) / 5);
      let threshold = 1.5,
        priceThreshold = 0.02;
      if (mode.startsWith("board") || mode === "etf") {
        const ins = e?.instrument;
        if (!ins?.identitySource.trim()) missing("当日历史证券身份与结算");
        else if (mode === "etf") {
          if (ins.kind !== "stock-etf" || ins.settlement !== "T+1")
            reason = "不适用：仅境内T+1股票ETF；指数及T+0留独立市场执行";
          threshold = 1.3;
        } else {
          if (ins.kind !== "stock" || !["chinext", "star"].includes(ins.board))
            reason = "不适用：仅沪深创业板/科创板历史身份";
          if (mode === "board-volume") threshold = 1.8;
          else priceThreshold = mode === "board-price3" ? 0.03 : 0.04;
        }
      }
      const change = b.close / prev.close - 1;
      entry = b.close > prev.close * (1 + priceThreshold) && ratio >= threshold;
      exit =
        b.close < prev.close * (1 - priceThreshold) ||
        (averages[i] != null && b.close < averages[i]!);
      if (mode === "turnover" || mode === "float") {
        const inputs = bars.slice(i - 5, i + 1),
          rows = inputs.map((v) => known(v.date));
        if (rows.some((v) => !positive(v?.floatShares) || !v?.volumeUnit))
          missing("六根历史流通股数/成交量股手单位");
        else {
          const shares = rows.map((v) => v!.floatShares!);
          if (mode === "float") {
            if (shares.some((v) => v !== shares[5])) {
              entry = false;
              reason = "流通变化后新段不足五根基准";
            }
          } else {
            const turns = inputs.map(
              (v, j) =>
                ((v.volume * (rows[j]!.volumeUnit === "hands" ? 100 : 1)) /
                  shares[j]!) *
                100,
            );
            detail = {
              turnover: turns[5],
              floatShares: shares[5],
              floatMarketCap: shares[5]! * raw.close,
            };
            entry =
              b.close > prev.close * 1.02 &&
              shares[5]! <= 5e8 &&
              shares[5]! * raw.close <= 5e9 &&
              turns[5]! >= 3 &&
              turns[5]! <= 15 &&
              turns[5]! > turns.slice(0, 5).reduce((s, v) => s + v / 5, 0);
          }
        }
      }
      if (mode === "chips") {
        const chips = chipFractions(e?.chips, raw.date, raw.close);
        detail = chips;
        if (!chips) missing("历史筹码算法/复权/窗口与合计为1的价格分布");
        else {
          entry = entry && chips.overhang <= 0.2 && chips.profit >= 0.5;
          exit = exit || chips.overhang > 0.5;
        }
      }
      if (mode === "money") {
        const m = e?.money;
        if (
          !m ||
          !m.algorithm.trim() ||
          m.currency !== "CNY" ||
          ![m.large, m.extraLarge].every(Number.isFinite)
        )
          missing("同算法CNY大单/超大单净额");
        else {
          entry = entry && m.large > 0 && m.extraLarge > 0;
          exit = exit || (m.large < 0 && m.extraLarge < 0);
          detail = m;
        }
      }
      if (mode === "profile") {
        const profile = volumeProfileBands(bars.slice(Math.max(0, i - 20), i));
        detail = profile;
        if (!profile) reason = "Volume Profile前20根有效历史不足";
        else {
          entry =
            ratio >= 1.5 &&
            prev.close <= profile.hvn.high &&
            b.close > profile.hvn.high;
          exit = b.close < profile.hvn.low;
        }
      }
      if (mode === "acceleration") {
        const prior = bars.slice(Math.max(0, i - 61), i - 1),
          d = e?.distribution;
        if (
          prior.length !== 60 ||
          !prior.every(valid) ||
          !d?.complete ||
          [
            d.price,
            d.volume,
            d.intraday,
            d.chips,
            d.news,
            d.duration,
            d.recovery,
          ].some((v) => typeof v !== "boolean")
        )
          missing("60根位置与七维派发判据完整覆盖");
        else if (raw.date < "2000-01-04" || raw.date > "2022-11-30")
          reason = "分钟判据超出2000-01-04至2022-11-30覆盖";
        else {
          const distribution = [
            d.price,
            d.volume,
            d.intraday,
            d.chips,
            d.news,
            d.duration,
            d.recovery,
          ].some(Boolean);
          const high =
            prev.close >= 1.5 * Math.min(...prior.map((v) => v.close));
          entry =
            entry &&
            high &&
            !distribution &&
            prev.close > Math.max(...prior.map((v) => v.high)) &&
            raw.close > prev.high;
          exit = exit || distribution;
          detail = { high, distribution };
        }
      }
      if (mode === "multi") {
        const gate = volumePeriodGate(bars.slice(0, i + 1), e, raw.date);
        if (gate === null)
          missing(
            "已完成周/日/60分钟序列与结束时点、完整日历；分钟限2022-11-30以前",
          );
        entry = gate === true;
        detail = { gate };
      }
    }
    if (reason) {
      entry = false;
      exit = false;
    }
    const trigger = entry && !previousEntry;
    previousEntry = entry;
    return {
      date: raw.date,
      entry: trigger && !exit,
      exit,
      reason,
      entryFraction,
      values: { close: raw.close, ratio } as Record<string, number | null>,
      detail,
      historyStart: bars[0]!.date,
    };
  });
}
