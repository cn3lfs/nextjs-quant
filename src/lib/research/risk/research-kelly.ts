import { z } from "zod";

export const researchKellyVersion = "research-kelly-1";
export const researchKellySchema = z.discriminatedUnion("provenance", [
  z
    .object({
      payoff: z.number().finite().positive(),
      fraction: z.literal(0.5),
      provenance: z.literal("rolling-switch30"),
    })
    .strict(),
  z
    .object({
      payoff: z.number().finite().positive(),
      fraction: z.number().finite().gt(0).max(1),
      provenance: z.literal("breakout-quality"),
    })
    .strict(),
  z
    .object({
      fraction: z.number().finite().gt(0).max(1),
      provenance: z.literal("development-net-payoff"),
    })
    .strict(),
  z
    .object({
      winRate: z.number().finite().gt(0).lt(1),
      payoff: z.number().finite().positive(),
      fraction: z.number().finite().gt(0).max(1),
      provenance: z.literal("manual-scenario"),
    })
    .strict(),
  z
    .object({
      payoff: z.number().finite().positive(),
      fraction: z.number().finite().gt(0).max(1),
      provenance: z.literal("development-closed"),
    })
    .strict(),
]);
export type ResearchKelly = z.infer<typeof researchKellySchema>;

export function researchKellyLimit(
  input: ResearchKelly,
  trainedWinRate?: number | null,
  trainedPayoff?: number | null,
) {
  const parsed = researchKellySchema.safeParse(input);
  if (!parsed.success)
    return { fullKelly: null, weight: null, reason: "凯利参数无效" };
  const { fraction } = parsed.data;
  const payoff =
    parsed.data.provenance === "development-net-payoff"
      ? trainedPayoff
      : parsed.data.payoff;
  const winRate =
    parsed.data.provenance === "manual-scenario"
      ? parsed.data.winRate
      : trainedWinRate;
  if (
    winRate == null ||
    !Number.isFinite(winRate) ||
    winRate < 0 ||
    winRate > 1
  )
    return { fullKelly: null, weight: null, reason: "开发期实测胜率不可用" };
  if (payoff == null || !Number.isFinite(payoff) || payoff <= 0)
    return {
      fullKelly: null,
      weight: null,
      reason: "开发期实测回报倍数不可用",
    };
  const fullKelly = winRate - (1 - winRate) / payoff;
  if (!Number.isFinite(fullKelly))
    return { fullKelly: null, weight: null, reason: "凯利计算超出有限数范围" };
  return {
    fullKelly,
    weight: Math.max(0, fullKelly) * fraction,
    reason: fullKelly <= 0 ? "凯利非正，不开新仓或加仓" : null,
  };
}
