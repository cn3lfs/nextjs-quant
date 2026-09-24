import { PrioritySlots } from "./priority-slots";

/**
 * Serial request gate for sources that ban bursty clients (Eastmoney bans an
 * IP for hours after sustained parallel scans). Callers run one at a time,
 * spaced by `minIntervalMs` plus random jitter, and never more than
 * `perMinute` starts inside any rolling minute.
 */
export type RateGateOptions = {
  minIntervalMs: number;
  jitterMs?: number;
  perMinute?: number;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
};

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("任务已取消"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("任务已取消"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

export function rateGate(options: RateGateOptions) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const slots = new PrioritySlots(1);
  const starts: number[] = [];
  let last = -Infinity;
  return async <T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
    priority = 1,
  ): Promise<T> => {
    const release = await slots.acquire(priority, signal);
    try {
      const jitter = random() * (options.jitterMs ?? 0);
      for (;;) {
        const at = now();
        while (starts.length && at - starts[0]! >= 60000) starts.shift();
        const spacing = last + options.minIntervalMs + jitter;
        const window =
          options.perMinute && starts.length >= options.perMinute
            ? starts[0]! + 60000
            : -Infinity;
        const wait = Math.max(spacing, window) - at;
        if (wait <= 0) break;
        await sleep(wait, signal);
      }
      last = now();
      starts.push(last);
      return await task();
    } finally {
      release();
    }
  };
}
