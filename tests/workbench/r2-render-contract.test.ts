import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import baseline from "../fixtures/r2-render-handlers.json";
import { renderHandlers, componentLogic } from "../r2-contracts";
import logic from "../fixtures/r2-component-logic.json";
import { withoutE1MarketBrowser } from "../e1-market-contract";

it("R2 preserves every original form and action handler, including request payloads and page resets", () => {
  for (const [file, handlers] of Object.entries(baseline)) {
    const source = readFileSync(file, "utf8");
    expect(
      renderHandlers(
        file.endsWith("/market-view.tsx")
          ? withoutE1MarketBrowser(source)
          : source,
      ),
      file,
    ).toEqual(handlers);
  }
});

it("R2 precisely wires the connection components and preserves validation attributes", () => {
  const connection = readFileSync(
    "src/components/workbench/connections.tsx",
    "utf8",
  );
  const policy = readFileSync(
    "src/components/signals/notification-policy-fields.tsx",
    "utf8",
  );
  expect(connection.match(/<Input\b/g)).toHaveLength(13);
  expect(connection.match(/<Textarea\b/g)).toHaveLength(1);
  expect(connection.match(/<Checkbox\b/g)).toHaveLength(3);
  expect(connection).toContain(
    '<SelectTrigger aria-label="平台" className="w-full">',
  );
  expect(connection).toContain('autoComplete="new-password"');
  expect(policy.match(/<Input\b/g)).toHaveLength(7);
  expect(policy.match(/<Checkbox\b/g)).toHaveLength(2);
  expect(policy).toContain('min="15:05"');
  expect(policy).toContain('max="23:30"');
  expect(policy.match(/disabled={!p.quietEnabled}/g)).toHaveLength(2);
});

it("R2 handler evidence rejects changed submitted settings", () => {
  const original = readFileSync(
    "src/components/workbench/connections.tsx",
    "utf8",
  );
  expect(
    renderHandlers(
      original.replace(
        "save.mutate(config)",
        "save.mutate({ ...config, tdxRoot: '' })",
      ),
    ),
  ).not.toEqual(renderHandlers(original));
});

it("R2 preserves component hooks, queries, local validation and computation outside rendering", () => {
  for (const [file, expected] of Object.entries(logic))
    expect(componentLogic(readFileSync(file, "utf8")), file).toEqual(expected);
});

it("R2 tables receive original result arrays and leave existing pagination and sorting in charge", () => {
  const screen = readFileSync(
    "src/components/workbench/screen-view.tsx",
    "utf8",
  );
  expect(screen).toContain("data={screenResult.candidates}");
  expect(screen).toContain("data={screenResult.excluded}");
  expect(screen).toContain("rowCount={screenResult.count}");
  expect(screen).toContain("rowCount={screenResult.excludedTotal}");
  expect(screen).toContain("pageIndex: screenPage");
  expect(screen).toContain("pageIndex: excludedPage");
  expect(screen.match(/showPagination={false}/g)).toHaveLength(2);
  expect(screen.match(/enableSorting: false/g)).toHaveLength(11);
  const ledger = readFileSync(
    "src/components/signals/signal-ledger-view.tsx",
    "utf8",
  );
  expect(ledger).toContain("const groups = aggregateLedger(rows)");
  expect(ledger).toContain("<SignalLedgerSummaryTable groups={groups} />");
  expect(
    readFileSync("src/components/screening/formula-screen.tsx", "utf8"),
  ).toContain('className="field-sizing-fixed"');
});
