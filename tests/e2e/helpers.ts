import type { CDPSession, Page } from "@playwright/test";
import budgets from "./perf-budgets.json" with { type: "json" };

export { budgets };

/** Chrome DevTools metrics after a forced GC. */
export async function metrics(page: Page, cdp?: CDPSession) {
  const session = cdp ?? (await page.context().newCDPSession(page));
  await session.send("Performance.enable");
  await session.send("HeapProfiler.collectGarbage");
  const { metrics } = await session.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value])) as Record<
    string,
    number
  >;
}

/** Sidebar pages, in navigation order (excluding the landing page). */
export const sidebarPages = [
  "/intraday",
  "/cls-review",
  "/market",
  "/screen",
  "/rps",
  "/limit-up",
  "/signals",
  "/crypto",
  "/futures",
  "/signal-ledger",
  "/trade-ledger",
  "/analysis",
  "/backtest",
  "/research",
  "/news",
  "/reports",
  "/tasks",
  "/settings",
] as const;

/** Clicks a sidebar link and waits until the page is idle. */
export async function visit(page: Page, path: string) {
  const link = page.locator(`a[href="${path}"]`).first();
  if (!(await link.count())) return false;
  await link.click();
  await page.waitForLoadState("networkidle");
  return true;
}

/** tRPC procedure names requested while `run` executes. */
export async function trpcCalls(page: Page, run: () => Promise<void>) {
  const calls: string[] = [];
  const listen = (r: { url(): string }) => {
    const url = r.url();
    if (url.includes("/api/trpc/"))
      calls.push(
        ...decodeURIComponent(url.split("/api/trpc/")[1]!.split("?")[0]!).split(
          ",",
        ),
      );
  };
  page.on("request", listen);
  try {
    await run();
  } finally {
    page.off("request", listen);
  }
  return calls;
}

/** tRPC headers the server requires from the workbench client. */
export const trpcHeaders = {
  "x-quant-client": "workbench",
  "x-trpc-source": "nextjs-react",
};
/** Polls a background job until it leaves queued/running; returns it. */
export async function waitForJob(
  page: Page,
  id: string,
  timeoutMs = 5 * 60 * 1000,
) {
  const input = encodeURIComponent(JSON.stringify({ json: { id } }));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await page.request.get(`/api/trpc/job?input=${input}`, {
      headers: trpcHeaders,
    });
    const job = (await response.json()).result?.data?.json as
      { status: string; error?: string } | undefined;
    if (job && !["queued", "running"].includes(job.status)) return job;
    await page.waitForTimeout(250);
  }
  throw new Error(`任务 ${id} 超时`);
}

/** The newest job of `type` created at or after `since` (epoch ms). */
export async function newJob(
  page: Page,
  type: string,
  since: number,
  timeoutMs = 30000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await page.request.get("/api/trpc/jobs", {
      headers: trpcHeaders,
    });
    const jobs = ((await response.json()).result?.data?.json ?? []) as {
      id: string;
      type: string;
      createdAt: number;
    }[];
    const job = jobs
      .filter((j) => j.type === type && j.createdAt >= since)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (job) return job.id;
    await page.waitForTimeout(200);
  }
  throw new Error(`未找到新的 ${type} 任务`);
}

/** Budgets assume an idle server: waits until no job is queued or running. */
export async function waitForIdleServer(page: Page, timeoutMs = 5 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await page.request.get("/api/trpc/jobs", {
      headers: trpcHeaders,
    });
    const jobs = ((await response.json()).result?.data?.json ?? []) as {
      status: string;
    }[];
    if (!jobs.some((j) => j.status === "queued" || j.status === "running"))
      return;
    await page.waitForTimeout(500);
  }
  throw new Error("服务端任务迟迟未结束");
}
