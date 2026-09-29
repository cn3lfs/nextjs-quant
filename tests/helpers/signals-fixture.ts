import type Database from "better-sqlite3";
import {
  defaultStrategy,
  type Monitor,
  type Signal,
  type Delivery,
} from "../../src/lib/domain";
export const signalsFixtureTime = Date.parse("2026-09-29T09:00:00+08:00");
export function seedSignals(
  db: Database.Database,
  monitors = 1000,
  signals = 10000,
) {
  const insert = db.prepare(
    "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,?,?,?)",
  );
  const put = (kind: string, value: { id: string }, at: number) =>
    insert.run(value.id, kind, JSON.stringify(value), at);
  db.transaction(() => {
    for (let i = 0; i < monitors; i++) {
      const value: Monitor = {
        id: `monitor-fixture-${i}`,
        name: `合成订阅 ${i}`,
        symbols: ["sh600519"],
        strategy: defaultStrategy,
        period: "day",
        source: "local",
        channels: ["channel-fixture-0", "channel-fixture-1"],
        ai: false,
        enabled: false,
        states: {},
        revision: `fixture-${i}`,
        createdAt: signalsFixtureTime + i,
        lastCheck: signalsFixtureTime,
      };
      put("monitor", value, value.createdAt);
    }
    for (let i = 0; i < signals; i++) {
      const createdAt = signalsFixtureTime + Math.floor(i / 2),
        date = "2026-09-29";
      const value: Signal = {
        id: `signal-fixture-${String(i).padStart(5, "0")}`,
        monitorId: `monitor-fixture-${i % monitors}`,
        symbol: i % 2 ? "sh600519" : "sz000001",
        strategy: defaultStrategy,
        period: "day",
        date,
        createdAt,
        expiresAt: createdAt + 600000,
        metrics: {
          close: 10,
          change: 1,
          fast: 10,
          slow: 9,
          volumeRatio: 1,
          matched: true,
          date,
          score: 1,
        },
        snapshotId: `snapshot-fixture-${i}`,
        source: "fixture",
        monitorRun: {
          createdAt: signalsFixtureTime + (i % monitors),
          revision: `fixture-${i % monitors}`,
        },
      };
      put("signal", value, createdAt);
      for (let j = 0; j < 5; j++) {
        const status = (
          ["sent", "failed", "cancelled", "expired", "sent"] as const
        )[j]!;
        const delivery: Delivery = {
          id: `delivery-fixture-${String(i).padStart(5, "0")}-${j}`,
          signalId: value.id,
          channelId: `channel-fixture-${j % 2}`,
          kind: j === 4 ? "summary" : "signal",
          title: `合成通知 ${i}-${j}`,
          body: `证据 ${i}。`.repeat(80),
          status,
          attempts: 1,
          nextAt: createdAt,
          expiresAt: createdAt + 600000,
          createdAt,
          ...(j === 4
            ? {
                summarySignalIds: [
                  value.id,
                  `signal-fixture-${String(Math.max(0, i - 1)).padStart(5, "0")}`,
                ],
              }
            : {}),
          ...(status === "failed" ? { error: "隔离投递失败" } : {}),
        };
        put("delivery", delivery, createdAt + j);
      }
    }
    for (let i = 0; i < 2; i++)
      put(
        "channel",
        {
          id: `channel-fixture-${i}`,
          name: `假渠道 ${i}`,
          type: "feishu",
          enabled: false,
          configured: false,
        } as { id: string },
        1,
      );
  })();
}
