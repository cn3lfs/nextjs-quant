import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { parseClsReport } from "../../src/server/news/cls-report-parser";
import type { ClsReportArchive } from "../../src/server/news/cls-review-store";
import type { ClsSample } from "../../src/server/news/cls-sample";
import type { ClsVerification } from "../../src/server/news/cls-verification";

export const clsFixtureTime = Date.parse("2026-09-01T08:00:00+08:00");
export function clsFixtureReport(
  index: number,
  body = "合成证据，需人工核对。".repeat(100),
): ClsReportArchive {
  const report = parseClsReport(
    `# 合成报告 ${index}\n报告日期：2026-09-01\n### 行业观点\n方向：偏多\n${body}`,
  );
  return {
    id: `cls-review-report:fixture-${String(index).padStart(5, "0")}`,
    report: {
      ...report,
      reportDate: index % 7 === 0 ? null : report.reportDate,
    },
    sourcePath: `C:\\synthetic\\cls-${Math.floor(index / 3)}.md`,
    size: Buffer.byteLength(report.markdown),
    modifiedAt: clsFixtureTime,
    observedAt: clsFixtureTime,
    importedAt: clsFixtureTime + Math.floor(index / 3),
    versionNumber: (index % 3) + 1,
  };
}

/** Deterministic synthetic data only. Caller owns an isolated DB and its schema. */
export function seedClsReview(
  db: Database.Database,
  count = 1000,
  history = 10,
) {
  const insert = db.prepare(
    "INSERT INTO records(id,kind,payload,updated_at) VALUES (?,?,?,?)",
  );
  db.transaction(() => {
    for (let index = 0; index < count; index++) {
      const report = clsFixtureReport(index);
      insert.run(
        report.id,
        "cls-review-report",
        JSON.stringify(report),
        report.importedAt,
      );
      const date = new Date(Date.UTC(2020, 0, 1 + index))
        .toISOString()
        .slice(0, 10);
      const sample: ClsSample = {
        version: "cls-sample-1",
        date,
        reportId: report.id,
        reportHash: report.report.hash,
        fixedAt: Date.parse(`${date}T08:00:00+08:00`),
        previousTradingDay: "2019-12-31",
        calendarSource: "synthetic",
        poolHash: "synthetic",
        candidates: [],
        selected: null,
        reason: "合成无样本，非真实交易数据",
      };
      insert.run(
        `cls-review-sample:${date}`,
        "cls-review-sample",
        JSON.stringify(sample),
        sample.fixedAt,
      );
      for (let version = 0; version < history; version++) {
        const factId = `cls-review-fact:fixture-${index}-${version}`;
        insert.run(
          factId,
          "cls-review-fact",
          JSON.stringify({
            id: factId,
            reportId: report.id,
            sectionId: report.report.sections[0]!.id,
            quote: "合成证据",
            evidence: `合成依据${version}`,
            verdict: version % 2 ? "supported" : "unresolved",
            reviewedAt: clsFixtureTime + version,
          }),
          clsFixtureTime + version,
        );
        const verification: ClsVerification = {
          version: "cls-verification-1",
          date,
          checkedAt: clsFixtureTime + version,
          source: {
            root: "synthetic",
            benchmark: "synthetic",
            adjustment: "none",
          },
          hash: createHash("sha256")
            .update(`${index}:${version}`)
            .digest("hex"),
          bars: [],
          benchmark: [],
          calendar: [date],
          warnings: ["合成未复权价格观察，不是策略业绩"],
          outcomes: ([0, 1, 5, 10] as const).map((horizon) => ({
            horizon,
            date,
            exitDate: null,
            status: "unavailable",
            grossReturn: null,
            benchmarkReturn: null,
            excessReturn: null,
            hit: null,
            reason: "合成无样本",
          })),
        };
        insert.run(
          `cls-review-verification:${date}:${verification.hash}`,
          "cls-review-verification",
          JSON.stringify(verification),
          verification.checkedAt,
        );
      }
    }
  })();
}
