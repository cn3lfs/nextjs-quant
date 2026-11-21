import { createHash, randomUUID } from "node:crypto";
import Big from "big.js";
import type { PortfolioFill, PortfolioExecution } from "quant-backtest";
import { PaperRepository } from "../db/paper-repository";
import { get, put, remove } from "../db";
import { readSecret } from "../vault";
import {
  withPaperCryptoMirror,
  getCryptoAccountReadContext,
  cryptoBotStatus,
} from "../crypto-trading/service";
import { credentialRevisionKey } from "../crypto-trading/account-model";
import {
  orderQuantity,
  terminal,
  type Order,
  type Snapshot,
  type Symbol,
} from "../crypto-trading/model";
import {
  MockTradingAdapter,
  type MockAccount,
  type MockTrade,
} from "../portfolio/mock/mock-trading";
import { mockEnabled } from "../portfolio/mock/mock-trading-service";
import { mirrorSettingsSchema, type PaperAccount } from "./model";
import { paperCompletedAt } from "./advance-clock";
import { chinaDate } from "../../lib/market/security-trading-status";

type MirrorRecord = {
  phase: "attempted" | "unknown" | "settled" | "skipped";
  at: number;
  local: PortfolioFill;
  order: Order;
  credentialRevision: string;
  baseline: Snapshot | null;
  remote: Order | null;
  /** Venue order identifiers; the only accepted attribution key. */
  remoteRef?: string[];
  remoteEvidence?: unknown;
  difference: {
    quantity: number;
    price: number | null;
    fees: Record<string, string>;
    feeDifference: number | null;
  } | null;
  reason: string | null;
};
export type MirrorVenue = {
  revision: string;
  snapshot(): Promise<Snapshot>;
  place(order: Order): Promise<unknown>;
  reconcile(
    order: Order,
    remoteRef?: string[],
    tradeDate?: string,
  ): Promise<Order | null>;
  prepare(order: Order): Promise<Order>;
  evidence?: (remoteRef?: string[]) => Promise<unknown>;
};
function receiptEntrustNos(receipt: unknown): string[] {
  if (!receipt || typeof receipt !== "object") return [];
  const value = (receipt as { entrustNos?: unknown }).entrustNos;
  return Array.isArray(value)
    ? value
        .filter(
          (nos): nos is string => typeof nos === "string" && nos.trim() !== "",
        )
        .map((nos) => nos.trim())
    : [];
}
/** Rows are already selected by entrust number; never re-match by symbol/size. */
export function mirrorOrderFromTrades(
  order: Order,
  rows: MockTrade[],
): Order | null {
  if (!rows.length) return null;
  // Several rows without trade numbers cannot be told apart from repeated
  // snapshots of the same execution: 2x50 shares must never become 100 filled.
  if (rows.length > 1 && rows.some((row) => row.tradeNo === null)) return null;
  const unique: { row: MockTrade; index: number }[] = [];
  const byTradeNo = new Map<string, MockTrade>();
  for (const [index, row] of rows.entries()) {
    if (row.tradeNo !== null) {
      const prior = byTradeNo.get(row.tradeNo);
      if (prior) {
        // The same trade number must describe the same execution; conflicting
        // rows are ambiguous, not extra fills and not a duplicate to drop.
        if (
          prior.entrustNo !== row.entrustNo ||
          prior.cjsl !== row.cjsl ||
          prior.cje !== row.cje ||
          prior.cjg !== row.cjg ||
          prior.fee !== row.fee
        )
          return null;
        continue;
      }
      byTradeNo.set(row.tradeNo, row);
    }
    unique.push({ row, index });
  }
  const fills: Order["fills"] = [];
  for (const { row, index } of unique) {
    const quantity =
      row.cjsl !== undefined
        ? new Big(row.cjsl)
        : row.cjg > 0
          ? new Big(row.cje).div(row.cjg)
          : null;
    if (
      quantity === null ||
      quantity.lte(0) ||
      !quantity.eq(quantity.round(0, 1)) ||
      !(row.cjg > 0) ||
      !Number.isFinite(row.fee)
    )
      return null;
    fills.push({
      id:
        row.tradeNo !== null
          ? `trade:${row.tradeNo}`
          : `${row.entrustNo ?? "row"}:${index}`,
      quantity: quantity.toFixed(),
      price: new Big(row.cjg).toFixed(),
      fee: new Big(row.fee).toFixed(),
      feeAsset: "CNY",
    });
  }
  const executed = fills.reduce(
    (sum, fill) => sum.plus(fill.quantity),
    new Big(0),
  );
  return {
    ...order,
    state: executed.eq(order.quantity) ? "FILLED" : "PARTIALLY_FILLED",
    executedQuantity: executed.toFixed(),
    fills,
  };
}
export type MirrorRunner = (
  account: PaperAccount,
  work: (venue: MirrorVenue) => Promise<void>,
) => Promise<void>;
const endpointKey = (a: PaperAccount) =>
  a.mirror.venue === "off" ? null : `${a.mirror.venue}-${a.mirror.network}`;

