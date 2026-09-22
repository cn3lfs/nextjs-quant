import { z } from "zod";
const table = z.object({
  status_code: z.literal(0),
  code_count: z.number().int().positive(),
  datas: z.array(z.record(z.unknown())),
  columns: z.array(
    z.object({
      key: z.string(),
      unit: z.string().optional(),
      timestamp: z.string().optional(),
      index_name: z.string().optional(),
      type: z.string().optional(),
    }),
  ),
});
export function canslimSectorRank(
  sectors: unknown,
  members: unknown,
  symbol: string,
  sectorCode: string,
  asOf: string,
  startDate?: string,
) {
  if (startDate !== undefined) {
    const startTime = Date.parse(startDate);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
      !Number.isFinite(startTime) ||
      new Date(startTime).toISOString().slice(0, 10) !== startDate ||
      startDate >= asOf
    )
      throw new Error("排名起始日期非法");
  }
  const time = Date.parse(asOf);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== asOf
  )
    throw new Error("排名日期非法");
  const stamp = asOf.replaceAll("-", ""),
    field = `涨跌幅[${stamp}]`;
  function parse(raw: unknown, key: string, format: RegExp) {
    const data = table.parse(raw);
    if (data.datas.length !== data.code_count)
      throw new Error("排名列表不完整");
    const fields = startDate
      ? [startDate, asOf].map((date) => ({
          stamp: date.replaceAll("-", ""),
          key: `${key === "指数代码" ? "收盘价" : "收盘价_不复权"}[${date.replaceAll("-", "")}]`,
          unit: key === "指数代码" ? "点" : "元",
          suffix: "收盘价:不复权",
        }))
      : [{ stamp, key: field, unit: "%", suffix: "涨跌幅:前复权" }];
    for (const expected of fields) {
      const columns = data.columns.filter((c) => c.key === expected.key);
      if (
        columns.length !== 1 ||
        columns[0]!.unit !== expected.unit ||
        columns[0]!.timestamp !== expected.stamp ||
        columns[0]!.type !== "DOUBLE" ||
        !columns[0]!.index_name?.endsWith(expected.suffix)
      )
        throw new Error("排名单位、日期或复权口径不一致");
    }
    const codes = new Set<string>();
    return data.datas.map((row) => {
      const code = row[key];
      if (typeof code !== "string" || !format.test(code) || codes.has(code))
        throw new Error("排名代码缺失或重复");
      codes.add(code);
      const values = fields.map((f) => row[f.key]);
      if (
        values.some(
          (value) =>
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            (startDate && value <= 0),
        )
      )
        throw new Error("排名价格或收益缺失或非法");
      const value = startDate
        ? ((values[1] as number) / (values[0] as number) - 1) * 100
        : values[0];
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error("排名收益缺失或非法");
      return {
        code,
        changePercent: value,
        endpoints: startDate ? { start: values[0], end: values[1] } : null,
        row,
      };
    });
  }
  const pool = parse(sectors, "指数代码", /^\d{6}\.TI$/);
  if (
    pool.some(
      (p) =>
        p.row.指数类型 !== "同花顺二级行业指数" || p.row.成分领域 !== "A股指数",
    )
  )
    throw new Error("行业层级不一致");
  const sector = pool.find((p) => p.code === sectorCode);
  if (
    !sector ||
    typeof sector.row.指数简称 !== "string" ||
    !sector.row.指数简称.trim()
  )
    throw new Error("目标行业不存在");
  const stocks = parse(members, "股票代码", /^\d{6}\.(SH|SZ|BJ)$/);
  if (stocks.some((p) => p.row.所属同花顺二级行业 !== sector.row.指数简称))
    throw new Error("成分行业归属不一致");
  const stock = stocks.find((p) => p.code === symbol);
  if (!stock) throw new Error("目标证券不在行业列表");
  const sectorRank =
    1 + pool.filter((p) => p.changePercent > sector.changePercent).length;
  const stockRank =
    1 + stocks.filter((p) => p.changePercent > stock.changePercent).length;
  const base =
    stockRank === 1 ? 6 : stockRank <= 3 ? 5 : stockRank <= 10 ? 3 : 0;
  return {
    version: "canslim-sector-rank-2",
    id: "L2",
    status: "missing",
    points: 0,
    maxPoints: 6,
    asOf,
    window: startDate ? `${startDate}/${asOf}` : "single-day",
    adjustment: startDate ? "none" : "qfq",
    sectorReturn: {
      changePercent: sector.changePercent,
      endpoints: sector.endpoints,
    },
    stockReturn: {
      changePercent: stock.changePercent,
      endpoints: stock.endpoints,
    },
    sectorCode,
    symbol,
    sectorRank,
    sectorCount: pool.length,
    stockRank,
    memberCount: stocks.length,
    observationPoints: sectorRank > pool.length / 2 ? Math.min(3, base) : base,
    warnings: [
      startDate
        ? "指定日期端点自算收益；未核验企业行动与交易日连续性，不是完整L2评分。"
        : "单日观察，不是已确定收益窗口的完整L2评分。",
      "并列使用竞争排名：严格更高者数量加1；后50%按该排名判断。",
      "分页完整不证明成员全集、历史归属或跨来源一致；多板块最强选择尚未核验。",
    ],
  };
}
