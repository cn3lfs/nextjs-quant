import { z } from "zod";

export const tmtVersion = "tmt-crowding-1";
export const swIndustries = {
  "801010": "农林牧渔",
  "801030": "基础化工",
  "801040": "钢铁",
  "801050": "有色金属",
  "801080": "电子",
  "801880": "汽车",
  "801110": "家用电器",
  "801120": "食品饮料",
  "801130": "纺织服饰",
  "801140": "轻工制造",
  "801150": "医药生物",
  "801160": "公用事业",
  "801170": "交通运输",
  "801180": "房地产",
  "801200": "商贸零售",
  "801210": "社会服务",
  "801780": "银行",
  "801790": "非银金融",
  "801230": "综合",
  "801710": "建筑材料",
  "801720": "建筑装饰",
  "801730": "电力设备",
  "801890": "机械设备",
  "801740": "国防军工",
  "801750": "计算机",
  "801760": "传媒",
  "801770": "通信",
  "801950": "煤炭",
  "801960": "石油石化",
  "801970": "环保",
  "801980": "美容护理",
} as const;
export const tmtCodes = ["801080", "801750", "801760", "801770"] as const;
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const t = Date.parse(v);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
  });
const code = z
  .string()
  .refine((v) => Object.hasOwn(swIndustries, v), "非申万31个一级行业代码");
const nonnegative = z.number().finite().nonnegative().nullable();
const inputSchema = z
  .object({
    cutoff: day,
    maxAgeDays: z.number().int().min(0).max(31),
    amount: z.array(
      z
        .object({
          date: day,
          code,
          amount: nonnegative,
          close: z.number().finite().positive().nullable(),
        })
        .strict(),
    ),
    daily: z.array(
      z
        .object({
          date: day,
          code,
          name: z.string(),
          turnover: nonnegative,
          pe: z.number().finite().nullable(),
          pb: z.number().finite().nullable(),
          capital: nonnegative,
        })
        .strict(),
    ),
    margin: z.array(z.object({ date: day, balance: nonnegative }).strict()),
  })
  .strict();
export type TmtInput = z.infer<typeof inputSchema>;
type Point = { date: string; value: number };
const average = (values: number[]) =>
  values.reduce((sum, v) => sum + v, 0) / values.length;
function byDate<T extends { date: string; code: string }>(
  rows: T[],
  cutoff: string,
) {
  const result = new Map<string, Map<string, T>>();
  for (const row of rows) {
    if (row.date > cutoff) continue;
    const group = result.get(row.date) ?? new Map<string, T>();
    if (group.has(row.code)) throw new Error("TMT缓存同日同行业重复");
    group.set(row.code, row);
    result.set(row.date, group);
  }
  return [...result].sort(([a], [b]) => a.localeCompare(b));
}
function percentile(
  series: Point[],
  cutoff: string,
  maxAgeDays: number,
  window?: number,
) {
  const sample = window ? series.slice(-window) : series;
  const last = sample.at(-1);
  const reason = !last
    ? "没有可用观测"
    : sample.length < 2
      ? "历史分位至少需要2个有效观测"
      : Date.parse(cutoff) - Date.parse(last.date) > maxAgeDays * 86400000
        ? "最新有效观测超过允许日历天数"
        : null;
  return {
    value: reason
      ? null
      : (sample.filter((p) => p.value <= last!.value).length / sample.length) *
        100,
    current: last?.value ?? null,
    asOf: last?.date ?? null,
    start: sample[0]?.date ?? null,
    observations: sample.length,
    distinctValues: new Set(sample.map((p) => p.value)).size,
    reason,
    formula: "count(历史值<=当前值)/有效观测数*100，含当日",
  };
}

