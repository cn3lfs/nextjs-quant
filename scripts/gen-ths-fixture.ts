/**
 * Synthetic 同花顺 history-export fixture for load tests: deterministic round
 * trips (buy, hold 3–42 days, sell) at real local closes since 2019, written as
 * UTF-8 (convert to GBK for import, e.g. `iconv -f utf-8 -t gbk`). Reads the
 * TDX root from the settings of an isolated QUANT_DATA_DIR; writes nothing
 * else. Usage:
 *   QUANT_DATA_DIR=.test-data/wb-baseline OUT=D:/tmp/ths.utf8 \
 *     [SYMBOLS=sh600519,sz000001,...] npx tsx scripts/gen-ths-fixture.ts
 * The e2e accounts were made with the default 20 symbols (`big`, 2222 fills)
 * and with 60 SH + 40 SZ main-board symbols (`big10k`, 9418 fills).
 */
import { writeFileSync } from "node:fs";

if (!process.env.QUANT_DATA_DIR) throw new Error("请设置隔离的 QUANT_DATA_DIR");
const { settings } = await import("~/server/infra/settings");
const { readSnapshot } = await import("~/server/data-sources/tdx/tdx");
const root = settings().tdxRoot;
const symbols = process.env.SYMBOLS?.split(",") ?? [
  "sh600519",
  "sh600036",
  "sh601318",
  "sz000001",
  "sz000858",
  "sz300750",
  "sh600900",
  "sz002594",
  "sh601012",
  "sz000333",
  "sh600276",
  "sh601888",
  "sz002415",
  "sh600030",
  "sz300059",
  "sh601166",
  "sh600887",
  "sz000651",
  "sh603259",
  "sz002475",
];
let seed = 11;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const fee = (amount: number) => Math.max(5, +(amount * 0.00025).toFixed(2));
const rows: string[] = [];
let id = 1;
for (const symbol of symbols) {
  const bars = (await readSnapshot(root, symbol, "day")).bars.filter(
    (b) => b.date >= "2019-01-01" && b.volume > 0,
  );
  let i = Math.floor(rand() * 40);
  while (i < bars.length - 50) {
    const hold = 3 + Math.floor(rand() * 40);
    const quantity = 100 * (1 + Math.floor(rand() * 10));
    for (const [bar, side] of [
      [bars[i]!, "买入"],
      [bars[i + hold]!, "卖出"],
    ] as const) {
      const amount = +(bar.close * quantity).toFixed(2),
        commission = fee(amount),
        tax = side === "卖出" ? +(amount * 0.0005).toFixed(2) : 0;
      const flow =
        side === "买入" ? -(amount + commission) : amount - commission - tax;
      rows.push(
        [
          bar.date.replaceAll("-", ""),
          "10:00:00",
          symbol.slice(2),
          symbol,
          side,
          quantity.toFixed(3),
          bar.close.toFixed(3),
          amount.toFixed(3),
          "0",
          String(900000 + id),
          String(1200000000 + id++),
          commission.toFixed(3),
          tax.toFixed(3),
          "0.000",
          flow.toFixed(3),
          side === "买入" ? "证券买入" : "证券卖出",
          symbol.startsWith("sh") ? "1" : "2",
          "0",
          "0",
          "",
        ].join("\t"),
      );
    }
    i += hold + 1 + Math.floor(rand() * 20);
  }
}
rows.sort((a, b) => b.localeCompare(a));
const header =
  "成交日期\t成交时间\t证券代码\t证券名称\t操作\t成交数量\t成交均价\t成交金额\t后证余额\t合同编号\t成交编号\t手续费\t印花税\t其他杂费\t发生金额\t备注\t交易市场\t真实操作\t结算费\t";
const out = process.env.OUT ?? "ths-fixture.utf8";
writeFileSync(out, [header, ...rows].join("\r\n") + "\r\n");
console.log(`${rows.length} 笔成交 → ${out}`);
