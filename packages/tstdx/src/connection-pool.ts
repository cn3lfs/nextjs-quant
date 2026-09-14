/** One shared connection; active requests never lose their transport to idle cleanup. */
export class ConnectionPool<T extends { close(): Promise<void> }> {
  private pending?: Promise<T>;
  private connection?: T;
  private active = 0;
  private users = new Map<T, number>();
  private retired = new Set<T>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly connect: () => Promise<T>,
    private readonly idleMs = 120000,
  ) {}

  async use<R>(fn: (connection: T) => Promise<R>): Promise<R> {
    clearTimeout(this.timer);
    this.active++;
    let used: T | undefined;
    try {
      const pending = (this.pending ??= this.connect());
      let connection: T;
      try {
        connection = await pending;
        if (this.pending === pending) this.connection = connection;
      } catch (error) {
        if (this.pending === pending) this.pending = undefined;
        throw error;
      }
      used = connection;
      this.users.set(connection, (this.users.get(connection) ?? 0) + 1);
      return await fn(connection);
    } finally {
      if (used) {
        const remaining = (this.users.get(used) ?? 1) - 1;
        if (remaining) this.users.set(used, remaining);
        else {
          this.users.delete(used);
          if (this.retired.delete(used)) void used.close().catch(() => {});
        }
      }
      if (--this.active === 0) {
        this.timer = setTimeout(() => {
          void this.close();
        }, this.idleMs);
        this.timer.unref?.();
      }
    }
  }

  disconnected(connection: T) {
    if (this.connection === connection) {
      this.pending = undefined;
      this.connection = undefined;
    }
  }

  /** Stop handing out a failed session; let other active requests finish. */
  invalidate(connection: T) {
    this.disconnected(connection);
    if (this.users.has(connection)) this.retired.add(connection);
    else void connection.close().catch(() => {});
  }

  async close() {
    clearTimeout(this.timer);
    const pending = this.pending;
    this.pending = undefined;
    this.connection = undefined;
    await pending?.then((connection) => connection.close()).catch(() => {});
  }
}