export function tmtCrowding(input: TmtInput) {
  const data = inputSchema.parse(input);
  const amount = byDate(data.amount, data.cutoff),
    daily = byDate(data.daily, data.cutoff);
  const concentration: Point[] = [],
    turnover: Point[] = [],
    relative: Point[] = [],
    pe: Point[] = [],
    pb: Point[] = [],
    momentum: Point[] = [];
  let breakdown: { date: string; industry: string; amountShare: number }[] = [];
  const tmt = (rows: Map<string, TmtInput["amount"][number]>) =>
    tmtCodes.map((c) => rows.get(c));
  for (const [date, rows] of amount) {
    if (rows.size !== 31 || [...rows.values()].some((r) => r.amount === null))
      continue;
    const total = [...rows.values()].reduce((sum, r) => sum + r.amount!, 0);
    if (!Number.isFinite(total) || total <= 0) continue;
    const selected = tmt(rows),
      numerator = selected.reduce((sum, r) => sum + r!.amount!, 0);
    concentration.push({ date, value: (numerator / total) * 100 });
    breakdown = tmtCodes.map((c) => ({
      date,
      industry: swIndustries[c],
      amountShare: (rows.get(c)!.amount! / total) * 100,
    }));
  }
  for (const [date, rows] of daily) {
    for (const r of rows.values())
      if (r.name !== swIndustries[r.code as keyof typeof swIndustries])
        throw new Error("TMT缓存行业代码与名称不匹配");
    if (
      rows.size !== 31 ||
      [...rows.values()].some((r) => r.capital === null || r.capital <= 0)
    )
      continue;
    const selected = tmtCodes.map((c) => rows.get(c)!);
    const weighted = (
      items: typeof selected,
      key: "turnover" | "pe" | "pb",
    ) => {
      if (
        items.some(
          (r) => r[key] === null || (key !== "turnover" && r[key]! <= 0),
        )
      )
        return null;
      const total = items.reduce((sum, r) => sum + r.capital!, 0);
      if (!Number.isFinite(total) || total <= 0) return null;
      const value = items.reduce(
        (sum, r) => sum + r[key]! * (r.capital! / total),
        0,
      );
      return Number.isFinite(value) ? value : null;
    };
    const h = weighted(selected, "turnover"),
      all = weighted([...rows.values()], "turnover");
    if (h !== null) turnover.push({ date, value: h });
    if (h !== null && all !== null && all > 0)
      relative.push({ date, value: h / all });
    const p = weighted(selected, "pe"),
      b = weighted(selected, "pb");
    if (p !== null) pe.push({ date, value: p });
    if (b !== null) pb.push({ date, value: b });
  }
  // A mean of index point levels is not an equal-weight portfolio return.
  // Require four complete series across all 61 observed dates, without filling gaps.
  for (let i = 60; i < amount.length; i++) {
    const window = amount.slice(i - 60, i + 1);
    if (
      window.some(([, rows]) => tmt(rows).some((r) => !r || r.close === null))
    )
      continue;
    const first = window[0]![1],
      last = window.at(-1)![1];
    const value = average(
      tmtCodes.map(
        (c) => (last.get(c)!.close! / first.get(c)!.close! - 1) * 100,
      ),
    );
    if (Number.isFinite(value))
      momentum.push({ date: window.at(-1)![0], value });
  }
  const margins = data.margin
    .filter((r) => r.date <= data.cutoff)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(margins.map((r) => r.date)).size !== margins.length)
    throw new Error("TMT融资缓存日期重复");
  const marginSeries = margins
    .filter((r) => r.balance !== null)
    .map((r) => ({ date: r.date, value: r.balance! }));
  const rank = (s: Point[], window?: number) =>
    percentile(s, data.cutoff, data.maxAgeDays, window);
  const metrics = {
    concentration: rank(concentration),
    turnover: rank(turnover),
    relativeTurnover: rank(relative),
    pe: rank(pe),
    pb: rank(pb),
    margin: rank(marginSeries, 244),
    momentum: rank(momentum),
  };
  const mWindow = margins.slice(-61),
    mFirst = mWindow[0],
    mLast = mWindow.at(-1);
  const growth =
    mWindow.length === 61 &&
    mWindow.every((r) => r.balance !== null) &&
    mFirst!.balance! > 0
      ? (mLast!.balance! / mFirst!.balance! - 1) * 100
      : null;
  const marginGrowth60 =
    growth !== null && Number.isFinite(growth) ? growth : null;
  const paired = (a: ReturnType<typeof rank>, b: ReturnType<typeof rank>) =>
    a.value !== null && b.value !== null && a.asOf === b.asOf
      ? (a.value + b.value) / 2
      : null;
  const C =
    metrics.margin.value !== null &&
    marginGrowth60 !== null &&
    metrics.margin.asOf === mLast?.date
      ? 0.6 * metrics.margin.value +
        0.4 * Math.min(100, (Math.max(0, marginGrowth60) / 20) * 100)
      : null;
  const raw = [
    {
      key: "A",
      weight: 0.25,
      value: metrics.concentration.value,
      asOf: metrics.concentration.asOf,
      missing: metrics.concentration.reason,
    },
    {
      key: "B",
      weight: 0.2,
      value: paired(metrics.turnover, metrics.relativeTurnover),
      asOf: metrics.turnover.asOf,
      missing: "换手及相对换手分位缺失、过期或日期不齐",
    },
    {
      key: "C",
      weight: 0.2,
      value: C,
      asOf: metrics.margin.asOf,
      missing: "上交所融资余额分位或完整61观测增长缺失/过期",
    },
    {
      key: "D",
      weight: 0.2,
      value: paired(metrics.pe, metrics.pb),
      asOf: metrics.pe.asOf,
      missing: "PE/PB分位缺失、非正估值、过期或日期不齐",
    },
    {
      key: "E",
      weight: 0.15,
      value: metrics.momentum.value,
      asOf: metrics.momentum.asOf,
      missing: metrics.momentum.reason,
    },
  ];
  const weight = raw.reduce(
    (sum, f) => sum + (f.value === null ? 0 : f.weight),
    0,
  );
  const factors = raw.map((f) => ({
    ...f,
    missing: f.value === null ? f.missing : null,
    effectiveWeight: f.value === null ? 0 : f.weight / weight,
  }));
  const availableWeightedScore = weight
    ? factors.reduce((sum, f) => sum + (f.value ?? 0) * f.effectiveWeight, 0)
    : null;
  const hasTmtFactor = factors.some((f) => f.key !== "C" && f.value !== null);
  const score = hasTmtFactor ? availableWeightedScore : null;
  return {
    version: tmtVersion,
    cutoff: data.cutoff,
    maxAgeDays: data.maxAgeDays,
    score,
    availableWeightedScore,
    scope: hasTmtFactor
      ? "tmt-partial"
      : availableWeightedScore === null
        ? "unavailable"
        : "market-proxy-only",
    band:
      score === null
        ? null
        : score > 85
          ? "极度拥挤"
          : score > 70
            ? "拥挤"
            : score > 50
              ? "偏热"
              : "不拥挤",
    used: factors.filter((f) => f.value !== null).length,
    total: 5,
    factors,
    metrics,
    marginGrowth60,
    breakdown: breakdown.map((row) => {
      const sameDay = daily.find(([date]) => date === row.date)?.[1];
      const index = tmtCodes.find(
        (code) => swIndustries[code] === row.industry,
      )!;
      const value = sameDay?.get(index)?.pe ?? null;
      return {
        ...row,
        pe: value,
        peAsOf: value === null ? null : row.date,
        peBasis: "源市盈率，TTM属性未独立核验",
        missing: value === null ? "同日行业PE缺失" : null,
      };
    }),
    coverage: {
      amountDates: amount.length,
      completeAmountDates: concentration.length,
      dailyDates: daily.length,
      turnoverDates: turnover.length,
      peDates: pe.length,
      pbDates: pb.length,
      marginDates: margins.length,
      momentumDates: momentum.length,
    },
    warnings: [
      "仅适用已核验的申万一级电子、计算机、传媒、通信；上交所融资余额为市场代理，不是TMT专属融资。",
      "若只有市场融资代理有效，仅显示该项分数与重算权重，不输出TMT综合分数或拥挤等级。",
      "缺失维度剔除并重算权重，不沿用参考脚本融资缺失填50分。不同分位历史窗口必须分别披露。",
      "成交占比分母须同日31行业齐全；换手与估值使用同日流通市值权重，PE/PB非正值不计估值分位。",
      "动量改为四行业各自60观测收益率等权；参考脚本对不同基点指数直接平均会产生隐含权重，因此不照搬。",
      "阈值按参考脚本严格大于50/70/85分档；分位至少2个观测是可计算下限，不是充分样本证明。",
      "经验分位包含相等值；全样本相等时分位也是100，不代表上涨或高增长，需同时读取原值与不同值数量。",
      "本地缓存不是交易日历或当时公开性的证明，缺整日观测仍可能影响60观测跨度；不能直接用于无前视回测。",
    ],
  };
}
