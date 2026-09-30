import { notificationPolicySchema } from "../../../src/lib/strategy-facts/notification-policy";
import { migrate } from "../../../src/server/db/migrations";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { seedSignals, signalsFixtureTime } from "../../helpers/signals-fixture";
import {
  monitorWorkspacePage,
  signalWorkspacePage,
  deliveryWorkspacePage,
  monitorWorkspaceSummary,
  signalDeliveryCounts,
  deliveryWorkspaceDetail,
  monitorWorkspaceExport,
  signalWorkspaceDetail,
} from "../../../src/server/monitoring/monitor-workspace-query";
import { deliveryOutcomeCounts } from "../../../src/lib/strategy-facts/monitor-workspace";
it("detects injected body, current-page statistics and first-channel reductions", () => {
  const db = fixture();
  try {
    const summary = monitorWorkspaceSummary(db, signalsFixtureTime);
    const guardSummary = (value: unknown) => {
      expect(JSON.stringify(value)).not.toContain('"body"');
      expect(value).toMatchObject({
        todaySignals: 41,
        todaySent: 82,
        failedDeliveries: 41,
      });
    };
    guardSummary(summary);
    expect(() =>
      guardSummary({ ...summary, body: "injected evidence" }),
    ).toThrow();
    expect(() =>
      guardSummary({
        ...summary,
        todaySignals: signalWorkspacePage(db, {}).items.length,
      }),
    ).toThrow();
    const rows = deliveryWorkspacePage(db, {
      signalId: "signal-fixture-00000",
    }).items;
    const guardMixed = (value: unknown) =>
      expect(value).toMatchObject({
        sent: 3,
        failed: 1,
        expired: 1,
        cancelled: 1,
      });
    guardMixed(deliveryOutcomeCounts(rows));
    expect(() => guardMixed(deliveryOutcomeCounts(rows.slice(0, 1)))).toThrow();
  } finally {
    db.close();
  }
});

it("uses inclusive Beijing calendar days, rejects malformed cursor and reaches Chinese filters", () => {
  const db = fixture();
  try {
    const original = JSON.parse(
      (
        db
          .prepare(
            "SELECT payload FROM records WHERE id='signal-fixture-00000'",
          )
          .get() as { payload: string }
      ).payload,
    );
    const at = Date.parse("2026-09-29T00:00:00+08:00");
    const put = db.prepare("INSERT INTO records VALUES(?,?,?,?)");
    for (const [id, offset] of [
      ["edge-before", -1],
      ["edge-start", 0],
      ["edge-end", 86400000 - 1],
      ["edge-after", 86400000],
    ] as const)
      put.run(
        id,
        "signal",
        JSON.stringify({ ...original, id, createdAt: at + offset }),
        at + offset,
      );
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = signalWorkspacePage(db, {
        from: "2026-09-29",
        to: "2026-09-29",
        cursor,
      });
      found.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toContain("edge-start");
    expect(found).toContain("edge-end");
    expect(found).not.toContain("edge-before");
    expect(found).not.toContain("edge-after");
    expect(
      monitorWorkspacePage(db, { query: "合成订阅 40" }).items.map(
        (row) => row.id,
      ),
    ).toEqual(["monitor-fixture-40"]);
    expect(() => signalWorkspacePage(db, { cursor: "not-a-cursor" })).toThrow(
      "分页",
    );
  } finally {
    db.close();
  }
});

