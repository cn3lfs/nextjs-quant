import { z } from "zod";
import { asOfTimestampSchema, type AsOfDomain } from "./as-of";
import { researchDateSchema } from "./research-usage";
const n = z.number().finite(),
  pct = n.min(0).max(100),
  nonnegative = n.min(0);
const text = z.string().trim().min(1);
export const sentimentMetrics = {
  amountTrillion: nonnegative,
  turnoverPct: nonnegative,
  amountTrend: z.enum(["shrink", "flat", "moderate", "surge"]),
  marginPeakPct: nonnegative,
  marginBuyPct: nonnegative,
  marginChangeYi: n,
  maintenancePct: nonnegative,
  marginRecord: z.boolean(),
  allAPePercentile: pct,
  shPe: n.positive(),
  growthPePercentile: pct,
  leaderTurnoverPct: nonnegative,
  defensiveReturnPct: n,
  breadthPct: pct,
  strengthPct: pct,
  newHighs: nonnegative.int(),
  newLows: nonnegative.int(),
  limitUps: nonnegative.int(),
  limitDowns: nonnegative.int(),
  fiveDaysAbove3Trillion: z.boolean(),
  accountsWan: nonnegative,
  accountTrend: z.enum(["decline", "flat", "rise", "surge"]),
  peakAccountsWan: n.positive(),
  fearGreed: pct,
  fearGreedChange5: n,
  newsTone: z.enum(["cautious", "neutral", "optimistic", "extreme"]),
  bullFrequency: z.enum(["few", "medium", "frequent", "ubiquitous"]),
  officialTone: z.enum(["risk", "neutral", "encourage"]),
  officialFrontRisk: z.boolean(),
  stockSearchYoy: n,
  entrySearchYoy: n,
  bullNewsYoy: n,
  bullSearchYoy: n,
  financeHits: nonnegative.int(),
  bestHotPosition: n.int().positive().nullable(),
  heatSharePct: pct,
  negativeHotMajority: z.boolean(),
  economy: z.enum(["recession", "weak", "steady", "overheat"]),
  money: z.enum(["tight", "neutral", "loose", "extreme"]),
  geopolitics: z.enum(["high", "medium", "low"]),
  belief: z.enum(["none-believe", "some-believe", "all-believe"]),
};
export const sentimentPanelSchema = z
  .object({
    version: text,
    evidence: text,
    origin: z.enum(["rule", "human"]),
    classifiedAt: asOfTimestampSchema,
    observationDate: researchDateSchema,
    scope: z.literal("A-share-market"),
    fearGreedIdentity: z.literal("unofficial-domestic-proxy"),
    valuationWindowYears: z.literal(10),
    metrics: z
      .object(
        Object.fromEntries(
          Object.entries(sentimentMetrics).map(([k, v]) => [k, v.optional()]),
        ),
      )
      .strict(),
  })
  .strict();
const dims = [
  "volume",
  "leverage",
  "valuation",
  "structure",
  "limits",
  "accounts",
  "emotion",
  "news",
  "search",
] as const;
// Actual named source subindicators, not arbitrary combinations of parameters.
export const sentimentNumericComponents: Record<
  string,
  { field: string; cuts: number[]; scores: number[] }
