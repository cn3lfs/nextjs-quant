import { z } from "zod";
import { symbolSchema } from "~/lib/domain";
const rowSchema = z.object({
  股票代码: z.string(),
  名称: z.string().trim().min(1),
  排名: z.number().int().min(1).max(10),
  公告日期: z.string().regex(/^\d{8}$/),
  类型: z.array(z.string()).optional(),
});
export function canslimHolderList(
  symbol: string,
  raw: unknown,
  cutoff: number,
) {
  symbolSchema.parse(symbol);
  if (!Number.isFinite(cutoff)) throw new Error("股东资料截止时间非法");
  const response = z
    .object({ status_code: z.literal(0), datas: z.array(rowSchema).max(10) })
    .parse(raw);
  const names = new Set<string>(),
    ranks = new Set<number>();
  for (const row of response.datas) {
    if (
      row["股票代码"] !==
      `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`
    )
      throw new Error("股东名单证券身份不匹配");
    if (names.has(row["名称"]) || ranks.has(row["排名"]))
      throw new Error("股东名称或排名重复，不能当作完整前十名单");
    names.add(row["名称"]);
    ranks.add(row["排名"]);
    const date = row["公告日期"],
      day = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
      time = Date.parse(`${day}T00:00:00+08:00`);
    if (
      !Number.isFinite(time) ||
      new Date(time + 8 * 3600000).toISOString().slice(0, 10) !== day ||
      time > cutoff
    )
      throw new Error("股东名单公告日期非法或越过截止");
  }
  const completeRanks =
    response.datas.length === 10 &&
    [...Array(10)].every((_, i) => ranks.has(i + 1));
  const consistentDate =
    new Set(response.datas.map((row) => row["公告日期"])).size === 1;
  return {
    version: "canslim-holder-list-1",
    symbol,
    rows: response.datas.sort((a, b) => a["排名"] - b["排名"]),
    completeRanks,
    consistentDate,
    missing: [
      ...(!completeRanks ? ["缺少唯一排名1–10的名单"] : []),
      ...(!consistentDate ? ["名单公告日期不一致或为空"] : []),
      "机构类别与报告期尚未核验，不能据前十未出现推断全市场无机构持股",
    ],
  };
}