function fixture() {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT,payload TEXT,updated_at INTEGER)",
  );
  seedSignals(db, 41, 41);
  return db;
}
it("paginates all records with tied creation times and binds cursors to filters", () => {
  const db = fixture();
  try {
    for (const [kind, query, total] of [
      ["monitor", monitorWorkspacePage, 41],
      ["signal", signalWorkspacePage, 41],
      ["delivery", deliveryWorkspacePage, 205],
    ] as const) {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = query(db, { cursor });
        ids.push(...page.items.map((row) => row.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(new Set(ids).size).toBe(total);
      expect(ids).toHaveLength(total);
      const golden = (
        db
          .prepare(
            "SELECT id FROM records WHERE kind=? ORDER BY json_extract(payload,'$.createdAt') DESC,id DESC",
          )
          .all(kind) as { id: string }[]
      ).map((row) => row.id);
      expect(ids).toEqual(golden);
      expect(() =>
        query(db, { query: "changed", cursor: query(db, {}).nextCursor }),
      ).toThrow("分页");
    }
  } finally {
    db.close();
  }
});
it("counts mixed outcomes and shared summaries once, independent of paged history", () => {
  const db = fixture();
  try {
    const counts = signalDeliveryCounts(db, ["signal-fixture-00000"]).get(
      "signal-fixture-00000",
    );
    expect(counts).toEqual({
      sent: 3,
      failed: 1,
      cancelled: 1,
      expired: 1,
      pending: 0,
      sending: 0,
    });
    const related = deliveryWorkspacePage(db, {
      signalId: "signal-fixture-00000",
    });
    expect(related.items).toHaveLength(6);
    expect(new Set(related.items.map((row) => row.id)).size).toBe(6);
    expect(monitorWorkspaceSummary(db, signalsFixtureTime)).toMatchObject({
      todaySignals: 41,
      todaySent: 82,
      failedDeliveries: 41,
      enabledMonitors: 0,
    });
    expect(
      monitorWorkspaceSummary(db, signalsFixtureTime + 86400000),
    ).toMatchObject({ todaySignals: 0, todaySent: 0, failedDeliveries: 41 });
    expect(
      deliveryWorkspacePage(db, { status: "failed" }).items.every(
        (row) => row.status === "failed",
      ),
    ).toBe(true);
    const update = db.prepare("UPDATE records SET payload=? WHERE id=?");
    for (const index of [0, 1]) {
      const id = `monitor-fixture-${index}`;
      const value = JSON.parse(
        (
          db.prepare("SELECT payload FROM records WHERE id=?").get(id) as {
            payload: string;
          }
        ).payload,
      );
      update.run(
        JSON.stringify({
          ...value,
          enabled: index === 0,
          tradingStatusChecks: {
            sh600519: { status: "suspended" },
            ...(index === 0
              ? {
                  sz000001: { status: "unknown" },
                  sz000002: { status: "trading" },
                }
              : {}),
          },
        }),
        id,
      );
    }
    expect(monitorWorkspaceSummary(db, signalsFixtureTime)).toMatchObject({
      enabledMonitors: 1,
      pausedSymbolInstances: 3,
    }); // Includes disabled subscriptions and counts duplicate symbols as separate instances.
  } finally {
    db.close();
  }
});
it("projects metadata only, matches exact Beijing date and rejects wrong-kind details", () => {
  const db = fixture();
  try {
    const page = deliveryWorkspacePage(db, {
      from: "2026-09-29",
      to: "2026-09-29",
    });
    expect(page.items).toHaveLength(20);
    expect(JSON.stringify(page)).not.toContain("证据");
    expect(JSON.stringify(page)).not.toContain('"body"');
    expect(deliveryWorkspacePage(db, { from: "2026-09-30" }).items).toEqual([]);
    expect(deliveryWorkspaceDetail(db, "signal-fixture-00000")).toBeNull();
    expect(deliveryWorkspaceDetail(db, page.items[0]!.id)?.body).toContain(
      "证据",
    );
  } finally {
    db.close();
  }
});

it("migrates metadata indexes without changing records or query results", () => {
  const db = fixture();
  try {
    const before = db.prepare("SELECT * FROM records ORDER BY id").all();
    const pageBefore = signalWorkspacePage(db, {});
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(13);
    expect(db.prepare("SELECT * FROM records ORDER BY id").all()).toEqual(
      before,
    );
    expect(signalWorkspacePage(db, {})).toEqual(pageBefore);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'monitor_workspace_%'",
        )
        .all(),
    ).toHaveLength(4);
    migrate(db);
    expect(db.prepare("SELECT * FROM records ORDER BY id").all()).toEqual(
      before,
    );
  } finally {
    db.close();
  }
});

it("exports complete large evidence and joins only stored decisions without exposing channel secrets", () => {
  const db = fixture();
  try {
    const id = "delivery-fixture-00000-0";
    const row = db
      .prepare("SELECT payload FROM records WHERE id=?")
      .get(id) as { payload: string };
    const body = "完整历史证据🙂".repeat(100000);
    const value = {
      ...JSON.parse(row.payload),
      body,
      policyDecisionIds: ["decision-fixture"],
    };
    db.prepare("UPDATE records SET payload=? WHERE id=?").run(
      JSON.stringify(value),
      id,
    );
    const channel = JSON.parse(
      (
        db
          .prepare("SELECT payload FROM records WHERE id='channel-fixture-0'")
          .get() as { payload: string }
      ).payload,
    );
    db.prepare("UPDATE records SET payload=? WHERE id='channel-fixture-0'").run(
      JSON.stringify({
        ...channel,
        secret: "synthetic-do-not-export",
        signingSecret: "synthetic-hidden",
      }),
    );
    const decision = {
      id: "decision-fixture",
      signalId: "signal-fixture-00000",
      symbol: "sh600519",
      strategy: "dual-breakout",
      date: "2026-09-29",
      endpointDate: "2026-09-29",
      direction: "long",
      score: 4,
      tier: "immediate",
      reasons: ["fixture decision"],
      policy: notificationPolicySchema.parse({}),
      createdAt: signalsFixtureTime,
    };
    db.prepare("INSERT INTO records VALUES(?,?,?,?)").run(
      decision.id,
      "notification-decision",
      JSON.stringify(decision),
      signalsFixtureTime,
    );
    const detail = deliveryWorkspaceDetail(db, id)!;
    expect(detail.body).toBe(body);
    expect(detail.decisions).toEqual([decision]);
    expect(JSON.stringify(detail.channel)).not.toContain("synthetic-hidden");
    expect(JSON.stringify(detail.channel)).not.toContain("secret");
    expect(
      signalWorkspaceDetail(db, "signal-fixture-00000")?.decisions,
    ).toEqual([decision]);
    const exported = monitorWorkspaceExport(
      db,
      "signal",
      "signal-fixture-00000",
    );
    expect("deliveries" in exported && exported.deliveries).toHaveLength(6);
    if (exported.kind === "signal")
      expect(exported.deliveries.find((row) => row.id === id)?.body).toBe(body);
    expect(
      JSON.stringify(
        deliveryWorkspacePage(db, { signalId: "signal-fixture-00000" }),
      ),
    ).not.toContain("完整历史证据");
  } finally {
    db.close();
  }
});
