import { z } from "zod";
import { createHash } from "node:crypto";
import { createAsOfAdapter, type AsOfDomain } from "~/lib/as-of";
import { asOfInputDefinitions, readAsOfInput } from "~/lib/as-of-inputs";
import {
  buildCanslimAsOfDossier,
  canslimAsOfRequestSchema,
  type CanslimAsOfRequest,
} from "./canslim-as-of-dossier";

type Rule = {
  family: "finance" | "catalyst" | "capital" | "institution";
  kind: string;
  binary?: boolean;
  cap: number;
  threshold: number;
  note: string;
};
// Source main-text binary rules and reference tier rules are separate methods.
export const growthFactorMethods: Record<string, Rule> = {
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
    if (rule.family === "finance") {
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
    } else requireFields("catalysts", ["growthEvents"], [req.observationDate]);
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
      const query = { domain, field, effectiveAt, entity: req.symbol };
      const row = readRows.find(
        (r) =>
          r.domain === domain &&
          r.field === field &&
          r.effectiveAt === effectiveAt &&
          r.entity === req.symbol,
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
      mode: "rule" | "human" = "rule";
    for (const input of requiredInputs) {
      try {
        read(input.domain, input.field, input.effectiveAt);
      } catch (error) {
        if (!(error instanceof InputGap)) throw error;
      }
    }
    try {
      if (gaps.length) throw new InputGap("所需字段尚未全部覆盖");
      if (rule.family === "finance") {
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
      status: points === null ? ("missing" as const) : ("computed" as const),
      points,
      maxPoints: rule.cap,
      passed: points === null ? null : points >= rule.threshold,
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
      llm: 0,
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
  return rows
    .sort(
      (a, b) =>
        a.participation.localeCompare(b.participation) ||
        (b.points ?? -1) - (a.points ?? -1) ||
        a.symbol.localeCompare(b.symbol),
    )
    .map((r) => ({
      ...r,
      rank:
        r.points === null
          ? null
          : 1 +
            rows.filter(
              (p) =>
                p.participation === r.participation &&
                p.points !== null &&
                p.points > r.points!,
            ).length,
    }));
}
