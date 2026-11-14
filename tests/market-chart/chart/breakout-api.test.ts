import { beforeEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { strategyRouter } from "~/server/api/routers/strategy";
import { put, sqlite } from "~/server/db";
import type { Bar, Snapshot } from "~/lib/domain";

const fixture = JSON.parse(
  readFileSync("tests/fixtures/breakout-valid.json", "utf8"),
) as { symbol: string; cutoff: string; bars: Bar[] };
const snapshot: Snapshot = {
  id: "breakout-api-snapshot",
  symbol: fixture.symbol,
  name: "breakout fixture",
  period: "day",
  source: "tdx-local",
  adjustment: "none",
  createdAt: 0,
  hash: "breakout-api-fixture",
  bars: fixture.bars.filter((bar) => bar.date <= fixture.cutoff),
};
const caller = strategyRouter.createCaller({ headers: new Headers() });

beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
});

it("runs breakout through the real RPC gate without creating tasks or changing the source", async () => {
  put("snapshot", snapshot.id, snapshot);
  const before = sqlite().prepare("SELECT * FROM records ORDER BY id").all();
  const result = await caller.breakout({ snapshotId: snapshot.id });
  expect(result.latest?.date).toBe(fixture.cutoff);
  expect(result.points.length).toBeGreaterThan(0);
  expect(sqlite().prepare("SELECT * FROM records ORDER BY id").all()).toEqual(
    before,
  );
});

it("keeps snapshot validation after reopening breakout", async () => {
  await expect(caller.breakout({ snapshotId: "missing" })).rejects.toThrow(
    "行情快照不存在",
  );
  put("snapshot", snapshot.id, { ...snapshot, period: "week" });
  await expect(caller.breakout({ snapshotId: snapshot.id })).rejects.toThrow(
    "仅支持日线",
  );
  await expect(
    caller.breakout({ snapshotId: snapshot.id, chartSnapshot: true }),
  ).rejects.toThrow("图表快照不匹配");
});

it("accepts the chart-snapshot path used by the market page", async () => {
  const id = "chart-snapshot-breakout-api";
  put("chart-snapshot", id, { ...snapshot, id });
  const result = await caller.breakout({ snapshotId: id, chartSnapshot: true });
  expect(result.latest?.date).toBe(fixture.cutoff);
  expect(result.points.length).toBeGreaterThan(0);
});
