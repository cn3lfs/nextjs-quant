import { randomUUID } from "node:crypto";
import { sqlite } from "../db";

/** A shared SQLite lease covers desktop and headless processes. */
export function claimWorkflow(key: string, duration = 15 * 60000) {
  const db = sqlite(),
    id = `workflow-lease-${key}`,
    owner = randomUUID(),
    now = Date.now();
  const payload = JSON.stringify({ owner, leaseUntil: now + duration });
  const claimed = db
    .prepare(
      `INSERT INTO records(id,kind,payload,updated_at) VALUES(?,'workflow-lease',?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at WHERE json_extract(records.payload,'$.leaseUntil') < ?`,
    )
    .run(id, payload, now, now).changes;
  if (!claimed) return null;
  const renew = () =>
    db
      .prepare(
        `UPDATE records SET payload=json_set(payload,'$.leaseUntil',?),updated_at=? WHERE id=? AND json_extract(payload,'$.owner')=?`,
      )
      .run(Date.now() + duration, Date.now(), id, owner).changes === 1;
  const timer = setInterval(renew, 30000);
  timer.unref();
  return {
    assert() {
      if (!renew()) throw new Error("后台任务租约已失效");
    },
    release() {
      clearInterval(timer);
      db.prepare(
        `DELETE FROM records WHERE id=? AND json_extract(payload,'$.owner')=?`,
      ).run(id, owner);
    },
  };
}
