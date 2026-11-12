import Big from "big.js";
import { randomUUID } from "node:crypto";
import { atomic, get, put, remove } from "../db";
import { processAlive } from "../infra/lease";
import { createSpotAdapter } from "./adapter";
import { symbols, type Balance, type Symbol } from "./model";
import { getCryptoAccountReadContext } from "./service";
import {
  accountSyncSchema,
  accountViewSchema,
  credentialRevisionKey,
  type AccountSnapshot,
  type AccountSyncInput,
  type AccountSyncState,
  type AccountView,
  type AccountViewInput,
  type CompletedRange,
  type PlatformTrade,
} from "./account-model";
import {
  appendAccountTrades,
  assertRevision,
  queryAccountTrades,
  saveAccountSnapshot,
  saveAccountSync,
  snapshotKey,
  syncKey,
} from "./account-store";

const day = 86400000;
const leaseKey = (id: string) => `crypto-account-sync-lease-${id}`;
type SyncLease = { owner: string; pid: number; revision: string };
const message = (error: unknown) =>
  error instanceof Error ? error.message : "账户同步失败";
function completeRanges(ranges: CompletedRange[]) {
  const result: CompletedRange[] = [];
  for (const symbol of symbols) {
    for (const range of ranges
      .filter((x) => x.symbol === symbol)
      .sort((a, b) => a.from - b.from || a.to - b.to)) {
      const previous = result.at(-1);
      if (previous?.symbol === symbol && range.from <= previous.to)
        previous.to = Math.max(previous.to, range.to);
      else result.push({ ...range });
    }
  }
  return result;
}
function validatedBalances(input: Balance[]): Balance[] {
  return ["BTC", "ETH", "USDT"].map((asset) => {
    const matching = input.filter((x) => x.asset === asset);
    if (matching.length > 1) throw new Error(`${asset}余额重复`);
    // Adapters return the complete wallet (including filtered nonzero assets): an omitted asset is zero.
    // Request/schema failures throw before this function; they never become a zero snapshot.
    const value = matching[0] ?? { asset, free: "0", total: "0" };
    if (
      new Big(value.total).lt(0) ||
      new Big(value.free).lt(0) ||
      new Big(value.total).lt(value.free)
    )
      throw new Error(`${asset}余额格式无效`);
    return {
      asset,
      free: new Big(value.free).toFixed(),
      total: new Big(value.total).toFixed(),
    };
  });
}
function checkedTrades(
  trades: PlatformTrade[],
  symbol: Symbol,
  from: number,
  to: number,
) {
  for (const trade of trades) {
    if (
      trade.symbol !== symbol ||
      !trade.id ||
      !trade.orderId ||
      !Number.isSafeInteger(trade.time) ||
      trade.time < from ||
      trade.time >= to ||
      !["BUY", "SELL"].includes(trade.side) ||
      !trade.feeAsset ||
      new Big(trade.quantity).lte(0) ||
      new Big(trade.price).lte(0) ||
      new Big(trade.quoteQuantity).lt(0)
    )
      throw new Error("平台成交不符合请求范围或格式");
    new Big(trade.fee);
  }
  return trades;
}
export async function cryptoAccountView(
  input: AccountViewInput,
): Promise<AccountView> {
  const parsed = accountViewSchema.parse(input);
  return atomic(() => {
    const revision = get<string>(credentialRevisionKey(parsed.id));
    if (!revision)
      return {
        snapshot: null,
        sync: null,
        rows: [],
        total: 0,
        page: parsed.page,
        pageSize: parsed.pageSize,
      };
    const snapshot =
      get<AccountSnapshot>(snapshotKey(parsed.id, revision)) ?? null;
    let sync = get<AccountSyncState>(syncKey(parsed.id, revision)) ?? null;
    if (sync?.status === "running") {
      const lease = get<SyncLease>(leaseKey(parsed.id));
      if (!lease || lease.revision !== revision || !processAlive(lease.pid))
        sync = {
          ...sync,
          status: "failed",
          finishedAt: Date.now(),
          error: "上次同步进程已中断，请重新同步；已获取记录仍保留",
        };
    }
    return {
      snapshot,
      sync,
      ...queryAccountTrades(parsed, revision),
      page: parsed.page,
      pageSize: parsed.pageSize,
    };
  });
}
export async function syncCryptoAccount(
  input: AccountSyncInput,
): Promise<AccountSyncState> {
  const parsed = accountSyncSchema.parse(input),
    context = await getCryptoAccountReadContext(parsed.id);
  const { revision, config } = context,
    now = Date.now(),
    explicit = parsed.from !== undefined || parsed.to !== undefined;
  const previous = get<AccountSyncState>(syncKey(parsed.id, revision));
  const to = parsed.to ?? now;
  const requestedStart =
    parsed.from ??
    (parsed.to !== undefined
      ? to - 30 * day
      : previous?.lastIncrementalTo !== null &&
          previous?.lastIncrementalTo !== undefined
        ? previous.lastIncrementalTo - 3600000
        : to - 30 * day);
  const from = explicit
    ? requestedStart
    : Math.max(0, to - 90 * day, requestedStart);
  const skippedOldGap = !explicit && from > requestedStart;
  if (from < 0 || from >= to || to > now || to - from > 90 * day)
    throw new Error("同步范围须为过去时间，且最多90天");
  const owner = randomUUID();
  const acquired = atomic(() => {
    assertRevision(parsed.id, revision);
    const current = get<SyncLease>(leaseKey(parsed.id));
    if (current && processAlive(current.pid)) return false;
    put("crypto-account-sync-lease", leaseKey(parsed.id), {
      owner,
      pid: process.pid,
      revision,
    });
    return true;
  });
  if (!acquired) {
    const running = get<AccountSyncState>(syncKey(parsed.id, revision));
    if (running) return running;
    throw new Error("账户正在同步，请稍后刷新");
  }
  const state: AccountSyncState = {
    revision,
    status: "running",
    startedAt: now,
    finishedAt: null,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastIncrementalTo: previous?.lastIncrementalTo ?? null,
    requestedFrom: from,
    requestedTo: to,
    completedRanges: previous?.completedRanges ?? [],
    warnings: [],
    error: null,
  };
  const errors: string[] = [];
  let snapshotSucceeded = false,
    windowsSucceeded = 0,
    historyComplete = true;
  const retentionDays = config.venue === "okx" ? 90 : null;
  const availableFrom =
    retentionDays === null ? from : Math.max(from, now - retentionDays * day);
  if (skippedOldGap)
    state.warnings.push(
      "距离上次增量同步已超过90天，本次仅查询最近90天；更早缺口未查询，可按范围补同步",
    );
  if (config.venue === "bybit")
    state.warnings.push(
      "Bybit Demo文档提示订单保留7天；成交实际可得以接口响应为准，空响应不能证明没有更早成交",
    );
  if (retentionDays !== null)
    state.warnings.push(
      "OKX成交历史接口提供近三个月记录；实际保留范围以平台响应为准",
    );
  if (availableFrom > from)
    state.warnings.push(
      "请求范围早于平台保留期，仅同步仍可查询部分；未查询范围不代表没有成交",
    );
  try {
    saveAccountSync(parsed.id, state);
    const exchange = createSpotAdapter(config, context.credential);
    try {
      const raw = await exchange.snapshot(),
        balances = validatedBalances(raw.balances);
      const snapshot: AccountSnapshot = {
        at: Date.now(),
        balances,
        positions: [],
        warnings: [],
      };
      for (const symbol of symbols) {
        const asset = symbol.slice(0, -4),
          balance = balances.find((x) => x.asset === asset)!;
        let price: string | null = null,
          marketValue: string | null = null,
          priceAt: number | null = null;
        try {
          const quoted = await exchange.price(symbol);
          if (new Big(quoted).lte(0)) throw new Error("无效价格");
          price = new Big(quoted).toFixed();
          marketValue = new Big(balance.total).times(price).toFixed();
          priceAt = Date.now();
        } catch (error) {
          snapshot.warnings.push(`${symbol}估值不可用：${message(error)}`);
        }
        snapshot.positions.push({
          symbol,
          total: balance.total,
          free: balance.free,
          locked: new Big(balance.total).minus(balance.free).toFixed(),
          price,
          marketValue,
          priceAt,
        });
      }
      saveAccountSnapshot(parsed.id, revision, snapshot);
      snapshotSucceeded = true;
    } catch (error) {
      assertRevision(parsed.id, revision);
      errors.push(`余额同步失败：${message(error)}`);
    }
    for (const symbol of symbols) {
      for (let start = availableFrom; start < to;) {
        const end = Math.min(start + day, to);
        try {
          assertRevision(parsed.id, revision);
          const trades = checkedTrades(
            await exchange.tradeHistory(symbol, start, end),
            symbol,
            start,
            end,
          );
          appendAccountTrades(parsed.id, revision, trades);
          state.completedRanges = completeRanges([
            ...state.completedRanges,
            { symbol, from: start, to: end },
          ]);
          windowsSucceeded++;
          saveAccountSync(parsed.id, state);
        } catch (error) {
          assertRevision(parsed.id, revision);
          historyComplete = false;
          errors.push(
            `${symbol} ${new Date(start).toISOString()}–${new Date(end).toISOString()}：${message(error)}`,
          );
          break;
        }
        start = end;
      }
    }
    // The cursor follows the complete recent window, independent of older provider retention.
    if (!explicit && historyComplete && availableFrom < to)
      state.lastIncrementalTo = Math.max(state.lastIncrementalTo ?? 0, to);
    const limited = availableFrom > from || skippedOldGap;
    state.status =
      !errors.length && !limited
        ? "success"
        : snapshotSucceeded || windowsSucceeded > 0
          ? "partial"
          : "failed";
    state.error = errors.length
      ? errors.join("；")
      : limited
        ? "部分历史超过本次查询范围或平台保留期"
        : null;
    state.finishedAt = Date.now();
    if (state.status === "success") state.lastSuccessAt = state.finishedAt;
    saveAccountSync(parsed.id, state);
    return state;
  } catch (error) {
    assertRevision(parsed.id, revision);
    state.status =
      snapshotSucceeded || windowsSucceeded > 0 ? "partial" : "failed";
    state.finishedAt = Date.now();
    state.error = message(error);
    saveAccountSync(parsed.id, state);
    return state;
  } finally {
    atomic(() => {
      if (get<SyncLease>(leaseKey(parsed.id))?.owner === owner)
        remove(leaseKey(parsed.id));
    });
  }
}
