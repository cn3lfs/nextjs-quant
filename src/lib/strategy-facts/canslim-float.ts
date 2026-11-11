import { scoreCanslimFloat } from "trading-strategies/research/canslim/canslim-float-score";
import { z } from "zod";
import { symbolSchema } from "trading-strategies/research/contracts/security";
export const floatResponseSchema = z.object({
  status_code: z.literal(0),
  datas: z.array(z.record(z.unknown())).length(1),
  columns: z.array(
    z.object({
      key: z.string(),
      unit: z.string().optional(),
      timestamp: z.string().optional(),
    }),
  ),
});
export function canslimFloat(
  symbol: string,
  raw: unknown,
  asOf: string,
  events: {
    symbol: string;
    unlockWithinThreeMonths: boolean;
    activeBuybackPlan: boolean;
    asOf: string;
    evidenceIds: string[];
  } | null = null,
) {
  symbolSchema.parse(symbol);
  const parsed = floatResponseSchema.parse(raw),
    row = parsed.datas[0]!;
  if (
    row["股票代码"] !== `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`
  )
    throw new Error("流通市值证券身份不匹配");
  const time = Date.parse(asOf);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== asOf
  )
    throw new Error("流通市值基准日期非法");
  const stamp = asOf.replaceAll("-", ""),
    field = `流通市值[${stamp}]`;
  const columns = parsed.columns.filter((c) => c.key === field),
    value = row[field];
  const numeric =
    typeof value === "number" ||
    (typeof value === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value));
  const yuan =
    columns.length === 1 &&
    columns[0]!.unit === "元" &&
    columns[0]!.timestamp === stamp &&
    numeric &&
    Number.isFinite(Number(value)) &&
    Number(value) > 0
      ? Number(value)
      : null;
  return { ...scoreCanslimFloat(symbol, yuan, asOf, events), field };
}
