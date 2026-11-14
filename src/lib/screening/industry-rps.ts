import {
  rpsPeriods,
  type RpsRow,
  aggregateGroupRps,
  type RpsGroupExclusion,
  type RpsGroupMemberAudit,
} from "quant-rps";

import { z } from "zod";
import { tableSortSchema } from "../common/server-sort";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { type RpsDay } from "./rps";

export const industryRpsPolicy = {
  version: "industry-rps-1",
  maxIndustries: 256,
  maxConcepts: 1024,
  maxMemberships: 100000,
  maxFileBytes: 128000,
  description:
    "行业涨幅为符合证券池条件的成分股后复权涨幅的等权平均。与通达信自身板块指数的加权方式不同，数值不会与通达信一致，不能直接比较。",
  warning:
    "成分名单是当前快照，不是历史成分。历史行业RPS存在成分漂移；回填同时带生存者偏差及历史ST状态偏差。回填段与向前新增段分别标记，已有结果不覆盖。",
  periodsNote:
    "计算当日及3/5/10/20/50/120交易日RPS。陶博士本人行业只用20/50/120；此处仅作方法说明。",
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
    category: z.literal("concept").optional(),
    classification: z.enum(["tdx-research-level1", "tdx-concept"]).optional(),
    selectionPolicy: z
      .object({
        version: z.literal("exclude-region-style-1"),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
        previousHash: z.string().regex(/^[a-f0-9]{64}$/),
        removed: z.array(
          z.object({
            name: z.string(),
            file: z.string(),
            kind: z.enum(["region", "style"]),
          }),
        ),
      })
      .optional(),
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    root: z.string().min(1).max(2048),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    files: z
      .array(industryFileSchema)
      .min(1)
      .max(industryRpsPolicy.maxConcepts),
  })
  .superRefine((value, ctx) => {
    if (!value.category && value.files.length > industryRpsPolicy.maxIndustries)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "行业名单超过256个上限",
      });
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
export type IndustryRpsAudit = {
  policy: typeof industryRpsPolicy;
  snapshot: IndustrySnapshot;
  members: RpsGroupMemberAudit[];
  excluded: Record<RpsGroupExclusion, number>;
};

export function aggregateIndustryRps(
  snapshot: IndustrySnapshot,
  stock: { rows: RpsRow[]; excluded: RpsDay["excluded"] },
  periods: readonly number[] = rpsPeriods,
) {
  snapshot = industrySnapshotSchema.parse(snapshot);
  const { members, excluded, ...result } = aggregateGroupRps(
    snapshot.files,
    stock,
    periods,
  );
  return {
    ...result,
    industry: {
      policy: industryRpsPolicy,
      snapshot,
      members,
      excluded,
    } satisfies IndustryRpsAudit,
  };
}
export const industryPageSchema = z.object({
  date: researchDateSchema.optional(),
  period: z
    .number()
    .refine((p) => (rpsPeriods as readonly number[]).includes(p)),
  page: z.number().int().min(0).max(255).default(0),
  order: tableSortSchema,
});
export const industryEmptyLabels = {
  "period-unavailable": "该历史批次未计算此周期，等待新批次",
  "empty-list": "名单为空，不参与排名",
  "all-filtered": "成分全被剔除，不参与排名",
  "missing-endpoints": "本周期无有效收益端点，不参与排名",
} as const;
