import {
  evaluateIndexFactor,
  indexFactorRules,
  indexFactorInputs,
} from "~/lib/research-index-factors";
import {
  chipFactorRules,
  evaluateChipFactor,
} from "~/lib/research-chip-factors";
import {
  queryFactorRules,
  evaluateQueryFactor,
} from "~/lib/research-query-templates";
import {
  evaluateNewsFactor,
  newsFactorRules,
  newsFactorInputs,
  newsReplaySchema,
} from "~/lib/research-news-factors";
import {
  evaluateCrowdingFactor,
  crowdingFactorRules,
} from "~/lib/research-crowding-factors";
import {
  evaluateSentimentFactor,
  sentimentFactorRules,
} from "~/lib/research-sentiment-factors";
import {
  evaluateValueFactor,
  valueFactorRules,
  valueFactorInputs,
} from "~/lib/research-value-factors";
import { researchKellyTraining } from "~/lib/research-kelly-training";
import { researchKellyLimit } from "~/lib/research-kelly";
import { researchWyckoffSeries } from "~/lib/research-wyckoff";
import { growthTrainingSchema, growthOverrideSchema } from "~/lib/as-of-inputs";
import { z } from "zod";
import { createHash } from "node:crypto";
import { createAsOfAdapter, type AsOfDomain } from "~/lib/as-of";
import { asOfInputDefinitions, readAsOfInput } from "~/lib/as-of-inputs";
import {
  buildCanslimAsOfDossier,
  canslimAsOfRequestSchema,
  type CanslimAsOfRequest,
} from "./canslim-as-of-dossier";

import {
  growthHistorySchema,
  growthCrossSectionSchema,
  growthSectorsSchema,
  growthSecuritySchema,
  growthEntrySchema,
  growthEarningsSchema,
  growthEntryEventsSchema,
} from "~/lib/as-of-inputs";
import { researchSepaSeries } from "./research-sepa";
import { researchCanslimHighSeries } from "./research-canslim-high";
import { researchCanslimVolumeTier } from "./research-canslim-volume-tier";
import { researchCanslimMarketScore } from "./research-canslim-market-score";
import { researchCanslimCupPoint } from "./research-canslim-cup";
import { researchCanslimFlatPoint } from "./research-canslim-flat";
import { researchCanslimSaucerPoint } from "./research-canslim-saucer";
import { canslimCaps } from "./canslim-scorecard";

// Named research interpretations; thresholds absent from the source are explicit here.
export const growthCombinationRules: Record<string, string> = {
  SE01: "严格/弹性财务两版并列，七趋势含冻结全池60日RS85，既有VCP首次枢纽突破；日收盘研究版非14:30买入",
  "CA-T-sector":
    "冻结同日多板块，20交易日板块收益严格正且位于前50%；取最强所属板块",
  "CA-T-smallcap":
    "流通市值低于100亿且换手率至少10%为游资代理，形态候选权重减半；不证明游资身份",
  "CA-T-earnings-window":
    "财报前5交易日至披露后3交易日谨慎窗口，形态候选减半；预约和已披露分开",
  "CA-S-L1":
    "全池60交易日可比收益百分位95/90/80/70给9/7/5/2；严格更低者/(有效数-1)，并列不拆",
  "CA-B-L1": "RS至少80二元9分，与细则5分独立",
  "CA-S-L1-ipo":
    "不足60交易日，目标上市日起全池同一窗口百分位，降置信度；非各自上市以来混窗",
  "CA-S-L2":
    "冻结20交易日板块及成员收益，最强所属板块内1/2-3/4-10名给6/5/3，后50%封顶3",
  "CA-B-L2": "最强所属板块内前三二元6分，不把行业前三当个股前三",
  "CA-E-rs80": "完整同日60交易日证券池百分位至少80准入",
  "CA-L-query-screen": "RS80、20>60>120日均线、总市值严格大于50亿",
  "CA-E-ipo60-risk": "上市不足60交易日标注风险，候选权重减半，不冒充硬性禁入",
  "CA-S-ipo-year-confidence":
    "上市未满一个自然年标低置信度，独立过滤组合；闰日周年取次年3月1日",
  "SE-E-five":
    "收盘>枢纽101%、量>=前20日均量150%、计划价<=105%；沪深300>MA120或近期催化",
  "CA-E-five": "核心三项全过且市场或催化成立BUY，两者都否WATCH，核心任一否PASS",
  "CA-E-five-soft": "核心失败WATCH，保留buyEligible=false，与细则PASS分开",
  "CA-E-catalyst":
    "已知未撤销盈利超预期/研报上调/调研，工程近期窗口20自然日含端点",
  "SE-E-earnings13":
    "已披露超一致预期严格>0，披露后1至3交易日，既有VCP趋势形态保持成熟；一致预期版本须早于披露",
  "SE-E-exclusions":
    "历史ST/退市风险/上市首日/北交所/长期停牌复牌过滤；长期工程阈值20交易日",
  "CA-E-earnings5": "已知预约财报在未来0至5交易日禁入，覆盖日历须包含预约日",
  "CA-E-reported5": "最近已披露后超过5交易日才通过，不替代未来5日预约禁入",
  "CA-S-total-absolute":
    "17项细则合计114，93/70/47分档，候选仓位上限25/12.5/0/0%",
  "CA-S-total-ratio": "固定114分分母80/60/40%分档，不按可得容量归一",
  "CA-S-weighted-ratio":
    "各因子按固定20/20/15/13/15/8/23容量归一，再乘20/20/15/15/15/5/10%权重",
  "CA-S-C-downgrade": "细则C低于10则绝对分档下降一级，工程固定降档不改原始分",
  "CA-S-missing":
    "缺失/冲突0贡献仅用于显示，完整证据为准入门槛；缺失不算规则失败，容量不重归一",
  CA07: "完整17细则分项筛选>=70，截面按同参与类型排序，缺失不排名",
  CA01: "完整17细则>=70且M>=6+既有严格U杯柄首次突破，独立财报/风险/身份/RS纪律",
  CA02: "完整17细则>=70且M>=6+既有平台首次突破，独立财报/风险/身份/RS纪律",
  CA03: "完整17细则>=70且M>=6+既有U/W碟形平底首次突破，独立财报/风险/身份/RS纪律",
  "CA-S-S1-limitup":
    "缩量涨停不认定量不足；工程单独实验给至少达标6分，涨停仍不准买入；非原文确定分",
};

export const growthDisciplineRules: Record<string, string> = {
  "CA-E-exclusions":
    "完整历史身份/止损/RS80/M6/预约财报/风险回报与冷静期；同CA形态基线",
  "CA-E-checklist70": "17项114分版>=70、M>=6、既有形态确认及不可覆盖的风险纪律",
  "CA-E-soft-overrides":
    "事前冻结仅允许总分65至69弱项；形态、M、RS、身份、财报及风险不放宽，非临场LLM",
  "SE-E-checklist":
    "严格四核心+盈利惊喜>=10%第五项、七趋势/VCP6/市场/预约财报/风险全过",
  "CA-K-kelly25":
    "B2开发段30闭合样本实测p；20%入场空间/止损>=2.5，半凯利/1.5%风险/25%取小",
  "SE-K-kelly":
    "B2实测p；入场30%与枢纽30%两目标分名，>=3，半凯利/1.5%风险/25%取小",
  "SE-K-quality":
    "两门及VCP8/6映射假设p .55/.48/.40，不冒充实测；仍要求B2训练准入",
  "CA-K-quality":
    "完整评分93/70及强形态映射假设p .55/.48/.40，工程质量分档；仍要求B2训练准入",
  "WY-K-quality":
    "复用确认结构事件，20交易日同一结构多重/单一/弱信号映射假设p；仍要求B2训练准入，2%/30%",
  "SE-K-script-quality":
    "SEPA入口质量强档额外要求量>=前20均量2倍；p仅假设，仍要求B2训练准入",
};

const combinationFields = (id: string): [AsOfDomain, string[]][] => {
  if (Object.hasOwn(growthDisciplineRules, id))
    return [
      ["rs", ["priceHistory"]],
      ["capital", ["entryPlan"]],
      ...(id.includes("-K-")
        ? [["capital", ["kellyTraining"]] as [AsOfDomain, string[]]]
        : []),
      ...(id === "CA-E-soft-overrides"
        ? [["capital", ["softOverride"]] as [AsOfDomain, string[]]]
        : []),
    ];
  const rs: [AsOfDomain, string[]] = ["rs", ["crossSection", "members"]];
  const h: [AsOfDomain, string[]] = ["rs", ["priceHistory"]];
  const state: [AsOfDomain, string[]] = ["capital", ["securityState"]];
  const earnings: [AsOfDomain, string[]] = ["catalysts", ["earningsWindow"]];
  const entry: [AsOfDomain, string[]][] = [
    h,
    ["capital", ["entryPlan"]],
    ["catalysts", ["entryEvents"]],
  ];
  if (["CA-S-L1", "CA-B-L1", "CA-S-L1-ipo", "CA-E-rs80"].includes(id))
    return [rs];
  if (id === "CA-L-query-screen") return [rs, h, state];
  if (["CA-S-L2", "CA-B-L2"].includes(id)) return [["rs", ["sectors"]]];
  if (id === "CA-T-sector") return [h, ["rs", ["sectors"]]];
  if (id === "CA-T-smallcap")
    return [h, state, ["capital", ["floatMarketCap"]]];
  if (
    ["CA-E-ipo60-risk", "CA-S-ipo-year-confidence", "CA-S-S1-limitup"].includes(
      id,
    )
  )
    return [h, state];
  if (id === "SE-E-exclusions") return [state];
  if (["CA-E-earnings5", "CA-E-reported5"].includes(id)) return [earnings];
  if (["CA-T-earnings-window", "SE-E-earnings13"].includes(id))
    return [h, earnings];
  if (id === "CA-E-catalyst") return [["catalysts", ["entryEvents"]]];
  if (["CA-E-five", "CA-E-five-soft", "SE-E-five"].includes(id)) return entry;
  if (id === "SE01") return [...entry, rs];
  return [
    h,
    rs,
    ["rs", ["sectors"]],
    ["capital", ["floatMarketCap", "plans"]],
    ["catalysts", ["growthEvents"]],
    ...(["CA01", "CA02", "CA03"].includes(id)
      ? [...entry, state, earnings]
      : []),
  ];
};

