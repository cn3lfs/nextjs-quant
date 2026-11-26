import { createHash, createHmac, randomUUID } from "node:crypto";
import Big from "big.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  extractVenueAccountKey,
  isLiveVenueKind,
  venueBindingSchema,
  type ExecutionVenueKind,
  type VenueBinding,
} from "trading-strategies";
import { cnTradingCalendar } from "../pipeline/cn-trading-calendar";
import { externalAccountDrawdown } from "../pipeline/external-account-risk";
import { chinaDate } from "~/lib/market/security-trading-status";
import { sqlite } from "../db";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import { getPipelineGlobalConfig } from "../db/deployment-repository";
import { getIntent, type OrderIntentRecord } from "../db/pipeline-repository";
import { normalizePoolSymbol } from "../db/pool-repository";
import { SimAccountRepository } from "../db/sim-account-repository";
import {
  readLocalSimAccountState,
  type PipelineAccountState,
} from "../pipeline/signal-risk-runner";
import { executePipelineSimOrder } from "../portfolio/sim-accounts/service";
import {
  confirmMockOrder,
  mockEnabled,
  previewMockOrder,
  queryMockFunds,
  queryMockOrderStatus,
} from "../portfolio/mock/mock-trading-service";
import {
  MockTradingAdapter,
  MockSubmissionBlocked,
  type MockAccount,
} from "../portfolio/mock/mock-trading";
import { workflowQuotes } from "../jobs/workflow-quotes";
import { createSpotAdapter } from "../crypto-trading/adapter";
import { getCryptoAccountReadContext } from "../crypto-trading/service";
import {
  symbols,
  type Credential,
  type Order,
  type Balance,
} from "../crypto-trading/model";
import { readSecret } from "../vault";

type Db = Database.Database;
type Binding<K extends ExecutionVenueKind> = Extract<VenueBinding, { kind: K }>;
type LiveBinding = Binding<"cn_broker_live" | "crypto_live">;
type Intent = OrderIntentRecord;
const statusSchema = z.enum([
  "submitted",
  "filled",
  "partial_filled",
  "rejected",
  "cancelled",
  "unknown_reconcile",
]);
const resultSchema = z.object({
  status: statusSchema,
  venueOrderId: z.string().min(1).nullable(),
  filledQuantity: z.number().finite().nonnegative().nullable(),
  averageFillPrice: z.number().positive().finite().nullable(),
  fee: z.number().finite().nonnegative().optional(),
  grossWithoutFee: z.number().finite().nonnegative().optional(),
  netProceeds: z.number().finite().optional(),
  fillId: z.string().min(1).optional(),
  fillIds: z.array(z.string().min(1)).optional(),
  errorSummary: z.string().nullable().optional(),
});
export type VenueOrderResult = z.infer<typeof resultSchema>;
export type VenueCancelResult = VenueOrderResult;
type Submission = {
  executeDate: string;
  executePrice: number;
  db: Db;
  submissionBlock?: () => string | null;
  quote?: { upperLimit: number | null; lowerLimit: number | null };
};
export interface ExecutionVenueAdapter {
  kind: ExecutionVenueKind;
  isLive: boolean;
  /** Additional buy increment required by this venue’s A-share order contract. */
  cnBuyStep?: number;
  readAccountState(
    binding: VenueBinding,
    asOfDate: string,
    db?: Db,
    asOfCreatedAt?: number,
  ): Promise<PipelineAccountState>;
  submitOrder(intent: Intent, context: Submission): Promise<VenueOrderResult>;
  reconcileOrder(
    intent: Intent,
    context: { db: Db },
  ): Promise<VenueOrderResult>;
  cancelOrder(intent: Intent, context: { db: Db }): Promise<VenueCancelResult>;
}
export interface VenueRouterDeps {
  thsAdapter?: ExecutionVenueAdapter;
  cryptoSimAdapter?: ExecutionVenueAdapter;
  cryptoLiveAdapter?: ExecutionVenueAdapter;
  fetchImpl?: typeof fetch;
  readCredential?: (logicalKey: string) => Promise<unknown>;
  now?: () => number;
}
const registry = new Map<string, ExecutionVenueAdapter>();
export function registerLiveVenueAdapter(
  accountKey: string,
  adapter: ExecutionVenueAdapter,
): void {
  if (
    !adapter.isLive ||
    !isLiveVenueKind(adapter.kind) ||
    !accountKey.startsWith(adapter.kind + ":")
  )
    throw new Error("实盘适配器与账户通道不匹配");
  registry.set(accountKey, adapter);
}
export function unregisterLiveVenueAdapter(accountKey: string): void {
  registry.delete(accountKey);
}
function logicalKey(binding: LiveBinding) {
  return binding.kind === "cn_broker_live"
    ? `pipeline-live-venue:${binding.broker}:${binding.accountId}`
    : `pipeline-crypto-live:${binding.venue}:${binding.accountId}`;
}
/** saveSecret/readSecret use filename-safe IDs. Keep the entire logical identity in the digest. */
export function pipelineLiveVaultId(binding: LiveBinding): string {
  return (
    "pipeline-live-" +
    createHash("sha256").update(logicalKey(binding)).digest("hex")
  );
}
function credential(binding: LiveBinding, deps: VenueRouterDeps) {
  return deps.readCredential
    ? deps.readCredential(logicalKey(binding))
    : readSecret<unknown>(pipelineLiveVaultId(binding));
}
export function submissionDateExpired(
  intent: Intent,
  now: () => number = Date.now,
) {
  const { venueKind, executeDate } = intent;
  if (venueKind === "crypto_live")
    return executeDate !== new Date(now()).toISOString().slice(0, 10);
  if (venueKind === "crypto_sim")
    return executeDate < new Date(now()).toISOString().slice(0, 10);
  return (
    (venueKind === "ths_mock" || isLiveVenueKind(venueKind)) &&
    executeDate !== chinaDate(now())
  );
}
function result(
  status: VenueOrderResult["status"],
  venueOrderId: string | null = null,
  errorSummary?: string,
): VenueOrderResult {
  return {
    status,
    venueOrderId,
    filledQuantity: null,
    averageFillPrice: null,
    ...(errorSummary ? { errorSummary } : {}),
  };
}
function credentialStrings(auth: unknown): string[] {
  const values =
    typeof auth === "object" && auth !== null
      ? ["token", "apiKey", "apiSecret", "passphrase"].map(
          (field) => (auth as Record<string, unknown>)[field],
        )
      : [auth];
  return values.flatMap((value) =>
    typeof value === "string" && value.trim() ? [value, value.trim()] : [],
  );
}
function safeLiveOrderId(id: string | null, secrets: string[]) {
  return id &&
    id.length <= 128 &&
    !/[^a-zA-Z0-9._:-]/.test(id) &&
    !secrets.some((secret) => id.includes(secret))
    ? id
    : null;
}
function unknown(id: string | null = null) {
  return result("unknown_reconcile", id, "委托结果待通道对账");
}
function fromReceipt(
  receipt: ReturnType<typeof executePipelineSimOrder>,
): VenueOrderResult {
  return {
    status: "filled",
    venueOrderId: receipt.orderId,
    fillId: receipt.fillId,
    ...(receipt.side === "sell" && {
      netProceeds: Number(receipt.netCashDelta),
    }),
    filledQuantity: Number(receipt.quantity),
    averageFillPrice: Number(receipt.price),
  };
}
function localAdapter(binding: Binding<"local_sim">): ExecutionVenueAdapter {
  const accountId = binding.simAccountId;
  const lookup: ExecutionVenueAdapter["reconcileOrder"] = async (
    intent,
    { db },
  ) => {
    const repo = new SimAccountRepository(db);
    return repo.read(() => {
      const row = repo.orderByRequest(
        accountId,
        "pipeline:" + intent.idempotencyKey,
      );
      if (!row) return unknown();
      const receipt = repo.receipt(repo.account(accountId), row.id);
      if (
        receipt.executionMode !== "plan-auto" ||
        receipt.planId !== null ||
        receipt.symbol.toUpperCase() !== intent.symbol.toUpperCase() ||
        receipt.side.toUpperCase() !== intent.side ||
        receipt.tradeDate !== intent.executeDate ||
        Number(receipt.quantity) !== intent.quantity
      )
        return unknown();
      return fromReceipt(receipt);
    });
  };
  return {
    kind: binding.kind,
    isLive: false,
    cnBuyStep: 100,
    readAccountState: (_, date, db = sqlite(), cutoff) =>
      readLocalSimAccountState(accountId, date, db, undefined, date, cutoff),
    async submitOrder(intent, { executePrice, executeDate, db }) {
      try {
        return fromReceipt(
          executePipelineSimOrder(
            {
              accountId,
              clientRequestId: "pipeline:" + intent.idempotencyKey,
              symbol: intent.symbol,
              side: intent.side === "BUY" ? "buy" : "sell",
              quantity: intent.quantity,
              price: executePrice,
              tradeDate: executeDate,
            },
            db,
          ),
        );
      } catch (error) {
        // An ordinary ledger validation error rolls back the entire local transaction.
        if (error instanceof Error && !("code" in error))
          return result("rejected", null, error.message);
        throw error;
      }
    },
    reconcileOrder: lookup,
    cancelOrder: lookup,
  };
}

