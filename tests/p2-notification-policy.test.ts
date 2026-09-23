import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const blocked = vi.hoisted(() => ({ network: vi.fn(), secret: vi.fn() }));
vi.mock("undici", () => ({ fetch: blocked.network, ProxyAgent: class {} }));
vi.mock("../src/server/vault", () => ({
  readSecret: blocked.secret,
  saveSecret: vi.fn(),
}));
vi.mock("../src/server/market/securities", () => ({
  securityLabel: (s: string) => s,
}));
import { get, put, sqlite, list } from "../src/server/db";
import {
  drain,
  enqueue,
  flushSummaries,
  notificationRequest,
  recoverDeliveries,
  SendError,
} from "../src/server/infra/notifications";
import {
  NotificationPolicyStore,
  renderSummary,
} from "../src/server/infra/notification-policy-store";
import {
  chinaClock,
  grade,
  notificationPolicySchema,
  quiet,
  summaryWindow,
  withinTradingWindow,
  type PolicyUnit,
  type NotificationPolicy,
} from "../src/lib/notification-policy";
import {
  settingsSchema,
  strategySchema,
  type Channel,
  type Delivery,
  type Monitor,
  type Signal,
} from "../src/lib/domain";
import { SignalLedgerStore } from "../src/server/monitoring/signal-ledger-store";
import { ledgerSignals } from "../src/server/monitoring/signal-ledger-engine";
import { SignalLedgerView } from "../src/components/signals/signal-ledger-view";
import { NotificationPolicyFields } from "../src/components/common/notification-policy-fields";
import type { CzscResult } from "../src/lib/czsc";
import valid from "./fixtures/breakout-valid.json";
import { analyzeBreakout } from "../src/server/strategies/breakout/breakout";

process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-p2-"));
const date = "2026-09-10";
const at = (time: string, day = date) => Date.parse(`${day}T${time}:00+08:00`);
const days = [
  "2026-09-09",
  date,
  "2026-09-11",
  "2026-09-14",
  "2026-09-15",
  "2026-09-16",
];
const types = ["feishu", "wecom", "telegram", "discord"] as const;
const credentials = {
  feishu: { secret: "https://open.feishu.cn/open-apis/bot/v2/hook/fake-only" },
  wecom: {
    secret: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fake-only",
  },
  telegram: { secret: "123:fake-only" },
  discord: { secret: "https://discord.com/api/webhooks/123/fake-only" },
};
let store: NotificationPolicyStore,
  channels: string[],
  seq = 0;
