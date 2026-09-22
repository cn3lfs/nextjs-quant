type Waiter = {
  priority: number;
  queuedAt: number;
  signal?: AbortSignal;
  grant: (release: () => void) => void;
  reject: (error: Error) => void;
  abort: () => void;
};
export class PrioritySlots {
  private active = 0;
  private waiting: Waiter[] = [];
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("Invalid concurrency limit");
  }
  acquire(priority = 1, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("任务已取消"));
    return new Promise((grant, reject) => {
      const waiter: Waiter = {
        priority,
        queuedAt: Date.now(),
        signal,
        grant,
        reject,
        abort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) {
            this.waiting.splice(index, 1);
            reject(new Error("任务已取消"));
          }
        },
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }
  private drain() {
    while (this.active < this.limit && this.waiting.length) {
      const now = Date.now();
      // Aging prevents an endless stream of interactive work starving old batches.
      const score = (waiter: Waiter) =>
        waiter.priority + Math.floor((now - waiter.queuedAt) / 30000);
      this.waiting.sort(
        (a, b) => score(b) - score(a) || a.queuedAt - b.queuedAt,
      );
      const waiter = this.waiting.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.abort);
      if (waiter.signal?.aborted) {
        waiter.reject(new Error("任务已取消"));
        continue;
      }
      this.active++;
      let released = false;
      waiter.grant(() => {
        if (released) return;
        released = true;
        this.active--;
        this.drain();
      });
    }
  }
}
