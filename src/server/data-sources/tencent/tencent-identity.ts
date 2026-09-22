import { westockScriptPath } from "../westock/westock-data";
import {
  westockSearch,
  WESTOCK_ADAPTER_VERSION,
} from "../westock/westock-adapter";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { symbolSchema } from "~/lib/domain";
import { isAStock } from "../tdx/tdx";
export function parseTencentIdentity(text: string, symbol: string) {
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .trim()
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  const header = rows.findIndex((row) => row.join(",") === "code,name,type");
  if (header < 0) throw new Error("腾讯未返回可验证的股票资料表");
  return resolveIdentity(rows.slice(header + 2), symbol);
}
function resolveIdentity(rows: string[][], symbol: string) {
  const matches = rows.filter(
    (row) =>
      row.length === 3 &&
      row[0] === symbol &&
      (row[2] === "GP-A" ||
        (row[2] === "GP-A-CYB" && /^sz30[01]\d{3}$/.test(symbol)) ||
        (row[2] === "GP-A-KCB" && /^sh688\d{3}$/.test(symbol)) ||
        (row[2] === "GP" && symbol.startsWith("bj") && isAStock(symbol))),
  );
  if (
    matches.length !== 1 ||
    !matches[0]![1] ||
    matches[0]![1]!.length > 80 ||
    !isAStock(symbol)
  )
    throw new Error("腾讯代码、市场或 A 股类型无法唯一确认");
  return {
    symbol,
    name: matches[0]![1]!,
    type: "A股" as const,
    market: symbol.slice(0, 2),
  };
}
export async function searchTencentIdentity(
  symbol: string,
  signal?: AbortSignal,
) {
  symbolSchema.parse(symbol);
  if (!isAStock(symbol)) throw new Error("身份核验仅支持 A 股");
  signal?.throwIfAborted();
  const script = westockScriptPath();
  const bytes = await readFile(script);
  const sourceHash = createHash("sha256")
    .update(bytes)
    .update(WESTOCK_ADAPTER_VERSION)
    .digest("hex");
  const rows = await westockSearch(
    { keyword: symbol.slice(2), type: "stock" },
    signal,
  );
  return {
    ...resolveIdentity(
      rows.map((row) => [row.code, row.name, row.type ?? ""]),
      symbol,
    ),
    source: "tencent" as const,
    sourceHash,
    checkedAt: Date.now(),
  };
}