> = {
  amount: {
    field: "amountTrillion",
    cuts: [1, 1.5, 2, 3],
    scores: [2, 4, 6, 8, 10],
  },
  turnover: {
    field: "turnoverPct",
    cuts: [1, 2, 3, 5],
    scores: [2, 4, 6, 8, 10],
  },
  marginPeak: {
    field: "marginPeakPct",
    cuts: [85, 92, 98],
    scores: [3, 5, 8, 10],
  },
  marginBuy: { field: "marginBuyPct", cuts: [7, 9, 11], scores: [3, 5, 8, 10] },
  marginTrend: {
    field: "marginChangeYi",
    cuts: [-300, 300, 800],
    scores: [2, 5, 7, 10],
  },
  allAValuation: {
    field: "allAPePercentile",
    cuts: [30, 50, 70, 90],
    scores: [2, 4, 6, 8, 10],
  },
  shValuation: {
    field: "shPe",
    cuts: [12, 15, 18, 22],
    scores: [2, 4, 6, 8, 10],
  },
  growthValuation: {
    field: "growthPePercentile",
    cuts: [45, 55, 95],
    scores: [2, 5, 8, 10],
  },
  leaderTurnover: {
    field: "leaderTurnoverPct",
    cuts: [7, 15],
    scores: [3, 6, 10],
  },
  breadth: { field: "breadthPct", cuts: [40, 55, 70], scores: [3, 5, 7, 9] },
  limitUps: { field: "limitUps", cuts: [50, 100, 200], scores: [2, 5, 8, 10] },
  accounts: {
    field: "accountsWan",
    cuts: [200, 350, 500],
    scores: [3, 5, 8, 10],
  },
  fearGreed: {
    field: "fearGreed",
    cuts: [20, 40, 55, 65, 75, 85],
    scores: [1, 3, 5, 6.5, 8, 9, 10],
  },
  strength: {
    field: "strengthPct",
    cuts: [20, 35, 50, 70],
    scores: [1, 3, 5, 7, 9],
  },
  stockSearch: {
    field: "stockSearchYoy",
    cuts: [-30, 0, 30, 100],
    scores: [2, 4, 6, 8, 10],
  },
  entrySearch: {
    field: "entrySearchYoy",
    cuts: [-40, 0, 50, 150],
    scores: [2, 4, 6, 8, 10],
  },
};
const sentimentCategoryComponents: Record<
  string,
  { field: string; keys: string[]; scores: number[] }
> = {
  amountTrend: {
    field: "amountTrend",
    keys: ["shrink", "flat", "moderate", "surge"],
    scores: [2, 5, 7, 10],
  },
  accountTrend: {
    field: "accountTrend",
    keys: ["decline", "flat", "rise", "surge"],
    scores: [3, 5, 8, 10],
  },
  newsTone: {
    field: "newsTone",
    keys: ["cautious", "neutral", "optimistic", "extreme"],
    scores: [3, 5, 8, 10],
  },
  bullFrequency: {
    field: "bullFrequency",
    keys: ["few", "medium", "frequent", "ubiquitous"],
    scores: [2, 5, 8, 10],
  },
  economy: {
    field: "economy",
    keys: ["recession", "weak", "steady", "overheat"],
    scores: [2, 4, 6, 8],
  },
  money: {
    field: "money",
    keys: ["tight", "neutral", "loose", "extreme"],
    scores: [2, 5, 7, 9],
  },
  geopolitics: {
    field: "geopolitics",
    keys: ["high", "medium", "low"],
    scores: [2, 5, 8],
  },
};
const specialComponents = [
  "defensive",
  "limitRatio",
  "accountPeak",
  "emotionSpeed",
  "mediaSearchGap",
  "socialPenetration",
  "officialRisk",
  "maintenance",
];
export const sentimentFactorRules: Record<string, string> = {
  ...Object.fromEntries(
    [
      ...Object.keys(sentimentNumericComponents),
      ...Object.keys(sentimentCategoryComponents),
      ...specialComponents,
    ].map((k) => [
      `MS-component-${k}`,
      `来源具名子指标${k}独立对照；阈值缺失/重叠处沿用左闭工程版，非完整九维`,
    ]),
  ),
  MS01: "恐惧贪婪自建代理<20逆向候选，>=75减半、>=85退出，非官方指数",
  MS02: "市场宽度>=55且20日新高>新低、强度>=50准入；新低>2倍新高退出",
  MS03: "九维完整计算场内减场外背离；<-1.5禁入减半，>1.5保留杠杆风险，不当全面狂热",
  MS04: "冻结三状态主观标签：无人信试探25%、部分信正常、全信禁入减半；不是从收益倒推",
  MS05: "杠杆/估值<8且宏观>=5过滤；担保比例<200独立脆弱性禁入，不因杠杆封顶变安全",
  MS06: "官媒明确风险或搜索>=8减仓；恐惧期官方鼓励且搜索<5逆向候选",
  "MS-full-nine":
    "九维与宏观50/35/15完整组合，源0-10合成乘10对齐0-100解读；缺项不可重归一冒充完整",
  ...Object.fromEntries(
    dims.map((d) => [
      `MS-dimension-${d}`,
      `九维独立${d}：热度>=8减半、>=8.5退出；<6通过同一基线过滤`,
    ]),
  ),
};
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const clamp = (x: number) => Math.max(0, Math.min(10, x));
const tier = (x: number, cuts: number[], scores: number[]) =>
  scores[
    cuts.findIndex((c) => x < c) === -1
      ? cuts.length
      : cuts.findIndex((c) => x < c)
  ]!;