type Rule = {
  family:
    | "finance"
    | "catalyst"
    | "capital"
    | "institution"
    | "combination"
    | "value"
    | "index"
    | "crowding"
    | "chip"
    | "query"
    | "sentiment"
    | "news";
  kind: string;
  binary?: boolean;
  cap: number;
  threshold: number;
  note: string;
};
// Source main-text binary rules and reference tier rules are separate methods.
export const growthFactorMethods: Record<string, Rule> = {
  ...Object.fromEntries(
    Object.entries(queryFactorRules).map(([id, note]) => [
      id,
      { family: "query" as const, kind: id, cap: 1, threshold: 1, note },
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(chipFactorRules).map(([id, note]) => [
      id,
      { family: "chip" as const, kind: id, cap: 1, threshold: 1, note },
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(newsFactorRules).map(([id, note]) => [
      id,
      { family: "news" as const, kind: id, cap: 1, threshold: 1, note },
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(sentimentFactorRules).map(([id, note]) => [
      id,
      { family: "sentiment" as const, kind: id, cap: 1, threshold: 1, note },
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(crowdingFactorRules).map(([id, note]) => [
      id,
      { family: "crowding" as const, kind: id, cap: 1, threshold: 1, note },
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(indexFactorRules).map(([id, note]) => [
      id,
      { family: "index" as const, kind: id, cap: 1, threshold: 1, note },
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(valueFactorRules).map(([id, note]) => [
      id,
      { family: "value" as const, kind: id, cap: 100, threshold: 1, note },
    ]),
  ),
  ...Object.fromEntries(
    Object.entries({ ...growthCombinationRules, ...growthDisciplineRules }).map(
      ([id, note]) => [
        id,
        {
          family: "combination" as const,
          kind: id,
          cap:
            id === "CA-S-weighted-ratio"
              ? 100
              : id === "CA-S-L1" || id === "CA-B-L1" || id === "CA-S-L1-ipo"
                ? 9
                : id === "CA-S-L2" || id === "CA-B-L2"
                  ? 6
                  : id === "CA-S-S1-limitup"
                    ? 8
                    : [
                          "CA07",
                          "CA-S-total-absolute",
                          "CA-S-total-ratio",
                          "CA-S-weighted-ratio",
                          "CA-S-C-downgrade",
                          "CA-S-missing",
                        ].includes(id)
                      ? 114
                      : 1,
          threshold:
            id === "CA-S-L1" || id === "CA-S-L1-ipo"
              ? 5
              : id === "CA-B-L1"
                ? 9
                : id === "CA-S-L2"
                  ? 5
                  : id === "CA-B-L2"
                    ? 6
                    : id === "CA-S-S1-limitup"
                      ? 6
                      : id === "CA07"
                        ? 70
                        : 1,
          note,
        },
      ],
    ),
  ),
  SE02: {
    family: "finance",
    kind: "sepa",
    cap: 4,
    threshold: 2,
    note: "四核心严格/20%容差并列；年报ROE版本，净利率改善在宽松版仍必需",
  },
  ...(Object.fromEntries(
    (["C1", "C2", "C3", "A1", "A2", "A3"] as const).flatMap((kind, i) => [
      [
        `CA-S-${kind}`,
        {
          family: "finance",
          kind,
          cap: [8, 7, 5, 8, 7, 5][i]!,
          threshold: [6, 5, 4, 6, 5, 4][i]!,
          note: "评分细则多档；EPS不替代为净利润，ROE采用具名年报版",
        },
      ],
      [
        `CA-B-${kind}`,
        {
          family: "finance",
          kind,
          binary: true,
          cap: [8, 7, 5, 8, 7, 5][i]!,
          threshold: [8, 7, 5, 8, 7, 5][i]!,
          note: "主文二元阈值；EPS标题口径，不混净利润查询口径",
        },
      ],
    ]),
  ) as Record<string, Rule>),
  "CA-S-C1-turnaround": {
    family: "finance",
    kind: "quarter-turn",
    cap: 8,
    threshold: 8,
    note: "同期EPS严格负且本期严格正；不将负增速视为扭亏",
  },
  "CA-S-A1-turnaround": {
    family: "finance",
    kind: "annual-turn",
    cap: 8,
    threshold: 8,
    note: "3至5连续年报首负末正，不产生CAGR",
  },
  "CA-S-A1-loss-exclusion": {
    family: "finance",
    kind: "annual-exclude",
    cap: 8,
    threshold: 6,
    note: "删除中间负EPS年但保留真实日历跨度；不删除零值或端点，输出删除轨迹",
  },
  ...(Object.fromEntries(
    [
      ["CA-S-N1", "all", false],
      ["CA-B-N1", "all", true],
      ["CA-S-N1-rumor2", "rumor", false],
      ...[
        "product",
        "management",
        "policy",
        "contract",
        "incentive",
        "forecast50",
      ].map((k) => [
        `CA-S-N1-${k}`,
        k === "forecast50" ? "forecast" : k,
        false,
      ]),
    ].map(([id, kind, binary]) => [
      id,
      {
        family: "catalyst",
        kind,
        binary,
        cap: 6,
        threshold: kind === "rumor" ? 2 : 4,
        note: "冻结结构化事件；规则/人工分开，传闻2分单列；合同金额>=最近年营收10%为工程重大性阈值",
      },
    ]),
  ) as Record<string, Rule>),
  "CA-S-S2": {
    family: "capital",
    kind: "full",
    cap: 5,
    threshold: 4,
    note: "市值重叠边界取高档；三日历月解禁-1、有效回购+1，钳制0..5",
  },
  "CA-B-S2": {
    family: "capital",
    kind: "binary",
    cap: 5,
    threshold: 5,
    note: "主文50至500亿元闭区间二元，不混细则事件修正",
  },
  "CA-S-S2-unlock": {
    family: "capital",
    kind: "unlock",
    cap: 5,
    threshold: 4,
    note: "基础分减解禁1分，与完整修正独立对照",
  },
  "CA-S-S2-buyback": {
    family: "capital",
    kind: "buyback",
    cap: 5,
    threshold: 4,
    note: "基础分加有效回购计划1分，上限5；不声称实际减股",
  },
  "CA-S-I1": {
    family: "institution",
    kind: "shares",
    cap: 5,
    threshold: 4,
    note: "三个连续季度两次持股增加，两次均严格>10%满分；家数增比例降例外2分",
  },
  "CA-B-I1": {
    family: "institution",
    kind: "shares",
    binary: true,
    cap: 5,
    threshold: 5,
    note: "主文最近两期股数比较，严格增加5分",
  },
  "CA-S-I1-turnover": {
    family: "institution",
    kind: "turnover",
    cap: 2,
    threshold: 2,
    note: "最近两期家数严格增且比例严格降2分，独立识别例外",
  },
  "CA-S-I2": {
    family: "institution",
    kind: "holders",
    cap: 3,
    threshold: 2,
    note: "时点分类版本；公募与外资3/之一2/一般或私募1/无0",
  },
  "CA-B-I2": {
    family: "institution",
    kind: "holders",
    binary: true,
    cap: 3,
    threshold: 3,
    note: "主文优质公募或外资任一3分；私募不自动等同优质公募",
  },
};

class InputGap extends Error {}
const tier = (value: number, rows: number[][]) =>
  rows.find(([cut]) => value >= cut!)?.[1] ?? 0;
const quarter = (d: string) =>
  Number(d.slice(0, 4)) * 4 + Number(d.slice(5, 7)) / 3;
const previousYear = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
const clamp = (n: number) => Math.max(0, Math.min(5, n));
function threeMonths(date: string) {
  const d = new Date(`${date}T00:00:00Z`),
    day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 4);
  d.setUTCDate(0);
  d.setUTCDate(Math.min(day, d.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

/** Offline factor research entry: no report text, provider call, order, or P&L.
 * Every value flows through B6a, including supplementary structured fields.
 */
export function evaluateGrowthFactors(
  request: CanslimAsOfRequest,
  observations: unknown,
  methodIds: readonly string[] = Object.keys(growthFactorMethods),
) {
  const dossier = buildCanslimAsOfDossier(request, observations);
  const req = dossier.request;
  if (
    Date.parse(`${req.observationDate}T00:00:00+08:00`) > Date.parse(req.asOf)
  )
    throw new Error("观察日期晚于as-of截止时间");
  const adapter = createAsOfAdapter(observations, {
    asOf: req.asOf,
    capturedBy: req.capturedBy,
  });
  const q = [...req.financialPeriods].sort().reverse(),
    a = [...req.annualPeriods].sort().reverse(),
    ins = [...req.institutionPeriods].sort().reverse();
  const readRows = Object.values(dossier.inputs).flat();
  const results = [...new Set(methodIds)].map((methodId) => {
    if (!Object.hasOwn(growthFactorMethods, methodId))
      throw new Error(`未知成长因子: ${methodId}`);
    const rule = growthFactorMethods[methodId]!;
    const requiredInputs: {
      domain: AsOfDomain;
      field: string;
      effectiveAt: string;
      unit: string;
    }[] = [];
    const requireFields = (
      domain: AsOfDomain,
      fields: string[],
      dates: string[],
    ) => {
      for (const field of fields)
        for (const effectiveAt of dates)
          requiredInputs.push({
            domain,
            field,
            effectiveAt,
            unit: asOfInputDefinitions[domain][field]!.unit,
          });
    };
    if (rule.family === "query") {
      requireFields("capital", ["queryPanel"], [req.observationDate]);
    } else if (rule.family === "chip") {
      requireFields("capital", ["chipHistory"], [req.observationDate]);
    } else if (rule.family === "news") {
      for (const v of newsFactorInputs(methodId, req.observationDate))
        requireFields(v.domain, [v.field], [v.effectiveAt]);
    } else if (rule.family === "sentiment") {
      requireFields("capital", ["sentimentPanel"], [req.observationDate]);
    } else if (rule.family === "crowding") {
      requireFields("capital", ["crowdingPanel"], [req.observationDate]);
    } else if (rule.family === "index") {
      for (const v of indexFactorInputs(req.observationDate))
        requireFields(v.domain, [v.field], [v.effectiveAt]);
    } else if (rule.family === "value") {
      for (const v of valueFactorInputs(methodId, req))
        requireFields(v.domain, [v.field], [v.effectiveAt]);
    } else if (rule.family === "combination") {
      for (const [domain, fields] of combinationFields(methodId))
        requireFields(domain, fields, [req.observationDate]);
      const total = [
        "CA01",
        "CA02",
        "CA03",
        "CA07",
        "CA-S-total-absolute",
        "CA-S-total-ratio",
        "CA-S-weighted-ratio",
        "CA-S-C-downgrade",
        "CA-S-missing",
      ].includes(methodId);
      if (methodId === "SE01") {
        requireFields(
          "finance",
          ["quarterlyProfitGrowth", "quarterlyRevenueGrowth"],
          q.slice(0, 2),
        );
        requireFields(
          "finance",
          ["quarterlyNetMargin"],
          [q[0]!, previousYear(q[0]!)],
        );
        requireFields("finance", ["annualRoe"], [a[0]!]);
      }
      if (total) {
        requireFields(
          "finance",
          ["quarterlyEps"],
          [q[0]!, previousYear(q[0]!)],
        );
        requireFields("finance", ["quarterlyEpsGrowth"], q.slice(0, 3));
        requireFields(
          "finance",
          ["quarterlyRevenueGrowth", "quarterlyProfitGrowth"],
          [q[0]!],
        );
        requireFields("finance", ["annualEps"], a.slice(0, 5));
        requireFields("finance", ["annualCashPerShare", "annualRoe"], [a[0]!]);
        requireFields("institutions", ["shares"], ins.slice(0, 3));
        requireFields("institutions", ["count", "floatRatio"], ins.slice(0, 2));
        requireFields("institutions", ["holders"], [ins[0]!]);
      }
    } else if (rule.family === "finance") {
      if (["C1", "quarter-turn"].includes(rule.kind))
        requireFields(
          "finance",
          ["quarterlyEps"],
          [q[0]!, previousYear(q[0]!)],
        );
      if (rule.kind === "C2")
        requireFields(
          "finance",
          ["quarterlyEpsGrowth"],
          q.slice(0, rule.binary ? 2 : 3),
        );
      if (rule.kind === "C3")
        requireFields(
          "finance",
          rule.binary
            ? ["quarterlyRevenueGrowth"]
            : ["quarterlyRevenueGrowth", "quarterlyProfitGrowth"],
          [q[0]!],
        );
      if (["A1", "annual-turn", "annual-exclude"].includes(rule.kind))
        requireFields("finance", ["annualEps"], a.slice(0, 5));
      if (rule.kind === "A2") requireFields("finance", ["annualRoe"], [a[0]!]);
      if (rule.kind === "A3")
        requireFields("finance", ["annualEps", "annualCashPerShare"], [a[0]!]);
      if (rule.kind === "sepa") {
        requireFields(
          "finance",
          ["quarterlyProfitGrowth", "quarterlyRevenueGrowth"],
          q.slice(0, 2),
        );
        requireFields(
          "finance",
          ["quarterlyNetMargin"],
          [q[0]!, previousYear(q[0]!)],
        );
        requireFields("finance", ["annualRoe"], [a[0]!]);
      }
    } else if (rule.family === "capital")
      requireFields(
        "capital",
        rule.kind === "binary"
          ? ["floatMarketCap"]
          : ["floatMarketCap", "plans"],
        [req.observationDate],
      );
    else if (rule.family === "institution") {
      if (rule.kind === "holders")
        requireFields("institutions", ["holders"], [ins[0]!]);
      else {
        if (rule.kind !== "turnover")
          requireFields(
            "institutions",
            ["shares"],
            ins.slice(0, rule.binary ? 2 : 3),
          );
        if (!rule.binary)
          requireFields(
            "institutions",
            ["count", "floatRatio"],
            ins.slice(0, 2),
          );
      }
    } else if (rule.family === "catalyst")
      requireFields("catalysts", ["growthEvents"], [req.observationDate]);
    const evidence: typeof readRows = [],
      gaps: { field: string; effectiveAt: string; reason: string }[] = [];
    const read = (domain: AsOfDomain, field: string, effectiveAt: string) => {
      if (
        !requiredInputs.some(
          (r) =>
            r.domain === domain &&
            r.field === field &&
            r.effectiveAt === effectiveAt,
        )
      )
        requiredInputs.push({
          domain,
          field,
          effectiveAt,
          unit: asOfInputDefinitions[domain][field]!.unit,
        });
      const entity =
        domain === "rs" && field === "members" ? req.universeId : req.symbol;
      const query = { domain, field, effectiveAt, entity };
      const row = readRows.find(
        (r) =>
          r.domain === domain &&
          r.field === field &&
          r.effectiveAt === effectiveAt &&
          r.entity === entity,
      ) ?? { ...query, ...readAsOfInput(adapter, query) };
      if (
        !evidence.some(
          (r) =>
            r.domain === domain &&
            r.field === field &&
            r.effectiveAt === effectiveAt,
        )
      )
        evidence.push(row);
      if (row.status === "missing") {
        gaps.push({
          field: `${domain}/${field}`,
          effectiveAt,
          reason: row.reason,
        });
        throw new InputGap(row.reason);
      }
      if (
        ((domain === "rs" &&
          ["priceHistory", "crossSection", "sectors"].includes(field)) ||
          (domain === "capital" &&
            [
              "valueMarket",
              "valueThesisObservations",
              "indexValuation",
              "crowdingPanel",
            ].includes(field))) &&
        Date.parse(row.provenance.availableAt) <
          Date.parse(`${effectiveAt}T15:00:00+08:00`)
      ) {
        const reason = "日收盘面板的首次可知时间早于收盘，证据不可信";
        gaps.push({ field: `${domain}/${field}`, effectiveAt, reason });
        throw new InputGap(reason);
      }
      const frozenGap = (reason: string) => {
        gaps.push({ field: `${domain}/${field}`, effectiveAt, reason });
        return new InputGap(reason);
      };
      if (field === "newsReplay") {
        const v = newsReplaySchema.parse(row.value);
        const immutable = (x: z.infer<typeof newsReplaySchema>) =>
          JSON.stringify(x);
        if (Array.isArray(observations))
          for (const raw of observations) {
            const candidate = z
              .object({
                field: z.string(),
                availableAt: z.string(),
                capturedAt: z.string(),
                value: z.unknown(),
              })
              .safeParse(raw);
            if (
              !candidate.success ||
              candidate.data.field !== "newsReplay" ||
              Date.parse(candidate.data.availableAt) > Date.parse(req.asOf) ||
              (req.capturedBy !== undefined &&
                Date.parse(candidate.data.capturedAt) >
                  Date.parse(req.capturedBy))
            )
              continue;
            const other = newsReplaySchema.safeParse(candidate.data.value);
            if (
              other.success &&
              other.data.archiveId === v.archiveId &&
              immutable(other.data) !== immutable(v)
            )
              throw frozenGap(
                "同一archiveId的原文/prompt/模型/映射/首次结果不可替换；新计算须新档案身份",
              );
          }
        for (const [bytes, digest] of [
          [v.rawInput, v.rawInputHash],
          [v.prompt, v.promptHash],
          [v.firstResult, v.firstResultHash],
        ])
          if (createHash("sha256").update(bytes!).digest("hex") !== digest)
            throw frozenGap(
              "原始输入/prompt/首次结果hash不一致，拒绝篡改后的重放",
            );
        if (
          Date.parse(v.firstProcessedAt) >
            Date.parse(row.provenance.availableAt) ||
          Date.parse(v.firstProcessedAt) > Date.parse(row.provenance.capturedAt)
        )
          throw frozenGap("首次结果可知/存档早于模型处理完成");
      }
      if (
        ["eventMarket", "newsSectorPanel"].includes(field) &&
        Date.parse(row.provenance.availableAt) <
          Date.parse(`${effectiveAt}T15:00:00+08:00`)
      )
        throw frozenGap("消息日终价格/资金面板不得早于收盘可知");
      if (
        [
          "valuePolicy",
          "softOverride",
          "indexPolicy",
          "indexEtfMapping",
        ].includes(field)
      ) {
        const frozen = (row.value as { frozenAt: string }).frozenAt;
        if (
          Date.parse(row.provenance.availableAt) > Date.parse(frozen) ||
          Date.parse(row.provenance.capturedAt) > Date.parse(frozen)
        )
          throw frozenGap(
            "冻结参数缺当时档案：首次可知/采集晚于冻结时间；不得事后回填假设",
          );
      }
      if (field === "sentimentPanel") {
        const v = row.value as { origin: string; classifiedAt: string };
        if (
          Date.parse(v.classifiedAt) > Date.parse(req.asOf) ||
          (v.origin !== "rule" &&
            Date.parse(row.provenance.capturedAt) > Date.parse(req.asOf))
        )
          throw frozenGap("情绪分类缺当时处理/采集证据");
      }
      if (field === "valueThesisObservations") {
        const values = Object.values(
          row.value as Record<string, { origin: string; recordedAt: string }>,
        );
        if (
          values.some(
            (v) =>
              v.origin !== "rule" &&
              (Date.parse(v.recordedAt) > Date.parse(req.asOf) ||
                Date.parse(row.provenance.capturedAt) > Date.parse(req.asOf)),
          )
        )
          throw frozenGap("人工/LLM观察无当时归档证据，不充当历史已知判断");
      }
      if (field === "valueTheses") {
        const theses = row.value as { frozenAt: string; recordedAt: string }[];
        if (
          theses.some(
            (t) =>
              Date.parse(row.provenance.availableAt) > Date.parse(t.frozenAt) ||
              Date.parse(row.provenance.capturedAt) > Date.parse(t.frozenAt) ||
              Date.parse(t.recordedAt) > Date.parse(t.frozenAt),
          )
        )
          throw frozenGap("主观假设缺当时冻结档案，不接收回放时生成的历史预测");
      }
      return row.value;
    };
    const n = (field: string, period: string, domain: AsOfDomain = "finance") =>
      z
        .number()
        .finite()
        .parse(read(domain, field, period));
    const periods = (list: string[], count: number, annual = false) => {
      if (
        list.length < count ||
        list
          .slice(0, count)
          .some(
            (d, i) =>
              i > 0 &&
              (annual
                ? Number(list[i - 1]!.slice(0, 4)) - Number(d.slice(0, 4)) !== 1
                : quarter(list[i - 1]!) - quarter(d) !== 1),
          )
      )
        throw new InputGap(
          `需要${count}个连续${annual ? "年度" : "季度"}报告期，缺口不能跳过`,
        );
      return list.slice(0, count);
    };
    let points: number | null = null,
      details: Record<string, unknown> = {},
      mode: "rule" | "human" | "llm" = "rule";
    for (const input of requiredInputs) {
      try {
        read(input.domain, input.field, input.effectiveAt);
      } catch (error) {
        if (!(error instanceof InputGap)) throw error;
      }
    }
    try {
      if (gaps.length && methodId !== "CA-S-missing")
        throw new InputGap("所需字段尚未全部覆盖");
      if (rule.family === "query") {
        try {
          const v = evaluateQueryFactor(methodId, req, read);
          points = v.points;
          details = v.details;
          mode = v.participation;
        } catch (error) {
          if (error instanceof InputGap) throw error;
          throw new InputGap(
            error instanceof Error ? error.message : "查询输入无效",
          );
        }
      } else if (rule.family === "chip") {
        try {
          const v = evaluateChipFactor(methodId, req, read);
          points = v.points;
          details = v.details;
          mode = v.participation;
        } catch (error) {
          if (error instanceof InputGap) throw error;
          throw new InputGap(
            error instanceof Error ? error.message : "筹码输入无效",
          );
        }
      } else if (rule.family === "news") {
        try {
          const v = evaluateNewsFactor(methodId, req, read);
          points = v.points;
          details = v.details;
          mode = v.participation;
        } catch (error) {
          if (error instanceof InputGap) throw error;
          throw new InputGap(
            error instanceof Error ? error.message : "冻结新闻输入无效",
          );
        }
      } else if (rule.family === "sentiment") {
        try {
          const v = evaluateSentimentFactor(methodId, req, read);
          points = v.points;
          details = v.details;
          mode = v.participation;
        } catch (error) {
          if (error instanceof InputGap) throw error;
          throw new InputGap(
            error instanceof Error ? error.message : "情绪输入无效",
          );
        }
      } else if (rule.family === "crowding") {
        try {
          const v = evaluateCrowdingFactor(methodId, req, read);
          points = v.points;
          details = v.details;
          mode = v.participation;
        } catch (error) {
          if (error instanceof InputGap) throw error;
          throw new InputGap(
            error instanceof Error ? error.message : "拥挤输入无效",
          );
        }
      } else if (rule.family === "index") {
        try {
          const v = evaluateIndexFactor(methodId, req, read);
          points = v.points;
          details = v.details;
          mode = v.participation;
        } catch (error) {
          if (error instanceof InputGap) throw error;
          throw new InputGap(
            error instanceof Error ? error.message : "指数输入无效",
          );
        }
      } else if (rule.family === "value") {
        try {
          const v = evaluateValueFactor(methodId, req, read);
          points = v.points;
          details = v.details;
          mode = v.participation;
        } catch (error) {
          if (error instanceof InputGap) throw error;
          throw new InputGap(
            error instanceof Error ? error.message : "估值输入无效",
          );
        }
      } else if (rule.family === "combination") {
        const supplemental = evaluateGrowthCombination(
          methodId,
          req,
          read,
          (ids) => {
            const children = evaluateGrowthFactors(
              req,
              observations,
              ids,
            ).results;
            for (const child of children) {
              for (const input of child.requiredInputs)
                if (
                  !requiredInputs.some(
                    (r) =>
                      r.domain === input.domain &&
                      r.field === input.field &&
                      r.effectiveAt === input.effectiveAt,
                  )
                )
                  requiredInputs.push(input);
              evidence.push(...child.evidence);
              gaps.push(...child.dataGaps);
              if (child.participation === "human") mode = "human";
            }
            return children;
          },
        );
        points = supplemental.points;
        details = supplemental.details;
        if (supplemental.human) mode = "human";
      } else if (rule.family === "finance") {
        const kind = rule.kind;
        if (kind === "C1" || kind === "quarter-turn") {
          const current = n("quarterlyEps", q[0]!),
            base = n("quarterlyEps", previousYear(q[0]!));
          if (kind === "quarter-turn") points = base < 0 && current > 0 ? 8 : 0;
          else {
            if (base <= 0)
              throw new InputGap(
                "EPS同比基数非正，使用独立扭亏分支；零基数不算增长",
              );
            const growth = (current / base - 1) * 100;
            points = rule.binary
              ? current >= base * 1.25
                ? 8
                : 0
              : current >= base * 1.5
                ? 8
                : current >= base * 1.25
                  ? 6
                  : current >= base * 1.2
                    ? 3
                    : 0;
            details = { growthPct: growth };
          }
        } else if (kind === "C2") {
          const [d0, d1] = periods(q, 2);
          const cur = n("quarterlyEpsGrowth", d0!),
            prev = n("quarterlyEpsGrowth", d1!);
          if (rule.binary) points = cur > prev ? 7 : 0;
          else {
            // A requested third period is mandatory for the three-quarter branch.
            const third =
              q.length >= 3 ? n("quarterlyEpsGrowth", periods(q, 3)[2]!) : null;
            points =
              cur > prev
                ? cur < 20
                  ? 3
                  : third !== null && prev > third
                    ? 7
                    : 5
                : Math.abs(cur - prev) < 5 || (cur >= 50 && prev >= 50)
                  ? 3
                  : 0;
          }
          details = { current: cur, previous: prev };
        } else if (kind === "C3") {
          const revenue = n("quarterlyRevenueGrowth", q[0]!);
          points = rule.binary
            ? revenue >= 20
              ? 5
              : 0
            : Math.max(
                0,
                tier(revenue, [
                  [30, 5],
                  [20, 4],
                  [10, 2],
                ]) -
                  (revenue > 0 && n("quarterlyProfitGrowth", q[0]!) < 0
                    ? 1
                    : 0),
              );
        } else if (["A1", "annual-turn", "annual-exclude"].includes(kind)) {
          const dates = periods(a, Math.min(a.length, 5), true);
          if (dates.length < 3) throw new InputGap("年度增长需3至5个连续年报");
          const vals = dates.map((d) => n("annualEps", d)),
            current = vals[0]!,
            base = vals.at(-1)!;
          const years =
            Number(dates[0]!.slice(0, 4)) - Number(dates.at(-1)!.slice(0, 4));
          details = {
            periods: dates,
            years,
            excludedPeriods:
              kind === "annual-exclude"
                ? dates.filter(
                    (_, i) => i > 0 && i < dates.length - 1 && vals[i]! < 0,
                  )
                : [],
          };
          if (kind === "annual-turn") points = base < 0 && current > 0 ? 8 : 0;
          else {
            if (
              base <= 0 ||
              current <= 0 ||
              vals.some(
                (v, i) =>
                  v <= 0 &&
                  !(
                    kind === "annual-exclude" &&
                    v < 0 &&
                    i > 0 &&
                    i < vals.length - 1
                  ),
              )
            )
              throw new InputGap(
                "年度EPS非正，严格版不删除年份；扭亏和删中间亏损年另列",
              );
            const ratio = current / base;
            points = rule.binary
              ? ratio >= 1.25 ** years
                ? 8
                : 0
              : ratio >= 1.35 ** years
                ? 8
                : ratio >= 1.25 ** years
                  ? 6
                  : ratio >= 1.15 ** years
                    ? 3
                    : 0;
            details.cagrPct = (ratio ** (1 / years) - 1) * 100;
          }
        } else if (kind === "A2") {
          const roe = n("annualRoe", a[0]!);
          points = rule.binary
            ? roe >= 17
              ? 7
              : 0
            : tier(roe, [
                [25, 7],
                [17, 5],
                [12, 2],
              ]);
          details = { roe, roeBasis: "annual", lowEquityRisk: roe > 50 };
        } else if (kind === "A3") {
          const eps = n("annualEps", a[0]!),
            cash = n("annualCashPerShare", a[0]!);
          points =
            eps <= 0 || cash < 0
              ? 0
              : rule.binary
                ? cash >= eps
                  ? 5
                  : 0
                : cash >= eps * 1.2
                  ? 5
                  : cash >= eps
                    ? 4
                    : cash >= eps * 0.7
                      ? 2
                      : 0;
        } else if (kind === "sepa") {
          const dates = periods(q, 2),
            profits = dates.map((d) => n("quarterlyProfitGrowth", d)),
            revenues = dates.map((d) => n("quarterlyRevenueGrowth", d));
          const margin = n("quarterlyNetMargin", q[0]!),
            old = n("quarterlyNetMargin", previousYear(q[0]!)),
            roe = n("annualRoe", a[0]!);
          const strict = [
            profits.every((v) => v >= 25),
            revenues.every((v) => v >= 20),
            margin >= 15 && margin > old,
            roe >= 17,
          ];
          const tolerant = [
            profits.every((v) => v >= 20),
            revenues.every((v) => v >= 16),
            margin >= 12 && margin > old,
            roe >= 13.6,
          ];
          const count = strict.filter(Boolean).length,
            strictPass = count === 4,
            flexiblePass = count >= 2 && tolerant.every(Boolean);
          points = flexiblePass ? count : 0;
          details = {
            strictPass,
            flexiblePass,
            strict,
            tolerant,
            confidence: strictPass ? "standard" : "reduced",
            roeBasis: "annual",
          };
        }
      } else if (rule.family === "capital") {
        const cap = n("floatMarketCap", req.observationDate, "capital") / 1e8;
        const base =
          cap >= 100 && cap <= 300
            ? 5
            : cap >= 50 && cap <= 500
              ? 4
              : cap >= 30 && cap <= 1000
                ? 2
                : 0;
        if (rule.kind === "binary") points = cap >= 50 && cap <= 500 ? 5 : 0;
        else {
          const plans = z
            .object({
              unlockDates: z.array(z.string()),
              activeBuybackPlan: z.boolean(),
            })
            .parse(read("capital", "plans", req.observationDate));
          const end = threeMonths(req.observationDate),
            unlock = plans.unlockDates.some(
              (d) => d >= req.observationDate && d <= end,
            );
          points = clamp(
            base -
              (rule.kind !== "buyback" && unlock ? 1 : 0) +
              (rule.kind !== "unlock" && plans.activeBuybackPlan ? 1 : 0),
          );
          details = {
            basePoints: base,
            unlock,
            windowEnd: end,
            activeBuybackPlan: plans.activeBuybackPlan,
          };
        }
      } else if (rule.family === "institution") {
        if (rule.kind === "holders") {
          const holders = z
            .object({
              classificationVersion: z.string(),
              origin: z.enum(["rule", "human"]),
              rows: z.array(z.object({ id: z.string(), category: z.string() })),
            })
            .parse(read("institutions", "holders", ins[0]!));
          mode = holders.origin;
          const pub = holders.rows.some((h) => h.category === "quality-public"),
            foreign = holders.rows.some((h) => h.category === "foreign");
          points = rule.binary
            ? pub || foreign
              ? 3
              : 0
            : pub && foreign
              ? 3
              : pub || foreign
                ? 2
                : holders.rows.length
                  ? 1
                  : 0;
          details = { classificationVersion: holders.classificationVersion };
        } else {
          const dates = periods(
            ins,
            rule.kind === "turnover" || rule.binary ? 2 : 3,
          );
          if (rule.binary)
            points =
              n("shares", dates[0]!, "institutions") >
              n("shares", dates[1]!, "institutions")
                ? 5
                : 0;
          else {
            const turnover =
              n("count", dates[0]!, "institutions") >
                n("count", dates[1]!, "institutions") &&
              n("floatRatio", dates[0]!, "institutions") <
                n("floatRatio", dates[1]!, "institutions");
            if (rule.kind === "turnover") points = turnover ? 2 : 0;
            else {
              const shares = dates.map((d) => n("shares", d, "institutions"));
              if (shares[1] === 0 || shares[2] === 0)
                throw new InputGap("机构股数零基数不能计算两次增幅");
              points = turnover
                ? 2
                : shares[0]! > shares[1]! && shares[1]! > shares[2]!
                  ? shares[0]! > shares[1]! * 1.1 &&
                    shares[1]! > shares[2]! * 1.1
                    ? 5
                    : 4
                  : shares[0]! > shares[1]!
                    ? 2
                    : 0;
            }
            details = { turnover };
          }
        }
      } else {
        const raw = read("catalysts", "growthEvents", req.observationDate);
        const events = z
          .array(
            z.object({
              id: z.string(),
              kind: z.string(),
              origin: z.enum(["rule", "human"]),
              classificationVersion: z.string(),
              effectiveFrom: z.string(),
              expiresAt: z.string(),
              withdrawn: z.boolean(),
              landingDate: z.string().nullable(),
              role: z.string().nullable(),
              successfulTrackRecord: z.boolean(),
              industryId: z.string().nullable(),
              contractRevenuePct: z.number().nullable(),
              forecastLowerPct: z.number().nullable(),
              forecastBaseProfit: z.number().nullable(),
            }),
          )
          .parse(raw);
        const active = events.filter(
          (e) =>
            !e.withdrawn &&
            e.effectiveFrom <= req.observationDate &&
            e.expiresAt >= req.observationDate,
        );
        // Classification origin of the entire input is retained, even if a human
        // rejected the only candidate. Filtering must not launder it into rule-only.
        mode = events.some((e) => e.origin === "human") ? "human" : "rule";
        const substantive = active.filter((e) => {
          if (
            rule.kind !== "all" &&
            rule.kind !== "rumor" &&
            e.kind !== rule.kind
          )
            return false;
          if (e.kind === "product") return e.landingDate !== null;
          if (e.kind === "management")
            return (
              ["CEO", "CFO"].includes(e.role ?? "") && e.successfulTrackRecord
            );
          if (e.kind === "policy") {
            const industry = z
              .object({ industryId: z.string() })
              .parse(read("rs", "industry", req.observationDate));
            return e.industryId === industry.industryId;
          }
          if (e.kind === "contract")
            return e.contractRevenuePct !== null && e.contractRevenuePct >= 10;
          if (e.kind === "incentive") return true;
          if (e.kind === "forecast")
            return (
              e.forecastBaseProfit !== null &&
              e.forecastBaseProfit > 0 &&
              e.forecastLowerPct !== null &&
              e.forecastLowerPct >= 50
            );
          return false;
        });
        points = rule.binary
          ? substantive.length
            ? 6
            : 0
          : substantive.length >= 2
            ? 6
            : substantive.length
              ? 4
              : rule.kind === "rumor" && active.some((e) => e.kind === "rumor")
                ? 2
                : 0;
        details = {
          eventIds: substantive.map((e) => e.id).sort(),
          classificationVersions: [
            ...new Set(events.map((e) => e.classificationVersion)),
          ].sort(),
          contractRevenueThresholdPct: 10,
        };
      }
      if (points === null || !Number.isFinite(points))
        throw new InputGap("规则计算不可用");
    } catch (error) {
      if (!(error instanceof InputGap)) throw error;
      points = null;
      if (!gaps.length)
        gaps.push({
          field: rule.kind,
          effectiveAt: req.observationDate,
          reason: error.message,
        });
    }
    return {
      methodId,
      version: "growth-factor-asof-1",
      status:
        points === null || gaps.length
          ? ("missing" as const)
          : ("computed" as const),
      points,
      maxPoints: rule.cap,
      passed:
        points === null || gaps.length
          ? null
          : typeof details.buyEligible === "boolean"
            ? details.buyEligible
            : points >= rule.threshold,
      participation: mode,
      details,
      requiredInputs,
      evidence,
      dataGaps: gaps,
      boundary: rule.note,
    };
  });
  const payload = {
    version: "growth-factor-research-1",
    request: req,
    results,
    realBacktest: {
      available: false,
      reason:
        "待数据策略：无已核验真实披露/修订历史覆盖、历史可比口径与完整交易证据；固定输入评分不是历史业绩",
      coverage: { start: null, end: null },
      requestedCoverage: {
        start: req.observationDate,
        end: req.observationDate,
      },
    },
    counts: {
      rule: results.filter(
        (r) => r.status === "computed" && r.participation === "rule",
      ).length,
      human: results.filter(
        (r) => r.status === "computed" && r.participation === "human",
      ).length,
      llm: results.filter(
        (r) => r.status === "computed" && r.participation === "llm",
      ).length,
    },
  };
  return {
    id: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    ...payload,
  };
}

/** Cross-sectional ranks only compare the same method and participation mode;
 * missing scores stay unranked, ties share rank then use symbol for stable order. */
export function rankGrowthFactors(
  requests: readonly CanslimAsOfRequest[],
  observations: unknown,
  methodId: string,
) {
  const parsed = requests.map((r) => canslimAsOfRequestSchema.parse(r));
  if (new Set(parsed.map((r) => r.symbol)).size !== parsed.length)
    throw new Error("证券重复");
  if (
    new Set(parsed.map(({ symbol: _symbol, ...r }) => JSON.stringify(r))).size >
    1
  )
    throw new Error("排名必须使用相同时点、报告期与证券池");
  const rows = parsed.map((r) => ({
    symbol: r.symbol,
    ...evaluateGrowthFactors(r, observations, [methodId]).results[0]!,
  }));
  const statisticsGroup = (r: (typeof rows)[number]) =>
    String(r.details.statisticsGroup ?? r.participation);
  return rows
    .sort(
      (a, b) =>
        statisticsGroup(a).localeCompare(statisticsGroup(b)) ||
        (b.points ?? -1) - (a.points ?? -1) ||
        a.symbol.localeCompare(b.symbol),
    )
    .map((r) => ({
      ...r,
      rank:
        r.status !== "computed" || r.points === null
          ? null
          : 1 +
            rows.filter(
              (p) =>
                statisticsGroup(p) === statisticsGroup(r) &&
                p.status === "computed" &&
                p.points !== null &&
                p.points > r.points!,
            ).length,
    }));
}

type FactorComponent = {
  methodId: string;
  points: number | null;
  maxPoints: number;
  status: string;
  participation: string;
  details: Record<string, unknown>;
};
function evaluateGrowthCombination(
  id: string,
  req: CanslimAsOfRequest,
  read: (domain: AsOfDomain, field: string, date: string) => unknown,
  components: (ids: string[]) => FactorComponent[],
): {
  points: number | null;
  details: Record<string, unknown>;
  human?: boolean;
} {
  const at = req.observationDate;
  const input = (domain: AsOfDomain, field: string) => read(domain, field, at);
  let human = false;
  const result = (
    points: number | null,
    details: Record<string, unknown> = {},
  ) => ({ points, details, human });
  const decision = (pass: boolean, details: Record<string, unknown> = {}) =>
    result(Number(pass), { ...details, buyEligible: pass });
  const assert = (ok: boolean, message: string) => {
    if (!ok) throw new InputGap(message);
  };
  const closeKnown = () =>
    assert(
      Date.parse(req.asOf) >= Date.parse(`${at}T15:00:00+08:00`),
      "日收盘输入在15:00前不可用，不冒充盘中入场",
    );
  let historyCache: z.infer<typeof growthHistorySchema> | undefined;
  const history = () => {
    if (historyCache) return historyCache;
    closeKnown();
    const h = growthHistorySchema.parse(input("rs", "priceHistory"));
    assert(
      h.symbol === req.symbol &&
        h.benchmarkId === req.benchmarkId &&
        h.calendar.at(-1) === at,
      "行情身份、基准或末端日期不一致；不接收含未来行情的面板",
    );
    historyCache = h;
    return h;
  };
  const state = () => {
    const s = growthSecuritySchema.parse(input("capital", "securityState"));
    assert(s.listingDate <= at && s.listingTradingDays > 0, "上市状态未生效");
    return s;
  };
  const consistentPrices = (
    calendar: string[],
    startPrice: number,
    endPrice: number,
  ) => {
    if (!historyCache) return;
    const window = historyCache.bars.slice(-calendar.length);
    const same = (a: number, b: number) =>
      Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-10;
    assert(
      window.length === calendar.length &&
        window.every((b, i) => b.date === calendar[i]) &&
        same(window[0]!.close, startPrice) &&
        same(window.at(-1)!.close, endPrice),
      "组合中的证券价格端点或交易窗口不一致，不能混用不同价格面板",
    );
  };
  const rs = (ipo = false) => {
    closeKnown();
    const panel = growthCrossSectionSchema.parse(input("rs", "crossSection"));
    const members = z.array(z.string()).parse(input("rs", "members"));
    assert(
      panel.universeId === req.universeId &&
        panel.end === at &&
        panel.rows.length === members.length &&
        panel.rows.every((r) => members.includes(r.symbol)),
      "RS必须完整覆盖冻结证券池且同一观察日",
    );
    const target = panel.rows.find((r) => r.symbol === req.symbol);
    assert(!!target, "目标不在历史证券池");
    assert(
      ipo
        ? panel.calendar.length >= 2 &&
            panel.calendar.length <= 60 &&
            panel.start === target!.listingDate
        : panel.calendar.length === 61,
      "RS须60个交易日区间；IPO版须目标上市日起不足60日同窗",
    );
    // Suspensions are explicit exclusions; an unexplained absent endpoint is a gap.
    assert(
      panel.rows.every(
        (r) =>
          r.suspended ||
          r.listingDate > panel.start ||
          (r.startPrice !== null && r.endPrice !== null),
      ),
      "RS非停牌有效成员缺端点价格",
    );
    const eligible = panel.rows.filter(
      (r) => !r.suspended && r.listingDate <= panel.start,
    );
    assert(
      eligible.length >= 2 && eligible.includes(target!),
      "RS有效池少于2或目标上市/停牌不适用",
    );
    consistentPrices(panel.calendar, target!.startPrice!, target!.endPrice!);
    const value = target!.endPrice! / target!.startPrice!;
    const percentile =
      (100 *
        eligible.filter((r) => r.endPrice! / r.startPrice! < value).length) /
      (eligible.length - 1);
    return {
      percentile,
      eligibleCount: eligible.length,
      excludedCount: panel.rows.length - eligible.length,
      start: panel.start,
      end: panel.end,
      confidence: ipo ? "reduced" : "standard",
      tieRule: "strict-lower-over-n-minus-one",
    };
  };
  const sectors = () => {
    closeKnown();
    const panel = growthSectorsSchema.parse(input("rs", "sectors"));
    assert(
      panel.end === at && panel.calendar.length === 21,
      "板块必须同日20交易日完整窗口",
    );
    const owned = panel.rows
      .filter((r) => r.members.some((m) => m.symbol === req.symbol))
      .sort(
        (a, b) =>
          b.endPrice / b.startPrice - a.endPrice / a.startPrice ||
          a.id.localeCompare(b.id),
      );
    assert(owned.length > 0, "历史板块成员缺目标证券");
    for (const sector of owned) {
      const member = sector.members.find((m) => m.symbol === req.symbol)!;
      consistentPrices(panel.calendar, member.startPrice, member.endPrice);
    }
    const best = owned[0]!,
      ret = best.endPrice / best.startPrice;
    const target = best.members.find((m) => m.symbol === req.symbol)!;
    const rank =
      1 +
      best.members.filter(
        (m) => m.endPrice / m.startPrice > target.endPrice / target.startPrice,
      ).length;
    const sectorRank =
      1 + panel.rows.filter((r) => r.endPrice / r.startPrice > ret).length;
    return {
      rank,
      sectorRank,
      sectorCount: panel.rows.length,
      sectorId: best.id,
      returnRatio: ret,
      classificationVersion: panel.classificationVersion,
      start: panel.start,
      end: panel.end,
    };
  };
  const earnings = () => {
    const e = growthEarningsSchema.parse(input("catalysts", "earningsWindow"));
    const i = e.calendar.indexOf(at),
      next = e.calendar.indexOf(e.scheduledDate),
      previous = e.calendar.indexOf(e.lastReportedDate);
    assert(
      i >= 0 && next >= i && previous >= 0 && previous <= i,
      "财报预约/披露和观察日均须在完整冻结交易日历；过期预约不能延用",
    );
    assert(
      Date.parse(e.reportAvailableAt) <= Date.parse(req.asOf) &&
        new Date(Date.parse(e.reportAvailableAt) + 8 * 3600000)
          .toISOString()
          .slice(0, 10) === e.lastReportedDate,
      "最近财报必须已披露且日期与公开时点一致",
    );
    assert(
      Date.parse(e.consensusAvailableAt) < Date.parse(e.reportAvailableAt),
      "一致预期版本必须严格早于财报披露",
    );
    return { ...e, before: next - i, after: i - previous };
  };
  const catalyst = () => {
    const rows = growthEntryEventsSchema.parse(
      input("catalysts", "entryEvents"),
    );
    human ||= rows.some((r) => r.origin === "human");
    assert(
      rows.every((r) => r.date <= at),
      "催化清单包含未来事件",
    );
    return rows
      .filter(
        (r) =>
          !r.withdrawn && Date.parse(at) - Date.parse(r.date) <= 20 * 86400000,
      )
      .map((r) => r.id)
      .sort();
  };
  const five = () => {
    const h = history(),
      plan = growthEntrySchema.parse(input("capital", "entryPlan"));
    assert(h.bars.length >= 121, "五步入场需20日量能及基准MA120预热");
    const last = h.bars.at(-1)!,
      avg = h.bars.slice(-21, -1).reduce((n, b) => n + b.volume / 20, 0);
    const checks = [
      last.close > plan.pivot * 1.01,
      last.volume >= avg * 1.5,
      plan.plannedPrice <= plan.pivot * 1.05 && plan.plannedPrice >= plan.pivot,
    ];
    const market =
      h.benchmarkBars.at(-1)!.close >
      h.benchmarkBars.slice(-120).reduce((n, b) => n + b.close / 120, 0);
    const events = catalyst(),
      core = checks.every(Boolean),
      pass = core && (market || events.length > 0);
    return {
      checks,
      market,
      eventIds: events,
      buyEligible: pass,
      classification: pass
        ? "BUY"
        : core || id === "CA-E-five-soft"
          ? "WATCH"
          : "PASS",
      plan,
    };
  };
  const sepa = () => {
    const h = history();
    assert(
      h.bars.length >= 141 &&
        Date.parse(at) - Date.parse(h.bars[0]!.date) >= 365 * 86400000,
      "完整SEPA需要52周及均线预热",
    );
    const point = researchSepaSeries(
      "sepa-vcp-close",
      h.bars,
      h.calendar,
      h.bars.length - 1,
    ).at(-1)!;
    return point;
  };
  const shape = () => {
    const h = history();
    assert(h.bars.length >= 141, "形态组合需要至少141日冻结行情");
    const cup = researchCanslimCupPoint("U", h.bars),
      flat = researchCanslimFlatPoint(h.bars),
      saucer = researchCanslimSaucerPoint("U", h.bars),
      bottom = researchCanslimSaucerPoint("W", h.bars);
    return {
      cup,
      flat,
      saucer,
      bottom,
      any: cup.entry || flat.entry || saucer.entry || bottom.entry,
    };
  };
  if (Object.hasOwn(growthDisciplineRules, id)) {
    const plan = growthEntrySchema.parse(input("capital", "entryPlan"));
    const stopPct =
      ((plan.plannedPrice - plan.stopPrice) / plan.plannedPrice) * 100;
    const wy = id === "WY-K-quality",
      ca = id.startsWith("CA-");
    const riskPct = wy ? 2 : 1.5,
      capPct = wy ? 30 : 25;
    const riskSafe =
      stopPct > 0 &&
      stopPct <= (ca ? 8 : 10) + 1e-10 &&
      plan.accountRiskPct <= riskPct &&
      plan.positionPct <= capPct &&
      (plan.positionPct * stopPct) / 100 <= riskPct + 1e-10;
    let eligible = false,
      assumedP = 0.4;
    let quality: Record<string, unknown> = {};
    if (wy) {
      const h = history();
      assert(h.bars.length >= 61, "威科夫质量需要完整结构预热");
      const series = researchWyckoffSeries(
        "wy-sos-jac-daily",
        h.bars,
        h.calendar,
      );
      const tail = series.slice(-20),
        latest = series.at(-1)!;
      assert(latest.reason === null, "威科夫结构不可用");
      const events = tail
        .flatMap((p) => p.events)
        .filter(
          (e) =>
            e.state === "confirmed" &&
            ["spring", "test", "sos", "jac", "lps"].includes(e.kind),
        );
      const current = events.filter((e) => e.confirmedAt === at);
      const latestEvent = current.at(-1);
      const sameStructure = latestEvent
        ? events.filter(
            (e) =>
              Math.abs(e.facts.support - latestEvent.facts.support) < 1e-8 &&
              Math.abs(e.facts.resistance - latestEvent.facts.resistance) <
                1e-8,
          )
        : [];
      const types = new Set(
        sameStructure.map((e) => (e.kind === "jac" ? "sos" : e.kind)),
      );
      assumedP =
        types.size >= 2
          ? 0.55
          : current.some((e) => e.kind !== "test")
            ? 0.48
            : 0.4;
      eligible =
        current.length > 0 && riskSafe && !latest.exit && !latest.reduction;
      quality = {
        events,
        sameStructure,
        qualityInterpretation: "20交易日确认事件类型计数；弱信号仍单列",
      };
    } else if (ca) {
      const total = components(["CA-S-total-absolute"])[0]!;
      if (total.status !== "computed") return result(null, { total });
      const groups = total.details.groups as Record<string, number>,
        score = total.points!;
      const sh = shape(),
        f = five(),
        s = state(),
        e = earnings(),
        r = rs();
      const selected = [sh.cup, sh.flat, sh.saucer, sh.bottom].find(
        (x) => x.entry,
      );
      let minimum = 70;
      if (id === "CA-E-soft-overrides") {
        const override = growthOverrideSchema.parse(
          input("capital", "softOverride"),
        );
        assert(
          Date.parse(override.frozenAt) < Date.parse(req.asOf),
          "弱项政策必须在决策前冻结",
        );
        human ||= override.origin === "human";
        minimum = 65;
        quality.override = override;
      }
      const hard =
        riskSafe &&
        groups.M! >= 6 &&
        r.percentile >= 80 &&
        !s.st &&
        !s.delistingRisk &&
        s.exchange !== "BJ" &&
        s.listingTradingDays >= 60 &&
        s.resumedAfterSuspensionDays < 20 &&
        plan.plannedPrice < s.limitUpPrice &&
        plan.sessionsSinceStop >= 5 &&
        e.before > 5 &&
        20 / stopPct >= 2.5 - 1e-10;
      eligible =
        score >= minimum &&
        !!selected &&
        selected.candidate?.high === plan.pivot &&
        f.buyEligible &&
        hard;
      assumedP =
        score >= 93 && !!selected && f.buyEligible
          ? 0.55
          : score >= 70
            ? 0.48
            : 0.4;
      quality = {
        ...quality,
        total,
        shape: sh,
        entry: f,
        hard,
        rs: r,
        minimum,
        assumptionQualityThresholds: [93, 70],
      };
    } else {
      const fundamental = components(["SE02"])[0]!;
      if (fundamental.status !== "computed")
        return result(null, { fundamental });
      const p = sepa(),
        r = rs(),
        f = five(),
        e = earnings(),
        s = state();
      assert(
        p.pattern?.score != null && p.trend !== undefined,
        "SEPA质量形态不可用",
      );
      const trend =
        Object.entries(p.trend!.checks)
          .filter(([k]) => k !== "relativeStrength85")
          .every(([, v]) => v === true) && r.percentile >= 85;
      const gates = fundamental.details.strictPass === true && trend;
      const volumeRatio = history().bars.at(-1)!.volume / p.volume!.average;
      assumedP =
        gates &&
        p.pattern!.score! >= 8 &&
        (id !== "SE-K-script-quality" || volumeRatio >= 2)
          ? 0.55
          : gates && p.pattern!.score! >= 6 && p.pattern!.score! < 8
            ? 0.48
            : 0.4;
      const surprise =
        e.consensusEps > 0 && e.actualEps >= e.consensusEps * 1.1 - 1e-10;
      eligible =
        gates &&
        p.entry &&
        p.candidate?.high === plan.pivot &&
        f.buyEligible &&
        f.market &&
        e.before > 5 &&
        riskSafe &&
        30 / stopPct >= 3 - 1e-10 &&
        !s.st &&
        !s.delistingRisk &&
        s.exchange !== "BJ" &&
        plan.plannedPrice < s.limitUpPrice &&
        (id !== "SE-E-checklist" || surprise);
      quality = {
        fundamental,
        trend,
        pattern: p.pattern,
        volumeRatio,
        surprise,
        entry: f,
      };
    }
    if (!id.includes("-K-"))
      return decision(eligible, { ...quality, stopPct, riskSafe });
    const inputTraining = growthTrainingSchema.parse(
      input("capital", "kellyTraining"),
    );
    assert(
      inputTraining.start < inputTraining.cutoff && inputTraining.cutoff <= at,
      "训练截止须不晚于决策日，且区间有效",
    );
    const training = researchKellyTraining(
      inputTraining.trades,
      inputTraining.start,
      inputTraining.cutoff,
    );
    assert(training.reason === null, training.reason ?? "开发训练不可用");
    const target = wy
      ? inputTraining.wyckoffTarget
      : plan.plannedPrice * (ca ? 1.2 : 1.3);
    if (plan.stopPrice >= plan.plannedPrice || target <= plan.plannedPrice)
      return decision(false, {
        ...quality,
        training,
        stopPct,
        riskSafe,
        weight: 0,
        payoff: null,
        halfKellyWeight: null,
        reason: "止损距离或目标空间非正，拒绝除零/负赔率",
        probabilityProvenance: id.includes("quality")
          ? "source-quality-assumption"
          : "development-closed",
        assumptionParameterP: id.includes("quality") ? assumedP : null,
        empiricalWinRate: training.winRate,
      });
    const payoff =
      (target - plan.plannedPrice) / (plan.plannedPrice - plan.stopPrice);
    const minimumPayoff = ca ? 2.5 : wy ? 0 : 3;
    const assumption = id.includes("quality");
    const limit = researchKellyLimit(
      { provenance: "development-closed", payoff, fraction: 0.5 },
      assumption ? assumedP : training.winRate,
    );
    const riskWeight = stopPct > 0 ? riskPct / stopPct : 0;
    const weight =
      limit.weight === null
        ? 0
        : Math.min(riskWeight, limit.weight, capPct / 100);
    const pivotPayoff =
      (plan.pivot * 1.3 - plan.plannedPrice) /
      (plan.plannedPrice - plan.stopPrice);
    const pivotLimit =
      id === "SE-K-kelly" && pivotPayoff >= 3
        ? researchKellyLimit(
            {
              provenance: "development-closed",
              payoff: pivotPayoff,
              fraction: 0.5,
            },
            training.winRate,
          )
        : null;
    return decision(eligible && payoff >= minimumPayoff - 1e-10 && weight > 0, {
      ...quality,
      training,
      probabilityProvenance: assumption
        ? "source-quality-assumption"
        : "development-closed",
      assumptionParameterP: assumption ? assumedP : null,
      empiricalWinRate: training.winRate,
      target,
      payoff,
      stopPct,
      riskWeight,
      halfKellyWeight: limit.weight,
      capWeight: capPct / 100,
      weight: eligible && payoff >= minimumPayoff - 1e-10 ? weight : 0,
      bindingConstraint:
        weight === riskWeight
          ? "risk"
          : weight === capPct / 100
            ? "cap"
            : "half-kelly",
      pivotTargetVariant:
        id === "SE-K-kelly"
          ? {
              name: "pivot-plus30pct",
              payoff: pivotPayoff,
              weight:
                eligible && pivotLimit?.weight
                  ? Math.min(riskWeight, pivotLimit.weight, capPct / 100)
                  : 0,
            }
          : null,
    });
  }
  if (
    [
      "CA-S-L1",
      "CA-B-L1",
      "CA-S-L1-ipo",
      "CA-E-rs80",
      "CA-L-query-screen",
    ].includes(id)
  ) {
    if (id === "CA-L-query-screen") history();
    const r = rs(id === "CA-S-L1-ipo");
    if (id === "CA-E-rs80") return decision(r.percentile >= 80, r);
    if (id === "CA-L-query-screen") {
      const h = history();
      assert(h.bars.length >= 120, "均线需120交易日");
      const mean = (n: number) =>
        h.bars.slice(-n).reduce((s, b) => s + b.close / n, 0);
      const means = [mean(20), mean(60), mean(120)];
      return decision(
        r.percentile >= 80 &&
          means[0]! > means[1]! &&
          means[1]! > means[2]! &&
          state().totalMarketCap > 50e8,
        { ...r, means },
      );
    }
    return result(
      id === "CA-B-L1"
        ? r.percentile >= 80
          ? 9
          : 0
        : tier(r.percentile, [
            [95, 9],
            [90, 7],
            [80, 5],
            [70, 2],
          ]),
      r,
    );
  }
  if (["CA-S-L2", "CA-B-L2", "CA-T-sector"].includes(id)) {
    if (id === "CA-T-sector") history();
    const r = sectors();
    const base = r.rank === 1 ? 6 : r.rank <= 3 ? 5 : r.rank <= 10 ? 3 : 0;
    if (id === "CA-T-sector") {
      const s = shape();
      return decision(
        s.any && r.returnRatio > 1 && r.sectorRank <= r.sectorCount / 2,
        { ...r, shapeCandidate: s.any },
      );
    }
    return result(
      id === "CA-B-L2"
        ? r.rank <= 3
          ? 6
          : 0
        : r.sectorRank > r.sectorCount / 2
          ? Math.min(3, base)
          : base,
      r,
    );
  }
  if (
    [
      "CA-T-smallcap",
      "CA-E-ipo60-risk",
      "CA-S-ipo-year-confidence",
      "SE-E-exclusions",
    ].includes(id)
  ) {
    const s = state();
    if (id === "SE-E-exclusions")
      return decision(
        !s.st &&
          !s.delistingRisk &&
          s.exchange !== "BJ" &&
          s.listingTradingDays > 1 &&
          s.resumedAfterSuspensionDays < 20,
        { state: s },
      );
    const candidate = shape().any;
    if (id === "CA-S-ipo-year-confidence") {
      const anniversary = new Date(`${s.listingDate}T00:00:00Z`);
      anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 1);
      const lowConfidence = at < anniversary.toISOString().slice(0, 10);
      return decision(candidate && !lowConfidence, {
        shapeCandidate: candidate,
        lowConfidence,
        anniversary: anniversary.toISOString().slice(0, 10),
      });
    }
    const cap =
      id === "CA-T-smallcap"
        ? z.number().parse(input("capital", "floatMarketCap"))
        : null;
    const risk =
      id === "CA-T-smallcap"
        ? cap! < 100e8 && s.speculativeTurnoverPct >= 10
        : s.listingTradingDays < 60;
    return result(candidate ? (risk ? 0.5 : 1) : 0, {
      shapeCandidate: candidate,
      risk,
      weight: risk ? 0.5 : 1,
      buyEligible: candidate,
    });
  }
  if (
    [
      "CA-T-earnings-window",
      "CA-E-earnings5",
      "CA-E-reported5",
      "SE-E-earnings13",
    ].includes(id)
  ) {
    const e = earnings();
    if (id === "CA-E-earnings5")
      return decision(e.before > 5, { before: e.before });
    if (id === "CA-E-reported5")
      return decision(e.after > 5, { after: e.after });
    if (id === "SE-E-earnings13") {
      assert(e.consensusEps > 0, "一致预期非正，不计算惊喜比例");
      const p = sepa(),
        mature =
          p.pattern?.score !== null &&
          p.pattern?.score !== undefined &&
          p.pattern.score >= 6 &&
          p.pattern.facts.checks?.minimumTwoContractions === true &&
          p.pattern.facts.checks.shrinkingAtLeast30Percent === true;
      return decision(
        e.after >= 1 && e.after <= 3 && e.actualEps > e.consensusEps && mature,
        {
          after: e.after,
          surprisePct: (e.actualEps / e.consensusEps - 1) * 100,
          mature,
        },
      );
    }
    const candidate = shape().any,
      cautious = e.before <= 5 || e.after <= 3;
    return result(candidate ? (cautious ? 0.5 : 1) : 0, {
      shapeCandidate: candidate,
      before: e.before,
      after: e.after,
      cautious,
      weight: cautious ? 0.5 : 1,
      buyEligible: candidate,
    });
  }
  if (id === "CA-E-catalyst") {
    const eventIds = catalyst();
    return decision(eventIds.length > 0, { eventIds });
  }
  if (["CA-E-five", "SE-E-five", "CA-E-five-soft"].includes(id)) {
    const f = five();
    return decision(f.buyEligible, f);
  }
  if (id === "SE01") {
    const fundamental = components(["SE02"])[0]!;
    if (fundamental.status !== "computed") return result(null, { fundamental });
    const p = sepa(),
      r = rs(),
      f = five();
    assert(
      p.trend !== undefined && p.pattern !== undefined,
      p.reason ?? "SEPA预热不足",
    );
    const technical = p.entry && r.percentile >= 85 && f.buyEligible;
    return decision(fundamental.details.flexiblePass === true && technical, {
      strictPass: fundamental.details.strictPass === true && technical,
      flexiblePass: fundamental.details.flexiblePass === true && technical,
      fundamental,
      trend: p.trend,
      pattern: p.pattern,
      rs: r,
      entry: f,
      executionBoundary:
        "收盘后候选，后续首个合法时点且<=枢纽105%；未执行撮合，仓位与退出沿用SEPA既有管理预设",
    });
  }
  let h: ReturnType<typeof history> | null = null;
  try {
    h = history();
  } catch (error) {
    if (!(error instanceof InputGap) || id !== "CA-S-missing") throw error;
  }
  const market = h
    ? {
        symbol: h.benchmarkId,
        bars: h.benchmarkBars,
        source: "as-of-priceHistory",
        hash: createHash("sha256")
          .update(JSON.stringify(h.benchmarkBars))
          .digest("hex"),
      }
    : undefined;
  const volume = h
    ? researchCanslimVolumeTier(
        "canslim-volume-tier-crash",
        h.bars,
        h.calendar,
        market,
      ).at(-1)!.diagnostic
    : null;
  if (id === "CA-S-S1-limitup") {
    if (!h || !volume) throw new InputGap("缺行情窗口");
    assert(volume.points !== null, "S1量能及市场预热缺失");
    const s = state(),
      limitup = h.bars.at(-1)!.close === s.limitUpPrice;
    return result(limitup ? Math.max(6, volume.points!) : volume.points, {
      basePoints: volume.points,
      limitup,
      buyEligible: !limitup && volume.points! >= 6,
      engineeringReplacementPoints: 6,
    });
  }
  // Full reference-tier 17-component score. No supplied report scores are accepted.
  const baseIds = [
    "C1",
    "C2",
    "C3",
    "A1",
    "A2",
    "A3",
    "N1",
    "S2",
    "L1",
    "L2",
    "I1",
    "I2",
  ];
  const parts = components(baseIds.map((k) => `CA-S-${k}`));
  const values: Record<string, number | null> = Object.fromEntries(
    parts.map((p) => [
      p.methodId.slice(5),
      p.status === "computed" ? p.points : null,
    ]),
  );
  human ||= parts.some((p) => p.participation === "human");
  const consistencyGaps: string[] = [];
  if (h)
    for (const [key, check] of [
      ["L1", rs],
      ["L2", sectors],
    ] as const) {
      try {
        check();
      } catch (error) {
        if (!(error instanceof InputGap)) throw error;
        values[key] = null;
        consistencyGaps.push(error.message);
      }
    }
  const high = h
    ? researchCanslimHighSeries("canslim-high-100", h.bars).at(-1)!.diagnostic
    : null;
  values.N2 = high?.status === "computed" ? high.points : null;
  values.S1 = volume?.points ?? null;
  (["ma250", "follow10", "distribution20"] as const).forEach((kind, i) => {
    values[`M${i + 1}`] = h
      ? researchCanslimMarketScore(
          `canslim-market-tier-${kind}`,
          h.bars,
          h.calendar,
          market,
        ).at(-1)!.diagnostic.points
      : null;
  });
  const missing = Object.keys(values).filter((k) => values[k] === null);
  const total = Object.values(values).reduce<number>((n, v) => n + (v ?? 0), 0);
  const capacity = Object.entries(canslimCaps).reduce(
    (n, [k, cap]) => n + (values[k] === null ? 0 : cap),
    0,
  );
  const groups = Object.fromEntries(
    ["C", "A", "N", "S", "L", "I", "M"].map((k) => [
      k,
      Object.entries(values)
        .filter(([key]) => key.startsWith(k))
        .reduce((n, [, v]) => n + (v ?? 0), 0),
    ]),
  );
  const absoluteTier = tier(total, [
    [93, 3],
    [70, 2],
    [47, 1],
  ]);
  const ratioTier = tier(total / 114, [
    [0.8, 3],
    [0.6, 2],
    [0.4, 1],
  ]);
  const weighted = Object.values(groups).reduce(
    (n, v, i) =>
      n +
      (v / [20, 20, 15, 13, 15, 8, 23][i]!) * [20, 20, 15, 15, 15, 5, 10][i]!,
    0,
  );
  const grade =
    id === "CA-S-total-ratio"
      ? ratioTier
      : id === "CA-S-weighted-ratio"
        ? tier(weighted, [
            [80, 3],
            [60, 2],
            [40, 1],
          ])
        : id === "CA-S-C-downgrade" && groups.C! < 10
          ? Math.max(0, absoluteTier - 1)
          : absoluteTier;
  const details: Record<string, unknown> = {
    values,
    total,
    maxPoints: 114,
    computedCapacity: capacity,
    missingIds: missing,
    groups,
    grade: missing.length ? null : grade,
    weightedPct: missing.length ? null : weighted,
    candidatePositionCapPct: missing.length
      ? 0
      : grade === 3
        ? 25
        : grade === 2
          ? 12.5
          : 0,
    buyEligible: missing.length === 0 && grade >= 2,
    consistencyGaps,
    scoringVersion: "reference-tier-114-v1",
    executionBoundary:
      "待数据筛选/候选，不执行撮合；完整输入补齐后进入统一执行器验证",
  };
  if (missing.length) {
    if (id === "CA-S-missing")
      return result(null, {
        ...details,
        displayedZeroContributionTotal: total,
      });
    throw new InputGap(`完整评分缺失: ${missing.join(",")}`);
  }
  if (["CA01", "CA02", "CA03"].includes(id)) {
    const shapes = shape(),
      f = five(),
      s = state(),
      e = earnings(),
      r = rs();
    const selected =
      id === "CA01"
        ? shapes.cup
        : id === "CA02"
          ? shapes.flat
          : shapes.saucer.entry
            ? shapes.saucer
            : shapes.bottom;
    const plan = f.plan,
      stopPct =
        ((plan.plannedPrice - plan.stopPrice) / plan.plannedPrice) * 100;
    const safe =
      stopPct > 0 &&
      stopPct <= 8 + 1e-10 &&
      plan.accountRiskPct <= 1.5 &&
      plan.positionPct <= 25 &&
      (plan.positionPct * stopPct) / 100 <= 1.5 + 1e-10 &&
      20 / stopPct >= 2.5 - 1e-10 &&
      plan.sessionsSinceStop >= 5 &&
      !s.st &&
      !s.delistingRisk &&
      s.exchange !== "BJ" &&
      s.listingTradingDays >= 60 &&
      s.resumedAfterSuspensionDays < 20 &&
      plan.plannedPrice < s.limitUpPrice &&
      e.before > 5;
    const pivot = selected.candidate?.high;
    return decision(
      total >= 70 &&
        groups.M! >= 6 &&
        selected.entry &&
        f.buyEligible &&
        r.percentile >= 80 &&
        safe &&
        pivot === plan.pivot,
      {
        ...details,
        selected,
        entry: f,
        safe,
        rs: r,
        stopPct,
        buyEligible: undefined,
        executionBoundary:
          "完整因子+形态候选工程版，5交易日止损后冷静期；收盘后下一合法时点限价枢纽105%，CA既有退出管理，未运行真实撮合",
      },
    );
  }
  return result(id === "CA-S-weighted-ratio" ? weighted : total, details);
}
