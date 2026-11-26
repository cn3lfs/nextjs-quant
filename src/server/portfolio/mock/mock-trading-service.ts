import { randomUUID } from "node:crypto";
import { z } from "zod";
import { get, put, sqlite } from "../../db";
import { saveSecret, readSecret } from "../../vault";
import {
  MockTradingAdapter,
  MockSubmissionBlocked,
  mockCredentialRevision,
  reconcilePositions,
  type MockAccount,
  type MockOrderStatus,
  type MockResponseEvidence,
} from "./mock-trading";
import { chinaDate } from "~/lib/market/security-trading-status";
import {
  tradeInputSchema,
  type TradeInput,
} from "~/lib/portfolio/trade-ledger";
import { tradeContext, tradeDashboard } from "../trade-ledger-service";
const configId = "mock-trading-config";
const credentialId = "mock-trading-account";
export const mockEnabled = () =>
  get<{ enabled: boolean }>(configId)?.enabled === true;
const adapter = () =>
  new MockTradingAdapter({
    enabled: mockEnabled,
    retain: (entry) =>
      put(
        "mock-diagnostics",
        "mock-diagnostics",
        [...mockDiagnostics(), entry].slice(-20),
      ),
    read: () => readSecret<MockAccount>(credentialId),
    save: async (a) => {
      await saveSecret(credentialId, a);
    },
  });
// Local-only preference. Enabling never implicitly opens an account or polls.
export function setMockEnabled(enabled: boolean) {
  put("mock-trading-config", configId, { enabled });
}
// Serialize credential creation per process; the account journal survives restarts.
let opening = false;
export async function openMockAccount() {
  if (opening) throw new Error("开户正在处理");
  opening = true;
  try {
    await adapter().open();
  } finally {
    opening = false;
  }
}
export async function reconcileMock() {
  // Disabled guard occurs before credential access and any request.
  const remote = await adapter().positions();
  return reconcilePositions((await tradeDashboard()).positions, remote);
}
type PendingOrder = {
  input: TradeInput;
  expires: number;
  state: "pending" | "attempted" | "accepted" | "unknown" | "blocked";
  receipt?: {
    entrustNos: string[];
    at: number;
    credentialRevision: string;
    tradeDate: string;
  };
};
export async function previewMockOrder(
  input: unknown,
  sessionConfirmed?: (date: string) => Promise<boolean>,
) {
  if (!mockEnabled()) throw new Error("同花顺模拟盘未开启");
  const t = tradeInputSchema.parse(input);
  const context = await tradeContext();
  if (
    t.date !== context.today ||
    !(sessionConfirmed
      ? await sessionConfirmed(t.date)
      : context.calendar.includes(t.date))
  )
    throw new Error("模拟委托仅接受当前已核验交易日");
  if (t.symbol.startsWith("bj"))
    throw new Error("模拟盘不支持北交所契约，仅可本地记账");
  const id = `mock-order-${randomUUID()}`;
  put<PendingOrder>("mock-order", id, {
    input: t,
    expires: Date.now() + 60000,
    state: "pending",
  });
  return { id, input: t };
}
export async function confirmMockOrder(
  id: string,
  submissionBlock?: () => string | null,
  sessionConfirmed?: (date: string) => Promise<boolean>,
) {
  if (get<string>("paper-mirror-reservation-ths-simulation"))
    throw new Error("该模拟账户由纸面镜像独占；请先关闭镜像");
  if (!mockEnabled()) throw new Error("同花顺模拟盘未开启");
  if (!/^mock-order-[\da-f-]{36}$/.test(id))
    throw new Error("无效委托确认编号");
  const order = sqlite()
    .transaction(() => {
      const o = get<PendingOrder>(id);
      if (!o || o.state !== "pending" || o.expires < Date.now())
        throw new Error("委托已确认或已过期，请重新预览");
      // Consume before I/O: reload/double-click/retry cannot place a second order.
      put("mock-order", id, { ...o, state: "attempted" });
      return o;
    })
    .immediate();
  try {
    const context = await tradeContext();
    if (
      order.input.date !== context.today ||
      !(sessionConfirmed
        ? await sessionConfirmed(context.today)
        : context.calendar.includes(context.today))
    ) {
      if (!submissionBlock) throw new Error("交易日期已变化，请重新预览");
      throw new MockSubmissionBlocked(
        submissionBlock() ?? "execute-date-expired",
      );
    }
    const receipt = await adapter().order(order.input, true, submissionBlock);
    put<PendingOrder>("mock-order", id, {
      ...order,
      state: "accepted",
      receipt: {
        entrustNos: receipt.entrustNos,
        at: Date.now(),
        credentialRevision: receipt.credentialRevision,
        tradeDate: receipt.tradeDate,
      },
    });
    return receipt;
  } catch (error) {
    // A blocked transport never sent a request. Other failures retain the one-attempt fence.
    put<PendingOrder>("mock-order", id, {
      ...order,
      state:
        submissionBlock && error instanceof MockSubmissionBlocked
          ? "blocked"
          : "unknown",
    });
    throw error;
  }
}

