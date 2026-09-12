import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { migrate } from "../src/server/db/migrations";
import {
  deriveTrackingStart,
  threeSegmentSample,
  threeSegmentAdmission,
  trackingUnavailableReason,
} from "../src/server/three-segment-sample";
import { admissionResearchFixture } from "./strategy-admission-fixture";
import { dailyPerformance } from "../src/lib/daily-performance";
import { researchSpecSchema } from "../src/lib/strategy-research";
import {
  admissionPageSchema,
  researchAdmissionSource,
  pageStrategyAdmission,
} from "../src/server/strategy-admission-service";
import {
  trackingDecayWarning,
  trackingDecayThreshold,
} from "../src/lib/three-segment-sample";
import { ThreeSegmentResults } from "../src/components/three-segment-results";
import { IntradayStore } from "../src/server/intraday-store";
import { SignalLedgerStore } from "../src/server/signal-ledger-store";

function ledger(
  db: Database.Database,
  date: string,
  strategyVersion = "dual-breakout-1",
) {
  new SignalLedgerStore(db).record(
    "sh600000",
    date,
    [date],
    [
      {
        id: `${strategyVersion}:${date}`,
        symbol: "sh600000",
        observedDate: date,
        endpointDate: "2020-01-01",
        strategy: "dual-breakout",
        strategyVersion,
        direction: "long",
        quality: "test",
        score: 1,
        evidence: "fixture",
        invalidation: "fixture",
        snapshotHash: "fixture",
        dllVersion: null,
        source: "tdx-local",
      },
    ],
  );
}
function preview(
  db: Database.Database,
  date: string,
  strategyVersion = "dual-breakout-1",
) {
  return new IntradayStore(db).record({
    sessionId: date,
    rpsDate: date,
    rps: 95,
    poolHash: "fixture",
    engineVersion: "unrelated-engine",
    observedAt: Date.parse(`${date}T00:30:00+08:00`),
    barCutoff: `${date}T00:00:00+08:00`,
    snapshotHash: "fixture",
    snapshot: {
      source: "tdx-local",
      adjustment: "none",
      symbol: "sh600000",
      bars: [],
    },
    signals: [
      {
        key: date,
        strategy: "dual-breakout",
        endpointDate: "2020-01-01",
        strategyVersion,
        evidence: "fixture",
      },
    ],
  });
}
function database() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

it("两处存储取更早观察交易日；只取精确版本，不取端点、回测或基线", () => {
  const db = database();
  try {
    expect(deriveTrackingStart(db, "dual-breakout-1")).toMatchObject({
      trackingStart: null,
      reason: trackingUnavailableReason,
    });
    ledger(db, "2026-09-10", "other");
    db.prepare("INSERT INTO records VALUES (?,?,?,?)").run(
      "fake",
      "research-result",
      JSON.stringify({ strategyVersion: "dual-breakout-1", observedAt: 1 }),
      1,
    );
    expect(deriveTrackingStart(db, "dual-breakout-1").trackingStart).toBeNull();
    ledger(db, "2026-09-11");
    expect(deriveTrackingStart(db, "dual-breakout-1").trackingStart).toBe(
      "2026-09-11",
    );
    preview(db, "2026-09-10");
    expect(deriveTrackingStart(db, "dual-breakout-1")).toMatchObject({
      trackingStart: "2026-09-10",
      reason: null,
      sources: { ledgerDate: "2026-09-11", previewDate: "2026-09-10" },
    });
    ledger(db, "2026-09-09");
    expect(deriveTrackingStart(db, "dual-breakout-1").trackingStart).toBe(
      "2026-09-09",
    );
    preview(db, "2026-09-08", "preview-only");
    expect(deriveTrackingStart(db, "preview-only").trackingStart).toBe(
      "2026-09-08",
    );
  } finally {
    db.close();
  }
});

it("无记录保持既有两段及 U8 数值，页面披露第三段不存在", async () => {
  const db = database();
  try {
    const { result, dataset } = await admissionResearchFixture();
    const before = JSON.stringify(result);
    const sample = threeSegmentSample(db, result, dataset);
    expect(sample.tracking).toBeNull();
    expect(sample.events).toEqual(result.events);
    expect(sample.segments.map((s) => s.partition)).toEqual([
      "development",
      "validation",
    ]);
    const page = admissionPageSchema.parse({});
    for (const partition of ["development", "validation"] as const) {
      const original = pageStrategyAdmission(
        researchAdmissionSource(result, dataset, partition),
        page,
        true,
      );
      const actual = threeSegmentAdmission(
        db,
        result,
        dataset,
        partition,
        page,
      ).page;
      expect(actual.history).toEqual(original.history);
      expect(actual.recent).toEqual({
        ...original.recent,
        trackingSegmentAvailable: false,
      });
      expect(actual.note).toContain(
        "近期窗口是按尾部天数截的，不是真实上线跟踪段",
      );
    }
    expect(JSON.stringify(result)).toBe(before);
    expect(
      renderToStaticMarkup(
        createElement(ThreeSegmentResults, { data: sample }),
      ),
    ).toContain(trackingUnavailableReason);
  } finally {
    db.close();
  }
});

