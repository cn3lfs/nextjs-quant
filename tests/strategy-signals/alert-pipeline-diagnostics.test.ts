import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { strategyObjectSchema } from "trading-strategies";
import type { Delivery } from "~/lib/domain";
import { alertKey, type AlertEvent } from "~/lib/strategy-facts/alerts";
import { AlertRepository } from "~/server/db/alert-repository";
import { migrate } from "~/server/db/migrations";
import { readAlertPipeline } from "~/server/infra/alert-pipeline-diagnostics";

const outboundFetch = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Unexpected external request");
  }),
);
// The delivery worker imports undici directly, bypassing global fetch.
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: outboundFetch,
}));

const bar = "2026-11-19";
const now = Date.parse(`${bar}T16:00:00+08:00`);
const strategy = strategyObjectSchema.parse({
  id: "pipeline-diagnostics",
  version: 2,
  market: "cn-equity",
  period: "day",
  sleeve: "swing",
  universe: { kind: "symbols", symbols: ["sh600000"] },
  entry: { kind: "constant", value: true },
  exit: {},
  sizing: { kind: "weight", weight: 0.1 },
});
const subscriptionId = "pipeline-subscription";
const channelId = "pipeline-channel";
const deliveryHref = "/system/notifications?monitorTab=deliveries";
const readiness = {
  ready: true,
  expectedDate: bar,
  closeStatus: "complete",
  scanAt: now,
};
const event: AlertEvent = {
  key: "",
  strategyId: strategy.id,
  version: strategy.version,
  market: strategy.market,
  symbol: "sh600000",
  bar,
  type: "entry",
  price: 12,
  stop: 11,
  target: null,
  observedAt: now,
  mode: "live",
  status: "live",
  reason: "fixture",
  source: "fixture",
  sleeve: "swing",
  wouldSend: true,
  outcomes: [],
};
event.key = alertKey(event);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const signalId = `alert-${hash(event.key + subscriptionId)}`;
const deliveryId = `delivery-alert-${hash(signalId + channelId)}`;

let repo: AlertRepository;
beforeEach(() => {
  outboundFetch.mockClear();
  vi.stubGlobal("fetch", outboundFetch);
  const db = new Database(":memory:");
  migrate(db);
  repo = new AlertRepository(db);
});
afterEach(() => {
  repo.db.close();
  vi.unstubAllGlobals();
  expect(outboundFetch).toHaveBeenCalledTimes(0);
});

function seedPipeline({
  trigger = true,
  matchSubscription = true,
  authorizeVersion = true,
  configuredChannel = true,
  receipt,
}: {
  trigger?: boolean;
  matchSubscription?: boolean;
  authorizeVersion?: boolean;
  configuredChannel?: boolean;
  receipt?: Pick<Delivery, "status" | "attempts" | "error">;
} = {}) {
  if (trigger) repo.record(strategy, event);
  repo.records.save(
    "alert-subscription",
    `alert-subscription:${subscriptionId}`,
    {
      id: subscriptionId,
      revision: "fixture",
      enabled: true,
      market: "cn-equity",
      kinds: ["entry"],
      symbols: matchSubscription ? [event.symbol] : ["sz000001"],
      strategyIds: [strategy.id],
      channels: [channelId],
    },
  );
  // A previous version's permission must never authorize this entry event.
  repo.saveState(`strategy:${strategy.id}:1`, { live: true });
  if (authorizeVersion)
    repo.saveState(`strategy:${strategy.id}:2`, { live: true });
  repo.records.save("channel", channelId, {
    id: channelId,
    enabled: true,
    configured: configuredChannel,
  });
  if (receipt)
    repo.records.save("delivery", deliveryId, {
      id: deliveryId,
      alertKey: event.key,
      channelId,
      createdAt: now,
      nextAt: now + 1000,
      ...receipt,
    });
}

function inspect(key = event.key) {
  repo.db.pragma("query_only=ON");
  return readAlertPipeline(repo, "live", readiness, now, key);
}

it.each([
  {
    stage: 1,
    fixture: { trigger: false },
    reason: "未找到指定提醒事件",
    fixHref: "/scan",
    fixLabel: "查看扫描",
  },
  {
    stage: 2,
    fixture: {},
    reason: "尚无该事件的推送队列记录",
    fixHref: deliveryHref,
    fixLabel: "查看队列",
  },
  {
    stage: 3,
    fixture: { matchSubscription: false },
    reason: "启用订阅未匹配本事件",
    fixHref: "/system",
    fixLabel: "设置订阅",
  },
  {
    stage: 4,
    fixture: { authorizeVersion: false },
    reason: "该策略版本尚未授权 live 提醒",
    fixHref: "/lab",
    fixLabel: "核对策略授权",
  },
  {
    stage: 5,
    fixture: { configuredChannel: false },
    reason: "匹配订阅没有已启用且已配置的渠道",
    fixHref: "/system",
    fixLabel: "检查渠道与投递",
  },
  {
    stage: 5,
    fixture: { receipt: { status: "pending", attempts: 1 } },
    reason: "渠道投递失败，正在等待重试",
    fixHref: deliveryHref,
    fixLabel: "检查渠道与投递",
  },
  {
    stage: 6,
    fixture: {
      receipt: {
        status: "failed",
        attempts: 1,
        error: "渠道拒绝请求 (403) private-detail",
      },
    },
    reason: "1 条投递失败、过期或取消：渠道拒绝请求 (403)",
    fixHref: deliveryHref,
    fixLabel: "查看投递回执",
  },
] satisfies (NonNullable<ReturnType<typeof inspect>["primaryBlocker"]> & {
  fixture: Parameters<typeof seedPipeline>[0];
})[])(
  "attributes stage $stage to $reason and offers the matching repair link",
  ({ fixture, ...blocker }) => {
    seedPipeline(fixture);
    // A successful receipt written under a different event cannot unblock this one.
    repo.records.save("delivery", "unrelated", {
      id: "unrelated",
      alertKey: "different-event",
      status: "sent",
    });
    const result = inspect();
    expect(result.primaryBlocker).toEqual(blocker);
    expect(
      result.stages.find((stage) => stage.stage === blocker.stage)?.passed,
    ).toBe(false);
    expect(result.evidence.lastSuccess).toBeNull();
  },
);

it("reports a correlated sent receipt with all six stages passed and no blocker", () => {
  seedPipeline({ receipt: { status: "sent", attempts: 1 } });
  const result = inspect();
  expect(
    result.stages.map(({ stage, label, passed }) => [stage, label, passed]),
  ).toEqual([
    [1, "触发", true],
    [2, "入队", true],
    [3, "订阅", true],
    [4, "资格", true],
    [5, "投递", true],
    [6, "回执", true],
  ]);
  expect(result.primaryBlocker).toBeNull();
  expect(result.evidence.lastSuccess).toMatchObject({
    id: deliveryId,
    channelId,
    status: "sent",
    attempts: 1,
  });
  expect(result.evidence.lastFailure).toBeNull();
  expect(result.evidence.deliveries.map(({ id }) => id)).toEqual([deliveryId]);
});
