import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsSchema } from "../../src/lib/domain";
import {
  connectionConfiguration,
  type ConnectionCheckInput,
} from "../../src/lib/settings/connection-check";
import { checkConnection } from "../../src/server/market/connection-check";
import { eastmoneyKlines } from "../../src/server/data-sources/eastmoney/eastmoney-adapter";
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, access: vi.fn(fs.access) };
});
vi.mock("../../src/server/data-sources/eastmoney/eastmoney-adapter", () => ({
  eastmoneyKlines: vi.fn(),
}));
vi.mock("../../src/server/data-sources/tstdx/tstdx-adapter", () => ({
  tstdxKlines: vi.fn(() => {
    throw Error("Unexpected fallback");
  }),
}));
vi.mock("../../src/server/data-sources/westock/westock-adapter", () => ({
  westockKlines: vi.fn(() => {
    throw Error("Unexpected fallback");
  }),
}));

describe("read-only connection diagnostics", () => {
  beforeEach(() =>
    vi
      .useFakeTimers({ toFake: ["Date"] })
      .setSystemTime(new Date("2026-09-28T16:00:00+08:00")),
  );
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "connection-check-"));
    const dir = join(root, "vipdoc", "sh", "lday");
    await mkdir(dir, { recursive: true });
    const settings = settingsSchema.parse({
      tdxRoot: root,
      calendar: ["2026-09-25", "2026-09-28"],
    });
    const input: ConnectionCheckInput = {
      source: "local",
      symbol: "sh600000",
      period: "day",
      configuration: connectionConfiguration(settings),
    };
    return { settings, input, path: join(dir, "sh600000.day") };
  }
  function day(date: number) {
    const buffer = Buffer.alloc(32);
    buffer.writeUInt32LE(date);
    for (let field = 1; field <= 4; field++)
      buffer.writeUInt32LE(1000, field * 4);
    buffer.writeFloatLE(10000, 20);
    buffer.writeUInt32LE(1000, 24);
    return buffer;
  }
  it("uses a bounded tail and preserves the source bytes", async () => {
    const { settings, input, path } = await fixture();
    const bytes = Buffer.concat(
      Array.from({ length: 100 }, (_, i) =>
        day(
          Number(
            new Date(Date.UTC(2026, 5, i + 1))
              .toISOString()
              .slice(0, 10)
              .replaceAll("-", ""),
          ),
        ),
      ),
    );
    await writeFile(path, bytes);
    const result = await checkConnection(settings, input);
    expect(result).toMatchObject({
      connection: "ok",
      data: "ok",
      sampleCount: 64,
      freshness: "lagging",
    });
    expect(await readFile(path)).toEqual(bytes);
  });
  it("distinguishes missing directory, missing sample, empty file and corrupt file", async () => {
    const { settings, input, path } = await fixture();
    expect(await checkConnection(settings, input)).toMatchObject({
      connection: "ok",
      data: "unavailable",
    });
    await writeFile(path, Buffer.alloc(0));
    expect(await checkConnection(settings, input)).toMatchObject({
      connection: "ok",
      data: "empty",
      sampleCount: 0,
    });
    await writeFile(path, Buffer.alloc(31));
    expect(await checkConnection(settings, input)).toMatchObject({
      connection: "ok",
      data: "invalid",
    });
    const missing = { ...settings, tdxRoot: join(settings.tdxRoot, "missing") };
    expect(
      await checkConnection(missing, {
        ...input,
        configuration: connectionConfiguration(missing),
      }),
    ).toMatchObject({ connection: "error", data: "unavailable" });
  });
  it("never equates an unavailable calendar with fresh data", async () => {
    const { settings, input, path } = await fixture();
    await writeFile(path, day(20260928));
    expect(await checkConnection(settings, input)).toMatchObject({
      freshness: "aligned",
      dataAsOf: "2026-09-28",
    });
    const unknown = { ...settings, calendar: [] };
    expect(
      await checkConnection(unknown, {
        ...input,
        configuration: connectionConfiguration(unknown),
      }),
    ).toMatchObject({ freshness: "unknown", data: "ok" });
  });
  it("rejects old configuration before accessing the source", async () => {
    const { settings, input } = await fixture();
    await expect(
      checkConnection({ ...settings, tdxRoot: "changed" }, input),
    ).rejects.toThrow("配置已更新");
  });
  it("classifies permission denial without leaking filesystem error details", async () => {
    const { settings, input } = await fixture();
    vi.mocked(access).mockRejectedValueOnce(
      Object.assign(new Error("private-path"), { code: "EACCES" }),
    );
    const result = await checkConnection(settings, input);
    expect(result).toMatchObject({ connection: "error", data: "unavailable" });
    expect(result.message).toContain("权限不足");
    expect(result.message).not.toContain("private-path");
  });
  it("reads the five-minute file with the existing packed-date parser", async () => {
    const { settings, input } = await fixture();
    const dir = join(settings.tdxRoot, "vipdoc", "sh", "fzline");
    await mkdir(dir, { recursive: true });
    const record = Buffer.alloc(32);
    record.writeUInt16LE((2026 - 2004) * 2048 + 928);
    record.writeUInt16LE(15 * 60, 2);
    for (let field = 1; field <= 4; field++) record.writeFloatLE(10, field * 4);
    record.writeFloatLE(1000, 20);
    record.writeUInt32LE(100, 24);
    await writeFile(join(dir, "sh600000.lc5"), record);
    expect(
      await checkConnection(settings, { ...input, period: "5m" }),
    ).toMatchObject({
      data: "ok",
      freshness: "aligned",
      dataAsOf: "2026-09-28T15:00:00+08:00",
    });
  });
  it("sanitizes upstream failures and never changes the selected provider", async () => {
    const { settings, input } = await fixture();
    vi.mocked(eastmoneyKlines).mockRejectedValueOnce(
      Error("https://user:secret@example.com?token=secret"),
    );
    const result = await checkConnection(settings, {
      ...input,
      source: "eastmoney",
    });
    expect(result).toMatchObject({
      source: "eastmoney",
      connection: "unknown",
      data: "unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(eastmoneyKlines).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 64, start: "2026-09-07" }),
      expect.any(AbortSignal),
    );
  });
  it("ends after the deadline and aborts the provider even if it never resolves", async () => {
    const { settings, input } = await fixture();
    vi.useFakeTimers();
    let providerSignal: AbortSignal | undefined;
    vi.mocked(eastmoneyKlines).mockImplementationOnce((_input, signal) => {
      providerSignal = signal;
      return new Promise(() => {});
    });
    const promise = checkConnection(settings, {
      ...input,
      source: "eastmoney",
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(await promise).toMatchObject({
      connection: "unknown",
      data: "unavailable",
      elapsedMs: 10000,
    });
    expect(providerSignal?.aborted).toBe(true);
  });
  it.each([
    {
      message: "empty",
      reason: "empty" as const,
      data: "empty",
      text: "样本为空",
    },
    {
      message: "HTTP 429 secret-token",
      data: "unavailable",
      text: "限制请求频率",
    },
    { message: "HTTP 403 secret-token", data: "unavailable", text: "拒绝访问" },
  ])(
    "distinguishes classified provider result: $text",
    async ({ message, reason, data, text }) => {
      const { settings, input } = await fixture();
      vi.mocked(eastmoneyKlines).mockResolvedValueOnce({
        version: "fixture",
        source: "eastmoney-online",
        period: "day",
        adjustment: "none",
        volumeUnit: "手",
        startedAt: 0,
        completedAt: 0,
        warnings: [],
        items: [
          {
            symbol: input.symbol,
            status: "unavailable",
            message,
            ...(reason ? { reason } : {}),
          },
        ],
      });
      const result = await checkConnection(settings, {
        ...input,
        source: "eastmoney",
      });
      expect(result.data).toBe(data);
      expect(result.message).toContain(text);
      expect(JSON.stringify(result)).not.toContain("secret-token");
    },
  );
});
