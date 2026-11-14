import { expect, it, vi } from "vitest";
import fixture from "../fixtures/binance-research-anomalies.json";
import {
  quarantineCryptoTimes,
  readCachedResearchCryptoWindow,
  readResearchCryptoWindow,
} from "~/server/research/validation-crypto-history";
import { cryptoKlines } from "~/server/market/bar-store/crypto-source";
import { readColumnCache } from "~/server/market/bar-store/column-cache";
import {
  parseBinanceKlines,
  BinanceNoKlinesError,
  BINANCE_KLINES_VERSION,
} from "~/server/data-sources/binance/binance-klines";
import { aggregateCryptoBars } from "~/lib/market/crypto-aggregation";
import { readBars } from "~/server/market/bar-store/read-bars";

vi.mock("~/server/market/bar-store/crypto-source", () => ({
  cryptoKlines: vi.fn(),
}));

it("treats a verified empty page before a known series as exhaustion, without accepting unknown or interior emptiness", async () => {
  const bars = ["2020-01-02T01:00:00+00:00", "2020-01-02T02:00:00+00:00"].map(
    (date) => ({ ...fixture.offGridHour, date }),
  );
  const input = {
    instrument: { market: "crypto" as const, symbol: "cxBNBUSDT" },
    period: "1h" as const,
    adjustment: "none" as const,
    cryptoSource: "binance" as const,
    from: "2020-01-01",
    to: "2020-01-02",
  };
  const callsBefore = vi.mocked(cryptoKlines).mock.calls.length;
  vi.mocked(cryptoKlines).mockResolvedValueOnce({
    version: BINANCE_KLINES_VERSION,
    source: "binance-spot",
    sourceUrl: fixture.source,
    bars,
    formingDates: [],
    historyExhausted: false,
    sourceNote: "QA",
    sourceErrors: [],
  });
  await readBars(input);
  vi.mocked(cryptoKlines).mockRejectedValueOnce(new BinanceNoKlinesError());
  const before = await readBars({ ...input, to: "2020-01-01T23:59:59.999Z" });
  expect(before.bars).toEqual([]);
  const cached = readColumnCache("crypto:cxBNBUSDT:1h:binance")!;
  expect(cached.bars).toEqual(bars);
  expect(cached.metadata.source.historyExhausted).toBe(true);
  expect((await readBars(input)).bars).toEqual(bars);
  expect(vi.mocked(cryptoKlines).mock.calls.length).toBe(callsBefore + 2);
  vi.mocked(cryptoKlines).mockRejectedValueOnce(new BinanceNoKlinesError());
  await expect(
    readBars({
      ...input,
      instrument: { market: "crypto", symbol: "cxADAUSDT" },
    }),
  ).rejects.toBeInstanceOf(BinanceNoKlinesError);
  vi.mocked(cryptoKlines).mockRejectedValueOnce(new BinanceNoKlinesError());
  await expect(
    readBars({
      ...input,
      to: "2020-01-02T01:59:59.999Z",
      now: Date.now() + 120000,
    }),
  ).rejects.toBeInstanceOf(BinanceNoKlinesError);
});

