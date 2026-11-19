import { describe, expect, it } from "vitest";
import { createThsdkClient } from "~/server/data-sources/thsdk/thsdk-client";
import {
  THSDK_ALLOWED_READ_METHODS,
  THSDK_MUTATING_METHODS,
  decodeThsdkDayNumber,
  decodeThsdkPackedTime,
  deriveAccountMac,
  fromThsdkSecurity,
  isAllowedReadMethod,
  isMutatingMethod,
  sanitizeThsdkText,
  toThsdkSecurity,
  validateThsdkRequestJson,
} from "~/server/data-sources/thsdk/thsdk-contract";

it.each([
  ["sh600519", "USHA", "600519"],
  ["sz300033", "USZA", "300033"],
  ["sh510300", "USHJ", "510300"],
  ["sz159915", "USZJ", "159915"],
  ["sh000001", "USHI", "1A0001"],
  ["sz399001", "USZI", "399001"],
  ["bj830799", "USTA", "830799"],
  ["ths885001", "URFI", "885001"],
])("round-trips %s as %s/%s", (symbol, market, code) => {
  expect(toThsdkSecurity(symbol)).toEqual({ market, code });
  expect(fromThsdkSecurity({ market, code })).toBe(symbol);
});

it("rejects ambiguous or inconsistent native market and code pairs", () => {
  expect(fromThsdkSecurity({ market: "USHI", code: "000001" })).toBeNull();
  expect(fromThsdkSecurity({ market: "USHA", code: "510300" })).toBeNull();
  expect(fromThsdkSecurity({ market: "unknown", code: "600519" })).toBeNull();
  expect(() => toThsdkSecurity("600519")).toThrow(
    expect.objectContaining({ code: "invalid_request" }),
  );
});

// The common date contributes 126 × 2²⁰ + 11 × 2¹⁶ + 19 × 2¹¹ = 132880384.
// The three hour/minute contributions are 9×64+30, 15×64, and 14×64+35.
it.each([
  [132880990, "2026-11-19T09:30:00+08:00"],
  [132881344, "2026-11-19T15:00:00+08:00"],
  [132881315, "2026-11-19T14:35:00+08:00"],
])("decodes packed minute %i as %s", (packed, expected) => {
  expect(decodeThsdkPackedTime(packed)).toBe(expected);
});

it("rejects a packed time with minute 60", () => {
  expect(() => decodeThsdkPackedTime(132880384 + 9 * 64 + 60)).toThrow(
    expect.objectContaining({ code: "invalid_response" }),
  );
});

it.each([
  [20261119, "2026-11-19"],
  [20240229, "2024-02-29"],
])("decodes a daily trading date %i as %s", (day, expected) => {
  expect(decodeThsdkDayNumber(day)).toBe(expected);
});

it.each([20260229, 20260431, 20261100, 20261301, 20261119.5, 2026111])(
  "rejects invalid daily date %s",
  (day) => {
    expect(() => decodeThsdkDayNumber(day)).toThrow(
      expect.objectContaining({ code: "invalid_response" }),
    );
  },
);

// Pin the Wave 1 protocol names so a same-size substitution still fails.
const readMethods = [
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
];

const watchlistWrites = [
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
];

it("allows exactly the 70 Wave 1 read methods", () => {
  expect(THSDK_ALLOWED_READ_METHODS.size).toBe(70);
  expect(THSDK_ALLOWED_READ_METHODS).toEqual(new Set(readMethods));
  for (const method of readMethods) {
    expect(isAllowedReadMethod(method), method).toBe(true);
    expect(isMutatingMethod(method), method).toBe(false);
  }
  expect(isAllowedReadMethod("auth")).toBe(false);
  expect(isAllowedReadMethod("future_read_method")).toBe(false);
  expect(THSDK_MUTATING_METHODS.size).toBe(10);
  expect(THSDK_MUTATING_METHODS).toEqual(new Set(watchlistWrites));
});

