import { z } from "zod";
import { symbolSchema } from "~/lib/domain";
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
  const quarter = (period: string) =>
    Number(period.slice(0, 4)) * 4 + Number(period.slice(4, 6)) / 3;
  const complete =
    series.length === 3 &&
    series.every(
      (p, i) =>
        p.shares !== null &&
        p.ratio !== null &&
        p.count !== null &&
        (!i || quarter(series[i - 1]!.period) - quarter(p.period) === 1),
    );
  const latest = series[0],
    prior = series[1],
    oldest = series[2];
  const zeroBase = complete && (prior!.shares === 0 || oldest!.shares === 0);
  const turnover =
    complete &&
    latest!.count! > prior!.count! &&
    latest!.ratio! < prior!.ratio!;
  const increasing = complete && latest!.shares! > prior!.shares!;
  const twice = increasing && prior!.shares! > oldest!.shares!;
  const strong =
    twice &&
    latest!.shares! > prior!.shares! * 1.1 &&
    prior!.shares! > oldest!.shares! * 1.1;
  const status = !complete ? "missing" : zeroBase ? "conflict" : "computed";
  return {
    id: "I1",
    maxPoints: 5,
    version: "canslim-institutions-1",
    status,
    points:
      status !== "computed"
        ? 0
        : turnover
          ? 2
          : strong
            ? 5
            : twice
              ? 4
              : increasing
                ? 2
                : 0,
    series,
    turnover,
    warnings: [
      "主体评分采用机构持股股数，不以机构家数替代；机构家数增加且占流通股比例下降时按例外给2分。",
      "连续两季增加需要三个连续季度；两次环比均严格超过10%才给5分，这是应用明确口径。缺期保留missing，零基数不伪算增幅。",
      "机构统计范围、季末披露时点与股本可比性尚未独立核验，computed仅为计算诊断。",
    ],
  };
}
