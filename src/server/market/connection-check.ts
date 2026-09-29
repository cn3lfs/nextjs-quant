import { access, open, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { Bar, Settings } from "~/lib/domain";
import {
  connectionConfiguration,
  type ConnectionCheckInput,
  type ConnectionCheckResult,
} from "~/lib/settings/connection-check";
import { parseBars } from "../data-sources/tdx/tdx";
import { tstdxKlines } from "../data-sources/tstdx/tstdx-adapter";
import { eastmoneyKlines } from "../data-sources/eastmoney/eastmoney-adapter";
import { westockKlines } from "../data-sources/westock/westock-adapter";
import { localCalendarReference, screenDataHealth } from "./data-health";
import { isPriceScaleThreeFund } from "~/lib/market/security-classification";

class CheckFailure extends Error {
  constructor(
    public kind: "empty" | "invalid" | "unavailable",
    message: string,
    public connection: "ok" | "error" | "unknown" = "unknown",
  ) {
    super(message);
  }
}

/** Read at most 64 records, using the existing parser and read-only descriptor. */
async function localSample(
  root: string,
  symbol: string,
  period: ConnectionCheckInput["period"],
) {
  if (!(await stat(root)).isDirectory())
    throw new CheckFailure("unavailable", "配置路径不是目录", "error");
  await access(root, constants.R_OK);
  const path = join(
    root,
    "vipdoc",
    symbol.slice(0, 2),
    period === "day" ? "lday" : "fzline",
    `${symbol}.${period === "day" ? "day" : "lc5"}`,
  );
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new CheckFailure(
        "unavailable",
        "目录可读，但未找到该证券与周期的行情文件",
        "ok",
      );
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size % 32)
      throw new CheckFailure("invalid", "行情文件记录不完整", "ok");
    const bytes = Buffer.alloc(Math.min(before.size, 64 * 32));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        before.size - bytes.length + offset,
      );
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat(),
      current = await stat(path);
    if (
      offset !== bytes.length ||
      [after, current].some(
        (s) =>
          s.size !== before.size ||
          s.mtimeMs !== before.mtimeMs ||
          s.ctimeMs !== before.ctimeMs ||
          s.birthtimeMs !== before.birthtimeMs ||
          s.ino !== before.ino ||
          s.dev !== before.dev,
      )
    )
      throw new CheckFailure(
        "unavailable",
        "行情文件正在更新，请稍后重试",
        "ok",
      );
    try {
      return parseBars(
        bytes,
        period,
        new Date().getFullYear(),
        isPriceScaleThreeFund(symbol) ? 3 : 2,
      );
    } catch {
      throw new CheckFailure("invalid", "行情样本格式或数值无效", "ok");
    }
  } finally {
    await handle.close();
  }
}

async function onlineSample(
  input: ConnectionCheckInput,
  signal: AbortSignal,
): Promise<Bar[]> {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const start = new Date(Date.parse(today) - 21 * 86400000)
    .toISOString()
    .slice(0, 10);
  const request = {
    symbols: [input.symbol],
    period: input.period,
    limit: 64,
    start,
    end: today,
  };
  const result =
    input.source === "pytdx"
      ? await tstdxKlines(request, signal)
      : input.source === "eastmoney"
        ? await eastmoneyKlines(request, signal)
        : await westockKlines(request, signal);
  signal.throwIfAborted();
  const item = result.items[0];
  if (!item || item.status !== "ok") {
    if (item?.reason === "empty") return [];
    const message = item?.message ?? "";
    if (/\b429\b|限流|too many requests/i.test(message))
      throw new CheckFailure(
        "unavailable",
        "来源限制请求频率，请稍后再检查",
        "ok",
      );
    if (/\b40[13]\b|unauthorized|forbidden/i.test(message))
      throw new CheckFailure(
        "unavailable",
        "来源拒绝访问，请核对服务访问权限",
        "ok",
      );
    if (/timeout|timed out|超时/i.test(message))
      throw new CheckFailure("unavailable", "来源响应超时，请稍后重试");
    // Adapter errors can contain URLs or credentials. Expose a fixed classification only.
    throw new CheckFailure(
      item?.status === "invalid" ? "invalid" : "unavailable",
      item?.status === "invalid"
        ? "来源返回的样本格式无效"
        : "来源未返回可用样本；可能是连接失败或该区间无数据",
      item?.status === "invalid" ? "ok" : "unknown",
    );
  }
  return item.bars;
}

export async function checkConnection(
  settings: Settings,
  input: ConnectionCheckInput,
  parentSignal?: AbortSignal,
): Promise<ConnectionCheckResult> {
  if (
    JSON.stringify(connectionConfiguration(settings)) !==
    JSON.stringify(input.configuration)
  )
    throw new Error("配置已更新，请刷新设置后重新检查");
  const started = Date.now();
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([controller.signal, parentSignal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), 10000);
  const result: ConnectionCheckResult = {
    ...input,
    checkedAt: started,
    elapsedMs: 0,
    connection: "unknown",
    data: "unavailable",
    freshness: "unknown",
    dataAsOf: null,
    referenceAsOf: null,
    referenceSource: "尚未核验",
    sampleCount: 0,
    message: "",
    nextAction: "",
  };
  let abortListener: (() => void) | undefined;
  try {
    const work = async () => {
      signal.throwIfAborted();
      const bars =
        input.source === "local"
          ? await localSample(settings.tdxRoot, input.symbol, input.period)
          : await onlineSample(input, signal);
      signal.throwIfAborted();
      const calendar = await localCalendarReference(
        settings.tdxRoot,
        settings.calendar,
      );
      signal.throwIfAborted();
      return {
        bars,
        health: screenDataHealth(
          bars.at(-1)?.date ?? null,
          input.period,
          started,
          calendar,
        ),
      };
    };
    const stopped = new Promise<never>((_, reject) => {
      abortListener = () => reject(new Error("check-aborted"));
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    });
    const { bars, health } = await Promise.race([work(), stopped]);
    Object.assign(result, {
      connection: "ok",
      data: bars.length ? "ok" : "empty",
      freshness: health.status,
      dataAsOf: health.dataAsOf,
      referenceAsOf: health.referenceAsOf,
      referenceSource: health.referenceSource,
      sampleCount: bars.length,
      message: bars.length
        ? "样本读取成功；仅代表所选证券与周期"
        : "连接可用，但样本为空",
      nextAction: !bars.length
        ? "核对证券、周期和数据下载范围后重试"
        : health.status === "lagging"
          ? "更新对应数据源后重新检查"
          : health.status === "unknown"
            ? "核对行情时点与交易日历；当前不能证明数据最新"
            : "样本与参考时点一致；全市场覆盖仍以扫描结果为准",
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    result.message = signal.aborted
      ? "检查已取消或超过 10 秒，请稍后重试"
      : error instanceof CheckFailure
        ? error.message
        : code === "ENOENT"
          ? "配置目录不存在"
          : code === "EACCES" || code === "EPERM"
            ? "无法读取目录或文件：权限不足"
            : "无法完成检查，请核对来源与配置";
    result.connection =
      error instanceof CheckFailure
        ? error.connection
        : code === "ENOENT" || code === "EACCES" || code === "EPERM"
          ? "error"
          : "unknown";
    result.data = error instanceof CheckFailure ? error.kind : "unavailable";
    result.nextAction =
      input.source === "local"
        ? "核对已保存目录和该证券的行情文件，然后重试"
        : "核对网络和该源支持范围，然后单独重试；不会自动切源";
  } finally {
    clearTimeout(timer);
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
  result.elapsedMs = Date.now() - started;
  return result;
}