function thsAdapter(now = Date.now): ExecutionVenueAdapter {
  return {
    kind: "ths_mock",
    isLive: false,
    cnBuyStep: 100,
    async readAccountState(_, date) {
      if (!mockEnabled() || date !== chinaDate(now()))
        throw new Error("同花顺模拟盘仅可查询已开启账户的当日状态");
      const reader = new MockTradingAdapter({
        enabled: mockEnabled,
        read: () => readSecret<MockAccount>("mock-trading-account"),
        save: async () => {
          throw new Error("只读账户查询");
        },
      });
      const [funds, holdings] = await Promise.all([
        queryMockFunds().catch(() => []),
        reader.positions().catch(() => null),
      ]);
      if (!holdings) return externalSnapshot(null);
      const quotes = holdings.length
        ? await workflowQuotes(
            holdings.map((p) => p.symbol),
            date,
          ).catch(() => new Map<string, { price: number }>())
        : new Map<string, { price: number }>();
      const fund = funds.length === 1 ? funds[0] : undefined;
      let equity = fund ? new Big(fund.zjye) : null;
      const positions = holdings.map(({ symbol, quantity, sellable }) => {
        const mark = quotes.get(symbol)?.price;
        const lastPrice =
          mark && Number.isFinite(mark) && mark > 0 ? mark : null;
        if (quantity > 0)
          equity =
            equity && lastPrice
              ? equity.plus(new Big(quantity).times(lastPrice))
              : null;
        return { symbol, quantity, sellable, lastPrice };
      });
      return {
        cash: fund?.kyje ?? NaN,
        equity: equity?.toNumber() ?? NaN,
        drawdownPct: null,
        positions,
      };
    },
    async submitOrder(
      intent,
      { executeDate, executePrice, quote, db, submissionBlock },
    ) {
      if (!mockEnabled()) return result("rejected", null, "同花顺模拟盘未开启");
      if (
        new AccountWorkspaceRepository(db).record(
          "paper-mirror-reservation-ths-simulation",
        )
      )
        return result("rejected", null, "同花顺模拟盘已被纸面镜像独占");
      if (quote?.lowerLimit == null || quote.upperLimit == null)
        return result("rejected", null, "模拟委托缺少当日涨跌停依据");
      const calendar = cnTradingCalendar(db);
      const confirmed = async (date: string) =>
        (await calendar.session(date)) === true;
      let id: string;
      try {
        ({ id } = await previewMockOrder(
          {
            id: randomUUID(),
            date: executeDate,
            price: executePrice,
            symbol: intent.symbol,
            side: intent.side === "BUY" ? "buy" : "sell",
            quantity: intent.quantity,
            lowerLimit: quote.lowerLimit,
            upperLimit: quote.upperLimit,
            limitSource: "流水线执行日行情",
          },
          confirmed,
        ));
      } catch {
        return result(
          "rejected",
          null,
          submissionBlock?.() ?? "模拟委托预检失败",
        );
      }
      try {
        const blocked = submissionBlock?.();
        if (blocked) return result("rejected", null, blocked);
        const receipt = await confirmMockOrder(id, submissionBlock, confirmed);
        return receipt.entrustNos.length
          ? result("submitted", id)
          : unknown(id);
      } catch (error) {
        if (error instanceof MockSubmissionBlocked)
          return result("rejected", null, error.message);
        return unknown(id);
      }
    },
    async reconcileOrder(intent) {
      const id = intent.venueOrderId;
      if (!id) return unknown();
      const remote = await queryMockOrderStatus(id, true);
      if (remote.fillStatus === "unfilled" && remote.state === "accepted")
        return result("submitted", id);
      if (!remote.attributable || !remote.rows.length) return unknown(id);
      const seen = new Map<string, string>();
      let fees = new Big(0),
        grossWithoutFee = new Big(0);
      let qty = new Big(0),
        gross = new Big(0);
      for (const row of remote.rows) {
        if (
          row.zqdm !== intent.symbol.slice(2) ||
          !(intent.side === "BUY" ? ["B", "买入"] : ["S", "卖出"]).includes(
            row.mmlb,
          ) ||
          row.cjg <= 0 ||
          (!row.tradeNo && remote.rows.length > 1)
        )
          return unknown(id);
        const key = row.tradeNo ?? "",
          evidence = JSON.stringify(row);
        if (seen.has(key)) {
          if (seen.get(key) !== evidence) return unknown(id);
          continue;
        }
        seen.set(key, evidence);
        const filled =
          row.cjsl === undefined
            ? new Big(row.cje).div(row.cjg)
            : new Big(row.cjsl);
        if (!filled.gt(0) || !filled.eq(filled.round(0))) return unknown(id);
        qty = qty.plus(filled);
        const turnover = filled.times(row.cjg);
        gross = gross.plus(turnover);
        if (row.fee === undefined)
          grossWithoutFee = grossWithoutFee.plus(turnover);
        else fees = fees.plus(row.fee);
      }
      if (qty.gt(intent.quantity)) return unknown(id);
      return {
        status: qty.eq(intent.quantity) ? "filled" : "partial_filled",
        venueOrderId: id,
        filledQuantity: qty.toNumber(),
        averageFillPrice: gross.div(qty).toNumber(),
        ...(grossWithoutFee.lt(gross) && { fee: fees.toNumber() }),
        ...(grossWithoutFee.gt(0) && {
          grossWithoutFee: grossWithoutFee.toNumber(),
        }),
        ...(intent.side === "SELL" &&
          grossWithoutFee.eq(0) && {
            netProceeds: gross.minus(fees).toNumber(),
          }),
        fillIds: [...seen.keys()].filter(Boolean),
      };
    },
    async cancelOrder(intent) {
      return {
        ...unknown(intent.venueOrderId),
        errorSummary: "同花顺模拟通道未提供撤单接口，请核对原委托",
      };
    },
  };
}

