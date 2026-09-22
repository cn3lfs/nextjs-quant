import { expect, it } from "vitest";
import { evaluateGrowthFactors } from "../src/server/strategies/canslim/research-growth-factors";
import {
  newsFactorRules,
  evaluateNewsOctants,
  newsResultSchema,
  eventMarketSchema,
} from "../src/lib/research-news-factors";
import {
  newsFixture,
  newsRows,
  newsRequest,
  digest,
} from "./helpers/news-factor-fixture";
const one = (id: string, f = newsFixture(id), req = newsRequest) =>
  evaluateGrowthFactors(req, newsRows(f), [id]).results[0]!;
it("all 36 named methods are executable through the same as-of entry", () => {
  expect(Object.keys(newsFactorRules)).toHaveLength(36);
  for (const id of Object.keys(newsFactorRules)) {
    const r = one(id);
    expect(r.status, `${id}:${JSON.stringify(r.dataGaps)}`).toBe("computed");
    expect(r.participation).not.toBe("rule");
    expect(r.details.firstResultHash).toMatch(/^[a-f0-9]{64}$/);
  }
});
it.each(Array.from({ length: 8 }, (_, i) => i + 1))(
  "octant %i keeps distinct entry/hold/reduce/forbid and scope",
  (num) => {
    const id = `EV0${num}`,
      r = one(id);
    expect(r.details.octant).toBe(num);
    expect(r.details).toHaveProperty("hold");
    expect(r.details).toHaveProperty("forbid");
    expect(r.details.observedScope).toBe(
      [6, 8].includes(num)
        ? "market"
        : [2, 4].includes(num)
          ? "sector"
          : "stock",
    );
    if ([3, 4, 5, 6].includes(num)) expect(r.passed).toBe(false);
    else expect(r.passed).toBe(true);
    if ([4, 6].includes(num)) expect(r.details.targetCapPct).toBe(30);
  },
);
it("archived output is used deterministically without any model call; tampered raw/prompt/result bytes rejected", () => {
  const f = newsFixture();
  expect(one("EV01", f)).toEqual(one("EV01", structuredClone(f)));
  for (const field of ["rawInput", "prompt", "firstResult"] as const) {
    const rows = newsRows(f);
    const v = rows[0]!.value as typeof f.replay;
    v[field] += " ";
    expect(
      evaluateGrowthFactors(newsRequest, rows, ["EV01"]).results[0]!.status,
    ).toBe("missing");
  }
});
it("today's model/mapping and missing availability remain explicitly retrospective, never historical orders", () => {
  const f = newsFixture();
  f.replay.firstProcessedAt = "2026-09-17T01:00:00Z";
  f.replay.modelAvailableAt = "2026-09-16T01:00:00Z";
  f.replay.industryMapping.frozenAt = "2026-09-16T01:00:00Z";
  f.raw[0]!.firstAvailableAt = null as unknown as string;
  const rows = newsRows(f).map((r) => ({
    ...r,
    availableAt: "2026-09-17T01:01:00Z",
    capturedAt: "2026-09-17T01:01:00Z",
  }));
  const r = evaluateGrowthFactors(
    { ...newsRequest, asOf: "2026-09-17T02:00:00Z" },
    rows,
    ["EV01"],
  ).results[0]!;
  expect(r).toMatchObject({
    status: "computed",
    passed: false,
    details: { action: "retrospective-only", exit: false },
  });
  expect((r.details.limitations as string[]).length).toBeGreaterThan(1);
});
it("invalid chronology, unknown citations and company/industry disagreement reject the replay", () => {
  const changes = [
    (f: ReturnType<typeof newsFixture>) => {
      f.replay.modelAvailableAt = "2025-01-01T00:00:00Z";
    },
    (f: ReturnType<typeof newsFixture>) => {
      f.result.events[0]!.newsIds = ["invented"];
    },
    (f: ReturnType<typeof newsFixture>) => {
      f.replay.companyMapping.rows[0]!.industryId = "银行";
    },
    (f: ReturnType<typeof newsFixture>) => {
      f.raw[0]!.firstCapturedAt = "2026-01-01T00:00:00Z";
    },
    (f: ReturnType<typeof newsFixture>) => {
      f.replay.industryMapping.capturedAt = "2025-01-01T00:00:00Z";
    },
  ];
  for (const change of changes) {
    const f = newsFixture();
    change(f);
    expect(one("EV01", f).status).toBe("missing");
  }
});
it("price equality confirms at 3%, low volume becomes dull and unknown dispersion does not invent a stock octant", () => {
  const f = newsFixture();
  f.market.bars.at(-1)!.close = 103;
  f.market.bars.at(-1)!.high = 104;
  f.market.bars.at(-1)!.low = 102;
  expect(one("EV01", f).details.direction).toBe("up");
  f.market.bars.at(-1)!.volume = 100;
  expect(one("EV01", f).details.octant).toBe(null);
  f.market.bars.at(-1)!.volume = 200;
  f.market.bars.at(-1)!.sectorUpPct = 59;
  f.market.bars.at(-1)!.sectorClose = 101.5;
  expect(one("EV01", f).details.octant).toBe(null);
});
it("source two-session and industry five-session thresholds share one implementation", () => {
  const f = newsFixture("NW04"),
    e = newsResultSchema.parse(f.result).events[0]!,
    p = eventMarketSchema.parse(f.market);
  p.bars.at(-1)!.volume = 120;
  expect(evaluateNewsOctants(e, p, "stock").direction).toBe("up");
  expect(evaluateNewsOctants(e, p, "industry").direction).toBe("flat");
  expect(one("NW04", f).passed).toBe(true);
});
it("all offensive octants reject rumor, noise, denial and expiry; defensive one-off loss can hold", () => {
  for (const id of [
    "EV01",
    "EV02",
    "EV07",
    "EV08",
    "EV10",
    "EV11",
    "EV12",
    "EV13",
  ]) {
    for (const change of [
      { authority: "rumor" },
      { materialPct: 4.99 },
      { denied: true },
      { expiresAt: "2024-04-30" },
    ]) {
      const f = newsFixture(id);
      Object.assign(f.result.events[0]!, change);
      expect(one(id, f).passed, `${id}:${JSON.stringify(change)}`).toBe(false);
    }
  }
  const f = newsFixture("EV05");
  f.result.events[0]!.persistentDamage = false;
  f.result.events[0]!.oneOffCovered = true;
  expect(one("EV05", f).details).toMatchObject({
    hold: true,
    reduce: false,
    forbid: true,
  });
});
it("profit protection, deep drawdown and confirmed reentry cannot be bypassed", () => {
  const high = newsFixture("EV01");
  high.market.high60 = 110;
  expect(one("EV01", high).passed).toBe(false);
  const hot = newsFixture("EV02");
  hot.market.overheatCount = 2;
  hot.market.failedNewHighDays = 2;
  expect(one("EV02", hot).details.reduce).toBe(true);
  const shallow = newsFixture("EV07");
  shallow.market.high60 = 120;
  expect(one("EV07", shallow).passed).toBe(false);
  const re = newsFixture("EV13");
  expect(one("EV13", re).passed).toBe(true);
  re.market.pullbackVolumeRatio = 1 / 3;
  expect(one("EV13", re).passed).toBe(false);
});
it("ME five-factor weighted truth score and denial dominate apparent price confirmation", () => {
  const f = newsFixture("ME01");
  f.result.events[0]!.authenticity = {
    ...f.result.events[0]!.authenticity,
    authority: 80,
    crossCheck: 80,
    logic: 80,
    timeliness: 80,
    trackRecord: 80,
  };
  expect(one("ME01", f).details.authenticity).toBe(80);
  expect(one("ME01", f).passed).toBe(true);
  f.result.events[0]!.denied = true;
  expect(one("ME01", f)).toMatchObject({
    passed: false,
    details: { authenticity: 0, exit: true },
  });
});
it("six impact types preserve direct/indirect direction and catalyst failure/expiry exits", () => {
  const f = newsFixture("ME02");
  for (const kind of [
    "policy",
    "technology",
    "demand",
    "cost-price",
    "competition",
    "capital",
  ]) {
    f.result.events[0]!.impacts[0]!.kind = kind;
    expect(one("ME02", f).passed).toBe(true);
  }
  f.result.events[0]!.impacts[0]!.direction = "negative";
  expect(one("ME02", f).details.exit).toBe(true);
  const expired = newsFixture("ME04");
  expired.result.events[0]!.catalyst!.due = "2024-04-30";
  expired.result.events[0]!.catalyst!.observed = 9;
  expect(one("ME04", expired).details.exit).toBe(true);
});
it("NW deduplicates news IDs, excludes background, and requires two news for Top7", () => {
  const f = newsFixture("NW01");
  expect(one("NW01", f).details.hot).toEqual([
    { industryId: "电子", count: 2 },
  ]);
  f.result.events[0]!.newsIds = ["n1", "n1"];
  expect(one("NW01", f).passed).toBe(false);
});
it("NW old qualitative and new flow version replay identical news separately; absent flow is not zero", () => {
  const old = newsFixture("NW02");
  old.sector.rows[0]!.flow5 = [-1, -1, -1, -1, -1];
  expect(one("NW02", old).passed).toBe(true);
  old.replay.pipelineVersion = "flow-enhanced-v2";
  expect(one("NW02", old)).toMatchObject({
    passed: false,
    details: { messageFlowDivergence: true, flow: -5 },
  });
  old.sector.rows[0]!.flow5 = null as unknown as number[];
  expect(one("NW02", old).status).toBe("missing");
});
it("NW valuation window and classification versions must match; tied valuation threshold preserved", () => {
  const f = newsFixture("NW03");
  expect(one("NW03", f).passed).toBe(true);
  f.sector.rows[0]!.peHistory = [10, 11, 12, 13, 14];
  expect(one("NW03", f).passed).toBe(false);
  f.sector.classificationVersion = "today-cache";
  expect(one("NW03", f).status).toBe("missing");
});
it.each([
  "IC01",
  "IC01-inventory",
  "IC01-capacity",
  "IC01-demand",
  "IC01-profit",
  "IC01-policy",
])("%s uses source weights without filling missing dimensions", (id) => {
  const f = newsFixture(id);
  expect(one(id, f).passed).toBe(true);
  for (const values of Object.values(f.result.chain.prosperity)) values.fill(0);
  expect(one(id, f).passed).toBe(false);
  expect(one(id, f).details.total).toBe(10);
});
it.each([
  "IC02",
  "IC02-technology",
  "IC02-supply",
  "IC02-verification",
  "IC02-commercialization",
  "IC02-competition",
])("%s preserves hard indispensability, evidence and falsification", (id) => {
  const f = newsFixture(id);
  expect(one(id, f).passed).toBe(true);
  f.result.chain.bottleneck.noSubstitute = false;
  f.result.chain.bottleneck.substituteCost = 3;
  expect(one(id, f).passed).toBe(false);
  f.result.chain.bottleneck.noSubstitute = true;
  f.result.chain.bottleneck.evidenceScores = [1, 1, 1, 2];
  expect(one(id, f).passed).toBe(false);
});
it("IC catalyst equality passes; horizons and real business paths are independent", () => {
  const f = newsFixture("IC03");
  f.result.events[0]!.catalyst!.observed = 10;
  expect(one("IC03", f).passed).toBe(true);
  f.result.events[0]!.catalyst!.observed = 9.99;
  expect(one("IC03", f).passed).toBe(false);
  f.result.chain.horizons.policyPositive = false;
  expect(one("IC04", f).passed).toBe(false);
  f.result.events[0]!.impacts = [];
  expect(one("IC05", f).passed).toBe(false);
});
it("schema-invalid first model output is rejected even with a valid hash", () => {
  const rows = newsRows();
  const a = rows[0]!.value as ReturnType<typeof newsFixture>["replay"];
  a.firstResult = JSON.stringify({ events: [] });
  a.firstResultHash = digest(a.firstResult);
  expect(
    evaluateGrowthFactors(newsRequest, rows, ["ME01"]).results[0]!.status,
  ).toBe("missing");
});
it("same archived calculation cannot substitute a fresh model result or mapping under another data version", () => {
  const old = newsRows(),
    fresh = newsRows();
  const a = fresh[0]!.value as ReturnType<typeof newsFixture>["replay"];
  a.modelVersion = "synthetic-rerun";
  fresh[0]!.versionId = "later-data-version";
  fresh[0]!.availableAt = "2024-05-01T15:01:00+08:00";
  fresh[0]!.capturedAt = fresh[0]!.availableAt;
  expect(
    evaluateGrowthFactors(
      { ...newsRequest, asOf: "2024-05-01T15:02:00+08:00" },
      [...old, fresh[0]!],
      ["ME01"],
    ).results[0]!.status,
  ).toBe("missing");
  expect(
    evaluateGrowthFactors(newsRequest, [...old, fresh[0]!], ["ME01"])
      .results[0]!.status,
  ).toBe("computed");
});
it("stock reduction is not liquidation, and sector risk is not silently promoted to market risk", () => {
  expect(one("EV03").details).toMatchObject({
    action: "reduce",
    exit: false,
    reduceFraction: 0.5,
    scope: "stock",
  });
  const f = newsFixture("EV06");
  f.market.bars.at(-1)!.marketUpPct = 50;
  expect(one("EV06", f).details).toMatchObject({
    scope: "sector",
    targetCapPct: 30,
    action: "reduce",
    exit: false,
  });
});
it("held octant stops survive migration into another octant", () => {
  const f = newsFixture("EV07");
  f.market.heldOctant = 7;
  f.market.entrySession = f.market.calendar[0]!;
  f.market.heldScope = "stock";
  const last = f.market.bars.at(-1)!;
  last.close = 90;
  last.low = 89;
  last.high = 91;
  expect(one("EV07", f).details).toMatchObject({
    buyEligible: false,
    exit: true,
    action: "exit",
    targetCapPct: 0,
    heldOctant: 7,
  });
  const m = newsFixture("EV08");
  m.market.heldOctant = 8;
  m.market.entrySession = m.market.calendar[0]!;
  m.market.heldScope = "market";
  m.market.bars.at(-1)!.indexClose = 98;
  m.market.bars.at(-1)!.indexLow = 97;
  expect(one("EV08", m).details).toMatchObject({
    action: "reduce",
    exit: false,
    targetCapPct: 30,
    heldOctant: 8,
  });
});
it("same raw corpus with different frozen classifier outputs changes counts, never regenerates the old result", () => {
  const old = newsFixture("NW01"),
    next = structuredClone(old);
  next.replay.archiveId = "new-classification-call";
  next.replay.classificationVersion = "synthetic-cache-added-keywords";
  const other = structuredClone(next.result.events[0]!);
  other.id = "event-other";
  other.industryId = "计算机";
  other.newsIds = ["n2"];
  next.result.events[0]!.newsIds = ["n1"];
  next.result.events.push(other);
  expect(old.raw).toEqual(next.raw);
  expect(one("NW01", old).passed).toBe(true);
  expect(one("NW01", next).passed).toBe(false);
  expect(one("NW01", old).details.hot).toEqual([
    { industryId: "电子", count: 2 },
  ]);
});
it("ME03 cannot turn low authenticity into a valid entry solely because price rose", () => {
  const f = newsFixture("ME03");
  f.result.events[0]!.authenticity.authority = 0;
  expect(one("ME03", f).passed).toBe(false);
});
it("archive immutability respects the independent capturedBy replay cutoff", () => {
  const rows = newsRows(),
    later = structuredClone(rows[0]!);
  later.versionId = "late-import";
  later.capturedAt = "2024-06-01T00:00:00Z";
  (later.value as { modelVersion: string }).modelVersion = "different-model";
  const req = { ...newsRequest, capturedBy: newsRequest.asOf };
  const before = evaluateGrowthFactors(req, rows, ["ME01"]),
    after = evaluateGrowthFactors(req, [...rows, later], ["ME01"]);
  expect(after).toEqual(before);
  expect(after.results[0]!.status).toBe("computed");
});
