import { beforeEach, expect, it, vi } from "vitest";
import type { ThsdkStatusView } from "../../../src/lib/settings/thsdk-settings";
import type {
  thsdkKlines,
  ThsdkKlineItem,
  ThsdkKlineResponse,
} from "../../../src/server/data-sources/thsdk/thsdk-adapter";
import {
  parseTencentChart,
  freeChartHistory,
  pytdxChartHistory,
  tencentChartHistory,
} from "../../../src/server/market/free-chart-sources";
const deps = vi.hoisted(() => ({
  page: vi.fn(),
  index: vi.fn(),
  query: vi.fn(),
  http: vi.fn(),
  thsdk: vi.fn<typeof thsdkKlines>(),
  thsdkStatus: vi.fn<() => ThsdkStatusView>(),
}));
vi.mock("../../../src/server/data-sources/thsdk/thsdk-adapter", () => ({
  thsdkKlines: deps.thsdk,
}));
vi.mock("../../../src/server/data-sources/thsdk/thsdk-auth", () => ({
  getThsdkStatus: deps.thsdkStatus,
}));
vi.mock("../../../src/server/market/chart-history", () => ({
  onlinePeriodHistory: deps.http,
}));
vi.mock("../../../src/server/data-sources/tdx/tdx-quotes", () => ({
  configuredHosts: () => ["127.0.0.1"],
  barPage: deps.page,
  indexBarPage: deps.index,
}));
vi.mock("tstdx", async (original) => ({
  ...(await original<typeof import("tstdx")>()),
  createTdxClient: () => ({
    barPage: deps.page,
    indexBarPage: deps.index,
    close: async () => {},
  }),
}));
vi.mock("../../../src/server/data-sources/westock/westock-data", () => ({
  westockScriptPath: () => "fixture-westock.js",
  query: deps.query,
}));
const row = {
  date: "2026-09-14",
  open: 10,
  last: 11,
  high: 12,
  low: 9,
  volume: 100,
  amount: 1000,
};
const defaultThsdkStatus: ThsdkStatusView = {
  enabled: false,
  configured: true,
  dllKnownVersion: "2.0.2",
  allowAutoFallback: false,
  authMode: "account",
  guestModeEnabled: false,
  hasSavedCredentials: false,
  state: "disabled",
  activeMode: null,
  authGeneration: 0,
  configRevision: "fixture",
  lastErrorCode: null,
  lastErrorMessage: null,
  circuitOpenUntil: null,
  updatedAt: 0,
};
const authenticatedThsdkStatus: ThsdkStatusView = {
  ...defaultThsdkStatus,
  enabled: true,
  configured: true,
  state: "authenticated",
  activeMode: "account",
};

function thsdkResponse(item: ThsdkKlineItem): ThsdkKlineResponse {
  return {
    version: "thsdk-adapter-1",
    source: "thsdk-hq",
    adjustment: "none",
    period: "day",
    limit: 3,
    end: row.date,
    currency: "CNY",
    volumeUnit: "股",
    delayed: true,
    fetchedAt: 0,
    warnings: [],
    items: [item],
  };
}

const thsdkBar = {
  date: row.date,
  open: row.open,
  high: row.high,
  low: row.low,
  close: row.last,
  volume: row.volume,
  amount: row.amount,
};
const thsdkSample = thsdkResponse({
  status: "ok",
  symbol: "sh600000",
  bars: [thsdkBar],
  historyExhausted: false,
  volumeUnit: "股",
});

beforeEach(() => {
  vi.resetAllMocks();
  deps.thsdkStatus.mockReturnValue(defaultThsdkStatus);
});
it("auto prefers tstdx and stops after the first valid source", async () => {
  deps.page.mockResolvedValue([{ ...row, close: row.last }]);
  expect((await freeChartHistory("sh600000", "day", 3)).source).toBe(
    "tdx-7709",
  );
  expect(deps.http).not.toHaveBeenCalled();
  expect(deps.query).not.toHaveBeenCalled();
});
it("auto falls back from tstdx to HTTP, then westock, retaining failures", async () => {
  const calls: string[] = [];
  deps.page.mockImplementation(async () => {
    calls.push("tstdx");
    throw Error("tdx down");
  });
  deps.http.mockImplementation(async () => {
    calls.push("http");
    return { bars: [{ ...row, close: row.last }], source: "eastmoney-online" };
  });
  expect((await freeChartHistory("sh600000", "day", 3)).source).toBe(
    "eastmoney-online",
  );
  expect(calls).toEqual(["tstdx", "http"]);
  expect(deps.query).not.toHaveBeenCalled();
  calls.length = 0;
  deps.http.mockImplementation(async () => {
    calls.push("http");
    throw Error("http down");
  });
  deps.query.mockImplementation(async () => {
    calls.push("westock");
    return [row];
  });
  const result = await freeChartHistory("sh600000", "day", 3);
  expect(calls).toEqual(["tstdx", "http", "westock"]);
  expect(result.source).toBe("tencent/westock-data");
  expect(result.sourceNote).toContain("tdx down");
  expect(result.sourceNote).toContain("http down");
});
it("manual tstdx failure never falls back", async () => {
  deps.page.mockRejectedValue(Error("tdx down"));
  await expect(freeChartHistory("sh600000", "day", 3, "pytdx")).rejects.toThrow(
    "tdx down",
  );
  expect(deps.http).not.toHaveBeenCalled();
  expect(deps.query).not.toHaveBeenCalled();
});
it("routes an explicit THSDK selection to its own unadjusted history", async () => {
  deps.thsdkStatus.mockReturnValue(authenticatedThsdkStatus);
  deps.thsdk.mockResolvedValueOnce(thsdkSample);
  await expect(
    freeChartHistory("sh600000", "day", 3, "thsdk"),
  ).resolves.toMatchObject({
    source: "thsdk-hq",
    bars: [thsdkBar],
    volumeUnit: "股",
    historyExhausted: false,
  });
  expect(deps.thsdk).toHaveBeenCalledOnce();
  expect(deps.thsdk.mock.calls[0]?.[0]).toMatchObject({
    symbols: ["sh600000"],
    period: "day",
    limit: 3,
  });
  expect(deps.thsdk.mock.calls[0]?.[0]?.adjustment ?? "none").toBe("none");
  expect(deps.page).not.toHaveBeenCalled();
  expect(deps.index).not.toHaveBeenCalled();
  expect(deps.http).not.toHaveBeenCalled();
  expect(deps.query).not.toHaveBeenCalled();
});