it("uses native Binance 15m only for the explicit research mode and retains the normal 5m source", async () => {
  const bar = {
    ...fixture.offGridHour,
    date: "2023-03-24T12:15:00+00:00",
    volume: 3,
    amount: 6,
  };
  const source = {
    version: "fixture-native-15m",
    source: "binance-spot",
    sourceUrl: fixture.source,
    formingDates: [],
    historyExhausted: true,
    sourceNote: "QA native 15m",
    sourceErrors: [],
  };
  vi.mocked(cryptoKlines).mockResolvedValueOnce({ ...source, bars: [bar] });
  const input = {
    instrument: { market: "crypto" as const, symbol: "cxETHUSDT" },
    period: "15m" as const,
    adjustment: "none" as const,
    cryptoSource: "binance" as const,
    from: "2023-03-24",
    to: "2023-03-24",
  };
  const native = await readResearchCryptoWindow(input);
  expect(vi.mocked(cryptoKlines).mock.calls.at(-1)![1]).toBe("15m");
  expect(native.snapshot.bars).toEqual([bar]);
  expect(readColumnCache("crypto:cxETHUSDT:15m:binance")!.bars).toEqual([bar]);
  vi.mocked(cryptoKlines).mockResolvedValueOnce({
    ...source,
    bars: [5, 10, 15].map((minute) => ({
      ...bar,
      date: `2023-03-24T12:${String(minute).padStart(2, "0")}:00+00:00`,
      volume: 1,
      amount: 2,
    })),
  });
  const standard = await readBars(input);
  expect(vi.mocked(cryptoKlines).mock.calls.at(-1)![1]).toBe("5m");
  expect(standard.bars).toEqual(native.snapshot.bars);
  await expect(
    readBars({ ...input, period: "1h", cryptoNative15m: true }),
  ).rejects.toThrow("Native 15m research requires");
});

it("retains the original off-grid record, quarantines it explicitly, and leaves price validation strict", async () => {
  const bars = [
    { ...fixture.offGridHour, date: "2023-03-24T12:00:00+00:00" },
    fixture.offGridHour,
    { ...fixture.offGridHour, date: "2023-03-24T14:00:00+00:00" },
  ];
  const original = structuredClone(bars);
  expect(() =>
    aggregateCryptoBars(bars, "1h", "1h", Date.parse("2023-03-25")),
  ).toThrow("数字货币聚合源行情无效");
  expect(quarantineCryptoTimes(bars, 3600000).excluded).toEqual([
    fixture.offGridHour,
  ]);
  vi.mocked(cryptoKlines).mockResolvedValueOnce({
    version: "fixture-binance",
    source: "binance-spot",
    sourceUrl: fixture.source,
    bars,
    formingDates: [],
    historyExhausted: true,
    sourceNote: "Fixed source anomaly",
    sourceErrors: [],
  });
  const result = await readResearchCryptoWindow({
    instrument: { market: "crypto", symbol: "cxBTCUSDT" },
    period: "1h",
    adjustment: "none",
    cryptoSource: "binance",
    from: "2023-03-24",
    to: "2023-03-24",
  });
  expect(result.quarantined).toEqual([fixture.offGridHour]);
  expect(result.snapshot.bars.map((b) => b.date)).toEqual([
    bars[0]!.date,
    bars[2]!.date,
  ]);
  expect(result.snapshot.barStore.excluded).toEqual([
    {
      date: fixture.offGridHour.date,
      reason:
        "币安原始收线时间不在周期网格，隔离原记录；不改写时间、不补造缺失bar",
    },
  ]);
  expect(readColumnCache("crypto:cxBTCUSDT:1h:binance")!.bars).toEqual(
    original,
  );
  expect(bars).toEqual(original);
  const calls = vi.mocked(cryptoKlines).mock.calls.length;
  const offline = await readCachedResearchCryptoWindow({
    instrument: { market: "crypto", symbol: "cxBTCUSDT" },
    period: "1h",
    adjustment: "none",
    cryptoSource: "binance",
    from: "2023-03-24",
    to: "2023-03-24",
  });
  expect(offline?.snapshot.bars).toEqual(result.snapshot.bars);
  expect(offline?.snapshot.hash).toBe(result.snapshot.hash);
  expect(vi.mocked(cryptoKlines).mock.calls.length).toBe(calls);
  expect(() => parseBinanceKlines([fixture.zeroDurationHour], "1h")).toThrow(
    "币安 K 线价格或时间无效",
  );
  const invalidPrice = [{ ...bars[0]!, close: -1 }];
  expect(() =>
    aggregateCryptoBars(
      quarantineCryptoTimes(invalidPrice, 3600000).accepted,
      "1h",
      "1h",
      Date.now(),
    ),
  ).toThrow("数字货币聚合源行情无效");
});
