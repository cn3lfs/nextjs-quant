import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { withoutE1MarketBrowser } from "./e1-market-contract";

it("verifies E1 selection wiring and rejects changed source, missing selection and altered loading guards", () => {
  const source = readFileSync(
    "src/components/workbench/market-view.tsx",
    "utf8",
  );
  expect(() => withoutE1MarketBrowser(source)).not.toThrow();
  expect(source.indexOf("<ChartWorkspace")).toBeLessThan(
    source.indexOf("<MarketPoolBrowser"),
  );
  const start = source.indexOf("<MarketPoolBrowser");
  const prefix = source.slice(0, start);
  const pool = source.slice(start);
  for (const changed of [
    pool.replace('source: "local"', 'source: "mcp"'),
    pool.replace("setSymbol(next);", "setSymbol(symbol);"),
    pool.replace("disabled={load.isPending}", "disabled={false}"),
  ])
    expect(() => withoutE1MarketBrowser(prefix + changed)).toThrow("E1");
});
