import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { captureTdxBaseline } from "../src/server/tdx-data-baseline";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    date: { type: "string" },
    symbols: { type: "string" },
    report: { type: "string" },
  },
});
if (!values.root || !values.date)
  throw new Error("需要 --root 通达信目录 --date YYYY-MM-DD");
if (values.report) {
  const destination = relative(resolve(values.root), resolve(values.report));
  if (
    !isAbsolute(destination) &&
    destination !== ".." &&
    !destination.startsWith("..\\") &&
    !destination.startsWith("../")
  )
    throw new Error("基线报告必须保存在通达信目录之外");
}
const symbols = (
  values.symbols ??
  "sh600000,sh600519,sh601318,sh688001,sz000001,sz000333,sz002594,sz300059,sz300750,sh000001,sz399001,sz399006,sh000016,sh000300,sh000905,sh000852"
)
  .split(",")
  .map((symbol) => symbol.trim().toLowerCase());
const report = await captureTdxBaseline(values.root, symbols, values.date);
const json = JSON.stringify(report, null, 2);
if (values.report)
  await writeFile(values.report, json, { encoding: "utf8", flag: "wx" });
console.log(
  values.report
    ? JSON.stringify(
        {
          report: resolve(values.report),
          observations: report.observations.map((row) =>
            row.status === "read"
              ? {
                  symbol: row.symbol,
                  period: row.period,
                  status: row.status,
                  last: row.last,
                  count: row.count,
                }
              : row,
          ),
        },
        null,
        2,
      )
    : json,
);