it("keeps an explicit THSDK failure on the selected provider", async () => {
  deps.thsdkStatus.mockReturnValue(authenticatedThsdkStatus);
  deps.thsdk.mockResolvedValueOnce(
    thsdkResponse({
      status: "unavailable",
      symbol: "sh600000",
      message: "请先登录同花顺",
      errorCode: "auth_required",
    }),
  );
  await expect(freeChartHistory("sh600000", "day", 3, "thsdk")).rejects.toThrow(
    /同花顺|THSDK/,
  );
  expect(deps.thsdk).toHaveBeenCalledOnce();
  expect(deps.page).not.toHaveBeenCalled();
  expect(deps.index).not.toHaveBeenCalled();
  expect(deps.http).not.toHaveBeenCalled();
  expect(deps.query).not.toHaveBeenCalled();
});

it.each([
  { enabled: false, allowAutoFallback: false, state: "disabled" },
  { enabled: true, allowAutoFallback: false, state: "authenticated" },
  { enabled: true, allowAutoFallback: true, state: "logged_out" },
] satisfies Partial<ThsdkStatusView>[])(
  "skips THSDK in auto with state $state and opt-in $allowAutoFallback",
  async (status) => {
    deps.thsdkStatus.mockReturnValue({
      ...defaultThsdkStatus,
      configured: status.enabled,
      ...status,
    });
    deps.page.mockRejectedValue(Error("tdx down"));
    deps.http.mockRejectedValue(Error("http down"));
    deps.query.mockRejectedValue(Error("westock down"));
    deps.thsdk.mockResolvedValue(thsdkSample);

    await expect(freeChartHistory("sh600000", "day", 3)).rejects.toThrow();
    expect(deps.page).toHaveBeenCalled();
    expect(deps.http).toHaveBeenCalled();
    expect(deps.query).toHaveBeenCalled();
    expect(deps.thsdk).not.toHaveBeenCalled();
  },
);

it("uses authenticated, opted-in THSDK only after tstdx, Eastmoney and Tencent fail", async () => {
  deps.thsdkStatus.mockReturnValue({
    ...authenticatedThsdkStatus,
    allowAutoFallback: true,
  });
  const calls: string[] = [];
  deps.page.mockImplementation(async () => {
    calls.push("tstdx");
    throw Error("tdx down");
  });
  deps.http.mockImplementation(async () => {
    calls.push("eastmoney");
    throw Error("http down");
  });
  deps.query.mockImplementation(async () => {
    calls.push("tencent");
    throw Error("westock down");
  });
  deps.thsdk.mockImplementation(async () => {
    calls.push("thsdk");
    return thsdkSample;
  });

  await expect(freeChartHistory("sh600000", "day", 3)).resolves.toMatchObject({
    source: "thsdk-hq",
    bars: [thsdkBar],
  });
  expect(calls).toEqual(["tstdx", "eastmoney", "tencent", "thsdk"]);
});
it("validates Tencent OHLC, dates, identity, empty output and structured errors", () => {
  expect(parseTencentChart([row], "sh600000", "day")[0]?.close).toBe(11);
  for (const raw of [
    [],
    { success: false, error: { code: "SKILL_006_2" } },
    [row, row],
    [{ ...row, date: "2026-02-30" }],
    [{ ...row, high: 8 }],
    [{ ...row, symbol: "sz000001" }],
    [{ ...row, amount: undefined }],
  ])
    expect(() => parseTencentChart(raw, "sh600000", "day")).toThrow();
});
it("requests unadjusted Tencent minute data and never hides the 2000 bar limit", async () => {
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse("2026-09-15T04:00:00Z"));
  try {
    deps.query.mockResolvedValue([{ ...row, date: "2026-09-14 14:55" }]);
    const result = await tencentChartHistory("sh600000", "5m", 4000);
    expect(deps.query.mock.calls[0]?.[1]).toEqual([
      "kline",
      "sh600000",
      "--period",
      "m5",
      "--limit",
      "2000",
      "--fq",
      "bfq",
      "--start",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      "--end",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    ]);
    expect(result.bars[0]?.date).toBe("2026-09-14T14:55:00+08:00");
    expect(result.historyExhausted).toBe(true);
    expect(result.sourceNote).toContain("2000");
  } finally {
    clock.mockRestore();
  }
});
it("uses index parsing for indices and rejects empty pytdx data", async () => {
  deps.index.mockResolvedValue([{ ...row, close: row.last }]);
  const result = await pytdxChartHistory("sh000001", "day", 100);
  expect(result.source).toBe("tdx-7709");
  expect(deps.index).toHaveBeenCalledWith("sh000001", "day", 0, 100);
  expect(deps.page).not.toHaveBeenCalled();
  deps.page.mockResolvedValue([]);
  await expect(pytdxChartHistory("sh600000", "day", 100)).rejects.toThrow(
    "未返回行情",
  );
});
