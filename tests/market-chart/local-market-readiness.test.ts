import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrate } from "../../src/server/db/migrations";
import {
  localRpsDependencies,
  runRpsJob,
} from "../../src/server/screening/rps-job";
import { RpsStore } from "../../src/server/screening/rps-store";
import { rpsProgress } from "../rps-fixture";
import { scan } from "../../src/server/data-sources/tdx/tdx";

it.skipIf(!process.env.QUANT_TDX_AUDIT_ROOT)(
  "real local stock names cover every daily file without excluding instruments",
  async () => {
    const data = await scan(process.env.QUANT_TDX_AUDIT_ROOT!);
    const rows = data.securities.filter(
      (row) => row.period === "day" && /^(sh|sz)/.test(row.symbol),
    );
    expect(rows.length).toBeGreaterThan(5000);
    expect(
      rows
        .filter((row) => !row.name || row.name === row.symbol)
        .map((row) => row.symbol),
    ).toEqual([]);
  },
);

// Opt-in real source audit. Only reads TDX; all calculated results stay in memory.
it.skipIf(!process.env.QUANT_TDX_AUDIT_ROOT)(
  "real local source produces a usable latest-day RPS ranking",
  async () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      const store = new RpsStore(db);
      const progress = rpsProgress();
      store.claim(progress);
      await runRpsJob(
        store,
        localRpsDependencies(process.env.QUANT_TDX_AUDIT_ROOT!, []),
        { mode: "backfill", days: 1 },
        progress,
        Date.now(),
      );
      const day = store.latest();
      expect(day, JSON.stringify(store.progress())).not.toBeNull();
      expect(day!.counts[3]).toBeGreaterThan(1000);
      console.info(
        JSON.stringify({
          date: day!.date,
          counts: day!.counts,
          unknownNames: day!.excluded.nameUnknown.length,
        }),
      );
    } finally {
      db.close();
    }
  },
  120000,
);
