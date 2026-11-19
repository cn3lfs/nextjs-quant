import { createHash } from "node:crypto";
import { z } from "zod";
import {
  isAShareStockSymbol,
  isPriceScaleThreeFund,
} from "~/lib/market/security-classification";

export const THSDK_ABI_VERSION = "2.0.0";
export const THSDK_MAX_REQUEST_BYTES = 1024 * 1024;
export const THSDK_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const THSDK_MAX_JSON_DEPTH = 64;

export const THSDK_PERIODS = {
  "1m": 0x3001,
  "5m": 0x3005,
  "15m": 0x300f,
  "30m": 0x301e,
  "60m": 0x303c,
  "120m": 0x3078,
  day: 0x4000,
  week: 0x5001,
  month: 0x6001,
  quarter: 0x6003,
  year: 0x7001,
} as const;
export type ThsdkPeriodKey = keyof typeof THSDK_PERIODS;

export const THSDK_ADJUSTMENTS = {
  none: 0,
  forward: 1,
  backward: 2,
} as const;
export type ThsdkAdjustmentKey = keyof typeof THSDK_ADJUSTMENTS;

// thsdk 2.0.2 _method_manifest.py is the source of the native names and flags.
export const THSDK_MUTATING_METHODS: ReadonlySet<string> = new Set([
  "add_account_watchlist_group_securities",
  "add_account_watchlist_securities",
  "clear_account_watchlist",
  "create_account_watchlist_group",
  "delete_account_watchlist_group",
  "remove_account_watchlist_group_securities",
  "remove_account_watchlist_securities",
  "rename_account_watchlist_group",
  "replace_account_watchlist_group_securities",
  "replace_account_watchlist_securities",
]);

export const THSDK_ALLOWED_READ_METHODS: ReadonlySet<string> = new Set([
  "account_permissions",
  "analyze_security_limit_up",
  "calculate_security_realtime_statistics",
  "check_market_timeline_readiness",
  "get_account_watchlist",
  "get_account_watchlist_groups",
  "get_market_metadata",
  "get_market_security_names",
  "get_security_concept_tags",
  "get_security_industry",
  "get_security_popularity_rank",
  "get_security_price_limit_events",
  "get_security_short_term_highlights",
  "get_security_trading_timeline",
  "list_block_constituents",
  "list_block_descriptions",
  "list_commodity_stock_linkage_news",
  "list_futures_related_securities",
  "list_hot_block_calendar_events",
  "list_hot_event_news",
  "list_index_call_auction_quotes",
  "list_industry_children",
  "list_market_call_auction_unusual_events",
  "list_market_change_events",
  "list_market_securities",
  "list_market_short_term_events",
  "list_news_flash_items",
  "list_news_items",
  "list_related_security_performances",
  "list_securities_by_realtime_signal",
  "list_security_ah_relations",
  "list_security_block_memberships",
  "list_security_call_auction_quotes",
  "list_security_corporate_actions",
  "list_security_daily_capital_flows",
  "list_security_daily_k_lines_with_previous_close",
  "list_security_extended_hours_intraday_bars",
  "list_security_extended_hours_ticks",
  "list_security_financial_snapshots",
  "list_security_futures_relations",
  "list_security_industry_mappings",
  "list_security_intraday_bars",
  "list_security_k_lines",
  "list_security_link_relations",
  "list_security_news_events",
  "list_security_news_markers",
  "list_security_option_greeks",
  "list_security_order_books",
  "list_security_price_volume_levels",
  "list_security_research_reports",
  "list_security_ticks",
  "list_security_time_and_sales_ticks",
  "list_wencai_expression_fields",
  "list_wencai_hot_blocks",
  "query_wencai",
  "query_wencai_realtime_fields",
  "query_wencai_securities",
  "rank_block_securities",
  "rank_block_securities_by_industry",
  "rank_block_securities_by_wencai_field",
  "rank_constituents_by_performance_contribution",
  "rank_related_securities",
  "rank_securities_by_popularity",
  "rank_securities_by_realtime_statistic",
  "resolve_block",
  "resolve_securities",
  "resolve_wencai_securities",
  "search_securities",
  "sort_securities",
  "sort_securities_by_industry",
]);

export const THSDK_ALL_NATIVE_METHODS: readonly string[] = [
  ...THSDK_MUTATING_METHODS,
  ...THSDK_ALLOWED_READ_METHODS,
].sort();

export const THSDK_CONTROL_METHODS: ReadonlySet<string> = new Set([
  "version",
  "methods",
  "auth",
  "auth_qrcode",
  "logout",
  "_close",
]);

export function isMutatingMethod(method: string): boolean {
  return THSDK_MUTATING_METHODS.has(method);
}

export function isAllowedReadMethod(method: string): boolean {
  return THSDK_ALLOWED_READ_METHODS.has(method);
}

export const thsdkRawResponseSchema: z.ZodType<{
  ok: boolean;
  data?: unknown;
  error?: { code: string; message?: string; retry_after_ms?: number };
}> = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string().optional(),
      retry_after_ms: z.number().int().nonnegative().safe().optional(),
    })
    .optional(),
});

