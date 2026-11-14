import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { RpsStatus } from "../../../src/components/market/rps-status";
import { migrate } from "../../../src/server/db/migrations";
import { RpsStore } from "../../../src/server/screening/rps-store";
import {
  runRpsJob,
  RPS_PUBLISH_BATCH,
} from "../../../src/server/screening/rps-job";
import {
  rpsCalendar,
  rpsDate,
  rpsDay,
  rpsDeps,
  rpsProgress,
} from "../../helpers/rps-fixture";

const connections: Database.Database[] = [];
function setup() {
  const db = new Database(":memory:");
  connections.push(db);
  migrate(db);
  const store = new RpsStore(db),
    progress = rpsProgress();
  store.claim(progress);
  return { store, progress };
}
afterEach(() => {
  connections.splice(0).forEach((db) => db.close());
});
const now = Date.parse(`${rpsDate}T15:05:00+08:00`);
it("daily batch stores all periods, uses completed dates only and preserves existing runs", async () => {
  const { store, progress } = setup();
  const result = await runRpsJob(
    store,
    { ...rpsDeps(), incrementSnapshots: () => ["tdx-daily-snapshot-fixture"] },
    { mode: "backfill", days: 3 },
    progress,
    now,
  );
  expect(result.status).toBe("complete");
  expect(result.completedDays).toBe(3);
  expect(store.latest()!.counts).toEqual([10, 10, 10, 10, 10, 10, 10]);
  expect(store.latest()!.date).toBe(rpsDate);
  expect(store.latest()!.source.incrementSnapshots).toEqual([
    "tdx-daily-snapshot-fixture",
  ]);
  const next = rpsProgress();
  store.claim(next);
  expect(
    (await runRpsJob(store, rpsDeps(), { mode: "forward", days: 1 }, next, now))
      .completedDays,
  ).toBe(0);
  expect(store.latest()!.mode).toBe("backfill");
  expect(store.latest()!.source.incrementSnapshots).toEqual([
    "tdx-daily-snapshot-fixture",
  ]);
});
it.each(["missing-gbbq", "broken-bars"])(
  "%s fails closed without raw-price fallback or smaller hidden universe",
  async (failure) => {
    const { store, progress } = setup(),
      deps = rpsDeps();
    if (failure === "missing-gbbq")
      deps.actions = async () => {
        throw new Error("missing-gbbq");
      };
    if (failure === "broken-bars")
      deps.bars = async () => {
        throw new Error("broken-bars");
      };
    expect(
      (
        await runRpsJob(
          store,
          deps,
          { mode: "backfill", days: 1 },
          progress,
          now,
        )
      ).status,
    ).toBe("failed");
    expect(store.latest()).toBeNull();
  },
);
it("cancellation keeps only fully committed dates; explicit retry resumes missing dates", async () => {
  const { store, progress } = setup();
  // Backfills publish in batches: cancel right after the first batch commits.
  const result = await runRpsJob(
    store,
    rpsDeps(),
    { mode: "backfill", days: RPS_PUBLISH_BATCH + 2 },
    progress,
    now,
    (p) => {
      if (p.completedDays === RPS_PUBLISH_BATCH) store.cancel();
    },
  );
  expect(result.status).toBe("cancelled");
  expect(store.latest()!.date).toBe(rpsCalendar[518]);
  const next = rpsProgress();
  store.claim(next);
  expect(
    (
      await runRpsJob(
        store,
        rpsDeps(),
        { mode: "backfill", days: RPS_PUBLISH_BATCH + 2 },
        next,
        now,
      )
    ).completedDays,
  ).toBe(2);
});
it("forward waits without publishing yesterday or an incomplete day as live observation", async () => {
  for (const clock of [
    Date.parse(`${rpsDate}T15:04:00+08:00`),
    Date.parse("2040-01-01T16:00:00+08:00"),
  ]) {
    const { store, progress } = setup();
    expect(
      (
        await runRpsJob(
          store,
          rpsDeps(),
          { mode: "forward", days: 1 },
          progress,
          clock,
        )
      ).status,
    ).toBe("waiting");
    expect(store.latest()).toBeNull();
  }
});
it.each(["calendar-history", "actions-coverage", "universe"])(
  "waits for %s, releases the lease, then publishes after an explicit retry",
  async (code) => {
    const { store, progress } = setup();
    const deps = rpsDeps();
    if (code === "calendar-history")
      deps.calendar = async () => ({ days: [rpsDate], source: "short" });
    if (code === "actions-coverage")
      deps.actions = async () => ({ events: new Map(), source: "stale" });
    if (code === "universe") deps.universe = async () => [];
    const result = await runRpsJob(
      store,
      deps,
      { mode: "backfill", days: 1 },
      progress,
      now,
    );
    expect(result).toMatchObject({ status: "waiting", waiting: { code } });
    expect(result.error).toBeUndefined();
    expect(store.latest()).toBeNull();
    expect(store.progress()).toMatchObject({
      status: "waiting",
      waiting: { code },
    });
    const retry = rpsProgress();
    expect(store.claim(retry)).toBe(true);
    expect(
      (
        await runRpsJob(
          store,
          rpsDeps(),
          { mode: "backfill", days: 1 },
          retry,
          now,
        )
      ).status,
    ).toBe("complete");
    expect(store.latest()?.date).toBe(rpsDate);
  },
);
it.each(["duplicate-calendar", "invalid-future-date", "duplicate-symbols"])(
  "%s remains a failure rather than a waiting prerequisite",
  async (fault) => {
    const { store, progress } = setup();
    const deps = rpsDeps();
    if (fault === "duplicate-calendar")
      deps.calendar = async () => ({
        days: [rpsDate, rpsDate],
        source: "invalid",
      });
    if (fault === "invalid-future-date")
      deps.calendar = async () => ({
        days: [...rpsCalendar, "9999-99-99"],
        source: "invalid",
      });
    if (fault === "duplicate-symbols")
      deps.universe = async () =>
        Array.from({ length: 2 }, () => ({
          symbol: "sh600000",
          name: "duplicate",
        }));
    const result = await runRpsJob(
      store,
      deps,
      { mode: "backfill", days: 1 },
      progress,
      now,
    );
    expect(result.status).toBe("failed");
    expect(result.waiting).toBeUndefined();
    expect(result.error).toBeTruthy();
    expect(store.latest()).toBeNull();
  },
);
it("completed forward day is explicitly tagged forward", async () => {
  const { store, progress } = setup();
  expect(
    (
      await runRpsJob(
        store,
        rpsDeps(),
        { mode: "forward", days: 1 },
        progress,
        now,
      )
    ).status,
  ).toBe("complete");
  expect(store.latest()!.mode).toBe("forward");
});
it("data management visibly discloses thresholds, all period denominators, bias, retention and errors", () => {
  const { day } = rpsDay();
  const markup = renderToStaticMarkup(
    createElement(RpsStatus, { latest: day }),
  );
  for (const text of [
    "后复权",
    "满一年",
    "连续20",
    "平均名次",
    "750",
    "生存者偏差",
    "回填",
    "当日",
    "RPS1",
    "RPS3",
    "RPS5",
    "RPS10",
    "RPS20",
    "RPS50",
    "RPS120",
  ])
    expect(markup).toContain(text);
  expect(
    renderToStaticMarkup(createElement(RpsStatus, { latest: null })),
  ).toContain("尚无已完成的排名");
});
