import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { readWdzFiveMinute } from "../src/server/data-sources/tdx/wdz-native";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    out: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help || !values.source || !values.out) {
  console.log("pnpm wdz:extract --source 文件.wdz --out 新输出目录");
  process.exit(values.help ? 0 : 1);
}
const source = resolve(values.source),
  output = resolve(values.out);
// An exclusive new directory keeps extraction isolated and prevents stale/overwritten CSVs.
await mkdir(output);
await Promise.all(["SH", "SZ"].map((market) => mkdir(join(output, market))));
const start = performance.now();
let files = 0,
  bars = 0;
const seen = new Set<string>();
try {
  for await (const item of readWdzFiveMinute(source)) {
    const target = join(output, item.symbol.slice(0, 2), `${item.symbol}.csv`);
    if (seen.has(item.symbol))
      await appendFile(target, item.csv.subarray(item.csv.indexOf(10) + 1));
    else {
      await writeFile(target, item.csv, { flag: "wx" });
      seen.add(item.symbol);
      files++;
    }
    bars += item.bars;
    if (files % 1000 === 0)
      console.log(
        `${files} 文件 · ${((performance.now() - start) / 1000).toFixed(1)} 秒`,
      );
  }
  console.log(
    JSON.stringify(
      {
        source,
        output,
        files,
        bars,
        seconds: (performance.now() - start) / 1000,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`解码失败，已生成 ${files} 文件；不完整输出目录: ${output}`);
  throw error;
}
