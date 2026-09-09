import { expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCaller } from "../src/server/api/root";
import { strategySchema } from "../src/lib/domain";
import { get, put } from "../src/server/db";
import type { Monitor } from "../src/lib/domain";
process.env.QUANT_DATA_DIR = mkdtempSync(
  join(tmpdir(), "quant-monitor-revision-"),
);
it("saving twice at the same millisecond and toggling assigns distinct run versions", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  try {
    const caller = createCaller({ headers: new Headers() });
    const input = {
      id: "test-revision",
      name: "fixture",
      symbols: ["sh600519"],
      strategy: strategySchema.parse({}),
      period: "day" as const,
      source: "local" as const,
      channels: [],
      ai: false,
      enabled: false,
    };
    const first = await caller.saveMonitor(input);
    const second = await caller.saveMonitor(input);
    expect(second.createdAt).toBe(first.createdAt);
    expect(first.revision).toMatch(/^[a-f0-9-]{36}$/);
    expect(second.revision).not.toBe(first.revision);
    put("monitor", second.id, {
      ...second,
      states: { sh600519: { date: "2026-09-09", matched: true } },
    });
    const enabled = await caller.toggleMonitor({
      id: second.id,
      enabled: true,
    });
    const disabled = await caller.toggleMonitor({
      id: second.id,
      enabled: false,
    });
    expect(
      new Set([
        first.revision,
        second.revision,
        enabled.revision,
        disabled.revision,
      ]).size,
    ).toBe(4);
    expect(disabled.createdAt).toBe(first.createdAt);
    expect(disabled.states).toEqual({});
    expect(get<Monitor>(second.id)?.enabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("manual resend creates a separate explicit action without reusing old delivery diagnostics", async () => {
  put("delivery", "cancelled-fixture", {
    id: "cancelled-fixture",
    signalId: "old-signal",
    channelId: "no-real-channel",
    kind: "signal",
    status: "cancelled",
    title: "fixture",
    body: "历史样本",
    attempts: 2,
    createdAt: 1,
    expiresAt: 1,
    nextAt: 1,
    remoteId: "old-remote",
    error: "旧订阅已停用",
  });
  const caller = createCaller({ headers: new Headers() });
  const retry = await caller.retryDelivery("cancelled-fixture");
  expect(retry.manualRetry).toBe(true);
  expect(retry.id).not.toBe("cancelled-fixture");
  expect(retry.body).toBe("【手动重发历史通知】\n历史样本");
  expect(retry.status).toBe("pending");
  expect(retry.remoteId).toBeUndefined();
  expect(retry.error).toBeUndefined();
  expect(get<{ status: string }>("cancelled-fixture")?.status).toBe(
    "cancelled",
  );
});
