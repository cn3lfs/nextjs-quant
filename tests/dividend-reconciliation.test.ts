import { expect, it } from "vitest";
import fixture from "./fixtures/hithink-dividends.json";
import { dividendSchedule } from "../src/server/data-sources/hithink/hithink-dividends";
import { actionReview } from "../src/server/backtest/backtest-actions";
import { reconcileDividends } from "../src/server/backtest/dividend-reconciliation";
const source = {
  symbol: "sh600519",
  source: "tdx-local",
  bars: [{ date: "2025-01-01" }, { date: "2026-09-08" }],
};
const metadata = { file: "fixture", modified: 1, fetchedAt: 2 };
const remote = () =>
  dividendSchedule("sh600519", fixture.raw, fixture.fetchedAt);
const events = () =>
  remote().events.map((e) => ({
    date: `${String(e.ex).slice(0, 4)}-${String(e.ex).slice(4, 6)}-${String(e.ex).slice(6)}`,
    category: 1,
    name: "除权除息",
    dividend: Math.fround(Number(e.dividend) * 10) / 10,
    rightsPrice: 0,
    bonusRatio: 0,
    rightsRatio: 0,
  }));
it("accepts only the source float32 representation error and records both provenance hashes", () => {
  const local = actionReview(source, events(), metadata),
    r = remote();
  const before = JSON.stringify({ local, r }),
    result = reconcileDividends(local, r);
  expect(result.matchedCash).toBe(2);
  expect(result.rows.every((r) => r.status === "matched-cash")).toBe(true);
  expect(result.localSourceHash).toBe(local.source!.hash);
  expect(result.remoteSourceHash).toBe(r.hash);
  expect(JSON.stringify({ local, r })).toBe(before);
  const changed = events();
  changed[0]!.dividend += 0.001;
  expect(
    reconcileDividends(actionReview(source, changed, metadata), r).rows[0]!
      .status,
  ).toBe("conflict");
});
it("preserves missing counterpart events and keeps shares distinct from cash", () => {
  const list = events();
  list[0]!.bonusRatio = 0.1;
  list.push({ ...list[0]!, date: "2025-10-10" });
  const result = reconcileDividends(
    actionReview(source, list, metadata),
    remote(),
  );
  expect(result.rows.map((r) => r.status)).toEqual([
    "local-only",
    "share-action",
    "matched-cash",
  ]);
  const onlyRemote = reconcileDividends(
    actionReview(source, [], metadata),
    remote(),
  );
  expect(onlyRemote.rows.every((r) => r.status === "remote-only")).toBe(true);
});
it("missing payment date cannot pass and altered archived evidence is rejected", () => {
  const raw = structuredClone(fixture.raw);
  delete (raw.datas[0] as Record<string, unknown>)["派息日[20251231]"];
  const incomplete = dividendSchedule("sh600519", raw, fixture.fetchedAt),
    local = actionReview(source, events(), metadata);
  expect(reconcileDividends(local, incomplete).rows.at(-1)!.status).toBe(
    "missing-date",
  );
  const changed = structuredClone(remote());
  changed.events[0]!.dividend = 999;
  expect(() => reconcileDividends(local, changed)).toThrow("远端档案");
  local.events[0]!.dividend = 999;
  expect(() => reconcileDividends(local, remote())).toThrow("本地事件档案");
});