const configure = (input: unknown = {}) => {
  const p = notificationPolicySchema.parse(input);
  put(
    "settings",
    "settings",
    settingsSchema.parse({ calendar: days, notificationPolicy: p }),
  );
  return p;
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("10:00"));
  blocked.network.mockReset().mockImplementation(() => {
    throw new Error("P2 forbids real network");
  });
  blocked.secret.mockReset().mockImplementation(() => {
    throw new Error("P2 forbids real credentials");
  });
  vi.stubGlobal("fetch", blocked.network);
  sqlite().prepare("DELETE FROM records").run();
  sqlite().prepare("DELETE FROM signal_ledger").run();
  sqlite().prepare("DELETE FROM signal_ledger_baselines").run();
  configure();
  store = new NotificationPolicyStore(sqlite());
  seq = 0;
  channels = types.map((type) => {
    const id = `fake-${type}-${crypto.randomUUID()}`;
    put<Channel>("channel", id, {
      id,
      type,
      name: type,
      configured: true,
      enabled: true,
      target: "fake-only",
      thread: "",
    });
    return id;
  });
});
afterEach(() => {
  expect(blocked.network).toHaveBeenCalledTimes(0);
  expect(blocked.secret).toHaveBeenCalledTimes(0);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function signal(
  quality = 2,
  symbol = `sh${String(600000 + seq++).padStart(6, "0")}`,
  kind = 3,
): Signal {
  const day = chinaClock(Date.now()).date;
  const id = `p2-${seq++}`;
  const monitor: Monitor = {
    id: `monitor-${id}`,
    name: "P2受控",
    revision: "r1",
    createdAt: 1,
    enabled: true,
    ai: true,
    period: "day",
    source: "local",
    strategy: strategySchema.parse({ type: "czsc", params: {} }),
    symbols: [symbol],
    channels,
    states: {},
  };
  put("monitor", monitor.id, monitor);
  const s: Signal = {
    id,
    symbol,
    monitorId: monitor.id,
    monitorRun: { createdAt: 1, revision: "r1" },
    strategy: monitor.strategy,
    period: "day",
    date: day,
    createdAt: Date.now(),
    expiresAt: Date.now() + 86400000,
    snapshotId: "p2-fixture",
    source: "tdx-local",
    metrics: {
      date: day,
      close: 10,
      fast: 0,
      slow: 0,
      change: 0,
      volumeRatio: 1,
      matched: true,
      score: quality,
    },
    czsc: {
      strategyVersion: "czsc-monitor-1",
      dllVersion: "fixture",
      config: 0,
      points: [
        {
          key: `0:${day}:${kind}`,
          date: day,
          kind,
          quality,
          center: null,
          divergence: "受控证据",
          invalidation: "结构撤销或质量降为观察",
        },
      ],
    },
  };
  put("signal", id, s);
  return s;
}
const fakeSend = () =>
  vi.fn(async (channel: Channel, delivery: Delivery) => {
    const request = notificationRequest(
      channel,
      credentials[channel.type],
      delivery,
    );
    expect(JSON.stringify(request.payload)).not.toContain("…");
    return "fake-accepted";
  });
it("15:05 immediate bypasses outside-trading quiet", async () => {
  vi.setSystemTime(at("15:05"));
  enqueue(signal(), channels, "signal");
  const send = fakeSend();
  await drain(send);
  expect(send).toHaveBeenCalledTimes(4);
});
it("15:05 immediate still obeys custom quiet", async () => {
  configure({ quietEnabled: true, quietStart: "15:00", quietEnd: "16:00" });
  vi.setSystemTime(at("15:05"));
  enqueue(signal(), channels, "signal");
  const send = fakeSend();
  await drain(send);
  expect(send).toHaveBeenCalledTimes(0);
  expect(store.decisions().every((d) => d.tier === "summary")).toBe(true);
});
it("15:05 immediate still obeys daily limit", async () => {
  configure({ dailyLimit: 1 });
  vi.setSystemTime(at("15:05"));
  enqueue(signal(), channels, "signal");
  const send = fakeSend();
  await drain(send);
  expect(send).toHaveBeenCalledTimes(0);
  expect(
    store
      .decisions()
      .every((d) => d.reasons.some((r) => r.includes("每日推送上限"))),
  ).toBe(true);
});
it("15:05 immediate still obeys dedup window", async () => {
  vi.setSystemTime(at("15:05"));
  enqueue(signal(2, "sh600519"), channels, "signal");
  const send = fakeSend();
  await drain(send);
  vi.setSystemTime(at("15:05", "2026-09-11"));
  const repeated = signal(2, "sh600519");
  enqueue(repeated, channels, "signal");
  await drain(send);
  expect(send).toHaveBeenCalledTimes(4);
  expect(
    store
      .decisions()
      .filter((d) => d.signalId === repeated.id)
      .every((d) => d.tier === "ledger"),
  ).toBe(true);
});
async function pump(
  send: ReturnType<typeof fakeSend>,
  count: number,
  start = Date.now(),
) {
  for (let i = 0; i < count; i++) {
    vi.setSystemTime(start + i * 4000);
    await drain(send);
  }
}
it.each([
  ["czsc", 0, "ledger"],
  ["czsc", 1, "summary"],
  ["czsc", 2, "immediate"],
  ["czsc", 3, "ledger"],
  ["dual-breakout", 0, "ledger"],
  ["dual-breakout", 2, "ledger"],
  ["dual-breakout", 3, "summary"],
  ["dual-breakout", 4, "summary"],
  ["dual-breakout", 5, "immediate"],
  ["dual-breakout", 6, "ledger"],
  ["dual-breakout", NaN, "ledger"],
] as const)("grade %s %s -> %s", (strategy, score, expected) => {
  expect(grade({ strategy, score }, notificationPolicySchema.parse({}))).toBe(
    expected,
  );
});
it("validates and persists configurable tiers/thresholds; rejects contradictory and malformed inputs", () => {
  const p = configure({
    czsc: { strong: "ledger", observe: "summary" },
    breakout: {
      highMin: 4,
      middleMin: 2,
      high: "summary",
      middle: "immediate",
    },
  });
  expect(store.policy()).toEqual(p);
  expect(grade({ strategy: "czsc", score: 2 }, p)).toBe("ledger");
  expect(grade({ strategy: "dual-breakout", score: 3 }, p)).toBe("immediate");
  for (const input of [
    { dailyLimit: 0 },
    { dedupTradingDays: -1 },
    { summaryTime: "14:59" },
    { quietStart: "25:00" },
    { breakout: { highMin: 3, middleMin: 4 } },
  ])
    expect(() => configure(input)).toThrow();
  const html = renderToStaticMarkup(
    createElement(NotificationPolicyFields, { value: p, onChange: () => {} }),
  );
  expect(html).toContain("每渠道每日最多消息数");
  expect(html).toContain("收盘汇总时间");
});
it("uses exchange dates, lunch/overnight silence, and an explicit 15-minute digest exception", () => {
  const p = store.policy();
  for (const t of ["09:29", "11:30", "12:59", "15:00", "23:00"])
    expect(quiet(at(t), days, p)).toBe(true);
  for (const t of ["09:30", "11:29", "13:00", "14:59"])
    expect(quiet(at(t), days, p)).toBe(false);
  expect(quiet(at("10:00", "2026-09-12"), days, p)).toBe(true);
  expect(quiet(at("10:00"), [], p)).toBe(true);
  expect(summaryWindow(at("15:14"), days, p)).toBe(false);
  expect(summaryWindow(at("15:15"), days, p)).toBe(true);
  expect(summaryWindow(at("15:29"), days, p)).toBe(true);
  expect(summaryWindow(at("15:30"), days, p)).toBe(false);
  expect(summaryWindow(at("15:15", "2026-09-12"), days, p)).toBe(false);
  const custom = configure({
    quietEnabled: true,
    quietStart: "15:00",
    quietEnd: "09:30",
  });
  expect(summaryWindow(at("15:15"), days, custom)).toBe(false);
  expect(quiet(at("09:29"), days, custom)).toBe(true);
  expect(quiet(at("10:00"), days, custom)).toBe(false);
  const all = { ...custom, quietStart: "10:00", quietEnd: "10:00" };
  expect(quiet(at("10:00"), days, all)).toBe(true);
});
it("all three tiers reach the real outbox/four formatters, with zero network and no lower-quality point leakage", async () => {
  const s = signal();
  s.czsc!.points = [0, 1, 2].map((quality, i) => ({
    ...s.czsc!.points[0]!,
    quality,
    kind: i + 1,
    key: `0:${date}:${i + 1}`,
  }));
  put("signal", s.id, s);
  enqueue(s, channels, "signal");
  enqueue(s, channels, "signal");
  expect(store.decisions()).toHaveLength(12);
  expect(list<Delivery>("delivery")).toHaveLength(4);
  const send = fakeSend();
  await drain(send);
  expect(send).toHaveBeenCalledTimes(4);
  for (const [, d] of send.mock.calls) {
    expect(d.body).toContain("强质量");
    expect(d.body).not.toContain("第一类");
    expect(d.body).not.toContain("第二类");
  }
  vi.setSystemTime(at("15:15"));
  await drain(send);
  // Confirmed points share symbol/direction with the already-pushed strong point.
  expect(send).toHaveBeenCalledTimes(4);
  expect(
    store
      .decisions()
      .filter((d) => d.score === 1)
      .every((d) => d.reasons.some((r) => r.includes("交易日"))),
  ).toBe(true);
});
it("daily limit reserves one digest slot per channel and survives a fresh policy-store instance", async () => {
  configure({ dailyLimit: 3 });
  for (let i = 0; i < 8; i++) {
    const s = signal();
    enqueue(s, channels, "signal");
  }
  const send = fakeSend();
  await pump(send, 10);
  expect(send).toHaveBeenCalledTimes(8); // two logical messages x four channels
  store = new NotificationPolicyStore(sqlite());
  expect(store.decisions().filter((d) => d.tier === "summary")).toHaveLength(
    24,
  );
  vi.setSystemTime(at("15:15"));
  await drain(send);
  await drain(send);
  expect(send).toHaveBeenCalledTimes(12);
  for (const id of channels)
    expect(store.budget(id, Date.now()).ids).toHaveLength(3);
  expect(
    list<Delivery>("delivery").filter((d) => d.kind === "summary"),
  ).toHaveLength(4);
  expect(
    send.mock.calls
      .filter(([, d]) => d.kind === "summary")
      .every(([, d]) => d.body.includes("待关注 6 条")),
  ).toBe(true);
});
it("after-close summary tier forms exactly one bounded structured message per channel", async () => {
  configure({ czsc: { strong: "summary" } });
  vi.setSystemTime(at("15:05"));
  for (let i = 0; i < 70; i++) {
    const s = signal(i % 2 ? 1 : 2);
    enqueue(s, channels, "signal");
  }
  const send = fakeSend();
  await drain(send);
  expect(send).not.toHaveBeenCalled();
  vi.setSystemTime(at("15:15"));
  await drain(send);
  expect(send).toHaveBeenCalledTimes(4);
  for (const [, d] of send.mock.calls) {
    expect(d.body).toContain("待关注 70 条");
    expect(d.body).toContain("本消息不拆分");
    expect(Buffer.byteLength(d.body)).toBeLessThan(1800);
  }
  const late = signal();
  enqueue(late, channels, "signal");
  vi.setSystemTime(at("15:16"));
  await drain(send);
  expect(send).toHaveBeenCalledTimes(4);
  expect(
    store
      .decisions()
      .filter((d) => d.signalId === late.id)
      .every(
        (d) => d.tier === "ledger" && d.reasons.some((r) => r.includes("封卷")),
      ),
  ).toBe(true);
});
it("quiet is checked again when a queued immediate message is claimed", async () => {
  const s = signal();
  enqueue(s, channels, "signal");
  configure({ quietEnabled: true, quietStart: "11:30", quietEnd: "13:00" });
  vi.setSystemTime(at("11:30"));
  const send = fakeSend();
  await drain(send);
  expect(send).not.toHaveBeenCalled();
  expect(store.decisions().every((d) => d.tier === "summary")).toBe(true);
  vi.setSystemTime(at("15:15"));
  await drain(send);
  expect(send).toHaveBeenCalledTimes(4);
});
it("custom all-day silence sends nothing and records the missed window without next-day catch-up", async () => {
  configure({ quietEnabled: true, quietStart: "00:00", quietEnd: "00:00" });
  const s = signal();
  enqueue(s, channels, "signal");
  const send = fakeSend();
  vi.setSystemTime(at("15:15"));
  await drain(send);
  expect(send).not.toHaveBeenCalled();
  vi.setSystemTime(at("15:30"));
  await drain(send);
  expect(
    store
      .decisions()
      .every(
        (d) => d.tier === "ledger" && d.reasons.some((r) => r.includes("错过")),
      ),
  ).toBe(true);
  vi.setSystemTime(at("15:15", "2026-09-11"));
  await drain(send);
  expect(send).not.toHaveBeenCalled();
});
it("dedup counts trading days including holidays, distinguishes direction/strategy, and allows the boundary", async () => {
  vi.setSystemTime(at("10:00", "2026-09-11"));
  const s = signal(2, "sh600519");
  enqueue(s, channels, "signal");
  const send = fakeSend();
  await drain(send);
  for (const day of ["2026-09-14", "2026-09-15"]) {
    vi.setSystemTime(at("10:00", day));
    const repeated = signal(2, s.symbol);
    enqueue(repeated, channels, "signal");
    await drain(send);
  }
  expect(send).toHaveBeenCalledTimes(4);
  const opposite = signal(2, s.symbol, -3);
  enqueue(opposite, channels, "signal");
  await drain(send);
  expect(send).toHaveBeenCalledTimes(8);
  const unit: PolicyUnit = {
    symbol: s.symbol,
    strategy: "dual-breakout",
    direction: "long",
    date,
    endpointDate: date,
    score: 5,
  };
  expect(store.duplicate(unit, channels[0]!, Date.now())).toBe(false);
  vi.setSystemTime(at("10:00", "2026-09-16"));
  const allowed = signal(2, s.symbol);
  enqueue(allowed, channels, "signal");
  await drain(send);
  expect(send).toHaveBeenCalledTimes(12);
  expect(withinTradingWindow("2026-09-11", "2026-09-16", days, 3)).toBe(false);
  expect(withinTradingWindow("missing", "2026-09-16", days, 3)).toBe(true);
});
it("duplicate queued messages are filtered at claim time, not merely enqueue time", async () => {
  const a = signal(2, "sh600519"),
    b = signal(2, "sh600519");
  enqueue(a, channels, "signal");
  enqueue(b, channels, "signal");
  const send = fakeSend();
  await pump(send, 3);
  expect(send).toHaveBeenCalledTimes(4);
  expect(store.decisions().filter((d) => d.tier === "ledger")).toHaveLength(4);
});
it("summary authorization is rechecked after disable/revision/channel edits", async () => {
  const s = signal(1);
  enqueue(s, channels, "signal");
  const m = get<Monitor>(s.monitorId)!;
  put("monitor", m.id, { ...m, enabled: false });
  vi.setSystemTime(at("15:15"));
  const send = fakeSend();
  await drain(send);
  expect(send).not.toHaveBeenCalled();
  expect(store.decisions().every((d) => d.tier === "ledger")).toBe(true);
  const next = signal(1);
  enqueue(next, channels, "signal");
  flushSummaries();
  put("monitor", next.monitorId, {
    ...get<Monitor>(next.monitorId)!,
    revision: "r2",
  });
  await drain(send);
  expect(send).not.toHaveBeenCalled();
  expect(
    list<Delivery>("delivery").every((d) => d.status === "cancelled"),
  ).toBe(true);
});
it("outbox retries/recovery keep the same digest, same quota slot, and never retry outside its window", async () => {
  const s = signal(1);
  enqueue(s, channels, "signal");
  vi.setSystemTime(at("15:15"));
  const send = fakeSend();
  send.mockRejectedValueOnce(new SendError("fake-transient"));
  await drain(send);
  const failed = list<Delivery>("delivery").find(
    (d) => d.status === "pending",
  )!;
  put("delivery", failed.id, { ...failed, status: "sending" });
  recoverDeliveries();
  vi.setSystemTime(at("15:16"));
  await drain(send);
  expect(send).toHaveBeenCalledTimes(5);
  for (const id of channels)
    expect(store.budget(id, Date.now()).ids).toHaveLength(1);
  expect(list<Delivery>("delivery").every((d) => d.status === "sent")).toBe(
    true,
  );
  put("delivery", failed.id, {
    ...get<Delivery>(failed.id)!,
    status: "pending",
    nextAt: at("15:31"),
  });
  vi.setSystemTime(at("15:31"));
  await drain(send);
  expect(send).toHaveBeenCalledTimes(5);
  expect(get<Delivery>(failed.id)?.status).toBe("expired");
});
it("AI cannot bypass suppressed parent tiers or the daily limit", async () => {
  const s = signal(1);
  enqueue(s, channels, "signal");
  enqueue(s, channels, "analysis");
  expect(list<Delivery>("delivery")).toHaveLength(0);
  expect(
    store
      .decisions()
      .filter((d) => d.deliveryId?.endsWith("-analysis"))
      .every((d) => d.tier === "ledger"),
  ).toBe(true);
  configure({ dailyLimit: 2, dedupTradingDays: 0 });
  const high = signal();
  enqueue(high, channels, "signal");
  enqueue(high, channels, "analysis");
  const send = fakeSend();
  await pump(send, 3);
  expect(send).toHaveBeenCalledTimes(4);
  expect(
    list<Delivery>("delivery")
      .filter((d) => d.kind === "analysis")
      .every((d) => d.status === "cancelled"),
  ).toBe(true);
});
it("all native observations remain immutable in the ledger; exact point joins expose filtering and preserve aggregates", () => {
  const ledger = new SignalLedgerStore(sqlite());
  const native: CzscResult = {
    status: "structure",
    hash: "fixture",
    sourceCommit: "b67f3c6",
    families: [
      {
        config: 0,
        points: [],
        centers: [],
        movements: [],
        qualities: [],
        divergences: [],
        signals: [0, 1, 2].map((quality, index) => ({
          index,
          date,
          quality,
          kind: index + 1,
        })),
      },
    ],
  };
  const result = ledgerSignals("sh600519", date, [], native, null, undefined);
  ledger.record("sh600519", date, result.keys, result.signals);
  expect(ledger.rows()).toHaveLength(3);
  const before = sqlite()
    .prepare("SELECT payload FROM signal_ledger ORDER BY id")
    .all();
  const s = signal(2, "sh600519");
  vi.setSystemTime(at("15:05"));
  enqueue(s, channels, "signal");
  ledger.record("sh600519", date, result.keys, result.signals);
  expect(
    sqlite().prepare("SELECT payload FROM signal_ledger ORDER BY id").all(),
  ).toEqual(before);
  const rows = ledger.rows();
  expect(rows.find((r) => r.score === 2)!.notifications).toHaveLength(4);
  expect(
    rows.find((r) => r.score === 0)!.notifications[0]!.reasons.join(),
  ).toContain("无匹配");
  const html = renderToStaticMarkup(
    createElement(SignalLedgerView, { rows, runs: [] }),
  );
  expect(html).toContain("质量分档：立即推送");
  expect(html).toContain("仅入台账不推送");
  expect(html).toContain("非策略业绩");
});
it("real dual-breakout output is graded from its side score without changing the source calculation", async () => {
  const breakout = analyzeBreakout(valid.bars);
  expect(breakout.latest!.long.score).toBe(4);
  const s = signal();
  delete s.czsc;
  s.breakout = breakout;
  s.strategy = strategySchema.parse({ type: "dual-breakout", params: {} });
  put("signal", s.id, s);
  enqueue(s, channels, "signal");
  expect(
    store.decisions().every((d) => d.score === 4 && d.tier === "summary"),
  ).toBe(true);
  vi.setSystemTime(at("15:15"));
  const send = fakeSend();
  await drain(send);
  expect(send).toHaveBeenCalledTimes(4);
  expect(send.mock.calls[0]![1].body).toContain("4/5");
});
it("pending pre-P2 notifications are adopted into the policy before any fake send", async () => {
  configure({ quietOutsideTrading: false, czsc: { confirmed: "immediate" } });
  const s = signal(1);
  enqueue(s, channels, "signal");
  for (const d of list<Delivery>("delivery")) {
    const { policyDecisionIds: _, ...old } = d;
    put("delivery", old.id, old);
  }
  sqlite()
    .prepare("DELETE FROM records WHERE kind='notification-decision'")
    .run();
  configure();
  vi.setSystemTime(at("15:05"));
  const send = fakeSend();
  await drain(send);
  expect(send).not.toHaveBeenCalled();
  expect(store.decisions()).toHaveLength(4);
  expect(store.decisions().every((d) => d.tier === "summary")).toBe(true);
  vi.setSystemTime(at("15:15"));
  await drain(send);
  expect(send).toHaveBeenCalledTimes(4);
});

it("a revoked member is removed from an unsent digest while unrelated subscribed signals still deliver", async () => {
  const a = signal(1),
    b = signal(1);
  enqueue(a, channels, "signal");
  enqueue(b, channels, "signal");
  vi.setSystemTime(at("15:15"));
  flushSummaries();
  put("monitor", a.monitorId, { ...get<Monitor>(a.monitorId)!, channels: [] });
  const send = fakeSend();
  await drain(send);
  expect(send).toHaveBeenCalledTimes(4);
  for (const [, d] of send.mock.calls) {
    expect(d.body).toContain("待关注 1 条");
    expect(d.body).not.toContain(a.symbol);
    expect(d.body).toContain(b.symbol);
  }
  expect(
    store
      .decisions()
      .filter((d) => d.signalId === a.id)
      .every((d) => d.tier === "ledger"),
  ).toBe(true);
});

it("summary claim removes newly duplicated members without dropping unrelated members", async () => {
  configure({ quietOutsideTrading: false });
  const a = signal(1, "sh600519"),
    b = signal(1);
  enqueue(a, channels, "signal");
  enqueue(b, channels, "signal");
  vi.setSystemTime(at("15:15"));
  flushSummaries();
  // Another outbox claimant reserved this direction after digest assembly.
  for (const channelId of channels)
    store.save(
      "notification-history",
      `notification-history:${channelId}:${a.symbol}:czsc:long`,
      { date, deliveryId: "other-claimed" },
    );
  const send = fakeSend();
  await drain(send);
  expect(send).toHaveBeenCalledTimes(4);
  expect(
    send.mock.calls.every(
      ([, d]) => !d.body.includes(a.symbol) && d.body.includes(b.symbol),
    ),
  ).toBe(true);
});

it("queued AI is cancelled when its parent loses eligibility at claim time", async () => {
  const a = signal(2, "sh600519"),
    b = signal(2, "sh600519");
  enqueue(a, channels, "signal");
  enqueue(b, channels, "signal");
  enqueue(b, channels, "analysis");
  const send = fakeSend();
  await pump(send, 4);
  expect(send).toHaveBeenCalledTimes(4);
  expect(
    list<Delivery>("delivery")
      .filter((d) => d.kind === "analysis")
      .every((d) => d.status === "cancelled"),
  ).toBe(true);
});

it("AI can follow a successfully sent immediate signal but uses its own daily slot", async () => {
  const s = signal();
  enqueue(s, channels, "signal");
  const send = fakeSend();
  await drain(send);
  enqueue(s, channels, "analysis");
  await pump(send, 2, Date.now() + 4000);
  expect(send).toHaveBeenCalledTimes(8);
  for (const id of channels)
    expect(store.budget(id, Date.now()).ids).toHaveLength(2);
});

it("a per-channel limit of one sends only its reserved digest", async () => {
  configure({ dailyLimit: 1 });
  const s = signal();
  enqueue(s, channels, "signal");
  const send = fakeSend();
  await drain(send);
  expect(send).not.toHaveBeenCalled();
  vi.setSystemTime(at("15:15"));
  await drain(send);
  expect(send).toHaveBeenCalledTimes(4);
  expect(send.mock.calls.every(([, d]) => d.kind === "summary")).toBe(true);
});

it("notification audit failure cannot roll back native ledger signals or their baseline", () => {
  const ledger = new SignalLedgerStore(sqlite());
  const native: CzscResult = {
    status: "structure",
    hash: "fixture",
    sourceCommit: "b67f3c6",
    families: [
      {
        config: 0,
        points: [],
        centers: [],
        movements: [],
        qualities: [],
        divergences: [],
        signals: [{ index: 0, date, quality: 0, kind: 3 }],
      },
    ],
  };
  const result = ledgerSignals("sh600519", date, [], native, null, undefined);
  const failure = vi
    .spyOn(NotificationPolicyStore.prototype, "auditLedger")
    .mockImplementation(() => {
      throw new Error("controlled policy failure");
    });
  try {
    expect(() =>
      ledger.record("sh600519", date, result.keys, result.signals),
    ).toThrow("controlled policy failure");
    expect(ledger.rows()).toHaveLength(1);
    expect(ledger.baseline("sh600519")?.date).toBe(date);
    expect(ledger.rows()[0]!.notifications[0]!.reasons.join()).toContain(
      "审计失败",
    );
  } finally {
    failure.mockRestore();
  }
});

it("message samples are generated by the real renderers and stay reviewable", () => {
  const high = signal(2, "sh600001");
  enqueue(high, channels.slice(0, 1), "signal");
  const immediate = list<Delivery>("delivery")[0]!.body;
  const middle = signal(1, "sh600002");
  enqueue(middle, channels.slice(0, 1), "signal");
  vi.setSystemTime(at("15:05"));
  const silent = signal(2, "sh600003");
  enqueue(silent, channels.slice(0, 1), "signal");
  const digest = renderSummary(
    date,
    store.decisions().filter((d) => d.tier === "summary"),
  );
  const text = `# P2 消息样本\n\n受控构造数据；实际网络投递数 0。正文来自现有通知渲染器与汇总渲染器，四渠道共用。\n\n## 立即档（交易时段构造例）\n\n\`\`\`text\n${immediate}\n\`\`\`\n\n## 收盘汇总\n\n\`\`\`text\n${digest}\n\`\`\`\n\n## 仅台账例\n\n缠论观察（质量0）：仅入台账不推送；同标的同策略同方向在3个交易日去重窗口内：仅入台账并保留过滤原因。此档没有消息正文。\n\n## B层待用户确认\n\n- 缠论观察仅记账、确认汇总、强质量立即档；双突破5/5立即档、3–4/5汇总、0–2/5仅记账。\n- 每渠道每日5条，预留1条汇总；每条原生点分别计数；同一消息失败重试不重复占逻辑条数，网络不确定仍占额度与去重窗口。\n- 去重3个交易日，包含首次尝试日（第0日），第3个后续交易日恢复；每渠道独立，同策略同方向不区分订阅和点类型。\n- 立即档绕过非交易时段静默，仍受自定义静默、每日限额和去重窗口约束；日线下立即档与汇总档实际相差约10分钟。\n- 汇总15:15–15:30专门放行非交易时段静默，自定义静默优先；错过窗口、汇总封卷后迟到仅记台账，不跨日补推。\n- 汇总按策略/方向/质量列总数；明细超长明确转台账，不拆散推送。确认排版与上述默认值，执行者不代填人工验收。\n`;
  if (process.env.P2_UPDATE_SAMPLES === "1")
    writeFileSync("docs/review/p2-message-samples.md", text);
  expect(readFileSync("docs/review/p2-message-samples.md", "utf8")).toBe(text);
});