const accountSchema = z.object({
  cash: z.number().finite().nonnegative(),
  equity: z.number().finite().nonnegative(),
  drawdownPct: z
    .number()
    .finite()
    .nonnegative()
    .nullish()
    .transform((n) => n ?? null),
  riskRegime: z.enum(["normal", "reduced", "halted"]).optional(),
  positions: z.array(
    z.object({
      symbol: z.string().min(1),
      quantity: z.number().finite().nonnegative(),
      sellable: z.number().finite().nonnegative(),
      lastPrice: z.number().finite().positive().nullable(),
    }),
  ),
});
function externalSnapshot(raw: unknown): PipelineAccountState {
  const parsed = accountSchema.safeParse(raw);
  // Keep independently verified quantities available to the exit planner.
  const rows = parsed.success
    ? parsed
    : accountSchema.pick({ positions: true }).safeParse(raw);
  const positions = rows.data?.positions ?? [];
  const symbols = new Set(positions.map((p) => normalizePoolSymbol(p.symbol)));
  const valid =
    symbols.size === positions.length &&
    positions.every((p) => p.sellable <= p.quantity);
  return parsed.success && valid
    ? parsed.data
    : {
        cash: NaN,
        equity: NaN,
        drawdownPct: null,
        positions: valid ? positions : [],
      };
}
export class VenueAccountConfigError extends Error {}
const bridgeMissing =
  "live_venue_not_configured：请先配置实盘桥接地址与鉴权凭证";
const bridgeOriginMismatch =
  "live_venue_origin_mismatch：实盘桥接地址与凭证绑定不匹配";
const cryptoMissing = "live_venue_not_configured：请先保存实盘交易所凭证";
const brokerCredential = z.union([
  z.string().transform((token) => ({
    token,
    endpointUrl: undefined,
    allowedOrigin: undefined,
  })),
  z.object({
    token: z.string(),
    endpointUrl: z.string().url().optional(),
    allowedOrigin: z.string().url().optional(),
  }),
]);

