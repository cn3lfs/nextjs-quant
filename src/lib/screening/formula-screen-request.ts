import { z } from "zod";
import { formulaSchema } from "trading-strategies/formula/formula-screen";
import { symbolSchema } from "trading-strategies/research/contracts/security";

export const formulaScreenSourceSchema = z
  .enum(["local", "thsdk"])
  .default("local");
export const formulaScreenInputSchema = formulaSchema
  .extend({
    id: z.string().min(1).max(100).optional(),
    marketSource: formulaScreenSourceSchema,
    symbols: z.array(symbolSchema).max(200).optional(),
  })
  .refine(
    (v) => v.marketSource !== "thsdk" || !!v.symbols?.length,
    "使用同花顺数据源执行公式选股时，请指定 1–200 只证券代码",
  )
  .refine(
    (v) => v.marketSource !== "thsdk" || v.source.length <= 20000,
    "同花顺选股公式最多 20000 字符",
  );
