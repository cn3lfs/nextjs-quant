import { join } from "node:path";
import { z } from "zod";
import type { Bar } from "~/lib/domain";
import { thsdkSessionRoot } from "../../infra/paths";
import { ensureThsdkAuthenticated, getThsdkStatus } from "./thsdk-auth";
import { getThsdkClient } from "./thsdk-client";
import {
  THSDK_ADJUSTMENTS,
  THSDK_PERIODS,
  ThsdkError,
  toThsdkSecurity,
  type ThsdkErrorCode,
} from "./thsdk-contract";
import { inspectThsdkDllFile, ThsdkPathError } from "./thsdk-path";
import {
  THSDK_ADAPTER_VERSION,
  mapThsdkKlines,
  mapThsdkOrderBooks,
  mapThsdkPriceVolumeLevels,
  mapThsdkCallAuction,
  mapThsdkIntraday,
  mapThsdkDailyCapitalFlows,
  mapThsdkPopularityRank,
  thsdkVolumeUnit,
} from "./thsdk-mapper";

export { THSDK_ADAPTER_VERSION };
export type ThsdkInvoker = <T = unknown>(
  method: string,
  params: unknown,
  options?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<T>;
export type ThsdkKlineInput = {
  symbols: string[];
  period:
    "1m" | "5m" | "15m" | "30m" | "60m" | "120m" | "day" | "week" | "month";
  limit?: number;
  adjustment?: "none" | "qfq" | "hfq";
  start?: string;
  end?: string;
};
export type ThsdkKlineItem =
  | {
      symbol: string;
      status: "ok";
      bars: Bar[];
      historyExhausted: boolean;
      volumeUnit: string;
    }
  | {
      symbol: string;
      status: "unsupported" | "unavailable" | "invalid";
      message: string;
      reason?: "empty";
      errorCode?: ThsdkErrorCode;
    };
export type ThsdkKlineResponse = {
  version: string;
  source: "thsdk-hq";
  adjustment: "none" | "qfq" | "hfq";
  period: ThsdkKlineInput["period"];
  limit: number;
  start?: string;
  end: string;
  currency: "CNY";
  volumeUnit: string;
  delayed: true;
  fetchedAt: number;
  warnings: string[];
  items: ThsdkKlineItem[];
};

const messages: Record<ThsdkErrorCode, string> = {
  disabled: "同花顺数据源未启用",
  not_configured: "请先配置同花顺数据源",
  dll_invalid: "同花顺行情组件校验失败",
  handshake_failed: "同花顺行情组件握手失败",
  auth_required: "请先登录同花顺",
  auth_failed: "同花顺登录失败",
  session_expired: "同花顺会话已失效，请重新登录",
  session_locked: "同花顺会话正被占用",
  rate_limited: "同花顺限制请求频率，请稍后重试",
  timeout: "同花顺请求超时",
  cancelled: "同花顺请求已取消",
  no_data: "同花顺未返回该区间的样本",
  invalid_request: "同花顺请求参数无效",
  invalid_response: "同花顺样本格式或数值无效",
  method_forbidden: "同花顺不支持此读取操作",
  worker_crashed: "同花顺行情进程意外退出",
  circuit_open: "同花顺行情进程正在冷却",
  unavailable: "同花顺数据源暂时不可用",
};

function failure(code: ThsdkErrorCode) {
  return new ThsdkError(code, messages[code]);
}

// Authentication has already staged and loaded the DLL. Replacing that file
// on every quote would race the loader's open handle on Windows.
let loadedDll:
  | {
      generation: number;
      revision: string;
      dllPath: string;
      expectedSha256: string;
    }
  | undefined;
const authenticatedRead: ThsdkInvoker = async <T>(
  method: string,
  params: unknown,
  options?: { timeoutMs?: number; signal?: AbortSignal },
) => {
  const session = await ensureThsdkAuthenticated(options?.signal);
  const status = getThsdkStatus();
  if (
    status.authGeneration !== session.authGeneration ||
    status.state !== "authenticated"
  )
    throw failure("session_expired");
  if (
    loadedDll?.generation !== session.authGeneration ||
    loadedDll.revision !== status.configRevision
  ) {
    const inspected = inspectThsdkDllFile(status.dllPath);
    if (!inspected.knownVersion && !status.allowUnlistedHash)
      throw failure("dll_invalid");
    loadedDll = {
      generation: session.authGeneration,
      revision: status.configRevision,
      dllPath: join(thsdkSessionRoot(), "dll", inspected.sha256, "hq.dll"),
      expectedSha256: inspected.sha256,
    };
  }
  const data = await getThsdkClient().invokeRead<T>(method, params, {
    ...options,
    dllPath: loadedDll.dllPath,
    expectedSha256: loadedDll.expectedSha256,
    sessionDir: session.sessionDir,
  });
  if (getThsdkStatus().authGeneration !== session.authGeneration)
    throw failure("session_expired");
  return data;
};

async function read(
  method: string,
  params: unknown,
  signal?: AbortSignal,
  invoke: ThsdkInvoker = authenticatedRead,
) {
  try {
    if (signal?.aborted) throw failure("cancelled");
    const data = await invoke(method, params, { signal });
    if (signal?.aborted) throw failure("cancelled");
    return data;
  } catch (error) {
    if (signal?.aborted) throw failure("cancelled");
    if (error instanceof ThsdkError) throw failure(error.code);
    if (error instanceof ThsdkPathError) throw failure("dll_invalid");
    throw failure("unavailable");
  }
}

function shanghaiToday() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

function dateNumber(date: string) {
  if (!z.string().date().safeParse(date).success)
    throw failure("invalid_request");
  return Number(date.replaceAll("-", ""));
}

export async function thsdkKlines(
  input: ThsdkKlineInput,
  signal?: AbortSignal,
  invoke?: ThsdkInvoker,
): Promise<ThsdkKlineResponse> {
  const {
    symbols,
    period,
    start,
    end = shanghaiToday(),
    limit = 2000,
    adjustment = "none",
  } = input;
  const endDay = dateNumber(end);
  const startDay = start === undefined ? undefined : dateNumber(start);
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    (startDay !== undefined && startDay > endDay)
  )
    throw failure("invalid_request");
  const range =
    !period.endsWith("m") && (start !== undefined || input.end !== undefined);
  const bounds = range
    ? { start: startDay ?? 19000101, end: endDay }
    : { start: -limit, end: 0 };
  const adjust = {
    none: THSDK_ADJUSTMENTS.none,
    qfq: THSDK_ADJUSTMENTS.forward,
    hfq: THSDK_ADJUSTMENTS.backward,
  }[adjustment];
  const items: ThsdkKlineItem[] = [];
  for (const symbol of symbols) {
    let security;
    try {
      security = toThsdkSecurity(symbol);
    } catch {
      items.push({
        symbol,
        status: "unsupported",
        message: "同花顺不支持此证券",
      });
      continue;
    }
    try {
      const raw = await read(
        "list_security_k_lines",
        { security, period: THSDK_PERIODS[period], adjust, ...bounds },
        signal,
        invoke,
      );
      const all = mapThsdkKlines(raw, period);
      const bars = all
        .filter((bar) => {
          const day = bar.date.slice(0, 10);
          return (!start || day >= start) && (!input.end || day <= end);
        })
        .slice(-limit);
      if (!bars.length) throw failure("no_data");
      items.push({
        symbol,
        status: "ok",
        bars,
        historyExhausted: !range && all.length < limit,
        volumeUnit: thsdkVolumeUnit(symbol),
      });
    } catch (error) {
      const errorCode =
        error instanceof ThsdkError ? error.code : "invalid_response";
      items.push({
        symbol,
        status: errorCode === "invalid_response" ? "invalid" : "unavailable",
        errorCode,
        message: messages[errorCode],
        ...(errorCode === "no_data" ? { reason: "empty" } : {}),
      });
    }
  }
  const units = new Set(
    items.flatMap((item) => (item.status === "ok" ? [item.volumeUnit] : [])),
  );
  return {
    version: THSDK_ADAPTER_VERSION,
    source: "thsdk-hq",
    adjustment,
    period,
    limit,
    start,
    end,
    currency: "CNY",
    volumeUnit: units.size === 1 ? [...units][0]! : "见各证券单位",
    delayed: true,
    fetchedAt: Date.now(),
    warnings: [],
    items,
  };
}

