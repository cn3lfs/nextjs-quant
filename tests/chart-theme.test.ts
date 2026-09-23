import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { chartColor, chartColorTokens } from "../src/lib/chart-theme";

it("chart canvas colors mirror the Nocturne tokens", () => {
  const css = readFileSync("src/styles/tokens.css", "utf8");
  for (const [key, token] of Object.entries(chartColorTokens)) {
    const value = css.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
    expect(value, token).toBeDefined();
    expect(chartColor[key as keyof typeof chartColor], key).toBe(value);
  }
  expect(chartColor.upSoft.startsWith(chartColor.up)).toBe(true);
  expect(chartColor.downFaint.startsWith(chartColor.down)).toBe(true);
});

it("chart components take colors only from the chart theme", () => {
  for (const file of [
    "src/components/market/chart.tsx",
    "src/components/market/chart-workspace.tsx",
  ])
    expect(readFileSync(file, "utf8")).not.toMatch(/"#[0-9a-fA-F]{3,8}"/);
});