export async function configurePaperMirror(
  repo: PaperRepository,
  id: string,
  raw: unknown,
  now: number,
) {
  const mirror = mirrorSettingsSchema.parse(raw);
  const account = repo.account(id);
  if (!account) throw new Error("纸面账户不存在");
  if (
    (mirror.venue === "binance" && account.market !== "crypto") ||
    (mirror.venue === "ths" && account.market !== "cn-equity")
  )
    throw new Error("模拟镜像市场不匹配");
  const unresolved = repo
    .mirrorRecords<MirrorRecord>(id)
    .some((r) => r.phase === "attempted" || r.phase === "unknown");
  const recovery =
    account.mirror.venue === "off" ? account.mirrorRecovery : account.mirror;
  if (
    unresolved &&
    mirror.venue !== "off" &&
    JSON.stringify(mirror) !== JSON.stringify(recovery)
  )
    throw new Error("模拟镜像仍有未知结果；只能恢复原场所核对");
  if (mirror.venue === "binance") {
    const status = await cryptoBotStatus(`binance-${mirror.network}`);
    if (
      !status.bot ||
      status.bot.status !== "stopped" ||
      Object.values(status.bot.positions).some((q) => new Big(q).gt(0))
    )
      throw new Error("请先停止原模拟策略并核对策略持仓");
    await getCryptoAccountReadContext(`binance-${mirror.network}`);
  }
  if (
    mirror.venue === "ths" &&
    (!mockEnabled() || !(await readSecret<MockAccount>("mock-trading-account")))
  )
    throw new Error("请先配置同花顺模拟账户");
  return repo.atomic(() => {
    const current = repo.account(id)!;
    if (current.revision !== account.revision)
      throw new Error("账户已更新，请重试");
    const oldKey =
      endpointKey(current) ??
      (current.mirrorRecovery
        ? `${current.mirrorRecovery.venue}-${current.mirrorRecovery.network}`
        : null);
    const next: PaperAccount = {
      ...current,
      mirror,
      mirrorRevision: unresolved ? current.mirrorRevision : randomUUID(),
      mirrorSince: unresolved ? current.mirrorSince : now,
      mirrorRecovery:
        unresolved && mirror.venue === "off" ? recovery : undefined,
    };
    const key = endpointKey(next);
    if (key) {
      if (
        repo.mirrorOwner(
          mirror.venue,
          "network" in mirror ? mirror.network : "",
          id,
        )
      )
        throw new Error("模拟场所已被其他纸面账户使用");
      const owner = get<string>(`paper-mirror-reservation-${key}`);
      if (owner && owner !== id) throw new Error("模拟账户已被占用");
      put("paper-mirror-reservation", `paper-mirror-reservation-${key}`, id);
    }
    if (oldKey && oldKey !== key && !unresolved)
      remove(`paper-mirror-reservation-${oldKey}`);
    return repo.save(next, current.revision);
  });
}
const runVenue: MirrorRunner = async (account, work) => {
  const mirror = mirrorSettingsSchema.parse(account.mirror);
  if (mirror.venue === "off") return;
  if (mirror.venue === "binance")
    return withPaperCryptoMirror(
      `binance-${mirror.network}`,
      account.id,
      async (exchange, revision) => {
        await work({
          revision,
          snapshot: () => exchange.snapshot(),
          place: (o) => exchange.place(o),
          reconcile: (o) => exchange.reconcile(o),
          prepare: async (o) => ({
            ...o,
            quantity: orderQuantity(
              o.quantity,
              await exchange.price(o.symbol),
              await exchange.rules(o.symbol),
            ),
          }),
        });
      },
    );
  if (!mockEnabled()) throw new Error("同花顺模拟盘已关闭");
  // Bind the whole run to one credential snapshot: the revision and the
  // adapter reads must describe the same account, and a replacement is
  // detected as a different revision instead of silently querying new keys.
  const credential = await readSecret<MockAccount>("mock-trading-account");
  if (!credential) throw new Error("请先配置同花顺模拟账户");
  const revision = `ths:${createHash("sha256")
    .update(
      JSON.stringify([
        credential.username,
        credential.account ?? null,
        credential.shareholders ?? null,
      ]),
    )
    .digest("hex")
    .slice(0, 16)}`;
  const adapter = new MockTradingAdapter({
    enabled: mockEnabled,
    read: async () => credential,
    save: () => {
      throw new Error("纸面镜像不开户");
    },
  });
  const state = new PaperRepository().state(account.id)!;
  // Only same-day trade queries exist; a historical order cannot be looked up
  // later, so a cross-day reconciliation must stay unknown.
  let crossDay: string | null = null;
  await work({
    revision,
    snapshot: async () => ({ balances: [], openOrders: [] }),
    prepare: async (o) => o,
    place: async (o) => {
      const fill = state.result.fills.find(
        (f) =>
          `p${createHash("sha256").update(`${account.id}:${f.orderId}:${f.date}`).digest("hex").slice(0, 28)}` ===
          o.clientId,
      );
      const instrument = state.request.instruments.find(
        (i) => i.symbol === o.symbol,
      );
      const quote =
        instrument && typeof instrument.execution !== "function"
          ? "evidence" in instrument.execution
            ? (instrument.execution as PortfolioExecution)
            : instrument.execution[fill?.date ?? ""]
          : null;
      if (!fill || quote?.limitDown == null || quote.limitUp == null)
        throw new Error("镜像缺少原始涨跌停依据");
      return adapter.order(
        {
          id: randomUUID(),
          symbol: o.symbol,
          date: fill.date.slice(0, 10),
          side: fill.side,
          quantity: fill.quantity,
          price: fill.price,
          lowerLimit: quote.limitDown,
          upperLimit: quote.limitUp,
          limitSource: quote.evidence,
          signalId: null,
          stop: null,
          note: "R2c纸面账户模拟镜像",
        },
        true,
      );
    },
    reconcile: async (o, remoteRef, tradeDate) => {
      crossDay = null;
      // The venue only exposes today's trades. Never infer a historical fill
      // from the current day's rows, and recheck the clock after the request:
      // a response crossing Beijing midnight must not settle yesterday's order.
      const before = chinaDate(Date.now());
      if (tradeDate && tradeDate !== before) {
        crossDay = tradeDate;
        return null;
      }
      if (!remoteRef?.length) return null;
      const status = await adapter.orderStatus(remoteRef);
      const after = chinaDate(Date.now());
      if (after !== before || (tradeDate && after !== tradeDate)) {
        crossDay = tradeDate ?? before;
        return null;
      }
      return status.attributable ? mirrorOrderFromTrades(o, status.rows) : null;
    },
    evidence: async (remoteRef = []) => {
      if (crossDay)
        return {
          crossDay,
          remoteRef,
          unverified: true,
          reason: "跨日无历史委托查询能力，保持未知；无本地委托号即人工核对",
        };
      const rows = await adapter.todayTrades();
      const wanted = new Set(remoteRef);
      const matched = rows.filter(
        (row) => row.entrustNo !== null && wanted.has(row.entrustNo),
      );
      return {
        total: rows.length,
        attributable: remoteRef.length > 0 && matched.length > 0,
        matchedRefs: [...new Set(matched.map((row) => row.entrustNo!))],
        unmatchedRefs: remoteRef.filter(
          (ref) => !matched.some((row) => row.entrustNo === ref),
        ),
        remoteRef,
        rows: rows.slice(0, 20).map((row) => ({
          ...row,
          matched: row.entrustNo !== null && wanted.has(row.entrustNo),
        })),
        unverified: true,
        reason:
          "仅委托号可归属；显示当日候选、目标委托号命中情况与 attributable，不按symbol/数量猜测；无本地委托号即人工核对",
      };
    },
  });
};

