import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { sqlite } from "~/server/db";
import {
  industryDay,
  industrySnapshot,
} from "../../helpers/industry-rps-fixture";
import { rpsDay } from "../../helpers/rps-fixture";
import { rpsHash } from "~/server/infra/content-hash";
import { rebuildBlockRps } from "~/server/screening/rps-block-rebuild";
import {
  applyBlockRebuild,
  planBlockRebuild,
  stockRpsFingerprint,
} from "~/server/screening/rps-block-maintenance";
import { RpsStore } from "~/server/screening/rps-store";
import {
  blockEligibilityVersion,
  excludedBlock,
  type BlockEligibility,
} from "~/lib/market/block-eligibility";
import type { RpsObservation } from "~/server/screening/rps-observation";

const policy: BlockEligibility = {
  version: blockEligibilityVersion,
  sourceHash: rpsHash("metadata"),
  hash: rpsHash("region-style"),
  excluded: [
    { name: "上海板块", code: "880201", kind: "region" },
    { name: "低市盈率", code: "880826", kind: "style" },
  ],
};
function group() {
  const base = industryDay();
  const names = ["行业甲", "上海板块", "低市盈率", "行业乙", "缺行情"];
  const returns = [0.4, 0.5, 0.6, 0.2, null];
  const snapshot = industrySnapshot(
    Object.fromEntries(names.map((name) => [name, ["sz000001"]])),
  );
  const result = {
    day: {
      ...base.day,
      total: 5,
      pool: 4,
      counts: base.day.periods.map(() => 4),
      missing: base.day.periods.map(() => 1),
      industry: {
        ...base.day.industry!,
        snapshot,
        members: names.map((name, i) => ({
          ...base.day.industry!.members[0]!,
          name,
          included: base.day.periods.map(() => (i === 4 ? 0 : 1)),
          missing: base.day.periods.map(() => (i === 4 ? 1 : 0)),
        })),
      },
    },
    rows: names.map((symbol, i) => ({
      symbol,
      values: base.day.periods.map(() =>
        returns[i] === null
          ? null
          : {
              return: returns[i]!,
              rank: [3, 2, 1, 4][i]!,
              rps: [25, 50, 75, 0][i]!,
            },
      ),
    })),
  };
  return result;
}
it("uses exact metadata identities and keeps place-themed concepts", () => {
  expect(excludedBlock("上海", "上海.txt", policy)?.kind).toBe("region");
  expect(excludedBlock("通达信·880201·旧地区名", "880201", policy)?.kind).toBe(
    "region",
  );
  expect(excludedBlock("低市盈率", "低市盈率.txt", policy)?.kind).toBe("style");
  expect(excludedBlock("上海国资", "上海国资.txt", policy)).toBeUndefined();
  expect(excludedBlock("低市盈率设备概念", "概念.txt", policy)).toBeUndefined();
});
it("reranks with the reduced denominator and retains exact returns/nulls and source capture time", () => {
  const before = group();
  const frozen = JSON.stringify(before);
  const next = rebuildBlockRps(before, policy);
  expect(next.rows.map((row) => row.symbol)).toEqual([
    "行业甲",
    "行业乙",
    "缺行情",
  ]);
  // Two valid groups: first rank=1 -> 50; second rank=2 -> 0. Null is not a third denominator.
  expect(next.rows[0]!.values[0]).toEqual({ return: 0.4, rank: 1, rps: 50 });
  expect(next.rows[1]!.values[0]).toEqual({ return: 0.2, rank: 2, rps: 0 });
  expect(next.rows[2]!.values).toEqual(before.day.periods.map(() => null));
  expect(next.day.counts).toEqual(before.day.periods.map(() => 2));
  expect(next.day.missing).toEqual(before.day.periods.map(() => 1));
  expect(next.day.total).toBe(3);
  expect(next.day.createdAt).toBe(before.day.createdAt);
  expect(next.day.source).toEqual(before.day.source);
  expect(JSON.stringify(before)).toBe(frozen);
  expect(rebuildBlockRps(next, policy)).toBe(next);
  const tied = group();
  tied.rows[0]!.values = tied.rows[3]!.values.map((value) => ({
    ...value!,
    return: 0.2,
  }));
  expect(rebuildBlockRps(tied, policy).rows[0]!.values[0]).toEqual({
    return: 0.2,
    rank: 1.5,
    rps: 25,
  });
  expect(() => rebuildBlockRps(rpsDay(), policy)).toThrow("不能修改个股");
});
function seed() {
  const db = sqlite();
  db.exec(
    "DELETE FROM records; DELETE FROM rps_values; DELETE FROM rps_days; DELETE FROM industry_rps_values; DELETE FROM industry_rps_days; DELETE FROM concept_rps_values; DELETE FROM concept_rps_days; DELETE FROM rps_job;",
  );
  const stock = rpsDay();
  new RpsStore(db).saveDay(stock.day, stock.rows);
  const board = group();
  new RpsStore(db, "industry").saveDay(board.day, board.rows);
  const observation: RpsObservation = {
    id: "old-observation",
    phase: "close",
    date: stock.day.date,
    createdAt: 1,
    baseline: "original",
    root: "tdx",
    fresh: 10,
    total: 10,
    coverage: 1,
    reused: [],
    missing: [],
    day: stock.day,
    rows: stock.rows,
    groups: { industry: board },
  };
  const payload = JSON.stringify(observation);
  db.prepare("INSERT INTO records VALUES(?,'rps-observation',?,?)").run(
    observation.id,
    payload,
    1234,
  );
  db.prepare(
    "INSERT INTO records VALUES('index','rps-observation-index',?,?)",
  ).run(JSON.stringify({ id: observation.id }), 1234);
  return { db, observation, payload };
}
it("atomically switches observations and daily vectors, retains byte-exact originals and leaves stock RPS unchanged", () => {
  const { db, observation, payload } = seed();
  const stage = new Database(
    join(process.env.QUANT_DATA_DIR!, "plan-apply.sqlite"),
  );
  try {
    const beforeStock = stockRpsFingerprint(db);
    const summary = planBlockRebuild(db, stage, policy, 10000);
    expect(summary.changes).toBe(2);
    expect(summary.removed).toEqual({
      region: ["上海板块"],
      style: ["低市盈率"],
    });
    applyBlockRebuild(db, stage, policy);
    expect(stockRpsFingerprint(db)).toBe(beforeStock);
    const archive = db
      .prepare("SELECT kind,payload FROM records WHERE id=?")
      .get(observation.id);
    expect(archive).toEqual({ kind: "rps-observation-archive", payload });
    const active = JSON.parse(
      (
        db
          .prepare("SELECT payload FROM records WHERE kind='rps-observation'")
          .get() as { payload: string }
      ).payload,
    ) as RpsObservation;
    expect(active.day).toEqual(observation.day);
    expect(active.rows).toEqual(observation.rows);
    expect(active.groups.industry!.day.counts[0]).toBe(2);
    expect(
      JSON.parse(
        (
          db.prepare("SELECT payload FROM records WHERE id='index'").get() as {
            payload: string;
          }
        ).payload,
      ).id,
    ).toBe(active.id);
    expect(
      new RpsStore(db, "industry")
        .rows(active.date)
        .find((row) => row.symbol === "行业甲")!.values[0]!.rps,
    ).toBe(50);
    expect(new RpsStore(db, "industry").day(active.date)!.total).toBe(3);
    expect(
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM records WHERE kind='rps-block-day-archive'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(1);
    const second = new Database(
      join(process.env.QUANT_DATA_DIR!, "plan-idempotent.sqlite"),
    );
    try {
      expect(planBlockRebuild(db, second, policy).changes).toBe(0);
    } finally {
      second.close();
    }
  } finally {
    stage.close();
  }
});
it("a conflict after earlier writes rolls back the entire switch and protects original records", () => {
  const { db, payload } = seed();
  const stage = new Database(
    join(process.env.QUANT_DATA_DIR!, "plan-conflict.sqlite"),
  );
  try {
    planBlockRebuild(db, stage, policy);
    // Daily rewrite sorts first; observation ID conflict must roll it back too.
    db.prepare("INSERT INTO records VALUES(?,'foreign','{}',0)").run(
      `old-observation-block-${policy.hash.slice(0, 12)}`,
    );
    expect(() => applyBlockRebuild(db, stage, policy)).toThrow("ID 已存在");
    expect(new RpsStore(db, "industry").latest()!.total).toBe(5);
    expect(
      db
        .prepare("SELECT payload FROM records WHERE id='old-observation'")
        .get(),
    ).toEqual({ payload });
    expect(
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM records WHERE kind='rps-block-day-archive'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);
  } finally {
    stage.close();
  }
});
it("refuses active leases and stale plans without changing data", () => {
  const { db, payload } = seed();
  const stage = new Database(
    join(process.env.QUANT_DATA_DIR!, "plan-stale.sqlite"),
  );
  try {
    planBlockRebuild(db, stage, policy);
    db.prepare(
      "UPDATE records SET updated_at=updated_at+1 WHERE id='old-observation'",
    ).run();
    expect(() => applyBlockRebuild(db, stage, policy)).toThrow(
      "观察批次已变化",
    );
    expect(
      db
        .prepare("SELECT kind,payload FROM records WHERE id='old-observation'")
        .get(),
    ).toEqual({ kind: "rps-observation", payload });
    db.prepare("INSERT INTO rps_job VALUES(1,'busy','{}',0,?)").run(
      Date.now() + 60000,
    );
    expect(() => applyBlockRebuild(db, stage, policy)).toThrow("正在计算");
  } finally {
    stage.close();
  }
});
