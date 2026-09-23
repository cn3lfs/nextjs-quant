import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { RpsStatus } from "../src/components/market/rps-status";
import { migrate } from "../src/server/db/migrations";
import { RpsStore } from "../src/server/screening/rps-store";
import { runRpsJob } from "../src/server/screening/rps-job";
import {
  rpsCalendar,
  rpsDate,
  rpsDay,
  rpsDeps,
  rpsProgress,
} from "./rps-fixture";

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
it("daily batch stores six periods, uses completed dates only and preserves existing runs", async () => {
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
  expect(store.latest()!.counts).toEqual([10, 10, 10, 10, 10, 10]);
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
it.each(["missing-gbbq", "stale-gbbq", "broken-bars"])(
  "%s fails closed without raw-price fallback or smaller hidden universe",
  async (failure) => {
    const { store, progress } = setup(),
      deps = rpsDeps();
    if (failure === "missing-gbbq")
      deps.actions = async () => {
        throw new Error("missing-gbbq");
      };
    if (failure === "stale-gbbq")
      deps.actions = async () => ({ events: new Map(), source: "stale" });
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
  const result = await runRpsJob(
    store,
    rpsDeps(),
    { mode: "backfill", days: 3 },
    progress,
    now,
    (p) => {
      if (p.completedDays === 1) store.cancel();
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
        { mode: "backfill", days: 3 },
        next,
        now,
      )
    ).completedDays,
  ).toBe(2);
});
it("forward cannot masquerade yesterday or an incomplete day as live observation", async () => {
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
    ).toBe("failed");
    expect(store.latest()).toBeNull();
  }
});
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
it("data management visibly discloses thresholds, all six denominators, bias, retention and errors", () => {
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
    "RPS5",
    "RPS10",
    "RPS20",
    "RPS50",
    "RPS120",
    "RPS250",
  ])
    expect(markup).toContain(text);
  expect(
    renderToStaticMarkup(createElement(RpsStatus, { latest: null })),
  ).toContain("尚无已完成的排名");
});