it.each(watchlistWrites)(
  "forbids %s in both IPC dispatch channels",
  async (method) => {
    const client = createThsdkClient();
    const options = { dllPath: "", expectedSha256: "", sessionDir: "" };
    try {
      expect(isMutatingMethod(method)).toBe(true);
      expect(isAllowedReadMethod(method)).toBe(false);
      await expect(
        client.invokeRead(method, {}, options),
      ).rejects.toMatchObject({
        code: "method_forbidden",
      });
      await expect(
        client.invokeControl(method, {}, options),
      ).rejects.toMatchObject({
        code: "method_forbidden",
      });
      expect(client.getState()).toMatchObject({
        running: false,
        generation: 0,
      });
    } finally {
      await client.shutdown(1_200);
    }
  },
);

describe("request JSON", () => {
  const method = "search_securities";
  const maxBytes = 1024 * 1024;
  const invalid = expect.objectContaining({ code: "invalid_request" });

  it("bounds serialized UTF-8 bytes at exactly 1 MiB", () => {
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify({ method, params: "" }),
    );
    const payload = "中".repeat(Math.floor((maxBytes - envelopeBytes) / 3));
    const remaining = maxBytes - envelopeBytes - Buffer.byteLength(payload);
    const atLimit = payload + "a".repeat(remaining);
    expect(Buffer.byteLength(validateThsdkRequestJson(method, atLimit))).toBe(
      maxBytes,
    );
    expect(() => validateThsdkRequestJson(method, atLimit + "a")).toThrow(
      invalid,
    );
  });

  it("allows depth 64 and rejects depth 65", () => {
    // params starts at depth 1, and each array adds one level for its contents.
    let params: unknown = 0;
    for (let level = 0; level < 63; level++) params = [params];
    expect(JSON.parse(validateThsdkRequestJson(method, params))).toEqual({
      method,
      params,
    });
    expect(() => validateThsdkRequestJson(method, [params])).toThrow(invalid);
  });

  it.each([
    ["NaN", { limit: Number.NaN }],
    ["a NUL value", { query: "ABC\0DEF" }],
    ["a NUL field name", { "query\0": "ABC" }],
  ])("rejects %s before serializing it", (_label, params) => {
    expect(() => validateThsdkRequestJson(method, params)).toThrow(invalid);
  });
});

it("derives a deterministic, locally administered unicast MAC per account", () => {
  const mac = deriveAccountMac("fixture-user-a");
  expect(mac).toMatch(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/);
  expect(Number.parseInt(mac.slice(0, 2), 16) & 0b11).toBe(0b10);
  expect(deriveAccountMac("fixture-user-a")).toBe(mac);
  expect(deriveAccountMac("fixture-user-b")).not.toBe(mac);
});

it("redacts credentials, paths, URLs, cookies, MACs and control characters", () => {
  const path = "C:\\Fixture User\\thsdk\\hq.dll";
  const url = "https://fixture.invalid/path?token=url-fixture";
  const mac = "02:11:22:33:44:55";
  const source = [
    "worker error\u0007",
    'username="fixture-login", password="fixture secret", session_id=fixture-session',
    "Authorization: Bearer bearer-fixture",
    "Set-Cookie: first=cookie-fixture; second=extra-cookie",
    'dll_path="' + path + '"',
    "url=" + url,
    "adapter " + mac,
  ].join("\n");
  const safe = sanitizeThsdkText(source);
  expect(safe).toContain("worker error");
  expect(safe).toContain("[已脱敏路径]");
  expect(safe).toContain("[已脱敏链接]");
  expect(safe).toContain("[已脱敏 MAC]");
  for (const secret of [
    "fixture-login",
    "fixture secret",
    "fixture-session",
    "bearer-fixture",
    "cookie-fixture",
    "extra-cookie",
    path,
    url,
    mac,
  ]) {
    expect(safe).not.toContain(secret);
  }
  expect(safe).not.toMatch(/\p{Cc}/u);
});
