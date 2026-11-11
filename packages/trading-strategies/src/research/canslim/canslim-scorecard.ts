import { z } from "zod";

export const canslimCaps = {
  C1: 8,
  C2: 7,
  C3: 5,
  A1: 8,
  A2: 7,
  A3: 5,
  N1: 6,
  N2: 9,
  S1: 8,
  S2: 5,
  L1: 9,
  L2: 6,
  I1: 5,
  I2: 3,
  M1: 10,
  M2: 8,
  M3: 5,
} as const;
const inputSchema = z.object({
  id: z.string(),
  maxPoints: z.number().int(),
  points: z.number().int().nonnegative(),
  status: z.enum(["computed", "missing", "conflict"]),
  evidenceIds: z.array(z.string().min(1)),
  reason: z.string().min(1),
});
export type CanslimScoreInput = z.input<typeof inputSchema>;

export function canslimScorecard(
  inputs: CanslimScoreInput[],
  allowedEvidenceIds: string[],
) {
  const allowed = new Set(allowedEvidenceIds);
  const items = z.array(inputSchema).max(17).parse(inputs);
  const seen = new Set<string>();
  for (const item of items) {
    const cap = canslimCaps[item.id as keyof typeof canslimCaps];
    if (
      cap === undefined ||
      cap !== item.maxPoints ||
      item.points > cap ||
      seen.has(item.id)
    )
      throw new Error("CANSLIM分项身份、满分或分值非法");
    if (
      new Set(item.evidenceIds).size !== item.evidenceIds.length ||
      item.evidenceIds.some((id) => !allowed.has(id))
    )
      throw new Error("CANSLIM分项引用不属于当前证据包");
    if (item.status === "computed" && !item.evidenceIds.length)
      throw new Error("已计算分项必须提供证据");
    if (item.status !== "computed" && item.points !== 0)
      throw new Error("缺失或冲突分项不能贡献分数");
    seen.add(item.id);
  }
  const checks = Object.entries(canslimCaps).map(([id, maxPoints]) => ({
    factor: id[0]!,
    ...(items.find((item) => item.id === id) ?? {
      id,
      maxPoints,
      points: 0,
      status: "missing" as const,
      evidenceIds: [],
      reason: "该分项的数据适配与核验尚未完成",
    }),
  }));
  return {
    version: "canslim-scorecard-1",
    checks,
    maxPoints: checks.reduce((sum, item) => sum + item.maxPoints, 0),
    computedPoints: checks.reduce((sum, item) => sum + item.points, 0),
    computedCapacity: checks
      .filter((item) => item.status === "computed")
      .reduce((sum, item) => sum + item.maxPoints, 0),
    missingIds: checks
      .filter((item) => item.status === "missing")
      .map((item) => item.id),
    conflictIds: checks
      .filter((item) => item.status === "conflict")
      .map((item) => item.id),
    warnings: [
      "源方法声称总分116，但17项分值及七因子分值实际合计114；应用采用分项之和114，不增加虚构2分、不二次乘权重。",
      "computed仅表示确定性计算有输入与引用，不表示披露时点、股本可比性、交易日完整性等前提已验证；不据此输出投资等级或仓位。",
      "缺失/冲突贡献0并单列；computedCapacity只展示可计算分值覆盖，不以它重新归一化总分。",
    ],
  };
}
