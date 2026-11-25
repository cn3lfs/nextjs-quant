import { isCnEtfSymbol } from "quant-execution";
import { z } from "zod";
import type { RebalanceRecheckResult } from "~/server/db/rebalance-plan-repository";
import { stockEvents, type StockEvents } from "~/server/research/stock-events";

/**
 * 调仓票据的限售解禁提示：只查票据内个别 A 股买入标的，按标的串行、
 * 逐个短超时，绝不批量扫描全市场。结论仅作盘中提示，不阻断复检。
 */
export type TicketUnlockCheck = RebalanceRecheckResult["checks"][number];

export const UNLOCK_CHECK_WINDOW_DAYS = 10;
/** 票据买入标的通常不超过持仓上限；上限只防御异常输入，不扩大抓取。 */
const MAX_CHECK_SYMBOLS = 30;
const TOTAL_BUDGET_MS = 6000;
const PER_SYMBOL_TIMEOUT_MS = 2500;
const cnEquitySymbol = /^(sh|sz|bj)\d{6}$/;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const checkInputSchema = z.object({
  symbols: z.array(z.string().trim().min(1)).max(1000),
  executeDate: z.string().date(),
  windowDays: z.number().int().min(1).max(90).default(UNLOCK_CHECK_WINDOW_DAYS),
});
const unlockUnknownMessage = "限售解禁事件暂不可查，请人工核对";

function addCalendarDays(day: string, days: number) {
  return new Date(Date.parse(day + "T00:00:00Z") + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

// 读取方忽略取消信号时，由竞速确保票据仍能按时返回。
async function withinDeadline<T>(
  task: () => Promise<T>,
  deadline: AbortSignal,
) {
  if (deadline.aborted) throw new Error("限售解禁查询超时");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("限售解禁查询超时"));
    deadline.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(task), aborted]);
  } finally {
    if (onAbort) deadline.removeEventListener("abort", onAbort);
  }
}

function passed(symbol: string, windowDays: number): TicketUnlockCheck {
  return {
    code: "unlock",
    status: "passed",
    symbol,
    detail: `未来 ${windowDays} 日内无限售解禁`,
  };
}

export async function checkTicketUnlockEvents(input: {
  symbols: readonly string[];
  executeDate: string;
  windowDays?: number;
  signal?: AbortSignal;
  readEvents?: (symbol: string, signal?: AbortSignal) => Promise<StockEvents>;
}): Promise<TicketUnlockCheck[]> {
  const expiresAt = performance.now() + TOTAL_BUDGET_MS;
  const { symbols, executeDate, windowDays } = checkInputSchema.parse({
    symbols: input.symbols,
    executeDate: input.executeDate,
    windowDays: input.windowDays,
  });
  const horizonEnd = addCalendarDays(executeDate, windowDays);
  const targets = [...new Set(symbols)]
    .filter((symbol) => cnEquitySymbol.test(symbol) && !isCnEtfSymbol(symbol))
    .sort()
    .slice(0, MAX_CHECK_SYMBOLS);
  const readEvents = input.readEvents ?? stockEvents;
  const checks: TicketUnlockCheck[] = [];
  let budgetExpired = false;
  for (const symbol of targets) {
    // 外部取消时安静收尾，已得结果仍然返回，不向复检抛错。
    if (input.signal?.aborted) break;
    const remaining = expiresAt - performance.now();
    if (remaining <= 0) {
      budgetExpired = true;
      break;
    }
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(),
      Math.min(PER_SYMBOL_TIMEOUT_MS, Math.ceil(remaining)),
    );
    const deadline = input.signal
      ? AbortSignal.any([input.signal, timeout.signal])
      : timeout.signal;
    let data: StockEvents | undefined;
    try {
      data = await withinDeadline(() => readEvents(symbol, deadline), deadline);
    } catch {
      // Reader failures and individual timeouts leave this symbol unknown.
    } finally {
      clearTimeout(timer);
    }
    if (input.signal?.aborted) break;
    if (performance.now() >= expiresAt) {
      budgetExpired = true;
      break;
    }
    if (
      !data ||
      data.symbol !== symbol ||
      data.failures.some((failure) => failure.type === "unlock")
    ) {
      checks.push({
        code: "unlock",
        status: "unknown",
        symbol,
        detail: unlockUnknownMessage,
      });
      continue;
    }
    if (
      !dayPattern.test(data.since) ||
      !dayPattern.test(data.until) ||
      data.since > executeDate ||
      data.until < horizonEnd
    ) {
      checks.push({
        code: "unlock",
        status: "unknown",
        symbol,
        detail: "限售解禁覆盖区间不足，请人工核对",
      });
      continue;
    }
    const upcoming = data.events
      .filter(
        (event) =>
          event.type === "unlock" &&
          dayPattern.test(event.date) &&
          event.date >= executeDate &&
          event.date <= horizonEnd,
      )
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    checks.push(
      upcoming
        ? {
            code: "unlock",
            status: "warning",
            symbol,
            detail: `未来 ${windowDays} 日内存在限售解禁（${upcoming.date}：${upcoming.title}）`,
          }
        : passed(symbol, windowDays),
    );
  }
  if (budgetExpired) {
    checks.push({
      code: "unlock",
      status: "unknown",
      detail: "限售解禁检查超时，请人工核对",
    });
  }
  return checks;
}
