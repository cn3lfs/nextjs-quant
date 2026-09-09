// Offline diagnostic: run after saving a sanitized two-endpoint price query.
// This source-declared list is not an independently verified historical universe.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { validateHithinkColumns } from "../src/server/hithink-columns";
const start = "20260612",
  end = "20260907";
const startKey = `收盘价_不复权[${start}]`,
  endKey = `收盘价_不复权[${end}]`;
const raw = await readFile("output/rs-price-source-live.json", "utf8");
const source = z
  .object({
    status_code: z.literal(0),
    code_count: z.number().int().positive(),
    datas: z.array(z.record(z.unknown())),
    columns: z.array(
      z.object({
        key: z.string(),
        unit: z.string().optional(),
        timestamp: z.string().optional(),
        type: z.string().optional(),
      }),
    ),
  })
  .parse(JSON.parse(raw));
if (source.datas.length !== source.code_count)
  throw new Error("列表未完整返回");
for (const [key, timestamp] of [
  [startKey, start],
  [endKey, end],
]) {
  if (
    source.columns.filter(
      (c) =>
        c.key === key &&
        c.unit === "元" &&
        c.timestamp === timestamp &&
        c.type === "DOUBLE",
    ).length !== 1
  )
    throw new Error("价格列口径不明确");
}
const seen = new Set<string>();
const excluded: Array<{ code: string; reason: string }> = [];
const rows: Array<{
  code: string;
  startClose: number;
  endClose: number;
  change: number;
}> = [];
for (const row of source.datas) {
  validateHithinkColumns(row, source.columns);
  const code = row["股票代码"];
  if (
    typeof code !== "string" ||
    !/^\d{6}\.(SH|SZ|BJ)$/.test(code) ||
    seen.has(code)
  )
    throw new Error("证券身份不完整或重复");
  seen.add(code);
  const a = row[startKey],
    b = row[endKey];
  if (
    typeof a !== "number" ||
    typeof b !== "number" ||
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    a <= 0 ||
    b <= 0
  ) {
    excluded.push({ code, reason: "缺少有效正数端点收盘价" });
    continue;
  }
  rows.push({ code, startClose: a, endClose: b, change: (b / a - 1) * 100 });
}
rows.sort((a, b) => b.change - a.change || a.code.localeCompare(b.code));
const target = rows.find((row) => row.code === "600519.SH");
if (!target) throw new Error("目标不在有效价格列表");
const above = rows.filter((row) => row.change > target.change).length,
  equal = rows.filter((row) => row.change === target.change).length;
const result = {
  version: "rs-price-audit-1",
  start,
  end,
  sourceHash: createHash("sha256").update(raw).digest("hex"),
  declaredCount: source.code_count,
  eligibleCount: rows.length,
  excluded,
  rows,
  target: {
    ...target,
    midRank: above + (equal + 1) / 2,
    percentile:
      rows.length > 1
        ? (1 - (above + (equal - 1) / 2) / (rows.length - 1)) * 100
        : null,
  },
  warnings: [
    "仅返回列表中具备两个端点正数不复权收盘价的证券排名。",
    "来源对日期查询可能隐含过滤，不能宣称覆盖独立完整A股名单或历史时点证券池。",
    "不得将该诊断的分母替换为其他查询的code_count。",
  ],
};
await writeFile(
  "output/rs-price-audit-live.json",
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    declaredCount: result.declaredCount,
    eligibleCount: result.eligibleCount,
    excludedCount: excluded.length,
    target: result.target,
  }),
);
