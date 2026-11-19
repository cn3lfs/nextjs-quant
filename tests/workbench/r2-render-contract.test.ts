import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { connectionSourcePaths } from "../helpers/r2-contracts";

// Current settings/formula/task behavior is covered by the corresponding
// browser harnesses. Frozen pre-R2 callback and hook inventories are obsolete.
it("keeps connection credentials, news archives and quiet hours wired", () => {
  const connection = connectionSourcePaths()
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const policy = readFileSync(
    "src/components/signals/notification-policy-fields.tsx",
    "utf8",
  );
  expect(connection).not.toContain("config.analysisLimit");
  expect(connection).not.toContain("config.autoAnalysis");
  expect(connection).toContain('aria-label="平台"');
  expect(connection).toContain('autoComplete="new-password"');
  expect(connection).toContain("value={config.clsDbPath}");
  expect(connection).toContain('aria-label="主档案类型"');
  expect(connection).toContain('<Field label="互补新闻档案路径">');
  expect(connection).toContain("value={config.clsComplementDbPath}");
  expect(connection).toContain('aria-label="互补档案类型"');
  expect(policy).toContain('min="15:05"');
  expect(policy).toContain('max="23:30"');
  expect(policy.match(/disabled={!p.quietEnabled}/g)).toHaveLength(2);
});

it("submits the validated settings payload", () => {
  const connection = readFileSync(
    "src/components/workbench/connections.tsx",
    "utf8",
  );
  expect(connection).toContain("save.mutate(parsed.data)");
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
  // Candidate columns backed by the server screen sort keys are sortable.
  expect(screen.match(/enableSorting: false/g)).toHaveLength(5);
  expect(screen).not.toContain('header: "AI 快评"');
  expect(screen.match(/enableSorting: true/g)).toHaveLength(5);
  const ledger = readFileSync(
    "src/components/signals/signal-ledger-analysis.tsx",
    "utf8",
  );
  // Ledger analysis now reads an independent full-population server projection;
  // the 20-row history page must never become its statistical input.
  expect(ledger).toContain("api.ledgerAnalysis.useQuery");
  expect(ledger).toContain("<SignalLedgerSummaryTable groups={data.groups} />");
  const ledgerQuery = readFileSync(
    "src/server/db/signal-ledger-query.ts",
    "utf8",
  );
  expect(ledgerQuery).toContain("groups: aggregateLedger(rows)");
  expect(ledgerQuery).not.toContain("aggregateLedger(rows.slice(");
});
