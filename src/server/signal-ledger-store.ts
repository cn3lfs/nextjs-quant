import type Database from "better-sqlite3";
import type { LedgerSignal, LedgerRow, Outcome } from "~/lib/signal-ledger";

export type LedgerRun = {
  date: string;
  status: "running" | "complete" | "partial" | "failed";
  total: number;
  scanned: number;
  signals: number;
  elapsedMs: number;
  errors: { symbol: string; reason: string }[];
  calendarSource: string;
};
export class SignalLedgerStore {
  constructor(readonly db: Database.Database) {}
  run(date: string): LedgerRun | undefined {
    return this.read(
      "SELECT payload FROM signal_ledger_runs WHERE date=?",
      date,
    );
  }
  saveRun(run: LedgerRun) {
    this.db
      .prepare(
        "INSERT INTO signal_ledger_runs VALUES (?,?) ON CONFLICT(date) DO UPDATE SET payload=excluded.payload",
      )
      .run(run.date, JSON.stringify(run));
  }
  baseline(symbol: string): { date: string; keys: string[] } | undefined {
    return this.read(
      "SELECT payload FROM signal_ledger_baselines WHERE symbol=?",
      symbol,
    );
  }
  record(
    symbol: string,
    date: string,
    keys: string[],
    signals: LedgerSignal[],
  ) {
    this.db.transaction(() => {
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO signal_ledger VALUES (?,?,?,?)",
      );
      for (const s of signals)
        insert.run(s.id, s.symbol, s.observedDate, JSON.stringify(s));
      this.db
        .prepare(
          "INSERT INTO signal_ledger_baselines VALUES (?,?) ON CONFLICT(symbol) DO UPDATE SET payload=excluded.payload",
        )
        .run(symbol, JSON.stringify({ date, keys }));
    })();
  }
  outcome(id: string, out: Outcome) {
    this.db
      .prepare(
        `INSERT INTO signal_ledger_outcomes VALUES (?,?,?,?)
      ON CONFLICT(signal_id,horizon) DO UPDATE SET settled=excluded.settled,payload=excluded.payload
      WHERE signal_ledger_outcomes.settled=0 AND signal_ledger_outcomes.payload<>excluded.payload`,
      )
      .run(id, out.horizon, Number(out.settled), JSON.stringify(out));
  }
  rows(): LedgerRow[] {
    const outcomes = new Map<string, Outcome[]>();
    for (const row of this.db
      .prepare(
        "SELECT signal_id,payload FROM signal_ledger_outcomes ORDER BY horizon",
      )
      .all() as { signal_id: string; payload: string }[]) {
      const values = outcomes.get(row.signal_id) ?? [];
      values.push(JSON.parse(row.payload) as Outcome);
      outcomes.set(row.signal_id, values);
    }
    return (
      this.db
        .prepare(
          "SELECT payload FROM signal_ledger ORDER BY observed_date DESC,symbol,id",
        )
        .all() as { payload: string }[]
    ).map((r) => {
      const s = JSON.parse(r.payload) as LedgerSignal;
      return { ...s, outcomes: outcomes.get(s.id) ?? [] };
    });
  }
  runs(): LedgerRun[] {
    return (
      this.db
        .prepare(
          "SELECT payload FROM signal_ledger_runs ORDER BY date DESC LIMIT 30",
        )
        .all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as LedgerRun);
  }
  private read<T>(sql: string, value: string): T | undefined {
    const row = this.db.prepare(sql).get(value) as
      { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : undefined;
  }
}
