import { afterEach, expect, it, vi } from "vitest";
import { ConnectionPool } from "../src/connection-pool";
afterEach(() => vi.useRealTimers());
it("retiring a session preserves its active request and cannot discard its replacement", async () => {
  const first = { close: vi.fn(async () => {}) };
  const second = { close: vi.fn(async () => {}) };
  const pool = new ConnectionPool(
    vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const active = pool.use(async () => {
    entered();
    await gate;
    return 1;
  });
  await ready;
  pool.invalidate(first);
  expect(first.close).not.toHaveBeenCalled();
  expect(await pool.use(async (value) => value)).toBe(second);
  pool.invalidate(first);
  expect(await pool.use(async (value) => value)).toBe(second);
  release();
  await active;
  expect(first.close).toHaveBeenCalledTimes(1);
  await pool.close();
});
it("a disconnected transport is replaced without invalidating a newer connection", async () => {
  const first = { close: vi.fn(async () => {}) };
  const second = { close: vi.fn(async () => {}) };
  const connect = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second);
  const pool = new ConnectionPool(connect);
  expect(await pool.use(async (value) => value)).toBe(first);
  pool.disconnected(first);
  expect(await pool.use(async (value) => value)).toBe(second);
  pool.disconnected(first);
  expect(await pool.use(async (value) => value)).toBe(second);
  expect(connect).toHaveBeenCalledTimes(2);
  await pool.close();
});
it("concurrent callers share one connection and idle cleanup waits for requests", async () => {
  vi.useFakeTimers();
  const close = vi.fn(async () => {});
  const connect = vi.fn(async () => ({ close }));
  const pool = new ConnectionPool(connect, 100);
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const first = pool.use(async () => {
    await waiting;
    return 1;
  });
  expect(await pool.use(async () => 2)).toBe(2);
  await vi.advanceTimersByTimeAsync(200);
  expect(close).not.toHaveBeenCalled();
  finish();
  expect(await first).toBe(1);
  expect(connect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(close).toHaveBeenCalledTimes(1);
  await pool.use(async () => 3);
  expect(connect).toHaveBeenCalledTimes(2);
  await pool.close();
});
it("failed connection is discarded, callback failure is never replayed", async () => {
  const connect = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ close: vi.fn(async () => {}) });
  const pool = new ConnectionPool(connect);
  const callback = vi.fn(async () => {
    throw new Error("invalid parameter");
  });
  await expect(pool.use(callback)).rejects.toThrow("offline");
  await expect(pool.use(callback)).rejects.toThrow("invalid parameter");
  expect(callback).toHaveBeenCalledTimes(1);
  expect(connect).toHaveBeenCalledTimes(2);
  await pool.close();
});
