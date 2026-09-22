import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { migrate } from "../src/server/db/migrations";
import { IntradayStore } from "../src/server/monitoring/intraday-store";
import {
  IntradayJob,
  type IntradayDependencies,
} from "../src/server/monitoring/intraday-job";
import { intradayConfigSchema } from "../src/lib/intraday-schedule";
import { previewSlots } from "../src/lib/intraday-preview";
import { rpsDay } from "./rps-fixture";
import type { CzscResult } from "../src/lib/czsc";

it("runs a partial batch, retries only failures, and closes against the captured prefix", async () => {
  const db = new Database(":memory:");
  migrate(db);
  try {
    let now = Date.parse("2024-03-04T14:40:01+08:00");
    let fail = true;
    const price = {
      open: 10,
      high: 12,
      low: 9,
      close: 11,
      volume: 100,
      amount: 1000,
    };
    const daily = Array.from({ length: 61 }, (_, i) => ({
      ...price,
      date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    }));
    const previous = daily.at(-1)!.date;
    const engine = vi.fn(async (): Promise<CzscResult> => ({
      status: "no-structure",
      hash: "fixed",
      sourceCommit: "b67f3c6",
      families: [],
    }));
    const history = vi.fn(async (_source: unknown, symbol: string) => {
      if (fail && symbol === "sh600001") throw new Error("缺失行情");
      return {
        daily: structuredClone(daily),
        fetchedAt: now,
        minutes: previewSlots("15:00").map((time) => ({
          ...price,
          date: `2024-03-04T${time}:00+08:00`,
        })),
      };
    });
    const pool = vi.fn(async () => ({
      rows: ["sh600000", "sh600001"].map((symbol) => ({
        symbol,
        rps: 95,
        rank: 1,
        return: 1,
      })),
      members: ["sh600000", "sh600001"],
      source: null,
      hash: "pool",
      rpsDay: rpsDay().day,
    }));
    const deps: IntradayDependencies = {
      now: () => now,
      calendar: async () => ({
        days: [previous, "2024-03-04"],
        source: "test",
      }),
      pool,
      history,
      czsc: engine,
    };
    const store = new IntradayStore(db),
      job = new IntradayJob(store, deps);
    const config = intradayConfigSchema.parse({ enabled: true });
    const first = await job.preview(config, "late");
    expect(pool).toHaveBeenCalledWith(
      config,
      previous,
      Date.parse("2024-03-04T14:40:00+08:00"),
    );
    expect(first.status).toBe("partial");
    expect(first.results.map((row) => Boolean(row.observationId))).toEqual([
      true,
      false,
    ]);
    fail = false;
    expect((await job.preview(config, "late")).status).toBe("complete");
    expect(pool).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledTimes(3);
    await job.preview(config, "late");
    expect(history).toHaveBeenCalledTimes(3);
    const id = first.results[0]!.observationId!;
    const captured = store.observation(id)!;
    now = Date.parse("2024-03-04T15:10:00+08:00");
    daily[0]!.close = 999;
    await job.confirm(id);
    expect(store.attempts(id)[0]?.close.snapshot?.bars[0]?.close).toBe(11);
    expect(store.observation(id)).toEqual(captured);
    expect((await job.preview(config, "noon")).status).toBe("missed");
    expect(history).toHaveBeenCalledTimes(4);
    const currentRun = job.runs().find((run) => run.id === first.id)!;
    db.prepare("UPDATE records SET payload=? WHERE id=?").run(
      JSON.stringify({
        ...currentRun,
        status: "running",
        leaseUntil: now + 60000,
      }),
      first.id,
    );
    expect(() => store.remove(id, now)).toThrow("仍在执行");
    expect(store.observation(id)).toEqual(captured);
    db.prepare("UPDATE records SET payload=? WHERE id=?").run(
      JSON.stringify(currentRun),
      first.id,
    );
    store.remove(id, now);
    expect(store.observation(id)).toBeUndefined();
    expect(store.attempts(id)).toEqual([]);
    expect(
      job.runs().find((run) => run.id === first.id)?.results[0]?.reason,
    ).toBe("原始记录已由用户清理");
  } finally {
    db.close();
  }
});
