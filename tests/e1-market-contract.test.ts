import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { withoutE1MarketBrowser } from "./e1-market-contract";

it("verifies E1 selection wiring and rejects changed source, missing selection and altered loading guards", () => {
  const source = readFileSync(
    "src/components/workbench/market-view.tsx",
    "utf8",
  );
  expect(() => withoutE1MarketBrowser(source)).not.toThrow();
  for (const changed of [
    source.replace('source: "local"', 'source: "mcp"'),
    source.replace("setSymbol(next);", "setSymbol(symbol);"),
    source.replace("disabled={load.isPending}", "disabled={false}"),
  ])
    expect(() => withoutE1MarketBrowser(changed)).toThrow("E1");
});