/** Exactly one write attempt. Unknowns remain unknown until client-ID reconciliation;
 * disabling/re-enabling never replays old local fills or changes local accounting. */
export async function synchronizePaperMirror(
  repo: PaperRepository,
  id: string,
  now: number,
  runner: MirrorRunner = runVenue,
) {
  const account = repo.account(id)!;
  mirrorSettingsSchema.parse(account.mirror);
  if (account.mirror.venue === "off") return;
  const state = repo.state(id);
  if (!state) return;
  await runner(account, async (venue) => {
    for (const [index, fill] of state.result.fills.entries()) {
      const key = `${account.mirrorRevision}:${index}`;
      let record = repo.factValue<MirrorRecord>(id, "mirror", key);
      if (record?.phase === "settled" || record?.phase === "skipped") continue;
      const save = (value: MirrorRecord) => {
        repo.fact(id, "mirror", { id: key, date: fill.date, value });
        record = value;
      };
      const current = repo.account(id)!;
      if (
        current.mirrorRevision !== account.mirrorRevision ||
        current.mirror.venue === "off"
      )
        return;
      if (record) {
        if (record.credentialRevision !== venue.revision)
          throw new Error("镜像凭证已变化，保留未知意图等待人工核对");
        const remote = await venue.reconcile(
          record.order,
          record.remoteRef,
          record.local.date.slice(0, 10),
        );
        if (!remote) {
          save({
            ...record,
            phase: "unknown",
            remoteEvidence: await venue.evidence?.(record.remoteRef),
            reason: "场所未能按唯一编号证实成交；不重发",
          });
          return;
        }
        const quantity = remote.fills.reduce(
          (sum, f) => sum + Number(f.quantity),
          0,
        );
        const amount = remote.fills.reduce(
          (sum, f) => sum + Number(f.quantity) * Number(f.price),
          0,
        );
        const fees: Record<string, string> = {};
        for (const f of remote.fills)
          fees[f.feeAsset] = new Big(fees[f.feeAsset] ?? 0)
            .plus(f.fee)
            .toFixed();
        const phase =
          remote.executedQuantity !== undefined &&
          new Big(remote.executedQuantity).eq(quantity) &&
          terminal(remote.state)
            ? "settled"
            : "unknown";
        const feeDifference = Object.keys(fees).every(
          (asset) => asset === account.currency,
        )
          ? Object.values(fees).reduce((sum, fee) => sum + Number(fee), 0) -
            fill.fee
          : null;
        save({
          ...record,
          phase,
          remote,
          difference: {
            quantity: quantity - fill.quantity,
            price: quantity ? amount / quantity - fill.price : null,
            fees,
            feeDifference,
          },
          reason: null,
        });
        if (phase !== "settled") return;
        continue;
      }
      const localAt = paperCompletedAt(account, fill.date);
      const advance = repo.factValue<{ at: number; catchUp: boolean }>(
        id,
        "advance",
        account.lastBar ?? "",
      );
      const order: Order = {
        clientId: `p${createHash("sha256").update(`${id}:${fill.orderId}:${fill.date}`).digest("hex").slice(0, 28)}`,
        symbol: fill.symbol as Symbol,
        side: fill.side === "buy" ? "BUY" : "SELL",
        quantity: String(fill.quantity),
        state: "NEW",
        fills: [],
      };
      record = {
        phase: "skipped",
        at: now,
        local: fill,
        order,
        credentialRevision: venue.revision,
        baseline: null,
        remote: null,
        difference: null,
        reason: "镜像开启前或补推历史成交，不向模拟场所补单",
      };
      if (
        (advance?.at === now && advance.catchUp) ||
        localAt < (account.mirrorSince ?? now) ||
        now - localAt > (account.market === "crypto" ? 5 : 60) * 60000
      ) {
        save(record);
        continue;
      }
      const snapshot = await venue.snapshot();
      if (snapshot.openOrders.length)
        throw new Error("镜像场所有未完成订单，先核对");
      const records = repo.mirrorRecords<MirrorRecord>(id);
      const settled = records
        .filter(
          (r) =>
            r.phase === "settled" &&
            r.credentialRevision === venue.revision &&
            r.baseline &&
            r.remote,
        )
        .at(-1);
      if (
        settled?.baseline &&
        settled.remote &&
        account.mirror.venue === "binance"
      ) {
        const expected = new Map(
          settled.baseline.balances.map((b) => [b.asset, new Big(b.total)]),
        );
        const base = settled.remote.symbol.replace(/USDT$/, ""),
          direction = settled.remote.side === "BUY" ? 1 : -1;
        const add = (asset: string, delta: Big) =>
          expected.set(asset, (expected.get(asset) ?? new Big(0)).plus(delta));
        for (const f of settled.remote.fills) {
          add(base, new Big(f.quantity).times(direction));
          add("USDT", new Big(f.quantity).times(f.price).times(-direction));
          add(f.feeAsset, new Big(f.fee).neg());
        }
        for (const asset of new Set([
          ...expected.keys(),
          ...snapshot.balances.map((b) => b.asset),
        ]))
          if (
            (expected.get(asset) ?? new Big(0))
              .minus(
                snapshot.balances.find((b) => b.asset === asset)?.total ?? 0,
              )
              .abs()
              .gt("0.00000001")
          )
            throw new Error("模拟账户余额出现外部变化；停止镜像等待对账");
      }
      if (fill.side === "sell" && account.mirror.venue === "binance") {
        const owned = records
          .filter(
            (r) => r.phase === "settled" && r.remote?.symbol === fill.symbol,
          )
          .reduce(
            (total, r) =>
              total.plus(
                r.remote!.fills.reduce(
                  (n, f) =>
                    n
                      .plus(
                        new Big(f.quantity).times(
                          r.remote!.side === "BUY" ? 1 : -1,
                        ),
                      )
                      .minus(
                        f.feeAsset === fill.symbol.replace(/USDT$/, "")
                          ? f.fee
                          : 0,
                      ),
                  new Big(0),
                ),
              ),
            new Big(0),
          );
        if (owned.lt(fill.quantity)) {
          save({
            ...record,
            reason: "本地卖出数量超过已镜像持仓；不动场所原有资产",
          });
          continue;
        }
      }
      const prepared = await venue.prepare(order);
      repo.atomic(() => {
        const latest = repo.account(id)!;
        if (latest.mirrorRevision !== account.mirrorRevision)
          throw new Error("镜像配置已变化");
        if (repo.factValue(id, "mirror", key))
          throw new Error("镜像意图已被领取");
        save({
          ...record!,
          phase: "attempted",
          order: prepared,
          baseline: snapshot,
          reason: "已领取一次发送；未证实前仅对账",
        });
      });
      // Credential and preference revisions are rechecked immediately before I/O.
      if (
        account.mirror.venue === "binance" &&
        get<string>(
          credentialRevisionKey(`binance-${account.mirror.network}`),
        ) !== venue.revision &&
        runner === runVenue
      )
        throw new Error("模拟凭证版本已变化");
      try {
        const receipt = await venue.place(prepared);
        const remoteRef = receiptEntrustNos(receipt);
        save({
          ...record!,
          phase: "unknown",
          remoteRef: remoteRef.length ? remoteRef : record!.remoteRef,
          reason: remoteRef.length
            ? "模拟委托已发送；按委托号等待成交对账"
            : "模拟委托已发送但响应无委托号；无法按委托号归属，等待人工核对",
        });
      } catch {
        save({
          ...record!,
          phase: "unknown",
          reason: "模拟委托结果未知；仅按唯一编号对账，不重发",
        });
      }
      return;
    }
  });
}
