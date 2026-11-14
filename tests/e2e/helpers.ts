import { expect, type CDPSession, type Page } from "@playwright/test";
import { z } from "zod";
import SuperJSON from "superjson";
import { navItems } from "../../src/components/workbench/navigation";
import budgets from "./perf-budgets.json" with { type: "json" };

export { budgets };

/** Chrome DevTools metrics after a forced GC. */
export async function metrics(page: Page, cdp?: CDPSession) {
  const session = cdp ?? (await page.context().newCDPSession(page));
  try {
    await session.send("Performance.enable");
    await session.send("HeapProfiler.collectGarbage");
    const { metrics } = await session.send("Performance.getMetrics");
    return Object.fromEntries(metrics.map((m) => [m.name, m.value])) as Record<
      string,
      number
    >;
  } finally {
    if (!cdp) await session.detach();
  }
}

/** Sidebar pages, in navigation order (excluding the landing page). */
export const sidebarPages = navItems
  .filter((item) => !item.hidden && item.href !== "/")
  .map((item) => item.href);

/** Clicks a sidebar link and waits until the page is idle. */
export async function visit(page: Page, path: string) {
  const link = page.locator(`a[href="${path}"]`).first();
  await expect(link, `Missing navigation entry: ${path}`).toBeVisible();
  await link.click();
  await expect(page).toHaveURL((url) => url.pathname === path);
  await page.waitForLoadState("networkidle");
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
const jobSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    createdAt: z.number(),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    error: z.string().optional(),
  })
  .passthrough();

async function localRead(page: Page, name: string, input?: unknown) {
  const query =
    input === undefined
      ? ""
      : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  const response = await page.request.get(`/api/trpc/${name}${query}`, {
    headers: trpcHeaders,
  });
  if (!response.ok()) throw new Error(`${name}: HTTP ${response.status()}`);
  const body = await response.json();
  if (body?.error || !body?.result?.data || !("json" in body.result.data))
    throw new Error(`${name}: invalid tRPC result`);
  return SuperJSON.deserialize(body.result.data) as unknown;
}
/** Polls task metadata, never the potentially large result/snapshot payload. */
export async function waitForJob(
  page: Page,
  id: string,
  timeoutMs = 5 * 60 * 1000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = jobSchema.parse(await localRead(page, "taskState", { id }));
    if (job.id !== id) throw new Error(`Unexpected job identity: ${job.id}`);
    if (!["queued", "running"].includes(job.status)) return job;
    await page.waitForTimeout(250);
  }
  throw new Error(`任务 ${id} 超时`);
}

/** Budgets assume an idle server: waits until no job is queued or running. */
export async function waitForIdleServer(page: Page, timeoutMs = 5 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const counts = z
      .object({
        running: z.number().int().nonnegative(),
        queued: z.number().int().nonnegative(),
      })
      .parse(await localRead(page, "taskOverview"));
    if (counts.running === 0 && counts.queued === 0) return;
    await page.waitForTimeout(500);
  }
  throw new Error("服务端任务迟迟未结束");
}
