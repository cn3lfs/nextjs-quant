import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "./db";
import { runClsNewsBatch, clsWorkflowDirectory } from "./cls-news-workflow";
import { clsBatchPhaseSchema } from "~/lib/cls-batch";
import { saveClsReviewConfig } from "./cls-review-scheduler";
import { runIntradayTick, intradayDependencies } from "./intraday-service";
import { analyzeCzsc, closeCzsc } from "./czsc";
import { z } from "zod";
import { get, put } from "./db";
import { settings, saveSettings } from "./settings";
import { runRpsObservation } from "./rps-observation-job";
import { downloadReady } from "./workflow-scheduler";
import { closeMcp } from "./mcp";
import { runClsReviewTick } from "./cls-review-scheduler";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--configure") {
    const config = settings();
    saveSettings({
      ...config,
      industryBlocksRoot: config.industryBlocksRoot || "D:\\wsWDZ\\Blocks",
    });
    saveClsReviewConfig({ enabled: true, directory: clsWorkflowDirectory() });
    put("workflow-config", "workflow-config", {
      enabled: true,
      configuredAt: Date.now(),
    });
    console.log(JSON.stringify({ status: "configured" }));
    return;
  }
  if (!get<{ enabled: boolean }>("workflow-config")?.enabled)
    throw new Error("每日工作流尚未启用");
  if (args[0] === "--news") {
    const phase = clsBatchPhaseSchema.parse(args[1]);
    const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const receipt = z
      .object({
        date: z.string(),
        phase: clsBatchPhaseSchema,
        exitCode: z.literal(0),
        completedAt: z.number(),
      })
      .parse(
        JSON.parse(
          (
            await readFile(
              join(dataDirectory(), `cls-collected-${date}-${phase}.json`),
              "utf8",
            )
          ).replace(/^\uFEFF/, ""),
        ),
      );
    if (
      receipt.date !== date ||
      receipt.phase !== phase ||
      receipt.completedAt > Date.now()
    )
      throw new Error("财联社采集完成回执无效");
    console.log(JSON.stringify(await runClsNewsBatch(phase)));
    return;
  }
  const phase = z.enum(["noon", "late", "close"]).parse(args[1]);
  if (args[0] !== "--phase") throw new Error("需要 --phase noon/late/close");
  const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  if (phase !== "late" && !(await downloadReady(date, phase)))
    throw new Error("没有本次下载成功回执");
  const batch = await runRpsObservation(phase);
  if (phase === "close") {
    await runIntradayTick(intradayDependencies(analyzeCzsc));
    await runClsReviewTick();
  }
  console.log(
    JSON.stringify({
      status: "complete",
      id: batch.id,
      phase,
      coverage: batch.coverage,
    }),
  );
}
void main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "每日工作流执行失败",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMcp();
    await closeCzsc();
  });
