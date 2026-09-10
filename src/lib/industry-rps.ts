import { z } from "zod";
import { historicalDateSchema } from "./historical-screen";
import {
  rankRps,
  isRpsMarketSymbol,
  rpsExclusions,
  rpsPeriods,
  type RpsDay,
  type RpsRow,
} from "./rps";

export const industryRpsPolicy = {
  version: "industry-rps-1",
  maxIndustries: 256,
  maxMemberships: 100000,
  maxFileBytes: 128000,
  description:
    "行业涨幅为符合证券池条件的成分股后复权涨幅的等权平均。与通达信自身板块指数的加权方式不同，数值不会与通达信一致，不能直接比较。",
  warning:
    "成分名单是当前快照，不是历史成分。历史行业RPS存在成分漂移；回填同时带生存者偏差及历史ST状态偏差。回填段与向前新增段分别标记，已有结果不覆盖。",
  periodsNote:
    "六周期全部计算。陶博士本人行业只用20/50/120，认为行业250强时个股往往已涨完；此处仅作方法说明。",
} as const;
export const industryFileSchema = z.object({
  name: z.string().min(1).max(128),
  file: z.string().min(1).max(256),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  mtimeMs: z.number().finite().nonnegative(),
  members: z.array(z.string().regex(/^(sh|sz|bj)\d{6}$/)).max(10000),
});
export const industrySnapshotSchema = z
  .object({
    root: z.string().min(1).max(2048),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    files: z
      .array(industryFileSchema)
      .min(1)
      .max(industryRpsPolicy.maxIndustries),
  })
  .superRefine((value, ctx) => {
    if (
      value.files.reduce((n, f) => n + f.members.length, 0) >
      industryRpsPolicy.maxMemberships
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "行业成分总数超过100000上限",
      });
    if (
      new Set(value.files.map((f) => f.name)).size !== value.files.length ||
      value.files.some((f) => new Set(f.members).size !== f.members.length)
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "行业或成分重复" });
  });
export type IndustrySnapshot = z.infer<typeof industrySnapshotSchema>;
export const industryExclusions = [...rpsExclusions, "unavailable"] as const;
export type IndustryExclusion = (typeof industryExclusions)[number];
export type IndustryMemberAudit = {
  name: string;
  total: number;
  eligible: number;
  excluded: Record<IndustryExclusion, number>;
  included: number[];
  missing: number[];
  empty: ("empty-list" | "all-filtered" | "missing-endpoints" | null)[];
};
export type IndustryRpsAudit = {
  policy: typeof industryRpsPolicy;
  snapshot: IndustrySnapshot;
  members: IndustryMemberAudit[];
  excluded: Record<IndustryExclusion, number>;
};

/** docs/rps-plan.md §3.5: each period averages only eligible, available returns. */
export function aggregateIndustryRps(
  snapshot: IndustrySnapshot,
  stock: { rows: RpsRow[]; excluded: RpsDay["excluded"] },
  periods: readonly number[] = rpsPeriods,
) {
  snapshot = industrySnapshotSchema.parse(snapshot);
  const rowsBySymbol = new Map(stock.rows.map((r) => [r.symbol, r]));
  const reasons = new Map<string, IndustryExclusion>();
  for (const reason of rpsExclusions)
    for (const symbol of stock.excluded[reason]) reasons.set(symbol, reason);
  const inputs = periods.map(() => [] as { symbol: string; return: number }[]);
  const counts = () =>
    Object.fromEntries(industryExclusions.map((key) => [key, 0])) as Record<
      IndustryExclusion,
      number
    >;
  const excluded = counts();
  const members = snapshot.files.map((file): IndustryMemberAudit => {
    const audit: IndustryMemberAudit = {
      name: file.name,
      total: file.members.length,
      eligible: 0,
      excluded: counts(),
      included: periods.map(() => 0),
      missing: periods.map(() => 0),
      empty: periods.map(() => null),
    };
    const sums = periods.map(() => 0);
    for (const symbol of file.members) {
      const row = rowsBySymbol.get(symbol);
      const reason =
        reasons.get(symbol) ??
        (!row ? (isRpsMarketSymbol(symbol) ? "unavailable" : "market") : null);
      if (reason) {
        audit.excluded[reason]++;
        excluded[reason]++;
        continue;
      }
      audit.eligible++;
      periods.forEach((_, i) => {
        const value = row!.values[i];
        if (value) {
          sums[i] = sums[i]! + value.return;
          audit.included[i] = audit.included[i]! + 1;
        } else audit.missing[i] = audit.missing[i]! + 1;
      });
    }
    periods.forEach((_, i) => {
      const n = audit.included[i]!;
      if (n) inputs[i]!.push({ symbol: file.name, return: sums[i]! / n });
      else
        audit.empty[i] = !file.members.length
          ? "empty-list"
          : !audit.eligible
            ? "all-filtered"
            : "missing-endpoints";
    });
    return audit;
  });
  const rankings = inputs.map(rankRps);
  return {
    rows: snapshot.files.map((f) => ({
      symbol: f.name,
      values: rankings.map((r) => r.get(f.name) ?? null),
    })),
    pool: members.filter((m) => m.included.some((n) => n > 0)).length,
    counts: inputs.map((v) => v.length),
    missing: periods.map(
      (_, i) => members.filter((m) => !m.included[i]).length,
    ),
    industry: {
      policy: industryRpsPolicy,
      snapshot,
      members,
      excluded,
    } satisfies IndustryRpsAudit,
  };
}
export const industryPageSchema = z.object({
  date: historicalDateSchema.optional(),
  period: z
    .number()
    .refine((p) => (rpsPeriods as readonly number[]).includes(p)),
  page: z.number().int().min(0).max(255).default(0),
});
export const industryEmptyLabels = {
  "empty-list": "名单为空，不参与排名",
  "all-filtered": "成分全被剔除，不参与排名",
  "missing-endpoints": "本周期无有效收益端点，不参与排名",
} as const;
