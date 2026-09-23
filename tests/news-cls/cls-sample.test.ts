import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../../src/server/db/migrations";
import { ClsReviewStore } from "../../src/server/news/cls-review-store";
import { parseClsReport } from "../../src/server/news/cls-report-parser";
import {
  buildClsSample,
  type ClsSampleCandidate,
} from "../../src/server/news/cls-sample";

it("locks one premarket sample with deterministic priority and rejects hindsight selection", () => {
  const db = new Database(":memory:");
  migrate(db);
  try {
    const store = new ClsReviewStore(db);
    const parsed = parseClsReport(
      "# 财联社\n**分析日期**：2026-09-11\n### 电子（方向：偏多 ｜ 信心：高）\n观察板块\n",
    );
    const now = Date.parse("2026-09-11T09:00:00+08:00");
    const imported = store.import(
      {
        sourcePath: "C:/sample.md",
        modifiedAt: now - 1000,
        observedAt: now - 500,
        size: 100,
        report: parsed,
      },
      parsed.hash,
    );
    const report = { ...imported, importedAt: now - 100 };
    const candidate: ClsSampleCandidate = {
      symbol: "sh600001",
      sectionId: parsed.sections[0]!.id,
      direction: "bullish",
      priority: 0,
      basis: "sector-rps",
      rps: 95,
      evidence: "previous-day-rps",
    };
    const input = {
      report,
      now,
      date: "2026-09-11",
      previousTradingDay: "2026-09-10",
      calendarSource: "fixture",
      isTradingDay: true,
      poolHash: "pool",
      candidates: [candidate, { ...candidate, symbol: "sh600000" }],
    };
    const sample = buildClsSample(input);
    expect(sample.selected?.symbol).toBe("sh600000");
    expect(sample.candidates).toHaveLength(2);
    expect(store.saveSample(sample)).toEqual(sample);
    const verification = {
      version: "cls-verification-1" as const,
      date: sample.date,
      checkedAt: now + 100,
      source: {
        root: "fixture",
        benchmark: "sh000001",
        adjustment: "none" as const,
      },
      bars: [],
      benchmark: [],
      calendar: [],
      outcomes: [],
      warnings: ["fixture"],
      hash: "first",
    };
    store.saveVerification(verification);
    store.saveVerification({ ...verification, checkedAt: now + 200 });
    expect(store.verifications(sample.date)).toEqual([verification]);
    store.saveVerification({
      ...verification,
      hash: "second",
      checkedAt: now + 300,
      outcomes: [
        {
          horizon: 0,
          date: sample.date,
          exitDate: sample.date,
          status: "observed",
          grossReturn: 0.1,
          benchmarkReturn: 0.02,
          excessReturn: 0.08,
          hit: true,
          reason: null,
        },
      ],
    });
    expect(store.verifications(sample.date)).toHaveLength(2);
    expect(store.verifications(sample.date)[1]).toEqual(verification);
    expect(store.outcomeSummary()[0]).toMatchObject({
      total: 1,
      valid: 1,
      hitRate: 1,
      meanExcessReturn: 0.08,
    });
    store.saveVerification({
      ...verification,
      hash: "third",
      checkedAt: now + 400,
      outcomes: [
        {
          horizon: 0,
          date: sample.date,
          exitDate: sample.date,
          status: "unavailable",
          grossReturn: null,
          benchmarkReturn: null,
          excessReturn: null,
          hit: null,
          reason: "修订后缺价",
        },
      ],
    });
    expect(store.outcomeSummary()[0]).toMatchObject({
      total: 1,
      valid: 0,
      unavailable: 1,
      hitRate: null,
    });
    expect(store.saveSample({ ...sample, selected: candidate })).toEqual(
      sample,
    );
    expect(() =>
      buildClsSample({
        ...input,
        now: Date.parse("2026-09-11T09:30:00+08:00"),
      }),
    ).toThrow("已开盘");
    expect(() =>
      buildClsSample({
        ...input,
        report: { ...report, report: { ...parsed, reportDate: "2026-09-10" } },
      }),
    ).toThrow("不是当日");
    expect(
      buildClsSample({ ...input, candidates: [{ ...candidate, rps: null }] })
        .selected,
    ).toBeNull();
    expect(
      buildClsSample({
        ...input,
        candidates: [
          candidate,
          {
            ...candidate,
            basis: "explicit-recommendation",
            symbol: "sz000001",
            rps: null,
          },
        ],
      }).selected?.symbol,
    ).toBe("sz000001");
    expect(
      store.exportReport(report.id).samples[0]?.verifications,
    ).toHaveLength(3);
    store.removeReport(report.id);
    expect(store.report(report.id)).toBeNull();
    expect(store.verifications(sample.date)).toEqual([]);
    expect(store.sample(sample.date)?.selected).toBeNull();
    expect(store.saveSample(sample).reason).toContain("清理");
    expect(() => store.saveVerification(verification)).toThrow("已清理");
  } finally {
    db.close();
  }
});
