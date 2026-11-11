import { scoreCanslimInstitutions } from "trading-strategies/research/canslim/canslim-institutions-score";
import { z } from "zod";
import { symbolSchema } from "trading-strategies/research/contracts/security";
export const institutionResponseSchema = z.object({
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
export function canslimInstitutions(symbol: string, raw: unknown) {
  symbolSchema.parse(symbol);
  const data = institutionResponseSchema.parse(raw),
    row = data.datas[0]!;
  if (
    row["股票代码"] !== `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`
  )
    throw new Error("机构资料证券身份不匹配");
  const read = (field: string, unit: string, period: string) => {
    const key = `${field}[${period}]`,
      columns = data.columns.filter((c) => c.key === key),
      value = row[key];
    if (
      columns.length !== 1 ||
      columns[0]!.unit !== unit ||
      columns[0]!.timestamp !== period ||
      (typeof value !== "number" &&
        !(typeof value === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)))
    )
      return null;
    const number = Number(value);
    return Number.isFinite(number) &&
      number >= 0 &&
      (unit !== "%" || number <= 100) &&
      (unit !== "家" || Number.isInteger(number))
      ? number
      : null;
  };
  const periods = [
    ...new Set(
      data.columns.flatMap(
        (c) =>
          c.key.match(
            /^机构持股数量\[(\d{4}(?:0331|0630|0930|1231))\]$/,
          )?.[1] ?? [],
      ),
    ),
  ]
    .sort()
    .reverse()
    .slice(0, 3);
  const series = periods.map((period) => ({
    period,
    shares: read("机构持股数量", "股", period),
    ratio: read("机构持股占流通股比例", "%", period),
    count: read("持股机构家数", "家", period),
  }));
  return scoreCanslimInstitutions(series);
}
