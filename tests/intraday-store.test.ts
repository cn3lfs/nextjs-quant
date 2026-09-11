import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrate } from "../src/server/db/migrations";
import {
  IntradayStore,
  type IntradayObservation,
} from "../src/server/intraday-store";

it("preserves previews, retries unavailable closes and never rewrites settled results", () => {
  const db = new Database(":memory:");
  migrate(db);
  try {
    const store = new IntradayStore(db);
    const preview: IntradayObservation = {
      engineVersion: "v1",
      sessionId: "2024-03-04:late",
      rpsDate: "2024-03-01",
      rps: 95,
      poolHash: "pool",
      observedAt: Date.parse("2024-03-04T14:40:01+08:00"),
      barCutoff: "2024-03-04T14:40:00+08:00",
      snapshotHash: "preview",
      snapshot: {
        source: "tdx-local",
        adjustment: "none",
        symbol: "sh600000",
        bars: [],
      },
      signals: [
        {
          key: "buy",
          strategy: "czsc",
          endpointDate: "2024-03-01",
          strategyVersion: "v1",
          evidence: "{}",
        },
      ],
    };
    const first = store.record(preview);
    const constrained = new IntradayStore(db, store.usage().bytes);
    expect(constrained.record(preview)).toEqual(first);
    expect(() =>
      constrained.record({ ...preview, sessionId: "another" }),
    ).toThrow("存储上限");
    expect(store.page()).toHaveLength(1);
    expect(store.record({ ...preview, rps: 12 })).toEqual(first);
    expect(() =>
      store.confirm(first.id, {
        observedAt: preview.observedAt,
        signalKeys: [],
        snapshotHash: "x",
        reason: null,
      }),
    ).toThrow("时间");
    const now = Date.parse("2024-03-04T15:10:00+08:00");
    const unavailable = {
      observedAt: now,
      signalKeys: null,
      snapshotHash: null,
      reason: "缺行情",
    };
    expect(store.confirm(first.id, unavailable).signals[0]?.status).toBe(
      "unavailable",
    );
    store.confirm(first.id, unavailable);
    expect(store.attempts(first.id)).toHaveLength(1);
    const settled = store.confirm(first.id, {
      observedAt: now + 1,
      signalKeys: ["buy"],
      snapshotHash: "close",
      reason: null,
    });
    expect(settled.signals[0]?.status).toBe("confirmed");
    expect(
      store.confirm(first.id, {
        observedAt: now + 2,
        signalKeys: [],
        snapshotHash: "revision",
        reason: null,
      }),
    ).toEqual(settled);
    expect(store.observation(first.id)).toEqual(preview);
    expect(store.page()[0]?.attempts).toHaveLength(2);
    db.prepare("INSERT INTO records VALUES ('unrelated','test','{}',0)").run();
    store.remove(first.id);
    expect(store.page()).toEqual([]);
    expect(store.attempts(first.id)).toEqual([]);
    expect(db.prepare("SELECT id FROM records").all()).toEqual([
      { id: "unrelated" },
    ]);
  } finally {
    db.close();
  }
});
