import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Channel, Delivery, Monitor } from "~/lib/domain";
import { channelDestinationVersion } from "../infra/channel-version";
export { channelDestinationVersion } from "../infra/channel-version";
import {
  monitorSaveSchema,
  monitorToggleSchema,
  deliveryConfirmSchema,
} from "~/lib/strategy-facts/monitor-workspace-actions";

function read<T>(
  db: Database.Database,
  kind: string,
  id: string,
): T | undefined {
  const row = db
    .prepare("SELECT payload FROM records WHERE kind=? AND id=?")
    .get(kind, id) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as T) : undefined;
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Only configuration participates: a routine check must not invalidate an open editor. */
export function monitorConfigurationVersion(value: Monitor) {
  return digest({
    id: value.id,
    revision: value.revision ?? null,
    createdAt: value.createdAt,
    name: value.name,
    symbols: value.symbols,
    strategy: value.strategy,
    period: value.period,
    source: value.source,
    channels: value.channels,
    ai: value.ai,
    enabled: value.enabled,
  });
}
function write<T extends { id: string }>(
  db: Database.Database,
  kind: string,
  value: T,
  now: number,
) {
  const result = db
    .prepare(
      "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at WHERE records.kind=excluded.kind",
    )
    .run(value.id, kind, JSON.stringify(value), now);
  if (result.changes !== 1) throw new Error("记录ID已被其他类型占用");
  return value;
}
function requireVersion(
  value: Monitor | undefined,
  expected: string | undefined,
) {
  if (!value) throw new Error("订阅不存在，请返回列表刷新");
  if (monitorConfigurationVersion(value) !== expected)
    throw new Error("订阅已被修改，请重新读取后再保存；当前草稿仍保留");
  return value;
}
export function saveWorkspaceMonitor(
  db: Database.Database,
  raw: unknown,
  now = Date.now(),
) {
  const input = monitorSaveSchema.parse(raw);
  return db
    .transaction(() => {
      const old = input.id
        ? requireVersion(
            read<Monitor>(db, "monitor", input.id),
            input.expectedVersion,
          )
        : undefined;
      for (const id of input.channels)
        if (!read<Channel>(db, "channel", id))
          throw new Error("通知渠道不存在，请重新选择");
      const value: Monitor = {
        id: old?.id ?? `monitor-${randomUUID()}`,
        name: input.name,
        symbols: [...new Set(input.symbols)],
        strategy: input.strategy,
        period: input.period,
        source: input.source,
        channels: [...new Set(input.channels)],
        ai: input.ai,
        enabled: input.enabled,
        createdAt: old?.createdAt ?? now,
        revision: randomUUID(),
        states: {},
      };
      return write(db, "monitor", value, now);
    })
    .immediate();
}
export function toggleWorkspaceMonitor(
  db: Database.Database,
  raw: unknown,
  now = Date.now(),
) {
  const input = monitorToggleSchema.parse(raw);
  return db
    .transaction(() => {
      const old = requireVersion(
        read<Monitor>(db, "monitor", input.id),
        input.expectedVersion,
      );
      // Repeating the same desired state must not silently rebuild an active baseline.
      if (old.enabled === input.enabled) return old;
      const {
        lastCheck: _lastCheck,
        error: _error,
        calendarEvidence: _calendar,
        tradingStatusChecks: _checks,
        ...config
      } = old;
      return write(
        db,
        "monitor",
        {
          ...config,
          enabled: input.enabled,
          revision: randomUUID(),
          states: {},
        },
        now,
      );
    })
    .immediate();
}
export type ManualWorkspaceDelivery = Delivery & {
  sourceDeliveryId: string;
  requestId: string;
};
export function confirmWorkspaceDelivery(
  db: Database.Database,
  raw: unknown,
  now = Date.now(),
) {
  const input = deliveryConfirmSchema.parse(raw);
  return db
    .transaction(() => {
      const id = `manual-${digest(input.requestId)}`;
      const existing = read<ManualWorkspaceDelivery>(db, "delivery", id);
      if (existing) {
        if (
          existing.sourceDeliveryId !== input.deliveryId ||
          existing.requestId !== input.requestId
        )
          throw new Error("确认请求已用于另一条投递");
        return existing;
      }
      const original = read<Delivery>(db, "delivery", input.deliveryId);
      if (!original) throw new Error("原投递不存在");
      if (!["failed", "expired", "cancelled"].includes(original.status))
        throw new Error("当前状态无需人工重发，请刷新结果");
      const channel = read<Channel>(db, "channel", original.channelId);
      if (!channel?.enabled || !channel.configured)
        throw new Error("渠道不存在、未配置或未启用，请先处理渠道设置");
      if (channelDestinationVersion(channel) !== input.expectedChannelVersion)
        throw new Error("渠道目标已变化，请重新核对后确认");
      const value: ManualWorkspaceDelivery = {
        ...original,
        id,
        sourceDeliveryId: original.id,
        requestId: input.requestId,
        confirmedChannelVersion: input.expectedChannelVersion,
        body: `【手动重发历史通知】\n${original.body}`,
        manualRetry: true,
        remoteId: undefined,
        error: undefined,
        status: "pending",
        attempts: 0,
        nextAt: now,
        createdAt: now,
        expiresAt: now + 600000,
      };
      return write(db, "delivery", value, now);
    })
    .immediate();
}
