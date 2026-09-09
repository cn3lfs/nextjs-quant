import { expect, it, vi } from "vitest";
import { sharedRead } from "../src/server/shared-read";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
it("isolates keys and callers while sharing a single in-flight read", async () => {
  const read = sharedRead<number>(),
    a = deferred<number>(),
    b = deferred<number>();
  let upstream!: AbortSignal;
  const load = vi.fn((signal: AbortSignal) => {
    upstream = signal;
    return a.promise;
  });
  const controller = new AbortController();
  const first = read("September", load, controller.signal),
    failure = expect(first).rejects.toThrow();
  const second = read("September", load),
    other = read("October", () => b.promise);
  controller.abort();
  await failure;
  expect(upstream.aborted).toBe(false);
  a.resolve(9);
  b.resolve(10);
  expect(await second).toBe(9);
  expect(await other).toBe(10);
  expect(load).toHaveBeenCalledOnce();
});
it("aborts the last abandoned read and does not let its late completion erase a replacement", async () => {
  const read = sharedRead<number>(),
    old = deferred<number>(),
    next = deferred<number>();
  let upstream!: AbortSignal;
  const controller = new AbortController();
  const first = read(
    "key",
    (signal) => {
      upstream = signal;
      return old.promise;
    },
    controller.signal,
  );
  const failure = expect(first).rejects.toThrow();
  controller.abort();
  await failure;
  expect(upstream.aborted).toBe(true);
  const replacement = vi.fn(() => next.promise);
  const second = read("key", replacement);
  old.resolve(1);
  await Promise.resolve();
  const third = read("key", replacement);
  next.resolve(2);
  expect(await second).toBe(2);
  expect(await third).toBe(2);
  expect(replacement).toHaveBeenCalledOnce();
});
it("releases failed reads for retry and rejects pre-cancelled calls without starting work", async () => {
  const read = sharedRead<number>(),
    load = vi.fn(async () => {
      throw new Error("source failed");
    });
  await expect(read("key", load)).rejects.toThrow("source failed");
  expect(await read("key", async () => 3)).toBe(3);
  const controller = new AbortController();
  controller.abort();
  expect(() => read("key", load, controller.signal)).toThrow();
  expect(load).toHaveBeenCalledOnce();
});