export async function thsdkOrderBooks(
  symbols: string[],
  signal?: AbortSignal,
  invoke?: ThsdkInvoker,
) {
  const raw = await read(
    "list_security_order_books",
    { securities: symbols.map(toThsdkSecurity), depth: "5" },
    signal,
    invoke,
  );
  return mapThsdkOrderBooks(raw, symbols, Date.now());
}

export async function thsdkPriceVolumeLevels(
  symbol: string,
  signal?: AbortSignal,
  invoke?: ThsdkInvoker,
) {
  const raw = await read(
    "list_security_price_volume_levels",
    { security: toThsdkSecurity(symbol) },
    signal,
    invoke,
  );
  return mapThsdkPriceVolumeLevels(raw, symbol, Date.now());
}

export async function thsdkCallAuction(
  symbol: string,
  phase: "opening" | "closing" = "opening",
  date = shanghaiToday(),
  signal?: AbortSignal,
  invoke?: ThsdkInvoker,
) {
  dateNumber(date);
  const raw = await read(
    "list_security_call_auction_quotes",
    {
      security: toThsdkSecurity(symbol),
      phase,
      date: date + "T00:00:00+08:00",
    },
    signal,
    invoke,
  );
  return mapThsdkCallAuction(raw, symbol, phase, date, Date.now());
}

export async function thsdkIntraday(
  symbol: string,
  date?: string,
  signal?: AbortSignal,
  invoke?: ThsdkInvoker,
) {
  const raw = await read(
    "list_security_intraday_bars",
    {
      security: toThsdkSecurity(symbol),
      date: date === undefined ? "0" : String(dateNumber(date)),
    },
    signal,
    invoke,
  );
  return mapThsdkIntraday(raw, symbol, date, Date.now());
}

export async function thsdkDailyCapitalFlows(
  symbols: string[],
  signal?: AbortSignal,
  invoke?: ThsdkInvoker,
) {
  const raw = await read(
    "list_security_daily_capital_flows",
    { securities: symbols.map(toThsdkSecurity) },
    signal,
    invoke,
  );
  return mapThsdkDailyCapitalFlows(raw, symbols, Date.now());
}

export async function thsdkPopularityRank(
  symbol: string,
  signal?: AbortSignal,
  invoke?: ThsdkInvoker,
) {
  const raw = await read(
    "get_security_popularity_rank",
    { security: toThsdkSecurity(symbol) },
    signal,
    invoke,
  );
  return mapThsdkPopularityRank(raw, symbol, Date.now());
}
