import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const mocks = vi.hoisted(() => ({ secret: vi.fn(), fetch: vi.fn() }));
vi.mock("../src/server/vault", () => ({
  readSecret: mocks.secret,
  saveSecret: vi.fn(),
}));
vi.mock("undici", () => ({
  fetch: mocks.fetch,
  ProxyAgent: class {
    async close() {}
  },
}));
import { get, put, sqlite } from "../src/server/db";
import {
  drain,
  enqueue,
  recoverDeliveries,
} from "../src/server/infra/notifications";
import {
  strategySchema,
  type Monitor,
  type Signal,
  type Delivery,
} from "../src/lib/domain";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-outbox-run-"));
let monitor: Monitor, signal: Signal;
beforeEach(() => {
  mocks.secret.mockReset();
  mocks.fetch.mockReset();
  sqlite().prepare("DELETE FROM records").run();
  const id = `channel-${crypto.randomUUID()}`;
  monitor = {
    id: "monitor-fixture",
    revision: "run-1",
    name: "fixture",
    createdAt: 1,
    enabled: true,
    ai: true,
    symbols: ["sh600519"],
    period: "day",
    source: "local",
    channels: [id],
    states: {},
    strategy: strategySchema.parse({}),
  };
  signal = {
    id: "signal-fixture",
    monitorId: monitor.id,
    monitorRun: { createdAt: 1, revision: "run-1" },
    symbol: "sh600519",
    strategy: monitor.strategy,
    period: "day",
    date: "2026-09-09",
    createdAt: Date.now(),
    expiresAt: Date.now() + 600000,
    snapshotId: "fixture",
    source: "fixture",
    metrics: {
      close: 1,
      fast: 1,
      slow: 1,
      change: 0,
      volumeRatio: 1,
      matched: true,
      score: 1,
      date: "2026-09-09",
    },
  };
  put("monitor", monitor.id, monitor);
  put("signal", signal.id, signal);
  put("channel", id, {
    id,
    type: "telegram",
    name: "fixture",
    enabled: true,
    configured: true,
    target: "fixture",
  });
  enqueue(signal, [id], "signal");
});
function item() {
  const row = sqlite()
    .prepare("SELECT payload FROM records WHERE kind='delivery'")
    .get() as { payload: string };
  return JSON.parse(row.payload) as Delivery;
}
it("does not send queued signals after disabling the subscription", async () => {
  put("monitor", monitor.id, { ...monitor, enabled: false });
  const send = vi.fn(async () => "not-real");
  await drain(send);
  expect(send).not.toHaveBeenCalled();
  expect(item().status).toBe("cancelled");
  expect(item().attempts).toBe(0);
});
it("does not send the old queue after a subscription restarts", async () => {
  put("monitor", monitor.id, { ...monitor, revision: "run-2" });
  const send = vi.fn(async () => "not-real");
  await drain(send);
  expect(send).not.toHaveBeenCalled();
  expect(item().status).toBe("cancelled");
});

it("sends once when the originating subscription is still valid", async () => {
  const send = vi.fn(async () => "not-real");
  await drain(send);
  await drain(send);
  expect(send).toHaveBeenCalledOnce();
  expect(item().status).toBe("sent");
});
it.each(["channel", "symbol", "analysis", "legacy"])(
  "cancels an automatic notice whose %s authorization no longer matches",
  async (change) => {
    if (change === "channel")
      put("monitor", monitor.id, { ...monitor, channels: [] });
    if (change === "symbol")
      put("monitor", monitor.id, { ...monitor, symbols: [] });
    if (change === "analysis") {
      put("monitor", monitor.id, { ...monitor, ai: false });
      put("delivery", item().id, { ...item(), kind: "analysis" });
    }
    if (change === "legacy") {
      const { monitorRun: _, ...legacy } = signal;
      put("signal", signal.id, legacy);
    }
    const send = vi.fn(async () => "not-real");
    await drain(send);
    expect(send).not.toHaveBeenCalled();
    expect(item().status).toBe("cancelled");
  },
);
it("cancels a backoff retry after restart without another sending attempt", async () => {
  const send = vi.fn(async () => {
    throw new Error("network");
  });
  await drain(send);
  expect(item().status).toBe("pending");
  put("monitor", monitor.id, { ...monitor, revision: "run-2" });
  await drain(send);
  expect(send).toHaveBeenCalledOnce();
  expect(item().status).toBe("cancelled");
  expect(item().attempts).toBe(1);
});
it("does not recover an old subscription's interrupted send into a retry", () => {
  put("delivery", item().id, { ...item(), status: "sending", attempts: 1 });
  put("monitor", monitor.id, { ...monitor, enabled: false });
  recoverDeliveries();
  expect(item().status).toBe("cancelled");
  expect(item().attempts).toBe(1);
});
it.each(["test", "manual"])(
  "preserves the separate explicit %s action",
  async (kind) => {
    put("monitor", monitor.id, { ...monitor, enabled: false });
    put("delivery", item().id, {
      ...item(),
      ...(kind === "test" ? { kind: "test" } : { manualRetry: true }),
    });
    const send = vi.fn(async () => "not-real");
    await drain(send);
    expect(send).toHaveBeenCalledOnce();
    expect(item().status).toBe("sent");
  },
);
it.each(["revision", "channel"])(
  "rechecks %s after awaiting credentials and before HTTP",
  async (change) => {
    mocks.secret.mockImplementationOnce(async () => {
      if (change === "revision")
        put("monitor", monitor.id, { ...monitor, revision: "run-2" });
      else {
        const channel = get<object>(monitor.channels[0]!)!;
        put("channel", monitor.channels[0]!, { ...channel, enabled: false });
      }
      return { secret: "fixture-only" };
    });
    await drain();
    expect(mocks.secret).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(item().status).toBe("cancelled");
  },
);