it("严格重叠拒绝；等于验证起点可用；三段 17 项与 U1 同源，切片不重置本金", async () => {
  const db = database();
  try {
    const { result, dataset } = await admissionResearchFixture();
    const before = JSON.stringify(result);
    const validation = researchAdmissionSource(result, dataset, "validation");
    const date = validation.input.dates[2]!;
    ledger(db, date);
    const sample = threeSegmentSample(db, result, dataset);
    expect(sample.trackingStart).toBe(date);
    expect(sample.tracking!.returns).toEqual(
      validation.input.strategyDaily.slice(2),
    );
    for (const segment of sample.segments) {
      const direct = dailyPerformance({
        returns: segment.returns,
        annualRiskFreeRate: result.spec.annualRiskFreeRate,
      });
      for (const key of Object.keys(direct) as (keyof typeof direct)[])
        expect(segment[key]).toEqual(direct[key]);
    }
    for (let i = 0; i < result.events.length; i++)
      expect(sample.events[i]!.partition).toBe(
        result.events[i]!.partition === "validation" &&
          result.events[i]!.observedDate >= date
          ? "tracking"
          : result.events[i]!.partition,
      );
    expect(JSON.stringify(result)).toBe(before);
    const page = admissionPageSchema.parse({ params: { recentDays: 1 } });
    for (const partition of ["development", "validation"] as const) {
      const admission = threeSegmentAdmission(
        db,
        result,
        dataset,
        partition,
        page,
      );
      expect(admission.page.recent.trackingSegmentAvailable).toBe(true);
      expect(admission.page.recent.recentStartDate).toBe(date);
      expect(admission.page.recent.recentActualDays).toBe(2);
      expect(admission.exported.inputs[1]!.params.recentDays).toBe(2);
      expect(admission.exported.inputs[0]!.dates.every((d) => d < date)).toBe(
        true,
      );
    }
    ledger(db, result.spec.validationStart);
    expect(
      threeSegmentSample(db, result, dataset).trackingSegmentAvailable,
    ).toBe(true);
    ledger(db, result.spec.start);
    const overlap = threeSegmentSample(db, result, dataset);
    expect(overlap.trackingStart).toBe(result.spec.start);
    expect(overlap.overlap).toBe(true);
    expect(overlap.reason).toContain("样本重叠");
    expect(overlap.tracking).toBeNull();
    expect(overlap.events).toEqual(result.events);
    expect(
      threeSegmentAdmission(db, result, dataset, "validation", page).page.recent
        .trackingSegmentAvailable,
    ).toBe(false);
  } finally {
    db.close();
  }
});

it("跟踪起点晚于快照时保留真实日期和空窗口，不回退尾部", async () => {
  const db = database();
  try {
    const { result, dataset } = await admissionResearchFixture();
    ledger(db, "2099-01-05");
    const sample = threeSegmentSample(db, result, dataset);
    expect(sample.trackingStart).toBe("2099-01-05");
    expect(sample.tracking!.coverage.observedDays).toBe(0);
    expect(sample.tracking!.totalReturn.value).toBeNull();
    const recent = threeSegmentAdmission(
      db,
      result,
      dataset,
      "validation",
      admissionPageSchema.parse({}),
    ).page.recent;
    expect(recent.recentActualDays).toBe(0);
    expect(recent.recentStartDate).toBeNull();
  } finally {
    db.close();
  }
});

it("日期不可从规格注入，服务签名没有 trackingStart 覆盖，原始两段判定未改", () => {
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: "2026-01-01",
    validationStart: "2026-02-01",
    end: "2026-03-01",
    trackingStart: "2026-02-20",
  });
  expect(spec).not.toHaveProperty("trackingStart");
  const source = readFileSync("src/server/three-segment-sample.ts", "utf8");
  expect(source).not.toMatch(/trackingStart\s*\?:/);
  expect(source).not.toMatch(/(?:input|params|spec)\.trackingStart/);
  const signals = readFileSync("src/server/research-signals.ts", "utf8");
  expect(signals).toContain(
    'bar.date >= spec.validationStart\n          ? ("validation" as const)\n          : ("development" as const)',
  );
});

it("衰减只有提示，阈值在常量，无基线不提示", () => {
  const dev = dailyPerformance({ returns: [0.01, 0.02] });
  const tracking = dailyPerformance({ returns: [-0.01, 0] });
  expect(trackingDecayThreshold).toBe(0.3);
  expect(trackingDecayWarning(dev, tracking)).toContain("不构成判定");
  expect(trackingDecayWarning(dev, null)).toBeNull();
  expect(trackingDecayWarning(tracking, dev)).toBeNull();
  expect(trackingDecayWarning(dev, dev)).toBeNull();
  expect(
    trackingDecayWarning(
      { ...dev, informationRatio: { value: 1, reason: null } },
      { ...dev, informationRatio: { value: 0.5, reason: null } },
    ),
  ).toContain("IR");
});
