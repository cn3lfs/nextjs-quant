import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import {
  clsReportPage,
  clsFactPage,
} from "../src/server/news/cls-review-query";
import { ClsReviewStore } from "../src/server/news/cls-review-store";
const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(directory.startsWith(resolve(tmpdir()) + "\\quant-cls-review-"));
const db = new Database(join(directory, "quant.sqlite"));
try {
  const page = clsReportPage(db, {});
  const noBody = (value: unknown) =>
    assert.ok(
      !JSON.stringify(value).includes('"markdown"'),
      "summary leaked markdown",
    );
  noBody(page);
  assert.throws(
    () =>
      noBody({
        ...page,
        items: page.items.map((item, index) =>
          index === 0 ? { ...item, markdown: "injected original text" } : item,
        ),
      }),
    /summary leaked/,
  );
  const facts = clsFactPage(db, { reportId: "cls-review-stress:report-0" });
  const fullDenominator = (value: typeof facts) =>
    assert.equal(
      value.statistics.reviewed,
      10000,
      "statistics must cover the full report",
    );
  fullDenominator(facts);
  assert.throws(
    () =>
      fullDenominator({
        ...facts,
        statistics: { ...facts.statistics, reviewed: facts.items.length },
      }),
    /full report/,
  );
  const store = new ClsReviewStore(db),
    original = store.report("cls-review-report:fixture-00000")!;
  assert.throws(
    () =>
      store.saveFact({
        reportId: original.id,
        sectionId: original.report.sections[0]!.id,
        quote: "合成事实00001。",
        evidence: "跨报告反例应拒绝",
        verdict: "supported",
      }),
    /事实摘录不在原报告章节中/,
  );
  const checks = [
    "real report summary passes; injected markdown makes same assertion fail",
    "real 10000-claim statistics pass; injected page-only denominator fails",
    "quote copied from stress report rejected by original report section",
  ];
  writeFileSync(
    join(tmpdir(), "logs/quant-cls-review/negative-controls.json"),
    JSON.stringify(
      {
        checks,
        note: "Scoped violating payloads and invalid save input; hidden-request negative control recorded separately",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(checks));
} finally {
  db.close();
}
