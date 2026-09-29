import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const db = new Database(join(tmpdir(), "quant-signals-s0/quant.sqlite"));
const id = "delivery-fixture-09999-1";
const original = db.prepare("SELECT * FROM records WHERE id=?").get(id);
const decisionId = "signals-refresh-decision-" + process.pid;
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const reads = [];
  page.on("request", (request) => {
    if (request.url().includes("signalWorkspaceDetail"))
      reads.push(request.url());
  });
  await page.goto(
    "http://127.0.0.1:3225/signals?monitorTab=signals&monitorRecord=signal-fixture-09999",
  );
  const detail = page.getByRole("region", {
    name: "监控记录详情",
    exact: true,
  });
  await detail
    .getByRole("button", { name: "查看全部关联投递", exact: true })
    .waitFor();
  const before = reads.length;
  const value = JSON.parse(original.payload);
  db.transaction(() => {
    db.prepare("UPDATE records SET payload=? WHERE id=?").run(
      JSON.stringify({ ...value, status: "sent" }),
      id,
    );
    db.prepare("INSERT INTO records VALUES(?,?,?,?)").run(
      decisionId,
      "notification-decision",
      JSON.stringify({
        id: decisionId,
        signalId: "signal-fixture-09999",
        symbol: "sh600519",
        strategy: "ma-cross",
        date: "2026-09-29",
        endpointDate: "2026-09-29",
        direction: "long",
        score: 4,
        tier: "immediate",
        reasons: ["刷新后新增决策证据"],
        createdAt: Date.now(),
      }),
      Date.now(),
    );
  })();
  // The signal page polls; a changed per-signal outcome vector must invalidate this completed detail.
  await page.waitForTimeout(12000);
  assert.ok(
    reads.length > before,
    "changed outcomes refresh the selected completed signal detail",
  );
  await detail.getByText(/刷新后新增决策证据/).waitFor();
  writeFileSync(
    join(tmpdir(), "logs/quant-signals/detail-refresh.json"),
    JSON.stringify(
      {
        initialReads: before,
        afterReads: reads.length,
        updatedDecisionVisible: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "Completed signal evidence refreshed after delivery outcome changed",
  );
} finally {
  await browser?.close();
  db.prepare("UPDATE records SET kind=?,payload=?,updated_at=? WHERE id=?").run(
    original.kind,
    original.payload,
    original.updated_at,
    id,
  );
  db.prepare(
    "DELETE FROM records WHERE id=? AND kind='notification-decision'",
  ).run(decisionId);
  assert.deepEqual(
    db.prepare("SELECT * FROM records WHERE id=?").get(id),
    original,
  );
  db.close();
}
