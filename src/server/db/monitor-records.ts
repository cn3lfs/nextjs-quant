import type { Channel, Delivery, Monitor, Signal } from "~/lib/domain";
import { monitorWorkspaceId } from "~/lib/strategy-facts/monitor-workspace";
import type { NotificationDecision } from "~/lib/strategy-facts/notification-policy";
import type { IntradayRun } from "../monitoring/intraday-job";
import { z } from "zod";
import { list, put, readRecordSnapshot, sqlite } from "./index";

type WorkspaceRecords = {
  channel: Channel;
  delivery: Delivery;
  monitor: Monitor;
  signal: Signal;
  "notification-decision": NotificationDecision;
  "intraday-run": IntradayRun;
};

export const monitorDefinitions = () =>
  readRecordSnapshot("monitor", (rows: Iterable<Monitor>) => [...rows]);
export const recentDeliveryRecords = () => list<Delivery>("delivery", 200);
export const recentSignalRecords = () => list<Signal>("signal", 100);
export function readMonitorRecord<Kind extends keyof WorkspaceRecords>(
  kind: Kind,
  id: string,
): WorkspaceRecords[Kind] | undefined {
  monitorWorkspaceId.parse(id);
  const row = sqlite()
    .prepare("SELECT payload FROM records WHERE kind=? AND id=?")
    .get(kind, id) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as WorkspaceRecords[Kind]) : undefined;
}

/** Kind-safe writes share the caller's transaction, or own an immediate one.
 * API/configuration policy stays with the owning service and action schemas. */
export function writeMonitorRecord<
  Kind extends "monitor" | "signal" | "delivery",
  Value extends WorkspaceRecords[Kind],
>(kind: Kind, value: Value): Value {
  z.object({
    id: monitorWorkspaceId,
    createdAt: z.number().finite().optional(),
  }).parse(value);
  const db = sqlite();
  return db
    .transaction(() => {
      if (
        db
          .prepare("SELECT id FROM records WHERE id=? AND kind<>?")
          .get(value.id, kind)
      )
        throw new Error(
          kind === "monitor"
            ? "不能覆盖其他类型记录"
            : "记录ID已被其他类型占用",
        );
      return put(kind, value.id, value);
    })
    .immediate();
}

/** One scheduler tick claims at most 500 identities, never 500 message bodies. */
export function pendingDeliveryIds() {
  return (
    sqlite()
      .prepare(
        `SELECT id FROM records WHERE kind='delivery'
    AND json_extract(payload,'$.status')='pending' ORDER BY updated_at,id LIMIT 500`,
      )
      .all() as { id: string }[]
  ).map((row) => row.id);
}

/** Recovery freezes IDs before updating status, so updates cannot move a row
 * across an offset boundary. Later additions belong to the next recovery. */
export function sendingDeliveryIds() {
  return (
    sqlite()
      .prepare(
        `SELECT id FROM records WHERE kind='delivery'
    AND json_extract(payload,'$.status')='sending' ORDER BY id`,
      )
      .all() as { id: string }[]
  ).map((row) => row.id);
}

export function enabledMonitorIds() {
  return (
    sqlite()
      .prepare(
        `SELECT id FROM records WHERE kind='monitor'
    AND json_extract(payload,'$.enabled')=1 ORDER BY updated_at DESC,id DESC`,
      )
      .all() as { id: string }[]
  ).map((row) => row.id);
}
