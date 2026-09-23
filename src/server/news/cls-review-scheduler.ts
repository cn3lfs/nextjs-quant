import { clsReviewConfigSchema } from "~/lib/news/cls-review-config";
import { get, put, sqlite } from "../db";
import { clsReportFiles, previewClsReport } from "./cls-report-files";
import { ClsReviewStore } from "./cls-review-store";
import { fixClsSample } from "./cls-review-service";
import { verifyClsSample } from "./cls-verification";

export const clsReviewConfig = () =>
  clsReviewConfigSchema.parse(get("cls-review-config") ?? {});
export type ClsReviewCheck = {
  checkedAt: number;
  status: "waiting" | "fixed" | "verified" | "missed" | "failed";
  message: string;
};
export const clsReviewLastCheck = () =>
  get<ClsReviewCheck>("cls-review-check") ?? null;
export const saveClsReviewConfig = (value: unknown) =>
  put(
    "cls-review-config",
    "cls-review-config",
    clsReviewConfigSchema.parse(value),
  );
const scope = globalThis as typeof globalThis & {
  clsReviewTick?: Promise<void>;
};
export function scheduleClsReview() {
  if (scope.clsReviewTick || !clsReviewConfig().enabled) return;
  scope.clsReviewTick = runClsReviewTick()
    .catch((error: unknown) => {
      put("cls-review-check", "cls-review-check", {
        checkedAt: Date.now(),
        status: "failed",
        message: error instanceof Error ? error.message : "财联社复盘检查失败",
      } satisfies ClsReviewCheck);
    })
    .finally(() => {
      scope.clsReviewTick = undefined;
    });
}
export async function runClsReviewTick() {
  const config = clsReviewConfig();
  if (!config.enabled) return;
  const now = Date.now();
  const local = new Date(now + 8 * 3600000).toISOString();
  const date = local.slice(0, 10),
    time = local.slice(11, 16);
  const store = new ClsReviewStore(sqlite());
  const errors: string[] = [];
  let status: ClsReviewCheck["status"] = "waiting",
    message = "等待盘前报告";
  if (time >= "08:00" && time < "09:30") {
    if (store.sample(date)) {
      status = "fixed";
      message = "今日样本已固定";
    } else {
      const files = await clsReportFiles(config.directory);
      const previews = [];
      for (const file of files) {
        try {
          const preview = await previewClsReport(file.path);
          if (
            preview.report.reportDate === date &&
            preview.batch?.phase === "morning" &&
            preview.batch.completedAt <= now
          )
            previews.push(preview);
        } catch (error) {
          errors.push(
            `${file.name}：${error instanceof Error ? error.message : "读取失败"}`,
          );
        }
      }
      previews.sort(
        (a, b) =>
          b.modifiedAt - a.modifiedAt ||
          a.sourcePath.localeCompare(b.sourcePath),
      );
      if (previews[0]) {
        const report = store.import(previews[0], previews[0].report.hash);
        const sample = await fixClsSample(report.id);
        status = "fixed";
        message = sample.selected
          ? `已固定 ${sample.selected.symbol}`
          : (sample.reason ?? "无候选");
      } else message = "尚无带完成标记的当日盘前报告";
    }
  } else if (time >= "09:30" && !store.sample(date)) {
    status = "missed";
    message = "今日未固定盘前样本，不补选";
  }
  if (time >= "15:05") {
    const rows = store.db
      .prepare(
        "SELECT payload FROM records WHERE kind='cls-review-sample' ORDER BY updated_at ASC",
      )
      .all() as { payload: string }[];
    let count = 0;
    for (const row of rows) {
      const sample = JSON.parse(row.payload) as {
        date: string;
        reportId: string;
      };
      if (sample.reportId && !store.report(sample.reportId)) continue;
      const latest = store.verifications(sample.date)[0];
      if (
        latest &&
        (now - latest.checkedAt < 15 * 60000 ||
          latest.outcomes.every((outcome) => outcome.status === "observed"))
      )
        continue;
      try {
        await verifyClsSample(sample.date);
        count++;
      } catch (error) {
        errors.push(
          `${sample.date}：${error instanceof Error ? error.message : "核对失败"}`,
        );
      }
    }
    if (count) {
      status = "verified";
      message += `；已核对${count}个样本`;
    }
  }
  if (errors.length) {
    if (status === "waiting") status = "failed";
    message += `；${errors.length}项失败：${errors.slice(0, 5).join("；")}`;
  }
  put("cls-review-check", "cls-review-check", {
    checkedAt: Date.now(),
    status,
    message,
  } satisfies ClsReviewCheck);
}
