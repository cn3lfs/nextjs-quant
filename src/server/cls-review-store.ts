import { createHash, randomUUID } from "node:crypto";
import { clsFactReviewSchema, type ClsFactReview } from "~/lib/cls-fact-review";
import type Database from "better-sqlite3";
import type { ClsReportPreview } from "./cls-report-files";
import type { ClsSample } from "./cls-sample";
import type { ClsVerification } from "./cls-verification";
import { clsOutcomeStatistics } from "./cls-outcomes";

export type ClsReportArchive = ClsReportPreview & {
  id: string;
  versionNumber: number;
  importedAt: number;
};
export class ClsReviewStore {
  constructor(
    readonly db: Database.Database,
    readonly limitBytes = 256 * 1024 * 1024,
  ) {}
  report(id: string) {
    const row = this.db
      .prepare(
        "SELECT payload FROM records WHERE id=? AND kind='cls-review-report'",
      )
      .get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as ClsReportArchive) : null;
  }
  exportReport(id: string) {
    const samples = (
      this.db
        .prepare(
          "SELECT payload FROM records WHERE kind='cls-review-sample' AND json_extract(payload,'$.reportId')=?",
        )
        .all(id) as { payload: string }[]
    ).map((row) => JSON.parse(row.payload) as ClsSample);
    return {
      report: this.report(id),
      facts: this.facts(id),
      samples: samples.map((sample) => ({
        sample,
        verifications: this.verifications(sample.date),
      })),
    };
  }
  removeReport(id: string) {
    return this.db
      .transaction(() => {
        const report = this.report(id);
        if (!report) return;
        const samples = this.exportReport(id).samples;
        for (const { sample } of samples) {
          // Retain a small immutable day reservation: deletion cannot enable reselection.
          const cleared: ClsSample = {
            ...sample,
            candidates: [],
            selected: null,
            reason: "原始报告及复盘证据已由用户清理，保留日期占位",
          };
          this.db
            .prepare(
              "UPDATE records SET payload=? WHERE id=? AND kind='cls-review-sample'",
            )
            .run(JSON.stringify(cleared), `cls-review-sample:${sample.date}`);
          this.db
            .prepare(
              "DELETE FROM records WHERE kind='cls-review-verification' AND json_extract(payload,'$.date')=?",
            )
            .run(sample.date);
        }
        this.db
          .prepare(
            "DELETE FROM records WHERE kind='cls-review-fact' AND json_extract(payload,'$.reportId')=?",
          )
          .run(id);
        this.db
          .prepare(
            "DELETE FROM records WHERE kind='cls-review-report' AND id=?",
          )
          .run(id);
      })
      .immediate();
  }
  facts(reportId: string) {
    return (
      this.db
        .prepare(
          "SELECT payload FROM records WHERE kind='cls-review-fact' AND json_extract(payload,'$.reportId')=? ORDER BY updated_at DESC,id DESC",
        )
        .all(reportId) as { payload: string }[]
    ).map((row) => JSON.parse(row.payload) as ClsFactReview);
  }
  saveFact(input: unknown) {
    const parsed = clsFactReviewSchema.parse(input);
    return this.db
      .transaction(() => {
        const section = this.report(parsed.reportId)?.report.sections.find(
          (item) => item.id === parsed.sectionId,
        );
        if (!section || !section.text.includes(parsed.quote))
          throw new Error("事实摘录不在原报告章节中");
        const value: ClsFactReview = {
          ...parsed,
          id: `cls-review-fact:${randomUUID()}`,
          reviewedAt: Date.now(),
        };
        const payload = JSON.stringify(value);
        const usage = this.db
          .prepare(
            "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM records WHERE kind LIKE 'cls-review-%'",
          )
          .get() as { bytes: number };
        if (usage.bytes + Buffer.byteLength(payload) > this.limitBytes)
          throw new Error("财联社复盘存储已达上限");
        this.db
          .prepare("INSERT INTO records VALUES (?,?,?,?)")
          .run(value.id, "cls-review-fact", payload, value.reviewedAt);
        return value;
      })
      .immediate();
  }
  reports(offset = 0) {
    return (
      this.db
        .prepare(
          "SELECT payload FROM records WHERE kind='cls-review-report' ORDER BY updated_at DESC,id DESC LIMIT 20 OFFSET ?",
        )
        .all(offset) as { payload: string }[]
    ).map((row) => JSON.parse(row.payload) as ClsReportArchive);
  }
  sample(date: string) {
    const row = this.db
      .prepare(
        "SELECT payload FROM records WHERE id=? AND kind='cls-review-sample'",
      )
      .get(`cls-review-sample:${date}`) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as ClsSample) : null;
  }
  verifications(date: string) {
    return (
      this.db
        .prepare(
          "SELECT payload FROM records WHERE kind='cls-review-verification' AND json_extract(payload,'$.date')=? ORDER BY updated_at DESC,id DESC",
        )
        .all(date) as { payload: string }[]
    ).map((row) => JSON.parse(row.payload) as ClsVerification);
  }
  outcomeSummary() {
    const rows = this.db
      .prepare(
        "SELECT payload FROM (SELECT payload, ROW_NUMBER() OVER (PARTITION BY json_extract(payload,'$.date') ORDER BY updated_at DESC,id DESC) AS position FROM records WHERE kind='cls-review-verification') WHERE position=1",
      )
      .all() as { payload: string }[];
    const outcomes = rows.flatMap(
      (row) => (JSON.parse(row.payload) as ClsVerification).outcomes,
    );
    return ([0, 1, 5, 10] as const).map((horizon) => ({
      horizon,
      ...clsOutcomeStatistics(outcomes, horizon),
    }));
  }
  saveVerification(value: ClsVerification) {
    return this.db
      .transaction(() => {
        const sample = this.sample(value.date);
        if (!sample || !this.report(sample.reportId))
          throw new Error("固定样本不存在或报告已清理");
        const id = `cls-review-verification:${value.date}:${value.hash}`;
        const existing = this.db
          .prepare(
            "SELECT payload FROM records WHERE id=? AND kind='cls-review-verification'",
          )
          .get(id) as { payload: string } | undefined;
        if (existing) return JSON.parse(existing.payload) as ClsVerification;
        const payload = JSON.stringify(value);
        const usage = this.db
          .prepare(
            "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM records WHERE kind LIKE 'cls-review-%'",
          )
          .get() as { bytes: number };
        if (usage.bytes + Buffer.byteLength(payload) > this.limitBytes)
          throw new Error("财联社复盘存储已达上限");
        this.db
          .prepare("INSERT INTO records VALUES (?,?,?,?)")
          .run(id, "cls-review-verification", payload, value.checkedAt);
        return value;
      })
      .immediate();
  }
  saveSample(sample: ClsSample) {
    return this.db
      .transaction(() => {
        const existing = this.sample(sample.date);
        if (existing) return existing;
        const report = this.report(sample.reportId);
        if (!report || report.report.hash !== sample.reportHash)
          throw new Error("样本报告依据不存在");
        const payload = JSON.stringify(sample);
        const usage = this.db
          .prepare(
            "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM records WHERE kind LIKE 'cls-review-%'",
          )
          .get() as { bytes: number };
        if (usage.bytes + Buffer.byteLength(payload) > this.limitBytes)
          throw new Error("财联社复盘存储已达上限");
        this.db
          .prepare("INSERT INTO records VALUES (?,?,?,?)")
          .run(
            `cls-review-sample:${sample.date}`,
            "cls-review-sample",
            payload,
            sample.fixedAt,
          );
        return sample;
      })
      .immediate();
  }
  import(preview: ClsReportPreview, expectedHash: string) {
    if (preview.report.hash !== expectedHash)
      throw new Error("报告已变化，请重新预览后导入");
    return this.db
      .transaction(() => {
        const sourceKey = preview.sourcePath.toLowerCase();
        const id = `cls-review-report:${createHash("sha256").update(`${sourceKey}\0${expectedHash}`).digest("hex")}`;
        const existing = this.report(id);
        if (existing) return existing;
        const versions = this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM records WHERE kind='cls-review-report' AND lower(json_extract(payload,'$.sourcePath'))=?",
          )
          .get(sourceKey) as { count: number };
        const value: ClsReportArchive = {
          ...preview,
          id,
          versionNumber: versions.count + 1,
          importedAt: Date.now(),
        };
        const payload = JSON.stringify(value);
        const usage = this.db
          .prepare(
            "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM records WHERE kind LIKE 'cls-review-%'",
          )
          .get() as { bytes: number };
        if (usage.bytes + Buffer.byteLength(payload) > this.limitBytes)
          throw new Error("财联社复盘存储已达上限，请导出并清理");
        this.db
          .prepare("INSERT INTO records VALUES (?,?,?,?)")
          .run(id, "cls-review-report", payload, value.importedAt);
        return value;
      })
      .immediate();
  }
}
