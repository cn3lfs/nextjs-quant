import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "./db";
import { runClsNewsBatch, clsWorkflowDirectory } from "./cls-news-workflow";
import { clsBatchPhaseSchema } from "~/lib/cls-batch";
import { saveClsReviewConfig } from "./cls-review-scheduler";
import { closeCzsc } from "./czsc";
import { z } from "zod";
import { get, put } from "./db";
import { settings, saveSettings } from "./settings";
import { runRpsObservation } from "./rps-observation-job";
import { downloadReady, requiresDownloadReceipt } from "./workflow-scheduler";
import { closeMcp } from "./tdx-mcp-disabled";
import { runCloseWorkflowFollowups } from "./close-workflow-followups";
// g4day 暂停（见 docs/decisions.md WF3）：增量任务入口一并停用，函数本身保留。
// import { runIncrementJob } from "./tdx-increment-job";
// import { readTdxLocalBlocks } from "./tdx-local-blocks";
import { publishFullDayPackage } from "./tdx-full-day-cache";
import { inspectFullDayPackage } from "./tdx-full-day-import";
import { historicalDateSchema } from "~/lib/historical-screen";
// import {
//   currentIncrementUniverse,
//   incrementalReferenceIndices,
//   runCloseIncrementWorkflow,
// } from "./close-increment-workflow";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--inspect-full-day" || args[0] === "--import-full-day") {
    const path = z.string().min(1).parse(args[1]);
    const symbols = z.string().min(1).parse(args[2]).split(",");
    if (args[0] === "--inspect-full-day") {
      const value = await inspectFullDayPackage(path, symbols);
      console.log(
        JSON.stringify({
          source: value.source,
          missing: value.missing,
          records: value.records.map((row) => ({
            symbol: row.symbol,
            hash: row.hash,
            count: row.bars.length,
            first: row.bars[0]?.date,
            last: row.bars.at(-1)?.date,
          })),
        }),
      );
      if (value.missing.length) process.exitCode = 2;
    } else {
      const snapshots = await publishFullDayPackage(
        path,
        symbols,
        Date.now(),
        args.includes("--repair-same-date"),
      );
      console.log(
        JSON.stringify({
          status: "imported",
          count: snapshots.length,
          snapshotIds: snapshots.map((value) => value.id),
        }),
      );
    }
    return;
  }
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
  // g4day 暂停（见 docs/decisions.md WF3）：收盘增量与全市场/A500 增量入口停用。
  // 全量包替换（--import-full-day）不受影响，仍是首选路径。
  // if (args[0] === "--close-rps-increment") {
  //   const result = await runCloseIncrementWorkflow();
  //   if (result.status === "complete") await runCloseWorkflowFollowups();
  //   console.log(JSON.stringify(result));
  //   if (result.status !== "complete") process.exitCode = 2;
  //   return;
  // }
  // if (args[0] === "--increment-hs") {
  //   const date = historicalDateSchema.parse(
  //     args[1] ?? new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
  //   );
  //   const symbols = [
  //     ...(await currentIncrementUniverse(settings().tdxRoot)),
  //     ...incrementalReferenceIndices,
  //   ];
  //   const result = await runIncrementJob(date, symbols, {
  //     force: args.includes("--force"),
  //     allowUnavailable: true,
  //   });
  //   console.log(JSON.stringify(result));
  //   if (result.status !== "published") process.exitCode = 2;
  //   return;
  // }
  // if (args[0] === "--increment-a500") {
  //   const date = historicalDateSchema.parse(
  //     args[1] ?? new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
  //   );
  //   const blocks = await readTdxLocalBlocks(settings().tdxRoot);
  //   const pool = blocks.blocks.find(
  //     (block) => block.category === "index" && block.name === "中证A500",
  //   );
  //   if (pool?.members.length !== 500) throw new Error("A500名单必须完整500只");
  //   const result = await runIncrementJob(date, pool.members, {
  //     force: args.includes("--force"),
  //   });
  //   console.log(
  //     JSON.stringify({
  //       status: result.status,
  //       date,
  //       count: pool.members.length,
  //       attempts: result.attempts,
  //       nextAttemptAt: result.nextAttemptAt,
  //       snapshotIds: result.snapshotIds,
  //       error: result.error,
  //     }),
  //   );
  //   if (result.status !== "published") process.exitCode = 2;
  //   return;
  // }
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
  // Only the close batch reads the downloaded daily files, so only it waits for
  // the package. Noon and late estimate today from online quotes.
  if (requiresDownloadReceipt(phase) && !(await downloadReady(date)))
    throw new Error("没有本次下载成功回执");
  const batch = await runRpsObservation(phase);
  if (phase === "close") {
    await runCloseWorkflowFollowups();
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