export function evaluateSentimentFactor(
  id: string,
  req: { observationDate: string; asOf: string },
  read: (domain: AsOfDomain, field: string, at: string) => unknown,
) {
  const p = sentimentPanelSchema.parse(
    read("capital", "sentimentPanel", req.observationDate),
  );
  if (
    p.observationDate !== req.observationDate ||
    Date.parse(p.classifiedAt) > Date.parse(req.asOf)
  )
    throw new Error("情绪观察/分类时间晚于决策");
  const m = p.metrics as Record<string, unknown>;
  const get = <T>(k: string): T => {
    if (!Object.hasOwn(m, k)) throw new Error(`缺情绪子指标:${k}`);
    return m[k] as T;
  };
  const num = (k: string) => get<number>(k),
    bool = (k: string) => get<boolean>(k),
    cat = (k: string, keys: string[], scores: number[]) =>
      scores[keys.indexOf(get<string>(k))]!;
  const score = (d: string): number => {
    if (d === "volume")
      return clamp(
        avg([
          tier(num("amountTrillion"), [1, 1.5, 2, 3], [2, 4, 6, 8, 10]),
          tier(num("turnoverPct"), [1, 2, 3, 5], [2, 4, 6, 8, 10]),
          cat(
            "amountTrend",
            ["shrink", "flat", "moderate", "surge"],
            [2, 5, 7, 10],
          ),
        ]) + Number(bool("fiveDaysAbove3Trillion")),
      );
    if (d === "leverage")
      return Math.min(
        num("maintenancePct") < 200 ? 6 : 10,
        avg([
          tier(num("marginPeakPct"), [85, 92, 98], [3, 5, 8, 10]),
          tier(num("marginBuyPct"), [7, 9, 11], [3, 5, 8, 10]),
          tier(num("marginChangeYi"), [-300, 300, 800], [2, 5, 7, 10]),
        ]) + Number(bool("marginRecord")),
      );
    if (d === "valuation")
      return avg([
        tier(num("allAPePercentile"), [30, 50, 70, 90], [2, 4, 6, 8, 10]),
        tier(num("shPe"), [12, 15, 18, 22], [2, 4, 6, 8, 10]),
        tier(num("growthPePercentile"), [45, 55, 95], [2, 5, 8, 10]),
      ]);
    if (d === "structure")
      return clamp(
        avg([
          tier(num("leaderTurnoverPct"), [7, 15], [3, 6, 10]),
          num("defensiveReturnPct") > 0
            ? 8
            : num("defensiveReturnPct") < 0
              ? 2
              : 5,
          tier(num("breadthPct"), [40, 55, 70], [3, 5, 7, 9]) -
            (num("breadthPct") >= 55 && num("strengthPct") < 35 ? 2 : 0),
        ]) - (num("newLows") > 2 * num("newHighs") ? 2 : 0),
      );
    if (d === "limits") {
      const down = num("limitDowns"),
        up = num("limitUps");
      if (!down)
        throw new Error("真实跌停为零，源涨跌停比无有限定义；保留待数据");
      return clamp(
        avg([
          tier(up, [50, 100, 200], [2, 5, 8, 10]),
          tier(up / down, [2, 5, 10], [3, 5, 8, 10]),
        ]) + (up > 300 ? 2 : 0),
      );
    }
    if (d === "accounts")
      return avg([
        tier(num("accountsWan"), [200, 350, 500], [3, 5, 8, 10]),
        cat(
          "accountTrend",
          ["decline", "flat", "rise", "surge"],
          [3, 5, 8, 10],
        ),
        tier(
          (100 * num("accountsWan")) / num("peakAccountsWan"),
          [30, 50, 70],
          [2, 5, 7, 10],
        ),
      ]);
    if (d === "emotion")
      return avg([
        tier(
          num("fearGreed"),
          [20, 40, 55, 65, 75, 85],
          [1, 3, 5, 6.5, 8, 9, 10],
        ),
        tier(num("strengthPct"), [20, 35, 50, 70], [1, 3, 5, 7, 9]),
        tier(Math.abs(num("fearGreedChange5")), [5, 10, 20], [3, 5, 8, 10]),
      ]);
    if (d === "news")
      return clamp(
        avg([
          cat(
            "newsTone",
            ["cautious", "neutral", "optimistic", "extreme"],
            [3, 5, 8, 10],
          ),
          cat(
            "bullFrequency",
            ["few", "medium", "frequent", "ubiquitous"],
            [2, 5, 8, 10],
          ),
        ]) +
          cat("officialTone", ["risk", "neutral", "encourage"], [-3, 0, 2]) -
          (bool("officialFrontRisk") ? 2 : 0),
      );
    if (d === "search") {
      const pos = get<number | null>("bestHotPosition"),
        hits = num("financeHits"),
        hot = clamp(
          avg([
            hits === 0 ? 1 : tier(hits, [4, 9, 16], [3, 5, 8, 10]),
            pos === null
              ? 1
              : pos <= 3
                ? 10
                : pos <= 10
                  ? 8
                  : pos <= 30
                    ? 5
                    : 3,
            tier(num("heatSharePct"), [1, 3, 8, 15], [2, 4, 7, 9, 10]),
          ]) - (bool("negativeHotMajority") ? 2 : 0),
        );
      const gap = num("bullNewsYoy") - num("bullSearchYoy");
      return clamp(
        avg([
          tier(num("stockSearchYoy"), [-30, 0, 30, 100], [2, 4, 6, 8, 10]),
          tier(num("entrySearchYoy"), [-40, 0, 50, 150], [2, 4, 6, 8, 10]),
          gap > 250 ? 2 : gap > 100 ? 4 : gap >= 0 ? 6 : 9,
          hot,
        ]) + (pos !== null && pos <= 3 && !bool("negativeHotMajority") ? 2 : 0),
      );
    }
    throw new Error("未知情绪维度");
  };
  const macro = () =>
    avg([
      cat("economy", ["recession", "weak", "steady", "overheat"], [2, 4, 6, 8]),
      cat("money", ["tight", "neutral", "loose", "extreme"], [2, 5, 7, 9]),
      cat("geopolitics", ["high", "medium", "low"], [2, 5, 8]),
    ]);
  let enter = false,
    heat = 0,
    action = "hold",
    scale = 1,
    details: Record<string, unknown> = {};
  if (id.startsWith("MS-component-")) {
    const key = id.slice(13),
      numeric = sentimentNumericComponents[key],
      category = sentimentCategoryComponents[key];
    if (numeric) heat = tier(num(numeric.field), numeric.cuts, numeric.scores);
    else if (category)
      heat = cat(category.field, category.keys, category.scores);
    else if (key === "defensive")
      heat =
        num("defensiveReturnPct") > 0
          ? 8
          : num("defensiveReturnPct") < 0
            ? 2
            : 5;
    else if (key === "limitRatio") {
      if (num("limitDowns") === 0) throw new Error("涨跌停比零分母");
      heat = tier(
        num("limitUps") / num("limitDowns"),
        [2, 5, 10],
        [3, 5, 8, 10],
      );
    } else if (key === "accountPeak")
      heat = tier(
        (100 * num("accountsWan")) / num("peakAccountsWan"),
        [30, 50, 70],
        [2, 5, 7, 10],
      );
    else if (key === "emotionSpeed")
      heat = tier(
        Math.abs(num("fearGreedChange5")),
        [5, 10, 20],
        [3, 5, 8, 10],
      );
    else if (key === "mediaSearchGap") {
      const gap = num("bullNewsYoy") - num("bullSearchYoy");
      heat = gap > 250 ? 2 : gap > 100 ? 4 : gap >= 0 ? 6 : 9;
    } else if (key === "socialPenetration") {
      const pos = get<number | null>("bestHotPosition"),
        hits = num("financeHits");
      heat = clamp(
        avg([
          hits === 0 ? 1 : tier(hits, [4, 9, 16], [3, 5, 8, 10]),
          pos === null ? 1 : pos <= 3 ? 10 : pos <= 10 ? 8 : pos <= 30 ? 5 : 3,
          tier(num("heatSharePct"), [1, 3, 8, 15], [2, 4, 7, 9, 10]),
        ]) - (bool("negativeHotMajority") ? 2 : 0),
      );
    } else if (key === "officialRisk")
      heat =
        get<string>("officialTone") === "risk" || bool("officialFrontRisk")
          ? 8
          : 0;
    else if (key === "maintenance") heat = num("maintenancePct") < 200 ? 8 : 0;
    else throw new Error("未知情绪子指标");
    enter = ["economy", "money", "geopolitics"].includes(key)
      ? heat >= 5
      : heat < 6;
    if (["economy", "money", "geopolitics"].includes(key)) {
      details.componentScore = heat;
      heat = enter ? 0 : 8;
    }
    details.component = key;
  } else if (id.startsWith("MS-dimension-")) {
    heat = score(id.slice(13));
    enter = heat < 6;
  } else if (id === "MS01") {
    heat = num("fearGreed") / 10;
    enter = heat < 2;
  } else if (id === "MS02") {
    enter =
      num("breadthPct") >= 55 &&
      num("strengthPct") >= 50 &&
      num("newHighs") > num("newLows");
    heat = num("newLows") > 2 * num("newHighs") ? 10 : 0;
  } else if (id === "MS04") {
    const state = get<string>("belief");
    enter = state !== "all-believe";
    heat = state === "all-believe" ? 8 : 0;
    scale = state === "none-believe" ? 0.25 : 1;
    details = { state, subjective: true };
  } else if (id === "MS05") {
    const lev = score("leverage"),
      val = score("valuation"),
      mac = macro();
    enter = lev < 8 && val < 8 && mac >= 5 && num("maintenancePct") >= 200;
    heat = enter ? 0 : 8;
    details = {
      leverage: lev,
      valuation: val,
      macro: mac,
      fragile: num("maintenancePct") < 200,
    };
  } else if (id === "MS06") {
    const search = score("search"),
      risk =
        get<string>("officialTone") === "risk" || bool("officialFrontRisk");
    enter =
      !risk &&
      get<string>("officialTone") === "encourage" &&
      search < 5 &&
      num("fearGreed") < 35;
    heat = risk || search >= 8 ? 8 : 0;
    details = { search, officialRisk: risk };
  } else {
    const scores = Object.fromEntries(dims.map((d) => [d, score(d)]));
    const inside =
        0.25 * scores.volume! +
        0.25 * scores.leverage! +
        0.25 * scores.valuation! +
        0.15 * scores.structure! +
        0.1 * scores.limits!,
      outside =
        0.35 * scores.accounts! +
        0.35 * scores.emotion! +
        0.2 * scores.news! +
        0.1 * scores.search!,
      mac = macro(),
      divergence = inside - outside;
    heat = 0.5 * inside + 0.35 * outside + 0.15 * mac;
    enter =
      id === "MS03"
        ? divergence >= -1.5 && num("maintenancePct") >= 200
        : heat < 6.5 && num("maintenancePct") >= 200;
    details = {
      scores,
      inside,
      outside,
      divergence,
      macro: mac,
      completeDimensions: 9,
      total: heat * 10,
      volatilityDirection: Math.sign(num("fearGreedChange5")),
    };
    if (id === "MS03" && divergence < -1.5) heat = Math.max(8, heat);
  }
  if (heat >= 8.5) {
    action = "exit";
    scale = 0;
  } else if (heat >= 7.5) {
    action = "reduce";
    scale = 0.5;
  } else if (enter) action = "enter";
  return {
    points: Number(enter),
    participation: p.origin,
    details: {
      ...details,
      buyEligible: enter,
      heat,
      action,
      positionScale: scale,
      scope: p.scope,
      volatilityDirection:
        typeof m.fearGreedChange5 === "number"
          ? Math.sign(m.fearGreedChange5)
          : null,
      emotionInterpretation:
        "变化速度是波动烈度；负向骤变不是贪婪，MS01独立保留逆向对照",
      fearGreedIdentity: p.fearGreedIdentity,
      executionBoundary:
        "市场过滤/逆向具名工程对照，同一MA5/10基线、下一合法成交时点、单股25%上限、最长20日；待数据候选未撮合。历史缺项保留，不重归一成完整九维",
    },
  };
}