function brokerAdapter(
  binding: Binding<"cn_broker_live">,
  fetchImpl: typeof fetch,
  key: unknown,
): ExecutionVenueAdapter {
  const endpoint =
    binding.endpointUrl && venueBindingSchema.safeParse(binding).success
      ? new URL(binding.endpointUrl).href.replace(/\/+$/, "")
      : null;
  const auth = brokerCredential.safeParse(key);
  const token = auth.success ? auth.data.token.trim() : "";
  let configurationError: string | null = null;
  if (!endpoint || !auth.success || !token) {
    configurationError = bridgeMissing;
  } else {
    const origin = new URL(endpoint).origin;
    const { endpointUrl, allowedOrigin } = auth.data;
    if (
      (endpointUrl !== undefined && new URL(endpointUrl).origin !== origin) ||
      (allowedOrigin !== undefined && new URL(allowedOrigin).origin !== origin)
    )
      configurationError = bridgeOriginMismatch;
  }
  const request = async (
    path: string,
    method: string,
    intent?: Intent,
    payload?: object,
    asOfDate?: string,
  ) => {
    if (!endpoint || configurationError)
      throw new VenueAccountConfigError(configurationError ?? bridgeMissing);
    return fetchImpl(endpoint + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        "Content-Type": "application/json",
        "X-Account-Id": binding.accountId,
        ...(asOfDate ? { "X-As-Of-Date": asOfDate } : {}),
        Authorization: "Bearer " + token,
        ...(intent ? { "Idempotency-Key": intent.idempotencyKey } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
  };
  const order = async (
    method: "POST" | "GET" | "DELETE",
    intent: Intent,
    payload?: object,
  ) => {
    if (configurationError)
      return method === "POST"
        ? result("rejected", null, configurationError)
        : { ...unknown(intent.venueOrderId), errorSummary: configurationError };
    try {
      const path =
        method === "POST"
          ? "/orders"
          : "/orders/" +
            encodeURIComponent(intent.venueOrderId ?? intent.idempotencyKey);
      const response = await request(path, method, intent, payload);
      if (!response.ok) {
        if (method === "POST" && [400, 401, 403, 422].includes(response.status))
          return result(
            "rejected",
            null,
            "实盘桥接拒绝委托 HTTP " + response.status,
          );
        return unknown(intent.venueOrderId);
      }
      const remote = resultSchema.parse(await response.json());
      if (
        intent.venueOrderId &&
        remote.venueOrderId &&
        intent.venueOrderId !== remote.venueOrderId
      )
        return unknown(intent.venueOrderId);
      // Never persist arbitrary text returned by an authenticated endpoint.
      return {
        ...remote,
        errorSummary: remote.status === "rejected" ? "实盘桥接拒绝委托" : null,
      };
    } catch {
      return unknown(intent.venueOrderId);
    }
  };
  return {
    kind: binding.kind,
    isLive: true,
    async readAccountState(_, asOfDate) {
      const response = await request(
        "/account",
        "GET",
        undefined,
        undefined,
        asOfDate,
      );
      if (!response.ok) throw new Error("实盘桥接账户查询失败");
      return externalSnapshot(await response.json());
    },
    submitOrder: (intent, ctx) =>
      order("POST", intent, {
        accountId: binding.accountId,
        symbol: intent.symbol,
        side: intent.side,
        quantity: intent.quantity,
        price: ctx.executePrice,
        executeDate: ctx.executeDate,
        idempotencyKey: intent.idempotencyKey,
      }),
    reconcileOrder: (intent) => order("GET", intent),
    cancelOrder: (intent) => order("DELETE", intent),
  };
}

const positiveDecimal = z.string().regex(/^\d+(?:\.\d+)?$/);
const orderId = z.union([
  z.string().min(1),
  z.number().int().safe().nonnegative().transform(String),
]);
const apiCredential = z.object({
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
  passphrase: z.string().min(1).optional(),
});
// The pipeline values spot accounts in USDT. Simulation has its own narrower market catalog.
const usdtPair = z.string().regex(/^[A-Z0-9]{1,20}USDT$/);
const spotSymbol = (intent: Intent) =>
  usdtPair.parse(intent.symbol.toUpperCase().replace(/^CX/, ""));
function clientOrderId(intent: Intent) {
  // All three exchanges accept at most 32 alphanumeric characters in common.
  return (
    "pl" +
    createHash("sha256")
      .update(intent.idempotencyKey)
      .digest("hex")
      .slice(0, 30)
  );
}
async function spotAccount(
  balances: Balance[],
  price: (symbol: string) => Promise<string>,
): Promise<PipelineAccountState> {
  const assets = new Set<string>();
  for (const balance of balances) {
    if (
      assets.has(balance.asset) ||
      !positiveDecimal.safeParse(balance.total).success ||
      !positiveDecimal.safeParse(balance.free).success ||
      new Big(balance.free).gt(balance.total)
    )
      return externalSnapshot(null);
    assets.add(balance.asset);
  }
  const usdt = balances.find((b) => b.asset === "USDT");
  let equity: Big | null = new Big(usdt?.total ?? 0);
  const positions = [];
  for (const balance of balances) {
    if (balance.asset === "USDT" || new Big(balance.total).eq(0)) continue;
    const symbol = usdtPair.parse(balance.asset + "USDT");
    const rawMark = await price(symbol).catch(() => null);
    const mark =
      rawMark && positiveDecimal.safeParse(rawMark).success
        ? new Big(rawMark)
        : null;
    equity =
      equity && mark?.gt(0) ? equity.plus(mark.times(balance.total)) : null;
    positions.push({
      symbol,
      quantity: Number(balance.total),
      sellable: Number(balance.free),
      lastPrice: mark?.gt(0) ? mark.toNumber() : null,
    });
  }
  return {
    cash: Number(usdt?.free ?? 0),
    equity: equity?.toNumber() ?? NaN,
    drawdownPct: null,
    positions,
  };
}
function spotResult(
  intent: Intent,
  id: string,
  state: string,
  filled: Big,
  average: Big | null,
): VenueOrderResult {
  const status = state.toUpperCase();
  if (
    filled.lt(0) ||
    filled.gt(intent.quantity) ||
    (intent.venueOrderId && id !== intent.venueOrderId)
  )
    return unknown(intent.venueOrderId);
  let mapped: VenueOrderResult["status"];
  if (status === "FILLED" && filled.eq(intent.quantity)) mapped = "filled";
  else if (
    [
      "CANCELED",
      "CANCELLED",
      "PARTIALLYFILLEDCANCELED",
      "EXPIRED",
      "EXPIRED_IN_MATCH",
      "DEACTIVATED",
    ].includes(status)
  )
    mapped = "cancelled";
  else if (status === "REJECTED") mapped = "rejected";
  else if (
    ["PARTIALLYFILLED", "PARTIALLY_FILLED"].includes(status) &&
    filled.gt(0) &&
    filled.lt(intent.quantity)
  )
    mapped = "partial_filled";
  else if (
    ["NEW", "LIVE", "CREATED", "SUBMITTED"].includes(status) &&
    filled.eq(0)
  )
    mapped = "submitted";
  else return unknown(id);
  return {
    status: mapped,
    venueOrderId: id,
    filledQuantity: filled.toNumber(),
    averageFillPrice: average?.gt(0) ? average.toNumber() : null,
  };
}
function simCryptoAdapter(
  binding: Binding<"crypto_sim">,
  now = Date.now,
): ExecutionVenueAdapter {
  async function exchange() {
    const context = await getCryptoAccountReadContext(binding.accountId);
    if (context.config.venue !== binding.venue)
      throw new Error("模拟交易所与账户绑定不匹配");
    return createSpotAdapter(context.config, context.credential);
  }
  function spotOrder(intent: Intent): Order {
    return {
      clientId: clientOrderId(intent),
      symbol: z.enum(symbols).parse(spotSymbol(intent)),
      side: intent.side,
      quantity: new Big(intent.quantity).toFixed(),
      exchangeId: intent.venueOrderId ?? undefined,
      state: "INTENT",
      fills: [],
    };
  }
  const reconcile: ExecutionVenueAdapter["reconcileOrder"] = async (intent) => {
    const remote = await (await exchange()).reconcile(spotOrder(intent));
    if (!remote?.exchangeId || remote.executedQuantity === undefined)
      return unknown(intent.venueOrderId);
    const filled = new Big(remote.executedQuantity);
    const totalQuantity = remote.fills.reduce(
      (sum, f) => sum.plus(f.quantity),
      new Big(0),
    );
    const value = remote.fills.reduce(
      (sum, f) => sum.plus(new Big(f.price).times(f.quantity)),
      new Big(0),
    );
    return {
      ...spotResult(
        intent,
        remote.exchangeId,
        remote.state,
        filled,
        filled.gt(0) && totalQuantity.eq(filled) ? value.div(filled) : null,
      ),
      fillIds: remote.fills.map((f) => f.id),
    };
  };
  return {
    kind: binding.kind,
    isLive: false,
    async readAccountState(_, date) {
      assertCurrentSpotDate(date, now);
      const adapter = await exchange();
      return spotAccount((await adapter.snapshot()).balances, (symbol) =>
        adapter.price(z.enum(symbols).parse(symbol)),
      );
    },
    async submitOrder(intent, { db, submissionBlock }) {
      if (
        new AccountWorkspaceRepository(db).record(
          "paper-mirror-reservation-" + binding.accountId,
        )
      )
        return result("rejected", null, "加密模拟账户由纸面镜像独占");
      const adapter = await exchange(),
        order = spotOrder(intent);
      try {
        const blocked = submissionBlock?.();
        if (blocked) return result("rejected", null, blocked);
        const placed = await adapter.place(order);
        return result("submitted", placed.exchangeId);
      } catch (error) {
        return error instanceof Error &&
          "outcomeUnknown" in error &&
          error.outcomeUnknown === false
          ? result("rejected", null, "交易所拒绝模拟委托")
          : unknown();
      }
    },
    reconcileOrder: reconcile,
    async cancelOrder(intent, ctx) {
      await (await exchange()).cancel(spotOrder(intent));
      return reconcile(intent, ctx);
    },
  };
}
function assertCurrentSpotDate(date: string, now: () => number) {
  if (date !== new Date(now()).toISOString().slice(0, 10))
    throw new Error("该交易所仅提供当前账户快照");
}
type Venue = Binding<"crypto_live">["venue"];
const mainnetHosts: Record<Venue, string> = {
  binance: "https://api.binance.com",
  okx: "https://openapi.okx.com",
  bybit: "https://api.bybit.com",
};
class SpotBalanceRejected extends Error {}
const insufficientBalance = {
  binance: z.object({
    code: z.literal(-2010),
    msg: z.literal("Account has insufficient balance for requested action."),
  }),
  okx: z.object({
    code: z.literal("1"),
    data: z
      .array(z.object({ sCode: z.literal("51008"), ordId: z.literal("") }))
      .length(1),
  }),
  bybit: z.object({ retCode: z.literal(170131) }),
};
function mainnetRequest(
  venue: Venue,
  auth: Credential,
  fetchImpl: typeof fetch,
) {
  const sign = (message: string, encoding: "hex" | "base64" = "hex") =>
    createHmac("sha256", auth.apiSecret).update(message).digest(encoding);
  return async (
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number> = {},
    signed = true,
  ): Promise<unknown> => {
    const query = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    );
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const time = String(Date.now());
    const body =
      venue !== "binance" && method !== "GET"
        ? JSON.stringify(params)
        : undefined;
    const queryPath = () =>
      path + (!body && query.size ? "?" + query.toString() : "");
    if (signed && venue === "binance") {
      query.set("timestamp", time);
      query.set("signature", sign(query.toString()));
      headers["X-MBX-APIKEY"] = auth.apiKey;
    } else if (signed && venue === "okx") {
      const timestamp = new Date(Number(time)).toISOString();
      Object.assign(headers, {
        "OK-ACCESS-KEY": auth.apiKey,
        "OK-ACCESS-PASSPHRASE": auth.passphrase!,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-SIGN": sign(
          timestamp + method + queryPath() + (body ?? ""),
          "base64",
        ),
      });
    } else if (signed) {
      Object.assign(headers, {
        "X-BAPI-API-KEY": auth.apiKey,
        "X-BAPI-TIMESTAMP": time,
        "X-BAPI-RECV-WINDOW": "5000",
        "X-BAPI-SIGN": sign(
          time + auth.apiKey + "5000" + (body ?? query.toString()),
        ),
      });
    }
    const response = await fetchImpl(mainnetHosts[venue] + queryPath(), {
      method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (response.status >= 500) throw new Error("交易所请求未确认");
    const raw: unknown = await response.json();
    if (method === "POST" && insufficientBalance[venue].safeParse(raw).success)
      throw new SpotBalanceRejected();
    if (!response.ok) throw new Error("交易所请求未确认");
    if (venue === "okx")
      return z
        .object({ code: z.literal("0"), data: z.array(z.unknown()) })
        .parse(raw).data;
    if (venue === "bybit")
      return z
        .object({ retCode: z.literal(0), result: z.record(z.unknown()) })
        .parse(raw).result;
    return raw;
  };
}
type SpotRequest = ReturnType<typeof mainnetRequest>;
async function liveBalances(
  venue: Venue,
  request: SpotRequest,
): Promise<Balance[]> {
  if (venue === "binance") {
    const { balances } = z
      .object({
        canTrade: z.literal(true),
        balances: z.array(
          z.object({
            asset: z.string(),
            free: positiveDecimal,
            locked: positiveDecimal,
          }),
        ),
      })
      .parse(await request("GET", "/api/v3/account"));
    return balances.map((b) => ({
      ...b,
      total: new Big(b.free).plus(b.locked).toFixed(),
    }));
  }
  if (venue === "okx") {
    const [account] = z
      .array(
        z.object({
          details: z.array(
            z.object({
              ccy: z.string(),
              cashBal: positiveDecimal,
              availBal: positiveDecimal,
            }),
          ),
        }),
      )
      .length(1)
      .parse(await request("GET", "/api/v5/account/balance"));
    return account!.details.map((b) => ({
      asset: b.ccy,
      free: b.availBal,
      total: b.cashBal,
    }));
  }
  const decZero = positiveDecimal.refine((value) => new Big(value).eq(0));
  const { list } = z
    .object({
      list: z
        .array(
          z.object({
            totalPositionIM: decZero,
            totalOrderIM: decZero,
            coin: z.array(
              z.object({
                coin: z.string(),
                walletBalance: positiveDecimal,
                locked: positiveDecimal,
                borrowAmount: decZero.optional(),
                spotBorrow: decZero.optional(),
              }),
            ),
          }),
        )
        .length(1),
    })
    .parse(
      await request("GET", "/v5/account/wallet-balance", {
        accountType: "UNIFIED",
      }),
    );
  return list[0]!.coin.map((b) => ({
    asset: b.coin,
    total: b.walletBalance,
    free: new Big(b.walletBalance).minus(b.locked).toFixed(),
  }));
}
async function livePrice(
  venue: Venue,
  request: SpotRequest,
  symbol: string,
): Promise<string> {
  if (venue === "binance")
    return z
      .object({ price: positiveDecimal })
      .parse(await request("GET", "/api/v3/ticker/price", { symbol }, false))
      .price;
  if (venue === "okx")
    return z
      .array(z.object({ last: positiveDecimal }))
      .length(1)
      .parse(
        await request(
          "GET",
          "/api/v5/market/ticker",
          { instId: symbol.replace("USDT", "-USDT") },
          false,
        ),
      )[0]!.last;
  return z
    .object({
      list: z.array(z.object({ lastPrice: positiveDecimal })).length(1),
    })
    .parse(
      await request(
        "GET",
        "/v5/market/tickers",
        { category: "spot", symbol },
        false,
      ),
    ).list[0]!.lastPrice;
}
async function liveSpotOrder(
  venue: Venue,
  request: SpotRequest,
  intent: Intent,
  price: number,
) {
  const symbol = spotSymbol(intent),
    id = clientOrderId(intent),
    qty = new Big(intent.quantity).toFixed(),
    px = new Big(price).toFixed();
  // Submit base quantity with a price limit on both sides. An acknowledgement is not a fill.
  if (venue === "binance")
    return z.object({ orderId, clientOrderId: z.literal(id) }).parse(
      await request("POST", "/api/v3/order", {
        symbol,
        side: intent.side,
        type: "LIMIT",
        timeInForce: "GTC",
        price: px,
        quantity: qty,
        newClientOrderId: id,
        newOrderRespType: "ACK",
      }),
    ).orderId;
  if (venue === "okx")
    return z
      .array(
        z.object({
          sCode: z.literal("0"),
          ordId: orderId,
          clOrdId: z.literal(id),
        }),
      )
      .length(1)
      .parse(
        await request("POST", "/api/v5/trade/order", {
          instId: symbol.replace("USDT", "-USDT"),
          tdMode: "cash",
          side: intent.side.toLowerCase(),
          ordType: "limit",
          px,
          sz: qty,
          clOrdId: id,
        }),
      )[0]!.ordId;
  return z.object({ orderId, orderLinkId: z.literal(id) }).parse(
    await request("POST", "/v5/order/create", {
      category: "spot",
      symbol,
      side: intent.side === "BUY" ? "Buy" : "Sell",
      orderType: "Limit",
      timeInForce: "GTC",
      price: px,
      qty,
      orderLinkId: id,
      isLeverage: 0,
    }),
  ).orderId;
}
async function queryLiveSpotSummary(
  venue: Venue,
  request: SpotRequest,
  intent: Intent,
) {
  const symbol = spotSymbol(intent),
    id = clientOrderId(intent);
  const qty = positiveDecimal.refine((v) => new Big(v).eq(intent.quantity));
  if (venue === "binance") {
    const o = z
      .object({
        orderId,
        clientOrderId: z.string().min(1),
        symbol: z.literal(symbol),
        side: z.literal(intent.side),
        origQty: qty,
        status: z.string(),
        executedQty: positiveDecimal,
        cummulativeQuoteQty: positiveDecimal,
      })
      .parse(
        await request("GET", "/api/v3/order", {
          symbol,
          ...(intent.venueOrderId
            ? { orderId: intent.venueOrderId }
            : { origClientOrderId: id }),
        }),
      );
    // Binance may replace the client ID on cancellation. The original exchange
    // order ID still identifies the same order within this account and symbol.
    if (
      o.clientOrderId !== id &&
      !(o.status === "CANCELED" && intent.venueOrderId === o.orderId)
    )
      return unknown(intent.venueOrderId);
    const filled = new Big(o.executedQty);
    return spotResult(
      intent,
      o.orderId,
      o.status,
      filled,
      filled.gt(0) ? new Big(o.cummulativeQuoteQty).div(filled) : null,
    );
  }
  if (venue === "okx") {
    const instId = symbol.replace("USDT", "-USDT");
    const o = z
      .array(
        z.object({
          ordId: orderId,
          clOrdId: z.literal(id),
          instId: z.literal(instId),
          side: z.literal(intent.side.toLowerCase()),
          sz: qty,
          state: z.string(),
          accFillSz: positiveDecimal,
          avgPx: z.union([z.literal(""), positiveDecimal]),
        }),
      )
      .length(1)
      .parse(
        await request("GET", "/api/v5/trade/order", { instId, clOrdId: id }),
      )[0]!;
    return spotResult(
      intent,
      o.ordId,
      o.state,
      new Big(o.accFillSz),
      o.avgPx ? new Big(o.avgPx) : null,
    );
  }
  const params = { category: "spot", symbol, orderLinkId: id };
  const rows = z.object({
    list: z
      .array(
        z.object({
          orderId,
          orderLinkId: z.literal(id),
          symbol: z.literal(symbol),
          side: z.literal(intent.side === "BUY" ? "Buy" : "Sell"),
          qty,
          orderStatus: z.string(),
          cumExecQty: positiveDecimal,
          avgPrice: z.union([z.literal(""), positiveDecimal]),
        }),
      )
      .max(1),
  });
  let [o] = rows.parse(await request("GET", "/v5/order/realtime", params)).list;
  if (!o)
    [o] = rows.parse(await request("GET", "/v5/order/history", params)).list;
  return o
    ? spotResult(
        intent,
        o.orderId,
        o.orderStatus,
        new Big(o.cumExecQty),
        o.avgPrice ? new Big(o.avgPrice) : null,
      )
    : unknown(intent.venueOrderId);
}
// Order-status responses expose cumulative quantities. Fetch the venue's actual trade IDs
// before closing reconciliation so a delayed or paginated execution history is not lost.
async function queryLiveSpot(
  venue: Venue,
  request: SpotRequest,
  intent: Intent,
): Promise<VenueOrderResult> {
  const summary = await queryLiveSpotSummary(venue, request, intent);
  const id = summary.venueOrderId;
  if (!id || !summary.filledQuantity) return summary;
  const symbol = spotSymbol(intent);
  const trades = new Map<string, Big>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  try {
    for (let page = 0; page < 100; page++) {
      let fills: { id: string; quantity: string }[];
      let next: string | undefined;
      if (venue === "binance") {
        const rows = z
          .array(
            z.object({
              id: orderId,
              orderId: z.coerce.string().pipe(z.literal(id)),
              symbol: z.literal(symbol),
              qty: positiveDecimal,
              isBuyer: z.literal(intent.side === "BUY"),
            }),
          )
          .parse(
            await request("GET", "/api/v3/myTrades", {
              symbol,
              orderId: id,
              limit: 1000,
              ...(cursor && { fromId: cursor }),
            }),
          );
        fills = rows.map((r) => ({ id: r.id, quantity: r.qty }));
        if (rows.length === 1000) next = String(BigInt(rows.at(-1)!.id) + 1n);
      } else if (venue === "okx") {
        const instId = symbol.replace(/USDT$/, "-USDT");
        const rows = z
          .array(
            z.object({
              ordId: z.literal(id),
              instId: z.literal(instId),
              side: z.literal(intent.side.toLowerCase()),
              tradeId: orderId,
              billId: orderId,
              fillSz: positiveDecimal,
            }),
          )
          .parse(
            await request("GET", "/api/v5/trade/fills-history", {
              instType: "SPOT",
              instId,
              ordId: id,
              limit: 100,
              ...(cursor && { after: cursor }),
            }),
          );
        fills = rows.map((r) => ({ id: r.tradeId, quantity: r.fillSz }));
        if (rows.length === 100) next = rows.at(-1)!.billId;
      } else {
        const batch = z
          .object({
            list: z.array(
              z.object({
                orderId: z.literal(id),
                symbol: z.literal(symbol),
                side: z.literal(intent.side === "BUY" ? "Buy" : "Sell"),
                execId: orderId,
                execQty: positiveDecimal,
              }),
            ),
            nextPageCursor: z.string().optional(),
          })
          .parse(
            await request("GET", "/v5/execution/list", {
              category: "spot",
              symbol,
              orderId: id,
              limit: 100,
              ...(cursor && { cursor }),
            }),
          );
        fills = batch.list.map((r) => ({ id: r.execId, quantity: r.execQty }));
        next = batch.nextPageCursor;
      }
      for (const fill of fills) {
        const qty = new Big(fill.quantity);
        if (
          !qty.gt(0) ||
          (trades.has(fill.id) && !trades.get(fill.id)!.eq(qty))
        )
          throw new Error("inconsistent-fill");
        trades.set(fill.id, qty);
      }
      if (!next) {
        const total = [...trades.values()].reduce(
          (a, b) => a.plus(b),
          new Big(0),
        );
        if (total.eq(summary.filledQuantity))
          return { ...summary, fillIds: [...trades.keys()] };
        break;
      }
      if (seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
  } catch {
    /* Reconcile again when authenticated trade details become available. */
  }
  return {
    ...summary,
    status: "unknown_reconcile",
    errorSummary: "missing-venue-fill-evidence",
  };
}
function liveCryptoAdapter(
  binding: Binding<"crypto_live">,
  fetchImpl: typeof fetch,
  key: unknown,
  now = Date.now,
): ExecutionVenueAdapter {
  const { venue } = binding;
  const auth = apiCredential.safeParse(key);
  const request =
    auth.success && (venue !== "okx" || auth.data.passphrase)
      ? mainnetRequest(venue, auth.data, fetchImpl)
      : null;
  return {
    kind: binding.kind,
    isLive: true,
    async readAccountState(_, date) {
      if (!request) throw new VenueAccountConfigError(cryptoMissing);
      assertCurrentSpotDate(date, now);
      return spotAccount(await liveBalances(venue, request), (symbol) =>
        livePrice(venue, request, symbol),
      );
    },
    async submitOrder(intent, ctx) {
      if (!request) return result("rejected", null, cryptoMissing);
      try {
        return result(
          "submitted",
          await liveSpotOrder(venue, request, intent, ctx.executePrice),
        );
      } catch (error) {
        if (error instanceof SpotBalanceRejected)
          return result("rejected", null, "交易所拒绝委托，可用余额不足");
        return unknown();
      }
    },
    async reconcileOrder(intent) {
      return request
        ? queryLiveSpot(venue, request, intent)
        : { ...unknown(intent.venueOrderId), errorSummary: cryptoMissing };
    },
    async cancelOrder(intent) {
      if (!request)
        return { ...unknown(intent.venueOrderId), errorSummary: cryptoMissing };
      const symbol = spotSymbol(intent),
        id = clientOrderId(intent);
      if (venue === "binance") {
        const cancelled = z
          .object({ orderId, origClientOrderId: z.literal(id) })
          .parse(
            await request("DELETE", "/api/v3/order", {
              symbol,
              origClientOrderId: id,
            }),
          );
        if (intent.venueOrderId && intent.venueOrderId !== cancelled.orderId)
          return unknown(intent.venueOrderId);
        return queryLiveSpot(venue, request, {
          ...intent,
          venueOrderId: cancelled.orderId,
        });
      } else if (venue === "okx")
        await request("POST", "/api/v5/trade/cancel-order", {
          instId: symbol.replace("USDT", "-USDT"),
          clOrdId: id,
        });
      else
        await request("POST", "/v5/order/cancel", {
          category: "spot",
          symbol,
          orderLinkId: id,
        });
      return queryLiveSpot(venue, request, intent);
    },
  };
}

export function resolveVenueAdapter(
  binding: VenueBinding,
  deps: VenueRouterDeps = {},
): ExecutionVenueAdapter {
  const key = extractVenueAccountKey(binding);
  const isLive = isLiveVenueKind(binding.kind);
  function configuredAdapter() {
    switch (binding.kind) {
      case "local_sim":
        return localAdapter(binding);
      case "ths_mock":
        return deps.thsAdapter ?? thsAdapter(deps.now);
      case "cn_broker_live":
        return undefined;
      case "crypto_sim":
        return deps.cryptoSimAdapter ?? simCryptoAdapter(binding, deps.now);
      case "crypto_live":
        return deps.cryptoLiveAdapter;
    }
  }
  const adapter = registry.get(key) ?? configuredAdapter();
  if (adapter && (adapter.kind !== binding.kind || adapter.isLive !== isLive))
    throw new Error("执行适配器与通道不匹配");
  async function loadCredential() {
    if (binding.kind !== "cn_broker_live" && binding.kind !== "crypto_live")
      return undefined;
    if (!adapter && binding.kind === "cn_broker_live" && !binding.endpointUrl)
      return undefined;
    try {
      return await credential(binding, deps);
    } catch {
      return undefined;
    }
  }
  function operationAdapter(auth: unknown) {
    if (adapter) return adapter;
    const fetchImpl = deps.fetchImpl ?? fetch;
    if (binding.kind === "cn_broker_live")
      return brokerAdapter(binding, fetchImpl, auth);
    if (binding.kind === "crypto_live")
      return liveCryptoAdapter(binding, fetchImpl, auth, deps.now);
    throw new Error("执行适配器未配置");
  }
  const check = (other: VenueBinding) => {
    if (extractVenueAccountKey(other) !== key)
      throw new Error("执行适配器与委托账户不匹配");
  };
  function assertAccountReadEnabled(db?: Db) {
    if (isLive && !getPipelineGlobalConfig(db ?? sqlite()).autoLiveEnabled)
      throw new Error("live-kill-switch-off：实盘总开关未开启，无法读取账户");
  }
  async function invoke(
    intent: Intent,
    action: (
      venue: ExecutionVenueAdapter,
      intent: Intent,
    ) => Promise<VenueOrderResult>,
  ) {
    check(intent.venueBinding);
    const auth = isLive ? await loadCredential() : undefined;
    const secrets = credentialStrings(auth);
    const safeIntent = isLive
      ? {
          ...intent,
          venueOrderId: safeLiveOrderId(intent.venueOrderId, secrets),
        }
      : intent;
    let receipt: VenueOrderResult;
    try {
      receipt = resultSchema.parse(
        await action(operationAdapter(auth), safeIntent),
      );
    } catch {
      receipt = unknown(safeIntent.venueOrderId);
    }
    if (!isLive) return receipt;
    const { errorSummary } = receipt;
    return {
      ...receipt,
      fillId: safeLiveOrderId(receipt.fillId ?? null, secrets) ?? undefined,
      fillIds: receipt.fillIds?.flatMap(
        (id) => safeLiveOrderId(id, secrets) ?? [],
      ),
      venueOrderId:
        safeLiveOrderId(receipt.venueOrderId, secrets) ??
        safeIntent.venueOrderId,
      errorSummary:
        errorSummary && secrets.some((secret) => errorSummary.includes(secret))
          ? null
          : errorSummary,
    };
  }
  return {
    kind: binding.kind,
    isLive,
    cnBuyStep: adapter?.cnBuyStep,
    async readAccountState(b, date, db, cutoff) {
      check(b);
      assertAccountReadEnabled(db);
      const venue = adapter ?? operationAdapter(await loadCredential());
      // The live switch can change while the vault is being read.
      assertAccountReadEnabled(db);
      const read = () =>
        cutoff === undefined
          ? venue.readAccountState(b, date, db)
          : venue.readAccountState(b, date, db, cutoff);
      if (b.kind === "local_sim") return read();
      let snapshot;
      try {
        snapshot = externalSnapshot(await read());
      } catch (error) {
        if (!(error instanceof z.ZodError || error instanceof SyntaxError))
          throw error;
        snapshot = externalSnapshot(null);
      }
      const drawdownPct = externalAccountDrawdown(
        b,
        date,
        snapshot,
        db ?? sqlite(),
      );
      return { ...snapshot, drawdownPct };
    },
    async submitOrder(i, ctx) {
      if (i.status !== "submitting")
        return result("rejected", null, "intent-not-claimed");
      if (isLive && getPipelineGlobalConfig(ctx.db).autoLiveEnabled !== true)
        return result("rejected", null, "live-kill-switch-off");
      return invoke(i, async (venue, intent) => {
        const claimed = getIntent(intent.id, ctx.db);
        if (
          claimed?.status !== "submitting" ||
          claimed.updatedAt !== intent.updatedAt ||
          claimed.idempotencyKey !== intent.idempotencyKey ||
          claimed.venueOrderId !== i.venueOrderId ||
          claimed.executeDate !== ctx.executeDate ||
          extractVenueAccountKey(claimed.venueBinding) !== key
        )
          return result("rejected", null, "intent-not-claimed");
        if (submissionDateExpired(claimed, deps.now))
          return result("rejected", null, "execute-date-expired");
        // The credential read can yield while the operator closes the live switch.
        if (
          venue.isLive &&
          getPipelineGlobalConfig(ctx.db).autoLiveEnabled !== true
        )
          return result("rejected", null, "live-kill-switch-off");
        const blocked = ctx.submissionBlock?.();
        if (blocked) return result("rejected", null, blocked);
        return venue.submitOrder(
          { ...claimed, venueOrderId: intent.venueOrderId },
          ctx,
        );
      });
    },
    reconcileOrder: (i, ctx) =>
      invoke(i, (venue, intent) => venue.reconcileOrder(intent, ctx)),
    cancelOrder: (i, ctx) =>
      invoke(i, (venue, intent) => venue.cancelOrder(intent, ctx)),
  };
}
