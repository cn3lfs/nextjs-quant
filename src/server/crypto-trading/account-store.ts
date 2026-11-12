import Big from "big.js";
import { createHash } from "node:crypto";
import { atomic, get, put, sqlite } from "../db";
import {
  credentialRevisionKey,
  type AccountSnapshot,
  type AccountSyncState,
  type AccountTradeRow,
  type AccountViewInput,
  type PlatformTrade,
} from "./account-model";

export const snapshotKey = (id: string, revision: string) =>
  `crypto-account-snapshot-${id}-${revision}`;
export const syncKey = (id: string, revision: string) =>
  `crypto-account-sync-${id}-${revision}`;
const tradeKind = (id: string, revision: string) =>
  `crypto-account-trades-${id}-${revision}`;
export function assertRevision(id: string, revision: string) {
  if (get<string>(credentialRevisionKey(id)) !== revision)
    throw new Error("账户凭证版本已更新，旧同步已终止，请重新同步");
}
export function saveAccountSnapshot(
  id: string,
  revision: string,
  snapshot: AccountSnapshot,
) {
  atomic(() => {
    assertRevision(id, revision);
    put("crypto-account-snapshot", snapshotKey(id, revision), snapshot);
  });
}
export function saveAccountSync(id: string, state: AccountSyncState) {
  atomic(() => {
    assertRevision(id, state.revision);
    put("crypto-account-sync", syncKey(id, state.revision), state);
  });
}
function sameTrade(a: PlatformTrade, b: PlatformTrade) {
  return (
    a.symbol === b.symbol &&
    a.orderId === b.orderId &&
    a.clientOrderId === b.clientOrderId &&
    a.side === b.side &&
    a.time === b.time &&
    a.feeAsset === b.feeAsset &&
    ["quantity", "price", "quoteQuantity", "fee"].every((key) =>
      new Big(a[key as "quantity"]).eq(b[key as "quantity"]),
    )
  );
}
export function appendAccountTrades(
  id: string,
  revision: string,
  trades: PlatformTrade[],
) {
  atomic(() => {
    assertRevision(id, revision);
    for (const trade of trades) {
      const digest = createHash("sha256")
        .update(`${trade.symbol}:${trade.orderId}:${trade.id}`)
        .digest("hex");
      const key = `crypto-account-trade-${id}-${revision}-${digest}`,
        existing = get<PlatformTrade>(key);
      if (existing && !sameTrade(existing, trade))
        throw new Error(
          `平台成交${trade.symbol}/${trade.id}已记录字段发生冲突，已保留原事实`,
        );
      if (!existing) put(tradeKind(id, revision), key, trade);
    }
  });
}
/** Filtering/count/pagination share the same full projection, including all strategy orders. */
export function queryAccountTrades(
  input: AccountViewInput & { page: number; pageSize: number },
  revision: string,
) {
  const conditions: string[] = [],
    params: (string | number)[] = [
      `crypto-orders-${input.id}`,
      tradeKind(input.id, revision),
    ];
  for (const [field, value] of [
    ["symbol", input.symbol],
    ["side", input.side],
  ] as const)
    if (value !== undefined) {
      conditions.push(`json_extract(payload,'$.${field}')=?`);
      params.push(value);
    }
  if (input.source) {
    conditions.push("source=?");
    params.push(input.source);
  }
  if (input.from !== undefined) {
    conditions.push("CAST(json_extract(payload,'$.time') AS INTEGER)>=?");
    params.push(input.from);
  }
  if (input.to !== undefined) {
    conditions.push("CAST(json_extract(payload,'$.time') AS INTEGER)<?");
    params.push(input.to);
  }
  const cte = `WITH projected AS (
    SELECT t.payload, CASE WHEN EXISTS (
      SELECT 1 FROM records o WHERE o.kind=?
      AND json_extract(o.payload,'$.symbol')=json_extract(t.payload,'$.symbol')
      AND ((json_extract(t.payload,'$.orderId')<>'' AND json_extract(o.payload,'$.exchangeId')=json_extract(t.payload,'$.orderId'))
        OR (json_extract(t.payload,'$.clientOrderId')<>'' AND json_extract(o.payload,'$.clientId')=json_extract(t.payload,'$.clientOrderId')))
    ) THEN 'strategy' ELSE 'platform' END source
    FROM records t WHERE t.kind=?
  )`;
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const total = (
    sqlite()
      .prepare(`${cte} SELECT count(*) total FROM projected${where}`)
      .get(...params) as { total: number }
  ).total;
  const rows = (
    sqlite()
      .prepare(
        `${cte} SELECT payload,source FROM projected${where} ORDER BY CAST(json_extract(payload,'$.time') AS INTEGER) DESC,json_extract(payload,'$.symbol') ASC,json_extract(payload,'$.id') ASC,json_extract(payload,'$.orderId') ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, input.pageSize, (input.page - 1) * input.pageSize) as {
      payload: string;
      source: "strategy" | "platform";
    }[]
  ).map((row): AccountTradeRow => ({
    ...(JSON.parse(row.payload) as PlatformTrade),
    source: row.source,
  }));
  return { rows, total };
}
