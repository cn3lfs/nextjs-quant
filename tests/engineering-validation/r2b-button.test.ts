import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

// The Button-only migration is complete. Current formula/chart behavior is
// covered by screen-workspace-browser.mjs and chart-annotations-browser.mjs;
// original emitted-source hashes no longer describe the authorized UI.

it("shows a currently supported RPS period in the formula example", () => {
  const source = readFileSync(
    "src/components/screening/formula-screen.tsx",
    "utf8",
  );
  expect(source).toContain(
    'placeholder="例如：MACD 金叉、RPS120 大于 90、近 5 日放量"',
  );
  expect(source).not.toContain("RPS250");
});
it("uses shared RPS periods and labels with explicit colors for the new chart windows", () => {
  const source = readFileSync("src/components/market/chart.tsx", "utf8");
  expect(source).toContain("rpsPeriods.map((window)");
  expect(source).toContain("{rpsPeriodLabel(window)}");
  const palette = readFileSync(
    "src/components/market/market-chart-palette.ts",
    "utf8",
  );
  expect(palette).toContain("1: chartColor.series4,");
  expect(palette).toContain("3: chartColor.accentLight,");
  expect(palette).not.toContain("250: chartColor.");
});
it("T1 keeps all three server routes in the shared client navigation", () => {
  const source = readFileSync("src/components/workbench/workbench.tsx", "utf8");
  const sidebar = readFileSync("src/components/workbench/sidebar.tsx", "utf8");
  // One navigation layer: every page is a framework route (native links).
  expect(sidebar).toContain("navGroups.map((group, index)");
  expect(sidebar).toContain("href={item.href}");
  expect(sidebar).toContain("scroll={false}");
  expect(source).toContain("router.push(");
  expect(source).toContain("scroll: false");
  expect(source).not.toContain("<a ");
  expect(sidebar).not.toContain("<a ");
  // Visited tab and route panels stay mounted; only cached routes skip the
  // framework children so a panel never renders twice.
  expect(source).toContain("<PanelCache active={pathname} panels={panels} />");
  expect(source).toContain("{!(pathname in panels) && children}");
  const navigation = readFileSync(
    "src/components/workbench/navigation.ts",
    "utf8",
  );
  for (const href of ["/signal-ledger", "/trade-ledger", "/rps"])
    expect(navigation.split(`href: "${href}"`)).toHaveLength(2);
  const panels = readFileSync(
    "src/components/workbench/route-panels.tsx",
    "utf8",
  );
  for (const href of ["/intraday", "/rps", "/cls-review"])
    expect(panels).toContain(`"${href}":`);
  expect(panels).not.toContain('"/research":');
  // The two ledger routes fetch server data per request; caching them would
  // change that data path, so they must stay out of the panel cache.
  for (const href of ["/signal-ledger", "/trade-ledger"])
    expect(panels).not.toContain(`"${href}":`);
  expect(readFileSync("src/app/layout.tsx", "utf8")).toContain(
    "<WorkbenchLayout>{children}</WorkbenchLayout>",
  );
  expect(
    readFileSync("src/components/workbench/workbench-layout.tsx", "utf8"),
  ).toContain("<Workbench>{children}</Workbench>");
  for (const file of [
    "src/app/rps/page.tsx",
    "src/components/signals/signal-ledger-view.tsx",
    "src/components/portfolio/trade-ledger-panel.tsx",
  ])
    expect(readFileSync(file, "utf8")).not.toContain("返回工作台");
});

it("uses shared buttons throughout the current UI", () => {
  const files = readdirSync("src", { recursive: true })
    .filter(
      (file): file is string =>
        typeof file === "string" && file.endsWith(".tsx"),
    )
    .map((file) => `src/${file}`);
  for (const file of files)
    expect(readFileSync(file, "utf8")).not.toMatch(/<button\b/);
  const css = readFileSync("src/styles/globals.css", "utf8");
  expect(css).not.toMatch(/\.button-(primary|outline|ghost|danger|sm)\b/);
});
