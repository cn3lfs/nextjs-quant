import type Database from "better-sqlite3";
import {
  rpsPolicy,
  type RpsDay,
  type RpsProgress,
  type RpsRow,
} from "~/lib/rps";

// One vector per security/day, NOT one row per period/value. Return and average rank
// use float64; RPS is reconstructed from the day's immutable period denominators.
function encode(row: RpsRow) {
  const bytes = Buffer.alloc(row.values.length * 16);
  row.values.forEach((v, i) => {
    bytes.writeDoubleLE(v?.return ?? NaN, i * 16);
    bytes.writeDoubleLE(v?.rank ?? NaN, i * 16 + 8);
  });
  return bytes;
}
function decode(symbol: string, bytes: Buffer, day: RpsDay): RpsRow {
  if (bytes.length !== day.periods.length * 16) throw new Error("RPS向量损坏");
  return {
    symbol,
    values: day.periods.map((_, i) => {
      const value = bytes.readDoubleLE(i * 16),
        rank = bytes.readDoubleLE(i * 16 + 8);
      return Number.isNaN(value)
        ? null
        : { return: value, rank, rps: (1 - rank / day.counts[i]!) * 100 };
    }),
  };
}
export class RpsStore {
  constructor(private db: Database.Database) {}
  day(date: string) {
    const row = this.db
      .prepare("SELECT payload FROM rps_days WHERE date=?")
      .get(date) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as RpsDay) : null;
  }
  latest() {
    const row = this.db
      .prepare("SELECT payload FROM rps_days ORDER BY date DESC LIMIT 1")
      .get() as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as RpsDay) : null;
  }
  progress() {
    // Lease recovery also runs on reads, so an abandoned worker never appears live forever.
    this.db
      .prepare(
        "UPDATE rps_job SET payload=json_set(payload,'$.status','failed','$.error','任务异常退出或租约超时'), lease_until=0 WHERE lease_until>0 AND lease_until<?",
      )
      .run(Date.now());
    const row = this.db
      .prepare("SELECT payload FROM rps_job WHERE singleton=1")
      .get() as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as RpsProgress) : null;
  }
  claim(progress: RpsProgress) {
    this.progress();
    return (
      this.db
        .prepare(
          "INSERT INTO rps_job(singleton,id,payload,cancelled,lease_until) VALUES(1,?,?,0,?) ON CONFLICT(singleton) DO UPDATE SET id=excluded.id,payload=excluded.payload,cancelled=0,lease_until=excluded.lease_until WHERE rps_job.lease_until=0",
        )
        .run(progress.id, JSON.stringify(progress), Date.now() + 120000)
        .changes === 1
    );
  }
  checkpoint(progress: RpsProgress) {
    const row = this.db
      .prepare("SELECT cancelled,lease_until FROM rps_job WHERE id=?")
      .get(progress.id) as
      { cancelled: number; lease_until: number } | undefined;
    if (!row || row.lease_until < Date.now())
      throw new Error("RPS任务租约已失效");
    if (row.cancelled) throw new Error("rps-cancelled");
    progress.updatedAt = Date.now();
    this.db
      .prepare("UPDATE rps_job SET payload=?,lease_until=? WHERE id=?")
      .run(JSON.stringify(progress), Date.now() + 120000, progress.id);
  }
  finish(progress: RpsProgress) {
    this.db
      .prepare("UPDATE rps_job SET payload=?,lease_until=0 WHERE id=?")
      .run(JSON.stringify(progress), progress.id);
  }
  cancel() {
    this.db
      .prepare(
        "UPDATE rps_job SET cancelled=1 WHERE singleton=1 AND lease_until>0",
      )
      .run();
  }
  saveDay(day: RpsDay, rows: RpsRow[], guard: () => void = () => {}) {
    if (rows.length > rpsPolicy.maxSymbols || day.total > rpsPolicy.maxSymbols)
      throw new Error("RPS证券数超出存储上限");
    if (rows.some((r) => r.values.length !== day.periods.length))
      throw new Error("RPS向量长度不匹配");
    return this.db
      .transaction(() => {
        guard();
        if (this.day(day.date)) return false;
        this.db
          .prepare("INSERT INTO rps_days VALUES(?,?)")
          .run(day.date, JSON.stringify(day));
        const insert = this.db.prepare("INSERT INTO rps_values VALUES(?,?,?)");
        for (const row of rows) insert.run(row.symbol, day.date, encode(row));
        // Retention and publication are one transaction: cleanup failure rolls both back.
        const obsolete = this.db
          .prepare(
            "SELECT date FROM rps_days ORDER BY date DESC LIMIT -1 OFFSET ?",
          )
          .all(rpsPolicy.retentionDays) as { date: string }[];
        for (const { date } of obsolete) {
          this.db.prepare("DELETE FROM rps_values WHERE date=?").run(date);
          this.db.prepare("DELETE FROM rps_days WHERE date=?").run(date);
        }
        guard();
        return true;
      })
      .immediate();
  }
  ranking(date: string, period: number) {
    const day = this.day(date);
    if (!day) return [];
    const index = day.periods.indexOf(period);
    if (index < 0) throw new Error("未存储该RPS周期");
    return (
      this.db
        .prepare("SELECT symbol,values_blob FROM rps_values WHERE date=?")
        .all(date) as { symbol: string; values_blob: Buffer }[]
    )
      .flatMap((r) => {
        const value = decode(r.symbol, r.values_blob, day).values[index];
        return value ? [{ symbol: r.symbol, ...value }] : [];
      })
      .sort((a, b) => a.rank - b.rank || a.symbol.localeCompare(b.symbol));
  }
  curve(symbol: string) {
    if (
      !this.db
        .prepare("SELECT 1 FROM rps_values WHERE symbol=? LIMIT 1")
        .get(symbol)
    )
      return [];
    return (
      this.db
        .prepare(
          "SELECT v.values_blob,d.payload FROM rps_days d LEFT JOIN rps_values v ON v.date=d.date AND v.symbol=? ORDER BY d.date",
        )
        .all(symbol) as { values_blob: Buffer | null; payload: string }[]
    ).map((r) => {
      const day = JSON.parse(r.payload) as RpsDay;
      return {
        date: day.date,
        mode: day.mode,
        periods: day.periods,
        counts: day.counts,
        policy: day.policy,
        pool: day.pool,
        inputHash: day.inputHash,
        values: r.values_blob
          ? decode(symbol, r.values_blob, day).values
          : day.periods.map(() => null),
      };
    });
  }
}
