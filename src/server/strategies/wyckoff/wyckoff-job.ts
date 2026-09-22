import { createHash } from "node:crypto";
import type { Snapshot } from "~/lib/domain";
import { get, put } from "../../db";
import { settings } from "../../infra/settings";
import { researchModel } from "../../research/research";
import {
  isAStock,
  readTailSnapshot,
  readHistoricalSnapshot,
} from "../../data-sources/tdx/tdx";
import { localCalendarReference } from "../../market/data-health";
import { analyzeWyckoff } from "./wyckoff-report";
import { gatherWyckoffMarket } from "./wyckoff-market";
import { background, updateJob } from "../../jobs/jobs";

export function wyckoffJob(snapshotId: string, question: string) {
  const day = get<Snapshot>(snapshotId);
  if (
    !day ||
    day.period !== "day" ||
    day.adjustment !== "none" ||
    !isAStock(day.symbol)
  )
    throw new Error("请先加载A股不复权日线，再进行威科夫研究");
  question = question.trim();
  if (!question || question.length > 2000)
    throw new Error("请输入2000字以内的研究问题");
  const config = settings(),
    model = researchModel(),
    now = Date.now();
  const snapshotHash = createHash("sha256")
    .update(JSON.stringify(day))
    .digest("hex");
  return background(
    "research",
    { method: "wyckoff", contextId: snapshotId, question, model },
    async (job, signal) => {
      updateJob(job.id, { phase: "准备威科夫多周期资料", progress: 10 });
      const [minute, calendar, market] = await Promise.all([
        (day.historicalAsOf
          ? readHistoricalSnapshot(
              config.tdxRoot,
              day.symbol,
              "5m",
              6000,
              day.historicalAsOf,
            )
          : readTailSnapshot(config.tdxRoot, day.symbol, "5m", 6000)
        ).catch((error: unknown) => {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return null;
          throw error;
        }),
        localCalendarReference(config.tdxRoot, config.calendar),
        gatherWyckoffMarket(day, config.tdxRoot, now).catch(() => null),
      ]);
      signal.throwIfAborted();
      if (minute) put("snapshot", minute.id, minute);
      updateJob(job.id, { phase: "生成威科夫分阶段研究", progress: 30 });
      const report = await analyzeWyckoff(
        day,
        minute,
        calendar,
        question,
        signal,
        model,
        now,
        market,
      );
      signal.throwIfAborted();
      return {
        reportId: report.id,
        hourlySourceStatus: minute ? "loaded" : "missing-file",
      };
    },
    {
      method: "wyckoff",
      snapshotHash,
      question,
      model,
      root: config.tdxRoot,
      calendar: config.calendar,
    },
  );
}
