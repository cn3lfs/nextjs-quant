import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { AlertRepository } from "../../src/server/db/alert-repository";
import { DeliveryStore } from "../../src/server/db/delivery-store";
import { PaperRepository } from "../../src/server/db/paper-repository";
import { seedR2cFixture } from "./r2c-fixture";
import { parseDeliveryTable } from "../../src/lib/research/evidence/delivery-table";
import { importDeliveryTable } from "../../src/lib/research/evidence/delivery-import";

/** Synthetic metadata operations only. The server's global mode stays shadow,
 * subscriptions remain absent and the fixture scheduler lease stays reserved. */
export function seedLifecycleReviewFixture(db: Database.Database) {
  seedR2cFixture(db);
  const repo = new AlertRepository(db);
  const strategyId = "QA-r3b-decay";
  const now = Date.now();
  const plan = repo.plans().find((row) => row.id === "QA-r3b-plan")!;
  repo.savePlan(
    {
      ...plan,
      id: "QA-l5-bulk-plan",
      entry: 10,
      stop: 9,
      target: null,
      quantity: 200,
      createdAt: Date.parse("2026-01-02T00:00:00Z"),
      expiresAt: "2026-01-06T23:59:59Z",
      rationale: "Synthetic review linkage",
      tags: ["QA-lifecycle"],
    },
    now,
  );
  const raw = readFileSync("tests/fixtures/delivery/r3b-account.csv");
  const table = parseDeliveryTable(raw);
  new DeliveryStore(db).commitImport({
    account: "QA-l5-review",
    source: "generic",
    fileHash: createHash("sha256").update(raw).digest("hex"),
    fileName: "synthetic-lifecycle-review.csv",
    importedAt: now,
    parsed: importDeliveryTable(table),
    rawRows: table.rows,
    sourceHeader: table.header,
  });
  repo.records.save("QA", "qa-lifecycle-review-fixture", { synthetic: true });
  const papers = new PaperRepository(db);
  const paper = papers.account("paper:QA-r2c")!;
  papers.save(
    {
      ...paper,
      summary: {
        ...paper.summary!,
        assessment: {
          eligible: true,
          recommendation: "OLD PAPER CAN ENABLE LIVE",
          reasons: [],
        },
      },
    },
    paper.revision,
  );
  repo.saveState(`shadow:${strategyId}:1`, {
    active: true,
    status: "shadow-candidate",
    startedAt: now,
  });
  repo.saveState(`shadow-summary:${strategyId}:1`, {
    signals: 30,
    days: 60,
    paused: false,
    assessment: {
      at: now - 1000,
      eligible: true,
      reasons: [],
      recommendation: "OLD SHADOW CAN ENABLE LIVE",
    },
  });
  repo.records.save(
    "validation-scoreboard",
    "validation-scoreboard-cn-equity",
    {
      market: "cn-equity",
      inputHash: "a".repeat(64),
      resultHash: "b".repeat(64),
      buildHash: "historical-QA",
      createdAt: now,
      runtimeMs: 0,
      universe: "Synthetic QA only",
      gaps: ["Synthetic historical summary, not current eligibility"],
      missing: [],
      rows: [
        {
          id: strategyId,
          strategyVersion: 1,
          level: "strategy",
          market: "cn-equity",
          sleeve: "swing",
          rule: "QA lifecycle review",
          status: "shadow-candidate",
          return: null,
          excess: null,
          drawdown: null,
          trades: 0,
          positiveWindows: 0,
          oosWindows: 0,
          reasons: ["missing-current-evidence"],
          bias: {
            universe: "QA",
            adjustment: "QA",
            financial: "QA",
            execution: "Synthetic; no real execution",
          },
        },
      ],
    },
  );
  repo.saveState(`strategy:${strategyId}:1`, {
    live: true,
    unvalidatedOverride: true,
  });
  // A recorded historical promotion must not imply current eligibility.
  repo.saveState(`promotion:${strategyId}:1`, {
    at: now - 1000,
    inputHash: "a".repeat(64),
    reasons: [],
  });
}
