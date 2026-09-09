import { createHash } from "node:crypto";
import { get, put } from "./db";
import { settings } from "./settings";
import { analyzeNews, type NewsAnalysis } from "./news-analysis";
import { readClsNews } from "./cls-news";
import { background, updateJob } from "./jobs";
import { newsBudget, reserveNewsBatch } from "./news-budget";

type CursorState = {
  next?: NewsAnalysis["nextInput"];
  retryAt: number;
  analysisId?: string;
  error?: string;
};
let active: { id?: string; started: boolean } | undefined;

// One bounded page per scheduler tick; revisit the recent window to catch late
// arrivals and corrected articles, while the item cache avoids repeated LLM work.
export function scheduleNews(now = Date.now()) {
  const config = settings();
  if (!config.autoNewsAnalysis) return;
  if (
    active &&
    !active.started &&
    active.id &&
    ["cancelled", "failed", "completed"].includes(
      get<{ status: string }>(active.id)?.status ?? "",
    )
  )
    active = undefined;
  if (active) return;
  const key =
    "news-consumer-" +
    createHash("sha256").update(config.clsDbPath).digest("hex");
  const state = get<CursorState>(key);
  if (state && state.retryAt > now) return;
  const flight = { started: false, id: undefined as string | undefined };
  active = flight;
  try {
    const job = background(
      "research",
      { kind: "automatic-news-analysis" },
      async (job, signal) => {
        flight.started = true;
        try {
          const input = state?.next ?? {
            cutoff: now,
            scope: "range" as const,
            maxItems: 50,
            historical: true,
          };
          const page = input.resumeId
            ? undefined
            : readClsNews(config.clsDbPath, { ...input, limit: 50 });
          if (page && !page.items.length) {
            put("news-consumer", key, {
              retryAt: now + 5 * 60000,
            } satisfies CursorState);
            return { empty: true };
          }
          const result = await analyzeNews(
            input,
            signal,
            (done, total) =>
              updateJob(job.id, {
                phase: `自动新闻分析 ${done}/${total}`,
                progress: Math.round((done / total) * 100),
              }),
            "background",
            reserveNewsBatch,
          );
          signal.throwIfAborted();
          const partial = result.status === "partial";
          put("news-consumer", key, {
            next: partial
              ? { ...result.input, resumeId: result.id }
              : result.nextInput,
            retryAt:
              partial && newsBudget().exhausted
                ? newsBudget().resetAt
                : now + (partial ? 15 : result.nextInput ? 1 : 5) * 60000,
            analysisId: result.id,
            error: partial
              ? newsBudget().exhausted
                ? "每日AI批次额度已用完，次日续跑。"
                : result.error
              : undefined,
          } satisfies CursorState);
          return result;
        } catch (error) {
          put("news-consumer", key, {
            ...state,
            retryAt: newsBudget().exhausted
              ? newsBudget().resetAt
              : Date.now() + 15 * 60000,
            error: newsBudget().exhausted
              ? "每日AI批次额度已用完，次日续跑。"
              : "自动新闻分析中断，15分钟后重试；已归档结果保留。",
          } satisfies CursorState);
          throw error;
        } finally {
          if (active === flight) active = undefined;
        }
      },
    );
    flight.id = job.id;
  } catch (error) {
    if (active === flight) active = undefined;
    throw error;
  }
}