export const thsdkErrorCodes = [
  "disabled",
  "not_configured",
  "dll_invalid",
  "handshake_failed",
  "auth_required",
  "auth_failed",
  "session_expired",
  "session_locked",
  "rate_limited",
  "timeout",
  "cancelled",
  "no_data",
  "invalid_request",
  "invalid_response",
  "method_forbidden",
  "worker_crashed",
  "circuit_open",
  "unavailable",
] as const;
export type ThsdkErrorCode = (typeof thsdkErrorCodes)[number];

export class ThsdkError extends Error {
  constructor(
    public readonly code: ThsdkErrorCode,
    public readonly safeMessage: string,
    public readonly retryAfterMs?: number,
  ) {
    super(safeMessage);
    this.name = "ThsdkError";
  }
}

function isJsonFieldName(key: string): boolean {
  return key.length > 0 && !/[^a-z0-9_]/.test(key);
}

function ownJsonValue(object: object, key: string): unknown {
  const property = Object.getOwnPropertyDescriptor(object, key);
  if (!property || !("value" in property)) {
    throw new ThsdkError("invalid_request", "同花顺请求包含非 JSON 字段。");
  }
  return property.value;
}

export function validateThsdkRequestJson(
  method: string,
  params?: unknown,
  timeoutMs?: number,
): string {
  if (
    typeof method !== "string" ||
    method.length > 128 ||
    !isJsonFieldName(method)
  ) {
    throw new ThsdkError("invalid_request", "同花顺请求的方法名称无效。");
  }
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 600_000)
  ) {
    throw new ThsdkError("invalid_request", "同花顺请求的超时参数无效。");
  }

  const request = {
    method,
    ...(params === undefined ? {} : { params }),
    ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
  };
  const parts: string[] = [];
  let bytes = 0;

  function append(part: string) {
    bytes += Buffer.byteLength(part, "utf8");
    if (bytes > THSDK_MAX_REQUEST_BYTES) {
      throw new ThsdkError("invalid_request", "同花顺请求超过 1 MiB。");
    }
    parts.push(part);
  }

  function appendValue(value: unknown, depth: number) {
    if (depth > THSDK_MAX_JSON_DEPTH) {
      throw new ThsdkError(
        "invalid_request",
        "同花顺请求的 JSON 嵌套超过 64 层。",
      );
    }
    if (typeof value === "string") {
      if (value.includes("\0")) {
        throw new ThsdkError("invalid_request", "同花顺请求包含 NUL 字符。");
      }
      if (value.length > THSDK_MAX_REQUEST_BYTES - bytes) {
        throw new ThsdkError("invalid_request", "同花顺请求超过 1 MiB。");
      }
      append(JSON.stringify(value));
      return;
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      append(JSON.stringify(value));
      return;
    }
    if (Array.isArray(value)) {
      append("[");
      for (let index = 0; index < value.length; index++) {
        if (index > 0) append(",");
        appendValue(ownJsonValue(value, String(index)), depth + 1);
      }
      append("]");
      return;
    }
    if (typeof value !== "object" || value === null) {
      throw new ThsdkError("invalid_request", "同花顺请求包含非 JSON 值。");
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ThsdkError("invalid_request", "同花顺请求包含非 JSON 对象。");
    }
    append("{");
    let first = true;
    for (const key of Object.keys(value)) {
      if (!isJsonFieldName(key)) {
        throw new ThsdkError(
          "invalid_request",
          "同花顺请求字段必须使用 ASCII 小写 snake_case。",
        );
      }
      if (!first) append(",");
      first = false;
      append(`"${key}":`);
      appendValue(ownJsonValue(value, key), depth + 1);
    }
    append("}");
  }

  appendValue(request, 0);
  return parts.join("");
}

export type ThsdkSecurity = { market: string; code: string };

const symbolPrefixByMarket = {
  USHA: "sh",
  USZA: "sz",
  USHJ: "sh",
  USZJ: "sz",
  USHI: "sh",
  USZI: "sz",
  USTA: "bj",
  // THSDK block identifiers are distinct from TDX and Eastmoney sectors.
  URFI: "ths",
} as const;

function securityMarket(
  symbol: string,
): keyof typeof symbolPrefixByMarket | null {
  if (/^ths[0-9]{6}$/.test(symbol)) return "URFI";
  if (/^sh(?:000|93[0-9]|95[0-9])[0-9]{3}$/.test(symbol)) return "USHI";
  if (/^sz399[0-9]{3}$/.test(symbol)) return "USZI";
  if (isPriceScaleThreeFund(symbol)) {
    return symbol.startsWith("sh") ? "USHJ" : "USZJ";
  }
  if (!isAShareStockSymbol(symbol)) return null;
  if (symbol.startsWith("sh")) return "USHA";
  if (symbol.startsWith("sz")) return "USZA";
  return "USTA";
}

export function toThsdkSecurity(symbol: string): ThsdkSecurity {
  const normalized = symbol.trim().toLowerCase();
  const market = securityMarket(normalized);
  if (!market) {
    throw new ThsdkError("invalid_request", "同花顺证券代码或市场无效。");
  }
  const code =
    normalized === "sh000001"
      ? "1A0001"
      : normalized.slice(symbolPrefixByMarket[market].length);
  return { market, code };
}

