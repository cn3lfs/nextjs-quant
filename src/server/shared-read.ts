export function sharedRead<T>() {
  type Flight = {
    controller: AbortController;
    promise: Promise<T>;
    users: number;
  };
  const pending = new Map<string, Flight>();
  return (
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    signal?.throwIfAborted();
    let flight = pending.get(key);
    if (!flight) {
      const controller = new AbortController();
      flight = { controller, promise: load(controller.signal), users: 0 };
      pending.set(key, flight);
      const current = flight;
      const clear = () => {
        if (pending.get(key) === current) pending.delete(key);
      };
      void flight.promise.then(clear, clear);
    }
    const current = flight;
    current.users++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = () => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (--current.users === 0 && pending.get(key) === current) {
          pending.delete(key);
          current.controller.abort();
        }
        return true;
      };
      const abort = () => {
        if (release()) reject(signal?.reason ?? new Error("任务已取消"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      void current.promise.then(
        (value) => {
          if (release()) resolve(value);
        },
        (error) => {
          if (release()) reject(error);
        },
      );
    });
  };
}
