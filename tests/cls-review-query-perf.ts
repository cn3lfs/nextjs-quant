import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { ClsReviewStore } from "../src/server/news/cls-review-store";
import {
  clsReportPage,
  clsFactPage,
  clsVerificationPage,
} from "../src/server/news/cls-review-query";
const directory = process.env.QUANT_DATA_DIR;
const stress = process.argv.includes("--stress");
if (!directory?.includes("quant-cls-review"))
  throw new Error("Explicit isolated directory required");
const db = new Database(join(directory, "quant.sqlite"), { readonly: true });
try {
  const store = new ClsReviewStore(db);
  function measure(run: () => unknown) {
    for (let i = 0; i < 5; i++) run();
    const times = Array.from({ length: 30 }, () => {
      const start = performance.now();
      run();
      return performance.now() - start;
    }).sort((a, b) => a - b);
    return {
      p50: times[15],
      p95: times[28],
      jsonBytes: Buffer.byteLength(JSON.stringify(run())),
    };
  }
  const result = {
    reportsBefore: measure(() =>
      store.reports().map((row) => ({
        ...row,
        report: {
          ...row.report,
          markdown: undefined,
          sections: row.report.sections.map((section) => ({
            ...section,
            text: undefined,
          })),
        },
      })),
    ),
    reportsAfter: measure(() => clsReportPage(db, {})),
    factsBefore: measure(() => store.facts("cls-review-report:fixture-00000")),
    factsAfter: measure(() =>
      clsFactPage(db, {
        reportId: stress
          ? "cls-review-stress:report-0"
          : "cls-review-report:fixture-00000",
      }),
    ),
    verificationsBefore: measure(() => store.verifications("2020-01-01")),
    verificationsAfter: measure(() =>
      clsVerificationPage(db, { date: "2020-01-01" }),
    ),
    summary: measure(() => store.outcomeSummary()),
  };
  writeFileSync(
    join(
      tmpdir(),
      `logs/quant-cls-review/query-${stress ? "stress" : "comparison"}.json`,
    ),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  db.close();
}
