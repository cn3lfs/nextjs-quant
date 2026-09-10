// Explicit manual Q0 probe. No retries, no creation, isolated existing DPAPI only.
import {
  MockTradingAdapter,
  type MockAccount,
} from "../src/server/mock-trading";
import { readSecret, saveSecret } from "../src/server/vault";
import { get, put } from "../src/server/db";
import { tradeInputSchema } from "../src/lib/trade-ledger";
import { redactMockBody, mockHost } from "../src/server/mock-trading";
import { fetch } from "undici";
import { evidenceEnvelope } from "../src/server/evidence";
import {
  tradeContext,
  tradeDashboard,
} from "../src/server/trade-ledger-service";
import { TradeLedgerStore } from "../src/server/trade-ledger-store";
import { sqlite } from "../src/server/db";
import { tradingLedgerMethods } from "../src/server/research-skills";
import { reconcilePositions } from "../src/server/mock-trading";
import { writeFile } from "node:fs/promises";
if (!process.env.QUANT_DATA_DIR?.includes(".test-data"))
  throw new Error("Q0 requires isolated QUANT_DATA_DIR");
const adapter = new MockTradingAdapter({
  enabled: () => true,
  read: () => readSecret<MockAccount>("mock-trading-account"),
  save: (a) => saveSecret("mock-trading-account", a),
  retain: (entry) =>
    put(
      "mock-diagnostics",
      "mock-diagnostics",
      [...(get<unknown[]>("mock-diagnostics") ?? []), entry].slice(-20),
    ),
});
const mode = process.argv[2] ?? "shareholders";
if (mode === "reconcile") {
  const remote = await adapter.positions();
  const funds = await adapter.funds();
  const fills = await adapter.todayTrades();
  const fill = fills.find(
    (f) =>
      f.zqdm === "601398" &&
      f.mmlb === "买入" &&
      f.cjg === 8.07 &&
      f.cje === 807 &&
      "cjsl" in f &&
      f.cjsl === 100,
  );
  if (!fill)
    throw new Error(
      "Expected existing buy fill not confirmed; no ledger mutation or repeated buy",
    );
  const buy = tradeInputSchema.parse({
    id: "b1f06d15-67ac-4c11-8d85-6a2a72a0d760",
    symbol: "sh601398",
    date: "2026-09-10",
    side: "buy",
    quantity: 100,
    price: fill.cjg,
    lowerLimit: 7.2,
    upperLimit: 8.8,
    limitSource: "Q0 2026-09-10 实测东方财富 f51=880/f52=720，精度2",
    note: "Q0 已核实同花顺10:23:03成交；远程费用0.26元，本地仍用实验费用，差异显式对账。",
  });
  const context = await tradeContext();
  if (context.today !== buy.date)
    throw new Error("This same-day probe cannot be reused on a later date");
  // Local completed daily calendar ends yesterday in the morning. The confirmed
  // remote fill establishes today's date for this isolated audit only; do not
  // alter settings or pretend the user supplied an official calendar.
  new TradeLedgerStore(sqlite()).record(buy, {
    ...context,
    calendar: [...new Set([...context.calendar, buy.date])].sort(),
    methods: await tradingLedgerMethods(),
    evidence: context.evidence(buy.symbol),
  });
  const local = await tradeDashboard();
  let sell: string;
  try {
    sell = await adapter.order(
      { ...buy, id: crypto.randomUUID(), side: "sell" },
      true,
    );
  } catch (e) {
    sell = String(e);
  }
  const evidence = {
    capturedAt: new Date().toISOString(),
    calendarBasis:
      "隔离实操：本地已有日期 + 当日远程已核实成交日期；未改变生产设置",
    remote,
    funds,
    fills,
    localTrades: local.trades,
    localPositions: local.positions,
    reconciliation: reconcilePositions(local.positions, remote),
    sell,
    diagnostics: adapter.diagnostics(),
  };
  await writeFile(
    "docs/q2b-review/q0-reconciliation.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      remote,
      funds,
      fills,
      localFees: local.trades.map((t) => t.fees),
      positions: local.positions,
      reconciliation: evidence.reconciliation,
      sell,
    }),
  );
} else if (mode === "query-script-contract") {
  // Read-only diagnostics using stock_query.py's explicit contract, not guessed endpoints.
  const a = await readSecret<MockAccount>("mock-trading-account");
  if (!a?.account) throw new Error("Existing identity required");
  for (const [path, params] of [
    ["/pt_web_qry_stock", { name: a.account, yybid: "997376", type: "1" }],
    ["/pt_qry_fund_t", { usrid: a.account }],
    ["/pt_qry_busin_nocache", { usrname: a.account, kind: "1" }],
  ] as const) {
    const url = new URL(path, mockHost);
    url.search = new URLSearchParams({
      datatype: "json",
      ...params,
    }).toString();
    try {
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      const rawBody = redactMockBody(await response.text(), [
        a.username,
        a.account,
        ...(a.shareholders?.map((s) => s.gddm) ?? []),
      ]);
      const entry = {
        path,
        httpStatus: response.status,
        rawBody,
        envelope: evidenceEnvelope(rawBody, {
          source: "mock-trading",
          symbol: null,
          type: "quote-financial",
          asOf: null,
          publishedAt: null,
          fetchedAt: Date.now(),
          currency: null,
          unit: {},
          adjustment: "not-applicable",
          reportPeriod: null,
          quality: "unavailable",
          warnings: ["Read-only script-contract probe; not yet validated"],
        }),
        failures: [],
      };
      put(
        "mock-diagnostics",
        "mock-diagnostics",
        [...(get<unknown[]>("mock-diagnostics") ?? []), entry].slice(-20),
      );
      console.log(JSON.stringify(entry));
    } catch {
      console.log(path, "transport unavailable; no retry");
    }
  }
} else if (mode === "shareholders") {
  try {
    await adapter.refreshShareholders();
    console.log("shareholders ready");
  } catch (e) {
    console.log(String(e));
  }
} else if (mode === "trade") {
  if (get("q0-q2b-attempt"))
    throw new Error("This authorized probe was already attempted; no retry");
  put("q0-probe", "q0-q2b-attempt", { at: Date.now() });
  const buy = tradeInputSchema.parse({
    id: crypto.randomUUID(),
    symbol: "sh601398",
    date: "2026-09-10",
    side: "buy",
    quantity: 100,
    price: 8.07,
    lowerLimit: 7.2,
    upperLimit: 8.8,
    limitSource: "东方财富实时 f51/f52，f86=1789006938，精度f59=2",
  });
  for (const [name, fn] of [
    ["buy", () => adapter.order(buy, true)],
    ["positions", () => adapter.positions()],
    ["funds", () => adapter.funds()],
    ["todayTrades", () => adapter.todayTrades()],
    [
      "sell",
      () =>
        adapter.order({ ...buy, id: crypto.randomUUID(), side: "sell" }, true),
    ],
  ] as const) {
    try {
      console.log(name, JSON.stringify(await fn()));
    } catch (e) {
      console.log(name, String(e));
    }
  }
} else throw new Error("Unknown mode");
console.log(JSON.stringify(adapter.diagnostics()));