export function fromThsdkSecurity(sec: ThsdkSecurity): string | null {
  if (sec.market === "USHI" && sec.code === "1A0001") return "sh000001";
  if (typeof sec.code !== "string" || !/^[0-9]{6}$/.test(sec.code)) return null;

  const market = sec.market as keyof typeof symbolPrefixByMarket;
  if (!Object.hasOwn(symbolPrefixByMarket, market)) return null;
  const symbol = symbolPrefixByMarket[market] + sec.code;
  // The Shanghai Composite has exactly one native representation.
  if (symbol === "sh000001") return null;
  return securityMarket(symbol) === market ? symbol : null;
}

function formatThsdkDate(year: number, month: number, day: number): string {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ThsdkError("invalid_response", "同花顺返回了无效日期。");
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new ThsdkError("invalid_response", "同花顺返回了无效日期。");
  }
  return date.toISOString().slice(0, 10);
}

export function decodeThsdkPackedTime(packed: number): string {
  if (!Number.isInteger(packed) || packed < 0 || packed > 0xffffffff) {
    throw new ThsdkError("invalid_response", "同花顺返回了无效分钟时间。");
  }
  const year = (packed >>> 20) + 1900;
  const month = (packed >>> 16) & 0xf;
  const day = (packed >>> 11) & 0x1f;
  const hour = (packed >>> 6) & 0x1f;
  const minute = packed & 0x3f;
  if (hour > 23 || minute > 59) {
    throw new ThsdkError("invalid_response", "同花顺返回了无效分钟时间。");
  }
  const date = formatThsdkDate(year, month, day);
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`;
}

export function decodeThsdkDayNumber(dayNum: number): string {
  if (!Number.isInteger(dayNum) || dayNum < 10_000_000 || dayNum > 99_999_999) {
    throw new ThsdkError("invalid_response", "同花顺返回了无效交易日。");
  }
  const year = Math.floor(dayNum / 10_000);
  const month = Math.floor(dayNum / 100) % 100;
  const day = dayNum % 100;
  return formatThsdkDate(year, month, day);
}

export function deriveAccountMac(username: string): string {
  const octets = createHash("sha256")
    .update("thsdk-account-mac-v1\0", "utf8")
    .update(username, "utf8")
    .digest()
    .subarray(0, 6);
  octets[0] = (octets[0]! & 0xfc) | 0x02;
  return Array.from(octets, (byte) => byte.toString(16).padStart(2, "0")).join(
    ":",
  );
}

export function sanitizeThsdkText(text: string): string {
  return (
    text
      .replace(/\b(?:https?|file):\/\/[^\s"'<>]+/gi, "[已脱敏链接]")
      .replace(
        /(["'])(?:[a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])[^\r\n]*?\1/gi,
        "[已脱敏路径]",
      )
      // Truncate an unquoted path at the end of its line, including space-bearing segments.
      .replace(
        /(?<![\w])(?:[a-z]:[\\/]|\\\\|\/(?=[\p{L}\p{N}._~-])|\.{1,2}[\\/])[^\r\n]*/giu,
        "[已脱敏路径]",
      )
      .replace(/(\b(?:set-cookie|cookie)\s*:\s*)[^\r\n]*/gi, "$1[已脱敏]")
      .replace(
        /((?:\b(?:username|user_name|user|login|account|password|passwd|pwd|ths_username|ths_password|secret|api[_-]?key|token|[a-z0-9_-]+[_-]token|authorization|cookie|session(?:[_-](?:id|dir|key|data))?|mac)\b|用户名|账号|密码|凭据|密钥|令牌)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:bearer|basic)\s+\S+|[^\s,;}\]]+)/gi,
        "$1[已脱敏]",
      )
      .replace(/\b(?:bearer|basic)\s+[a-z0-9+/_=.~-]+/gi, "[已脱敏凭据]")
      .replace(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, "[已脱敏 MAC]")
      .replace(/\p{Cc}/gu, " ")
      .trim()
  );
}

export type ThsdkWorkerInitMessage = {
  type: "init";
  id: number;
  dllPath: string;
  expectedSha256: string;
  parentPid: number;
};

export type ThsdkWorkerCallMessage = {
  type: "call";
  id: number;
  kind: "read" | "control";
  method: string;
  params?: unknown;
  timeoutMs: number;
};

export type ThsdkWorkerShutdownMessage = {
  type: "shutdown";
  id: number;
};

export type ThsdkWorkerMessage =
  ThsdkWorkerInitMessage | ThsdkWorkerCallMessage | ThsdkWorkerShutdownMessage;

export type ThsdkWorkerReply =
  | {
      id: number;
      ok: true;
      data?: unknown;
      abiVersion?: string;
      methodsCount?: number;
    }
  | {
      id: number;
      ok: false;
      errorCode: ThsdkErrorCode;
      safeMessage: string;
      retryAfterMs?: number;
    };
