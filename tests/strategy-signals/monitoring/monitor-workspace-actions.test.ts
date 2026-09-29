import Database from "better-sqlite3";
import { expect, it } from "vitest";
import {
  defaultStrategy,
  type Channel,
  type Monitor,
} from "../../../src/lib/domain";
import {
  channelDestinationVersion,
  confirmWorkspaceDelivery,
  monitorConfigurationVersion,
  saveWorkspaceMonitor,
  toggleWorkspaceMonitor,
} from "../../../src/server/monitoring/monitor-workspace-actions";
function fixture() {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL)",
  );
  return db;
}
function put<T extends { id: string }>(
  db: Database.Database,
  kind: string,
  value: T,
) {
  db.prepare("INSERT OR REPLACE INTO records VALUES(?,?,?,0)").run(
    value.id,
    kind,
    JSON.stringify(value),
  );
}
const input = {
  name: "合成订阅",
  symbols: ["sh600519"],
  strategy: defaultStrategy,
  period: "day",
  source: "local",
  channels: [],
  ai: false,
  enabled: false,
};
it.each(["current", "legacy"])(
  "editing %s uses configuration identity and preserves creation while resetting the baseline",
  (mode) => {
    const db = fixture();
    try {
      const created = saveWorkspaceMonitor(db, input, 100);
      const first =
          mode === "legacy" ? { ...created, revision: undefined } : created,
        version = monitorConfigurationVersion(first);
      const running = {
        ...first,
        lastCheck: 200,
        states: { sh600519: { date: "2026-09-29", matched: true } },
      };
      put(db, "monitor", running);
      expect(monitorConfigurationVersion(running)).toBe(version);
      const saved = saveWorkspaceMonitor(
        db,
        { ...input, id: first.id, expectedVersion: version, name: "修改后" },
        300,
      );
      expect(saved.createdAt).toBe(100);
      expect(saved.states).toEqual({});
      expect(saved.revision).not.toBe(first.revision);
      expect(() =>
        saveWorkspaceMonitor(
          db,
          { ...input, id: first.id, expectedVersion: version },
          400,
        ),
      ).toThrow("订阅已被修改");
      const enabled = toggleWorkspaceMonitor(
        db,
        {
          id: saved.id,
          expectedVersion: monitorConfigurationVersion(saved),
          enabled: true,
        },
        500,
      );
      expect(enabled.enabled).toBe(true);
      expect(enabled.revision).not.toBe(saved.revision);
      const unchanged = toggleWorkspaceMonitor(
        db,
        {
          id: enabled.id,
          expectedVersion: monitorConfigurationVersion(enabled),
          enabled: true,
        },
        600,
      );
      expect(unchanged).toEqual(enabled);
    } finally {
      db.close();
    }
  },
);
it("confirmation is idempotent, target-bound and leaves the original failure immutable", () => {
  const db = fixture();
  try {
    const channel: Channel = {
      id: "channel",
      name: "假渠道",
      type: "feishu",
      target: "",
      thread: "",
      enabled: true,
      configured: true,
    };
    put(db, "channel", channel);
    const original = {
      id: "original",
      signalId: "signal",
      channelId: channel.id,
      kind: "signal",
      title: "合成",
      body: "完整历史正文",
      status: "failed",
      attempts: 3,
      nextAt: 1,
      expiresAt: 2,
      createdAt: 0,
      error: "旧错误",
      remoteId: "旧远端ID",
    };
    put(db, "delivery", original);
    const action = {
      deliveryId: original.id,
      requestId: "83a849d0-e17a-4cfe-b3f4-c0e47c9b8401",
      expectedChannelVersion: channelDestinationVersion(channel),
    };
    const first = confirmWorkspaceDelivery(db, action, 1000),
      second = confirmWorkspaceDelivery(db, action, 2000);
    expect(second).toEqual(first);
    expect(() =>
      confirmWorkspaceDelivery(
        db,
        { ...action, deliveryId: "another-original" },
        2000,
      ),
    ).toThrow("另一条投递");
    expect(first).toMatchObject({
      sourceDeliveryId: "original",
      status: "pending",
      manualRetry: true,
      attempts: 0,
      expiresAt: 601000,
    });
    expect(first.remoteId).toBeUndefined();
    expect(first.error).toBeUndefined();
    expect(
      JSON.parse(
        (
          db
            .prepare("SELECT payload FROM records WHERE id='original'")
            .get() as { payload: string }
        ).payload,
      ),
    ).toEqual(original);
    const next = {
      ...action,
      requestId: "e5ee8223-179b-42c6-a14a-c4b597c50b4e",
    };
    expect(confirmWorkspaceDelivery(db, next, 3000).id).not.toBe(first.id);
    put(db, "channel", { ...channel, enabled: false });
    expect(() =>
      confirmWorkspaceDelivery(
        db,
        { ...action, requestId: "3e7b46eb-a670-4c6b-8e22-8b73322490b7" },
        4000,
      ),
    ).toThrow("未启用");
    expect(
      (
        db
          .prepare("SELECT count(*) n FROM records WHERE kind='delivery'")
          .get() as { n: number }
      ).n,
    ).toBe(3);
  } finally {
    db.close();
  }
});
it("rejects changed destinations and invalid retry states without creating a delivery", () => {
  const db = fixture();
  try {
    const channel: Channel = {
      id: "channel",
      name: "假渠道",
      type: "telegram",
      target: "target-a",
      thread: "",
      enabled: true,
      configured: true,
    };
    put(db, "channel", channel);
    const original = {
      id: "original",
      signalId: "signal",
      channelId: channel.id,
      kind: "signal",
      title: "合成",
      body: "正文",
      status: "failed",
      attempts: 1,
      nextAt: 1,
      expiresAt: 2,
      createdAt: 0,
    };
    put(db, "delivery", original);
    const action = {
      deliveryId: original.id,
      requestId: "83a849d0-e17a-4cfe-b3f4-c0e47c9b8401",
      expectedChannelVersion: channelDestinationVersion(channel),
    };
    put(db, "channel", { ...channel, target: "target-b" });
    expect(() => confirmWorkspaceDelivery(db, action)).toThrow("目标已变化");
    put(db, "channel", channel);
    put(db, "delivery", { ...original, status: "sent" });
    expect(() => confirmWorkspaceDelivery(db, action)).toThrow("无需人工重发");
    put(db, "delivery", original);
    db.prepare("DELETE FROM records WHERE id='channel'").run();
    expect(() => confirmWorkspaceDelivery(db, action)).toThrow("渠道不存在");
    expect(
      (
        db
          .prepare("SELECT count(*) n FROM records WHERE kind='delivery'")
          .get() as { n: number }
      ).n,
    ).toBe(1);
    db.prepare("DELETE FROM records WHERE id='original'").run();
    expect(() => confirmWorkspaceDelivery(db, action)).toThrow("原投递不存在");
  } finally {
    db.close();
  }
});
