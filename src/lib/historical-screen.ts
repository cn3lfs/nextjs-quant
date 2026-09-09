import { z } from "zod";
export const historicalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const stamp = Date.parse(`${value}T00:00:00Z`);
    return (
      Number.isFinite(stamp) &&
      new Date(stamp).toISOString().slice(0, 10) === value
    );
  }, "历史日期不合法");
export const historicalScreenSchema = z.object({
  asOf: historicalDateSchema.optional(),
  universeSource: z.string().trim().max(500).optional(),
  requireCurrent: z.boolean().optional(),
});
export function validateHistoricalScreen(
  input: z.infer<typeof historicalScreenSchema>,
  symbols?: string[],
) {
  const options = historicalScreenSchema.parse(input);
  if (options.asOf && options.requireCurrent)
    throw new Error("严格当前模式不能同时指定历史截止日");
  if (!options.asOf)
    return options.requireCurrent ? { requireCurrent: true } : {};
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  if (options.asOf >= today) throw new Error("历史研究请选择今天之前的日期");
  if (!symbols?.length || !options.universeSource)
    throw new Error(
      "历史研究须明确提供证券池及来源，不能默认使用今天的全市场名单",
    );
  return options;
}
