import { sqlite } from "./index";

/** Synchronous read transaction; an iterator must never outlive this callback. */
export function readSnapshot<T>(read: () => T): T {
  const db = sqlite();
  return db.transaction(() => {
    const readOnly = db.pragma("query_only", { simple: true });
    db.pragma("query_only = ON");
    try {
      const result = read();
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw new Error("数据库快照必须同步读取");
      return result;
    } finally {
      db.pragma(`query_only = ${readOnly ? "ON" : "OFF"}`);
    }
  })();
}