/** Read-only: consults the venue, never resubmits or rewrites business state. */
type MockStatusReceipt = { state: PendingOrder["state"]; entrustNos: string[] };
export function queryMockOrderStatus(
  id: string,
): Promise<MockStatusReceipt & MockOrderStatus>;
export function queryMockOrderStatus(
  id: string,
  allowMissingFee: true,
): Promise<
  MockStatusReceipt & Awaited<ReturnType<MockTradingAdapter["orderStatus"]>>
>;
export async function queryMockOrderStatus(
  id: string,
  allowMissingFee = false,
) {
  if (!/^mock-order-[\da-f-]{36}$/.test(id)) throw new Error("无效委托编号");
  if (!mockEnabled()) throw new Error("同花顺模拟盘未开启");
  const order = get<PendingOrder>(id);
  if (!order) throw new Error("委托记录不存在");
  const entrustNos = order.receipt?.entrustNos ?? [];
  const unattributable = (reason: string): MockOrderStatus => ({
    attributable: false,
    fillStatus: "unknown",
    rows: [],
    reason,
  });
  if (!order.receipt || order.state !== "accepted" || entrustNos.length === 0)
    return {
      state: order.state,
      entrustNos,
      ...unattributable("缺少发送时的委托号，无法按成交归属"),
    };
  // The venue only exposes today's trades. Bind the query to the credential
  // snapshot and trading date that actually sent the order; never let a new
  // account or a later day claim an old entrust number.
  const current = await readSecret<MockAccount>(credentialId);
  if (
    !current ||
    mockCredentialRevision(current) !== order.receipt.credentialRevision
  )
    return {
      state: order.state,
      entrustNos,
      ...unattributable("凭证已变化，保持未知；请人工核对"),
    };
  const today = chinaDate(Date.now());
  if (today !== order.receipt.tradeDate)
    return {
      state: order.state,
      entrustNos,
      ...unattributable("跨日无历史委托查询能力，保持未知"),
    };
  const status = allowMissingFee
    ? await adapter().orderStatus(entrustNos, true)
    : await adapter().orderStatus(entrustNos);
  if (chinaDate(Date.now()) !== today)
    return {
      state: order.state,
      entrustNos,
      ...unattributable("查询跨越交易日，保持未知"),
    };
  return { state: order.state, entrustNos, ...status };
}

export function mockDiagnostics() {
  return get<MockResponseEvidence[]>("mock-diagnostics") ?? [];
}
export async function refreshMockShareholders() {
  await adapter().refreshShareholders();
}
export async function mockMarketCodes() {
  if (!mockEnabled()) return [];
  return (
    (await readSecret<MockAccount>(credentialId))?.shareholders?.map(
      (s) => s.scdm,
    ) ?? []
  );
}
export async function queryMockFunds() {
  return adapter().funds();
}
export async function queryMockTrades() {
  return adapter().todayTrades();
}

const mockAccountMetaSource = z.object({
  state: z.enum(["creating", "ready"]),
  username: z.string().min(1),
  shareholders: z.array(z.object({ scdm: z.string() })).optional(),
});

// Match the order adapter's shareholder codes for Shenzhen and Shanghai.
const allowedMockMarketCodes = new Set(["1", "2"]);

export async function readMockAccountMeta() {
  const stored = await readSecret<MockAccount>(credentialId).catch(
    () => undefined,
  );
  const account = mockAccountMetaSource.safeParse(stored);
  const shareholders = account.success ? (account.data.shareholders ?? []) : [];
  const marketCodes = shareholders
    .map(({ scdm }) => scdm)
    .filter((code) => allowedMockMarketCodes.has(code));
  return {
    enabled: mockEnabled(),
    hasAccount: account.success,
    // The adapter uses this THS branch for both account creation and recovery.
    yybid: account.success ? "997376" : null,
    marketCodes: [...new Set(marketCodes)],
  };
}

export async function queryMockOverview() {
  if (!mockEnabled()) throw new Error("同花顺模拟盘未开启");
  const [funds, positions, trades] = await Promise.all([
    queryMockFunds(),
    adapter().positions(),
    queryMockTrades().catch(() => null),
  ]);
  return {
    funds,
    positions,
    trades: trades ?? [],
    tradesAvailable: trades !== null,
    fetchedAt: Date.now(),
  };
}
