import { z } from "zod";
import { asOfTimestampSchema, type AsOfDomain } from "./as-of";
import { researchDateSchema } from "./research-usage";
import { symbolSchema } from "./domain";
const text = z.string().trim().min(1),
  positive = z.number().finite().positive();
export const tmtIndustries = ["801080", "801750", "801760", "801770"] as const;
export const crowdingPanelSchema = z
  .object({
    version: text,
    membershipVersion: text,
    evidence: text,
    windowStart: researchDateSchema,
    windowEnd: researchDateSchema,
    frozenAt: asOfTimestampSchema,
    windowRecordedAt: asOfTimestampSchema,
    targetSymbol: symbolSchema,
    targetIndustry: z.enum(tmtIndustries),
    targetMembershipEvidence: text,
    marginScope: z.literal("SSE-market-proxy"),
    calendar: z.array(researchDateSchema).min(62),
    rows: z
      .array(
        z
          .object({
            date: researchDateSchema,
            marginBalance: positive,
            industries: z
              .array(
                z
                  .object({
                    id: text,
                    amount: positive,
                    floatCap: positive,
                    turnover: positive,
                    pe: positive,
                    pb: positive,
                    close: positive,
                  })
                  .strict(),
              )
              .length(31),
          })
          .strict(),
      )
      .min(62),
  })
  .strict()
  .refine(
    (r) =>
      r.calendar[0] === r.windowStart &&
      r.calendar.at(-1) === r.windowEnd &&
      r.rows.length === r.calendar.length &&
      r.calendar.every(
        (d, i) => (i === 0 || d > r.calendar[i - 1]!) && r.rows[i]!.date === d,
      ) &&
      r.rows.every(
        (x) =>
          new Set(x.industries.map((y) => y.id)).size === 31 &&
          tmtIndustries.every((id) => x.industries.some((y) => y.id === id)),
      ),
    "31行业同源完整面板及四行业覆盖不可缺失",
  );
export const crowdingFactorRules: Record<string, string> = {
  TM01: "五维25/20/20/20/15拥挤度<=70准入；>85禁止新增",
  TM02: "拥挤>70减半，>85退出；50/70/85等号按源脚本下档",
  TM03: "前次>70且本次<=50恢复；缺前值不从缺失制造穿越",
  TM04: "A/B/C/D/E分别命名对照，不能把上交所市场融资代理称为TMT融资",
  ...Object.fromEntries(
    ["A", "B", "C", "D", "E"].map((k) => [`TM04-${k}`, `独立${k}维度拥挤对照`]),
  ),
};
export function evaluateCrowdingFactor(
  id: string,
  req: { observationDate: string; asOf: string; symbol: string },
  read: (domain: AsOfDomain, field: string, at: string) => unknown,
) {
  const p = crowdingPanelSchema.parse(
    read("capital", "crowdingPanel", req.observationDate),
  );
  if (
    p.windowEnd !== req.observationDate ||
    p.targetSymbol !== req.symbol ||
    Date.parse(p.windowRecordedAt) > Date.parse(p.frozenAt) ||
    Date.parse(p.frozenAt) > Date.parse(`${p.windowStart}T00:00:00+08:00`)
  )
    throw new Error("拥挤窗口必须事前冻结且截止观察日");
  const data = p.rows.map((r) => {
    const t = r.industries.filter((x) =>
        (tmtIndustries as readonly string[]).includes(x.id),
      ),
      cap = t.reduce((s, x) => s + x.floatCap, 0),
      weighted = (key: "turnover" | "pe" | "pb") =>
        t.reduce((s, x) => s + (x[key] * x.floatCap) / cap, 0);
    return {
      a:
        t.reduce((s, x) => s + x.amount, 0) /
        r.industries.reduce((s, x) => s + x.amount, 0),
      turnover: weighted("turnover"),
      relative:
        weighted("turnover") /
        (r.industries.reduce((s, x) => s + x.turnover * x.floatCap, 0) /
          r.industries.reduce((s, x) => s + x.floatCap, 0)),
      pe: weighted("pe"),
      pb: weighted("pb"),
      margin: r.marginBalance,
      closes: t.map((x) => ({ id: x.id, close: x.close })),
    };
  });
  // Source _prank counts samples <= current; equal samples all count.
  const rank = (xs: number[]) => {
    const x = xs.at(-1)!;
    return (100 * xs.filter((y) => y <= x).length) / xs.length;
  };
  const scoreAt = (n: number) => {
    const xs = data.slice(0, n + 1),
      last = xs.at(-1)!,
      momentum = xs
        .slice(60)
        .map(
          (r, j) =>
            r.closes.reduce((s, c) => s + c.close, 0) /
              xs[j]!.closes.reduce((s, c) => s + c.close, 0) -
            1,
        );
    const A = rank(xs.map((x) => x.a)),
      B =
        (rank(xs.map((x) => x.turnover)) + rank(xs.map((x) => x.relative))) / 2,
      C =
        0.6 * rank(xs.slice(-244).map((x) => x.margin)) +
        0.4 *
          Math.min(
            100,
            (Math.max(0, (last.margin / xs.at(-61)!.margin - 1) * 100) / 20) *
              100,
          ),
      D = (rank(xs.map((x) => x.pe)) + rank(xs.map((x) => x.pb))) / 2,
      E = rank(momentum);
    return {
      A,
      B,
      C,
      D,
      E,
      total: 0.25 * A + 0.2 * B + 0.2 * C + 0.2 * D + 0.15 * E,
    };
  };
  const now = scoreAt(data.length - 1),
    prior = scoreAt(data.length - 2),
    band =
      now.total > 85
        ? "extreme"
        : now.total > 70
          ? "crowded"
          : now.total > 50
            ? "warm"
            : "normal";
  const selected = id.startsWith("TM04-")
    ? now[id.slice(-1) as "A" | "B" | "C" | "D" | "E"]
    : now.total;
  const enter =
    id === "TM03" ? prior.total > 70 && now.total <= 50 : selected <= 70;
  const variants = Object.entries(now)
    .filter(([k]) => k !== "total")
    .map(([dimension, score]) => ({
      id: `TM04-${dimension}`,
      score,
      buyEligible: score <= 70,
      action: score > 85 ? "exit" : score > 70 ? "reduce" : "hold",
      positionScale: score > 85 ? 0 : score > 70 ? 0.5 : 1,
    }));
  return {
    points: Number(enter),
    participation: "rule" as const,
    details: {
      buyEligible: enter,
      score: selected,
      dimensions: now,
      previousScore: prior.total,
      band,
      action:
        selected > 85
          ? "exit"
          : selected > 70
            ? "reduce"
            : enter
              ? "enter"
              : "hold",
      positionScale: selected > 85 ? 0 : selected > 70 ? 0.5 : 1,
      variants: id === "TM04" ? variants : [],
      marginScope: p.marginScope,
      industries: tmtIndustries,
      targetIndustry: p.targetIndustry,
      window: { start: p.windowStart, end: p.windowEnd },
      executionBoundary:
        "同一双突破基线的TMT四行业风险过滤/减仓/恢复对照，下一合法成交时点、单股25%上限、最长20日；仅候选未撮合",
    },
  };
}
