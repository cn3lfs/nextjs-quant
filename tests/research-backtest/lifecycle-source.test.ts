import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";
import { rankRps } from "quant-rps";
import type { Bar } from "trading-strategy-core/bars";
import { csi800SignalBars, type Csi800Stock } from "trading-strategies";
import type { MarketLowZoneInput } from "trading-strategies";
import { classicFinancialFeatures } from "trading-strategies";
import {
  financialMappingVersion,
  projectFinancialFields,
  type FinancialReportSnapshot,
} from "tstdx/financial-model";
import {
  buildLifecycleRps,
  lifecycleCryptoCoverage,
  lifecycleRpsPeriods,
  lifecycleLowZoneAxis,
  lifecycleFinancialValuations,
  loadLifecycleSource,
  lifecycleSupplementKey,
  readLifecycleSignalOriginBars,
  readLifecycleSourceManifest,
} from "~/server/research/lifecycle-source";
import { binanceArchiveSource } from "~/server/market/bar-store/binance-archive-source";
import { runPortfolio, actionPrice } from "quant-backtest";
import {
  parseGbbqFile,
  adjustmentFactors,
  applyAdjustment,
  applyAdjustmentAtAnchor,
} from "tstdx/local";
import { researchCorporateActions } from "~/server/research/corporate-actions";
import { lifecycleMainMenu } from "../../scripts/lib/research/lifecycle-menu";
import { lifecycleRequest } from "../../scripts/lib/research/lifecycle-runner";

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const daily = (start: string, n: number) =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10),
  );
const bar = (date: string, close = 10): Bar => ({
  date,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 100,
  amount: 1000,
});

it("all nine periods share one eligible frozen pool and reuse the exact quant-rps tie/rank policy", () => {
  const dates = daily("2020-01-01", 150);
  const stocks: Csi800Stock[] = ["a", "b", "c"].map((symbol, s) => ({
    symbol,
    actions: [],
    bars: dates.map((d, i) =>
      bar(d, s === 0 ? 10 + i : s === 1 ? 20 + 2 * i : 30 + i),
    ),
  }));
  // Missing only the 132-period endpoint excludes c from ALL period ranks.
  stocks[2]!.bars[0]!.volume = 0;
  const rps = buildLifecycleRps(stocks, dates);
  const point = rps.rpsBySymbol.get("a")![0]!;
  expect(point.periods).toEqual(lifecycleRpsPeriods);
  expect(rps.rpsBySymbol.get("c")![0]!.values).toEqual(Array(9).fill(null));
  expect(rps.audit.coverage[0]).toMatchObject({ eligible: 2, excluded: 1 });
  const expected = rankRps([
    {
      symbol: "a",
      return: stocks[0]!.bars[132]!.close / stocks[0]!.bars[112]!.close - 1,
    },
    {
      symbol: "b",
      return: stocks[1]!.bars[132]!.close / stocks[1]!.bars[112]!.close - 1,
    },
  ]);
  expect(point.values[1]).toEqual(expected.get("a"));
  expect(point.values[1]?.rank).toBe(1.5);
  const plain = {
    date: point.date,
    periods: point.periods,
    values: point.values,
  };
  expect({ ...point }).toEqual(plain);
  expect(structuredClone(point)).toEqual(plain);
  expect(JSON.parse(JSON.stringify(point))).toEqual(plain);
  expect(Object.getOwnPropertyDescriptor(point, "values")?.get).toBe(
    Object.getOwnPropertyDescriptor(rps.rpsBySymbol.get("b")![0]!, "values")
      ?.get,
  );
  const mutable = point.values;
  mutable[1]!.rps = -1000;
  expect(point.values[1]).toEqual(expected.get("a"));
  expect(rps.rankBytes.byteLength).toBe(3 * (150 - 132) * 9 * 4);
  const future = stocks.map((s) => ({
    ...s,
    bars: s.bars.map((b, i) =>
      i > 135
        ? {
            ...b,
            open: b.open * 3,
            high: b.high * 3,
            low: b.low * 3,
            close: b.close * 3,
          }
        : b,
    ),
  }));
  const changed = buildLifecycleRps(future, dates);
  expect(
    changed.rpsBySymbol
      .get("a")!
      .slice(0, 4)
      .map((p) => p.values),
  ).toEqual(
    rps.rpsBySymbol
      .get("a")!
      .slice(0, 4)
      .map((p) => p.values),
  );
  expect(() => buildLifecycleRps([...stocks, stocks[0]!], dates)).toThrow(
    "pool/calendar",
  );
  expect(() =>
    buildLifecycleRps(
      Array.from({ length: 3000 }, (_, i) => ({
        symbol: `budget-${i}`,
        bars: [],
        actions: [],
      })),
      daily("2000-01-01", 5000),
    ),
  ).toThrow("compact cache exceeds512MiB");
});

it("4h END labels require all six bars including next midnight and preserve interior missing days", () => {
  const days = daily("2020-01-01", 3);
  const bars = days.flatMap((d) =>
    Array.from({ length: 6 }, (_, i) =>
      bar(new Date(Date.parse(d) + (i + 1) * 4 * 3600000).toISOString()),
    ),
  );
  const absent = bars.filter((b) => b.date !== "2020-01-02T12:00:00.000Z");
  expect(lifecycleCryptoCoverage(absent, "4h")).toMatchObject({
    complete: [days[0], days[2]],
    missing: [days[1]],
    first: days[0],
    last: days[2],
  });
  expect(lifecycleCryptoCoverage(bars.slice(0, 5), "4h").complete).toEqual([]);
  expect(
    lifecycleCryptoCoverage(
      days.map((d) => bar(d)),
      "day",
    ).complete,
  ).toEqual(days);
  expect(() =>
    lifecycleCryptoCoverage([bar("2020-01-01T05:00:00Z")], "4h"),
  ).toThrow("Off-grid");
  expect(() => lifecycleCryptoCoverage([bars[0]!, bars[0]!], "4h")).toThrow(
    "duplicate",
  );
});

it("low-zone valuations reuse PIT financial numerators and actual same-date market caps without filling missing dates", () => {
  const reports: FinancialReportSnapshot[] = [
    ["2026-09-30", 16000],
    ["2025-12-31", 20000],
    ["2025-09-30", 12000],
  ].map(([date, profit]) => {
    const raw = new Array<number>(658).fill(0);
    raw[95] = Number(profit);
    raw[270] = 200000;
    return {
      symbol: "sh600000",
      reportDate: String(date),
      announcementDate: "2026-10-30",
      availableFrom: "2026-11-02",
      calendar: { hash: "QA", source: "QA" },
      financialCompany: false,
      sourceFilename: "QA",
      sourceSha256: "QA",
      contentSha256: "QA",
      recordOffset: 0,
      mappingVersion: financialMappingVersion,
      fields: projectFinancialFields(raw, false),
      warnings: [],
    };
  });
  const source = {
    version: "csi800-financial-1" as const,
    priceHash: hash("price"),
    reports: { sh600000: reports },
    caps: {
      sh600000: {
        "2026-11-01": 1000000,
        "2026-11-02": 1000000,
        "2026-11-03": null,
        "2029-01-01": 1000000,
      },
    },
    seriesSources: { sh600000: { hash: hash("GP16") } },
  };
  const values = lifecycleFinancialValuations(
    source,
    ["sh600000"],
    ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"],
    hash("financial"),
  );
  expect(values[0]).toMatchObject({ marketCap: 1000000, pe: null, pb: null });
  expect(values[1]?.pb).toBe(5);
  expect(values[1]?.pe).toBeCloseTo(1000000 / 24000);
  expect(values[2]).toMatchObject({ marketCap: null, pe: null, pb: null });
  expect(values.find((v) => v.date === "2026-11-04")).toBeUndefined();
  const reordered = ["2029-01-01", "2026-11-02", "2026-11-01", "2026-11-02"];
  const cached = lifecycleFinancialValuations(
    source,
    ["sh600000"],
    reordered,
    hash("financial"),
  );
  expect(cached.map((v) => [v.pe, v.pb])).toEqual(
    reordered.map((date) => {
      const numerators = classicFinancialFeatures(
        reports,
        date,
      )?.valuationNumerators;
      return [
        numerators?.["earnings-yield"]
          ? 1000000 / numerators["earnings-yield"]
          : null,
        numerators?.["book-to-price"]
          ? 1000000 / numerators["book-to-price"]
          : null,
      ];
    }),
  );
});

it("the low-zone source axis retains interior coverage gaps and never reduces the full membership denominator or borrows diagnostic constituents", () => {
  const dates = daily("2010-01-01", 2200).filter(
      (d) => ![0, 6].includes(new Date(d).getUTCDay()),
    ),
    bars = dates.map((d) => bar(d));
  const input: MarketLowZoneInput = {
    calendar: dates,
    index: {
      symbol: "sh000300",
      bars,
      source: "fixture300",
      hash: hash("300"),
    },
    stocks: ["a", "b"].map((symbol) => ({
      symbol,
      bars,
      source: "fixture",
      hash: hash(symbol),
    })),
    constituents: dates.map((date) => ({
      index: "sh000300",
      date,
      availableAt: "2026-11-07",
      basis: "current-labelled",
      symbols: ["a", "b"],
      source: "current labelled fixture",
      hash: hash("membership"),
    })),
    valuations: dates.flatMap((date) =>
      ["a", "b"].map((symbol) => ({
        date,
        availableAt: date,
        symbol,
        marketCap: 100,
        pe: date === "2015-04-01" ? null : 10,
        pb: 1,
        source: "fixture",
        hash: hash("valuations"),
      })),
    ),
  };
  const axis = lifecycleLowZoneAxis(input, 1000);
  expect(axis.dailyAxis[0]).toBe("2015-01-01");
  expect(axis.dailyAxis).toContain("2015-04-01");
  expect(axis.missing.join()).toContain("2015-04-01");
  expect(
    lifecycleLowZoneAxis(
      {
        ...input,
        valuations: input.valuations.filter((v) => v.symbol !== "b"),
      },
      1000,
    ).dailyAxis,
  ).toEqual([]);
  expect(
    lifecycleLowZoneAxis(
      {
        ...input,
        constituents: input.constituents.map((c) => ({
          ...c,
          index: "sh000001",
        })),
      },
      1000,
    ).dailyAxis,
  ).toEqual([]);
});

async function archive(
  root: string,
  symbol: string,
  period: "1d" | "4h",
  days: string[],
  missing?: string,
) {
  const directory = join(root, "data/spot/monthly/klines", symbol, period);
  await mkdir(directory, { recursive: true });
  const months = new Map<string, string[]>(),
    step = period === "1d" ? 86400000 : 4 * 3600000;
  for (const day of days)
    for (let i = 0; i < 86400000 / step; i++) {
      const open = Date.parse(day) + i * step;
      if (new Date(open + step).toISOString() === missing) continue;
      const rows = months.get(day.slice(0, 7)) ?? [];
      rows.push(
        [open, 10, 11, 9, 10, 100, open + step - 1, 1000, 1, 50, 500, 0].join(
          ",",
        ),
      );
      months.set(day.slice(0, 7), rows);
    }
  const files = [];
  for (const [month, rows] of months) {
    if (month === days.at(-1)!.slice(0, 7)) {
      const dailyDirectory = join(
        root,
        "data/spot/daily/klines",
        symbol,
        period,
      );
      await mkdir(dailyDirectory, { recursive: true });
      const buckets = new Map<string, string[]>();
      for (const row of rows) {
        const day = new Date(Number(row.split(",")[0]))
            .toISOString()
            .slice(0, 10),
          bucket = buckets.get(day) ?? [];
        bucket.push(row);
        buckets.set(day, bucket);
      }
      for (const [day, bucket] of buckets) {
        const name = `${symbol}-${period}-${day}.zip`,
          bytes = zipSync({
            [name.replace(".zip", ".csv")]: strToU8(bucket.join("\n")),
          }),
          path = join(dailyDirectory, name);
        await writeFile(path, bytes);
        await writeFile(path + ".CHECKSUM", `${hash(bytes)}  ${name}`);
        files.push({ path, sha256: hash(bytes) });
      }
      continue;
    }
    const name = `${symbol}-${period}-${month}.zip`,
      bytes = zipSync({
        [name.replace(".zip", ".csv")]: strToU8(rows.join("\n")),
      });
    await writeFile(join(directory, name), bytes);
    files.push({ path: join(directory, name), sha256: hash(bytes) });
    await writeFile(
      join(directory, name + ".CHECKSUM"),
      `${hash(bytes)}  ${name}`,
    );
  }
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ version: 1, symbol, interval: period, files }),
  );
}

it("the real frozen-file and native Binance adapters bind sources/axes before returns, retain gaps, and preserve bare menu identities", async () => {
  const root = join(process.env.QUANT_DATA_DIR!, "source-fixture"),
    binanceRoot = join(root, "native");
  await mkdir(root, { recursive: true });
  const industryRoot = join(root, "industry");
  await mkdir(join(industryRoot, "申万行业"), { recursive: true });
  await writeFile(join(industryRoot, "申万行业", "食品饮料.txt"), "SH600000\n");
  await writeFile(
    join(industryRoot, "申万行业", "饮料制造.txt"),
    "SH600000\nSZ000001\n",
  );
  const gbbqFixture = JSON.parse(
      await readFile("tests/fixtures/tdx-gbbq.json", "utf8"),
    ) as { gbbqBase64: string },
    gbbqBytes = Buffer.from(gbbqFixture.gbbqBase64, "base64"),
    gbbqPath = join(root, "fixture-gbbq.bin");
  await writeFile(gbbqPath, gbbqBytes);
  const gbbqEvents = parseGbbqFile(gbbqBytes).events;
  const dates = daily("1990-08-06", 600).filter(
    (d) => ![0, 6].includes(new Date(d).getUTCDay()),
  );
  const tdxRoot = join(root, "tdx"),
    indexDirectory = join(tdxRoot, "vipdoc/sh/lday");
  await mkdir(indexDirectory, { recursive: true });
  const nativeIndex = Buffer.alloc(3 * 32);
  dates.slice(0, 3).forEach((date, i) => {
    const at = i * 32;
    nativeIndex.writeUInt32LE(Number(date.replaceAll("-", "")), at);
    [1000, 1100, 900, 1000].forEach((v, n) =>
      nativeIndex.writeUInt32LE(v, at + 4 + n * 4),
    );
    nativeIndex.writeFloatLE(10000, at + 20);
    nativeIndex.writeUInt32LE(1000, at + 24);
  });
  for (const symbol of ["sh000300", "sh000001"])
    await writeFile(join(indexDirectory, `${symbol}.day`), nativeIndex);
  const stocks: Csi800Stock[] = ["sh600000", "sz000001", "sz000831"].map(
    (symbol, s) => {
      const actions = researchCorporateActions(
          gbbqEvents.get(symbol) ?? [],
          hash(gbbqBytes),
          dates[0]!,
          dates.at(-1)!,
        ),
        bars: Bar[] = [];
      let previous = 10;
      for (const [i, date] of dates.entries()) {
        if (s === 2 && i >= dates.length - 3) break;
        let open = previous;
        for (const action of actions.filter((a) => a.date === date))
          open = actionPrice(open, action);
        const close = open * (1 + Math.sin(i) / 1000);
        bars.push({
          date,
          open,
          high: Math.max(open, close) * 1.01,
          low: Math.min(open, close) * 0.99,
          close,
          volume: 1000,
          amount: close * 1000,
        });
        previous = close;
      }
      return {
        symbol,
        bars,
        actions: actions.map((a) => ({
          date: a.date,
          dividend: a.dividend,
          bonus: a.bonus,
          rights: a.rightsRatio,
          rightsPrice: a.rightsPrice,
          unsupported: false,
        })),
      };
    },
  );
  const priceBytes = Buffer.from(
    JSON.stringify({
      version: "fixed-source-fixture",
      stocks,
      benchmark: dates.map((d) => bar(d)),
      end: dates.at(-1),
    }),
  );
  const pricePath = join(root, "price.json"),
    panelPath = join(root, "panel.json.gz"),
    financialPath = join(root, "financial.json.gz");
  const firstSignal = dates[139]!,
    end = dates.at(-1)!,
    target = dates[145]!;
  const panelBytes = Buffer.from(
      JSON.stringify([
        { date: firstSignal, nextDate: dates[140], marketBudget: 1, rows: [] },
        { date: target, nextDate: end, marketBudget: 1, rows: [] },
      ]),
    ),
    panelZip = gzipSync(panelBytes),
    financial = gzipSync(
      JSON.stringify({
        version: "csi800-financial-1",
        priceHash: hash(priceBytes),
        reports: {},
        caps: {},
        seriesSources: {},
      }),
    );
  await writeFile(pricePath, priceBytes);
  await writeFile(panelPath, panelZip);
  await writeFile(financialPath, financial);
  const manifest = {
    inputs: {
      pricePath,
      priceHash: hash(priceBytes),
      financial: { path: financialPath, fileHash: hash(financial) },
    },
    panel: {
      path: panelPath,
      fileHash: hash(panelZip),
      contentHash: hash(panelBytes),
    },
    commonStart: dates[140],
    firstSignal,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest)),
    manifestPath = join(root, "manifest.json"),
    oraclePath = join(root, "oracle.json");
  await writeFile(manifestPath, manifestBytes);
  await writeFile(
    oraclePath,
    JSON.stringify({
      sourceManifestHash: hash(manifestBytes),
      inputHashes: [
        { path: pricePath, hash: hash(priceBytes) },
        { path: panelPath, hash: hash(panelZip) },
        { path: financialPath, hash: hash(financial) },
      ],
      panelContentHash: hash(panelBytes),
      commonStart: dates[140],
      firstSignal,
      finalDate: target,
    }),
  );
  const cnMain = lifecycleMainMenu().find(
    (m) => m.id === "l3-cn-swing-weekly-rps-open",
  )!;
  const mains = [
    cnMain,
    { id: "low", family: "cn-equity:low-zone", strategy: { period: "day" } },
    {
      id: "swing",
      family: "crypto:swing",
      strategy: {
        market: "crypto",
        period: "day",
        entry: { kind: "dual-ma", fast: 10, slow: 40 },
        overlay: { lookback: 60 },
        universe: { kind: "symbols", symbols: ["BTCUSDT", "ETHUSDT"] },
      },
    },
    {
      id: "breakout",
      family: "crypto:breakout",
      strategy: {
        market: "crypto",
        period: "4h",
        entry: { parameters: { N1: 40 } },
        overlay: { lookback: 60 },
        universe: { kind: "symbols", symbols: ["BTCUSDT", "ETHUSDT"] },
      },
    },
  ];
  const config = {
    main: mains,
    neighbors: [
      {
        parent: "swing",
        family: "crypto:swing",
        patch: { "strategy.entry.slow": 70 },
      },
    ],
    families: [...new Set(mains.map((m) => m.family))].map((family) => ({
      family,
    })),
    rankSource: { periods: lifecycleRpsPeriods },
    axes: { cnSwing: { start: dates[140], end }, crypto: {} },
    resources: { mutableOutputRoot: root },
  };
  const configBytes = Buffer.from(JSON.stringify(config)),
    configPath = join(root, "config.json");
  await writeFile(configPath, configBytes);
  const targetSymbols = ["sh600000", "sz000001"],
    captureSymbols = ["sh600000", "sh603083"],
    excluded = [
      {
        symbol: "sz000831",
        reason: "Unverified tail fixture; frozen execution exclusion only",
      },
    ];
  const pointer = async (name: string, value: unknown) => {
    const bytes = gzipSync(JSON.stringify(value)),
      path = join(root, `${name}.json.gz`),
      pointerPath = join(root, `${name}-pointer.json`);
    await writeFile(path, bytes);
    await writeFile(
      pointerPath,
      JSON.stringify({ path, sha256: hash(bytes), bytes: bytes.length }),
    );
    return { pointerPath, hash: hash(bytes) };
  };
  const rows = stocks.slice(0, 2).map((stock) => {
    const events = gbbqEvents.get(stock.symbol) ?? [],
      factors = adjustmentFactors(stock.bars, events),
      forward = applyAdjustment(stock.bars, factors, "forward");
    return {
      symbol: stock.symbol,
      sourceHash: hash(`normalized-${stock.symbol}`),
      adjustmentReference: `fixture:${end}:${factors.at(-1)!.factor}`,
      actions: researchCorporateActions(
        events,
        hash(gbbqBytes),
        dates[0]!,
        end,
      ),
      columns: stock.bars.map((b, i) => {
        const s = forward[i]!;
        return [
          b.date,
          b.open,
          b.high,
          b.low,
          b.close,
          b.volume,
          b.amount,
          s.open,
          s.high,
          s.low,
          s.close,
          s.volume,
          s.amount,
        ];
      }),
    };
  });
  await pointer("equity-0", [rows[0], { ...rows[1], symbol: "sh603083" }]);
  const equity = await pointer("equity", {
      eligible: captureSymbols,
      shards: ["equity-0"],
      audit: [
        ...captureSymbols.map((symbol) => ({
          symbol,
          accepted: true,
          reason: "normalized fixture",
        })),
        { ...excluded[0], accepted: false },
      ],
    }),
    roster = await pointer("roster", {
      constituents: ["sh600000", "sh603083", "sz000831"],
      symbols: captureSymbols,
      excluded,
    });
  const correctionPath = join(root, "source-correction.json");
  await writeFile(
    correctionPath,
    JSON.stringify({
      version: "lifecycle-source-correction-1",
      rawPrice: { sha256: hash(priceBytes), symbols: 3 },
      preregistrationSha256: hash(configBytes),
      execution: {
        equitySha256: equity.hash,
        rosterSha256: roster.hash,
        symbols: 2,
        rosterScopeMismatch: {
          rawOnly: ["sz000001"],
          captureOnly: ["sh603083"],
        },
      },
    }),
  );
  const derived = join(root, "derived");
  await mkdir(derived, { recursive: true });
  const supplementBytes = gzipSync(JSON.stringify([rows[1]])),
    supplementPath = join(
      derived,
      `supplement-sz000001-${hash(supplementBytes)}.json.gz`,
    );
  await writeFile(supplementPath, supplementBytes);
  await writeFile(
    join(
      derived,
      `supplement-sz000001-${lifecycleSupplementKey("sz000001", hash(priceBytes), hash(configBytes), dates[0]!, end)}.json`,
    ),
    JSON.stringify({
      path: supplementPath,
      sha256: hash(supplementBytes),
      bytes: supplementBytes.length,
      captureKey: lifecycleSupplementKey(
        "sz000001",
        hash(priceBytes),
        hash(configBytes),
        dates[0]!,
        end,
      ),
      origin: {
        kind: "fixed frozen supplement fixture",
        gbbqHash: hash(gbbqBytes),
      },
      quality: { gaps: [] },
    }),
  );
  const nativeDays = daily("2020-01-01", 80);
  for (const symbol of ["BTCUSDT", "ETHUSDT"])
    for (const period of ["1d", "4h"] as const)
      await archive(
        binanceRoot,
        symbol,
        period,
        nativeDays,
        symbol === "ETHUSDT" && period === "4h"
          ? "2020-03-10T12:00:00.000Z"
          : undefined,
      );
  const options = {
    expectedConfigHash: hash(configBytes),
    classicManifestPath: manifestPath,
    reconstructionPath: oraclePath,
    expectedRawPoolSize: 3,
    executionCapture: {
      equityPointerPath: equity.pointerPath,
      rosterPointerPath: roster.pointerPath,
      correctionPath,
      expectedEquityHash: equity.hash,
      expectedRosterHash: roster.hash,
      expectedExecutionCount: 2,
      excludedSymbols: ["sz000831"],
    },
    industryRoot,
    tdxRoot,
    gbbqPath,
    expectedGbbqHash: hash(gbbqBytes),
    decodeLowZoneFinancials: true,
    terminalStatusPath: null,
    lowZoneMembershipPath: null,
    binanceRoot,
    outputRoot: join(root, "derived"),
    now: Date.parse("2026-11-16T00:00:00Z"),
  };
  await expect(
    loadLifecycleSource(configPath, {
      ...options,
      expectedConfigHash: "0".repeat(64),
    }),
  ).rejects.toThrow("registration bytes");
  await writeFile(pricePath, Buffer.concat([priceBytes, Buffer.from(" ")]));
  await expect(loadLifecycleSource(configPath, options)).rejects.toThrow(
    "source hash mismatch",
  );
  await writeFile(pricePath, priceBytes);
  const normalizedPath = join(root, "equity-0.json.gz"),
    normalizedOriginal = await readFile(normalizedPath);
  await writeFile(
    normalizedPath,
    Buffer.concat([normalizedOriginal, Buffer.from(" ")]),
  );
  await expect(loadLifecycleSource(configPath, options)).rejects.toThrow(
    "normalized capture bytes/hash mismatch",
  );
  await writeFile(normalizedPath, normalizedOriginal);
  const source = await loadLifecycleSource(configPath, options);
  expect(await loadLifecycleSource(configPath, options)).toBe(source);
  expect(
    source.markets["cn-day"].request.instruments.map((i) => i.symbol),
  ).toEqual(targetSymbols);
  expect(source.markets["cn-day"].bookFacts.classicRiskSeries).toHaveLength(3);
  expect(source.markets["cn-day"].bookFacts.classicRiskSeries).toEqual(
    stocks.map((stock) => ({
      symbol: stock.symbol,
      bars: csi800SignalBars(stock).map(({ date, close }) => ({ date, close })),
    })),
  );
  expect(
    Object.keys(
      source.markets["cn-day"].bookFacts.classicRiskSeries![1]!.bars[0]!,
    ),
  ).toEqual(["date", "close"]);
  expect(
    source.markets["cn-day"].bookFacts.classicRiskSeries![0]!.bars[150]!.close,
  ).toBe(stocks[0]!.bars[150]!.close);
  const origin = source.markets["cn-day"].signalBasis!.origins.find(
      (o) => o.symbol === "sz000001",
    )!,
    original = stocks[1]!.bars,
    expectedSignal = applyAdjustmentAtAnchor(
      original,
      adjustmentFactors(original, gbbqEvents.get("sz000001") ?? []),
      { date: original[0]!.date, factor: 1 },
    );
  expect(source.markets["cn-day"].request.instruments[1]!.signalBars).toEqual(
    expectedSignal,
  );
  expect(await readLifecycleSignalOriginBars(origin)).toEqual(original);
  expect(
    (await readLifecycleSourceManifest(source.manifestPath, source.inputHash))
      .inputHash,
  ).toBe(source.inputHash);
  expect(source.markets["cn-day"].missing).toEqual([]);
  const request = lifecycleRequest(source, cnMain, {
    start: dates[140]!,
    end,
    scenario: "base",
  });
  expect(request.strategies[0]!.universe.kind).toBe("pool");
  expect(
    request.memberships?.some(
      (m) => m.strategyId === cnMain.id && m.symbols.length === 2,
    ),
  ).toBe(true);
  const actual = runPortfolio(request);
  expect(actual.fills.length).toBeGreaterThan(0);
  expect(actual.corporateActions.some((a) => a.date === "1991-05-02")).toBe(
    true,
  );
  await mkdir(join(root, "checkpoints"), { recursive: true });
  await mkdir(join(root, "reports"), { recursive: true });
  // A later local-source revision must not silently resample frozen GBBQ.
  await writeFile(gbbqPath, Buffer.from("changed live source"));
  for (const symbol of ["sh000300", "sh000001"])
    await writeFile(
      join(indexDirectory, `${symbol}.day`),
      Buffer.from("changed local index"),
    );
  vi.resetModules();
  const cold = await import("~/server/research/lifecycle-source");
  const resumed = await cold.loadLifecycleSource(configPath, {
    ...options,
    now: options.now + 1000,
  });
  expect(resumed.inputHash).toBe(source.inputHash);
  expect(resumed.frozenAt).toBe(source.frozenAt);
  expect(resumed.markets["cn-day"].signalBasis).toEqual(
    source.markets["cn-day"].signalBasis,
  );
  expect(resumed.lowZoneSources.indices).toEqual(source.lowZoneSources.indices);
  expect(source.lowZoneSources.indices[0]!.sourceHash).toBe(hash(nativeIndex));
  expect(source.lowZoneSources.indices[0]!.archive?.hash).toMatch(
    /^[a-f0-9]{64}$/,
  );
  const metrics = (await readFile(join(root, "source-memory.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { stage: string; nativeMaxRss: number });
  expect(metrics.some((m) => m.stage === "rps:shared-view")).toBe(true);
  expect(metrics.some((m) => m.stage === "source:complete")).toBe(true);
  expect(metrics.some((m) => m.stage === "financial:decoded")).toBe(true);
  expect(metrics.every((m) => m.nativeMaxRss <= 4096 * 1024 ** 2)).toBe(true);
  expect(source.markets["cn-day"].request.instruments[0]!.bars).toHaveLength(
    dates.length,
  );
  expect(
    source.markets["cn-day"].bookFacts.industries?.filter(
      (f) => f.symbol === "sh600000",
    ),
  ).toMatchObject([{ groups: ["食品饮料", "饮料制造"] }]);
  expect(source.families["cn-equity:swing"]).toMatchObject({
    firstSignal,
    targetThrough: target,
    valuationThrough: end,
  });
  expect(source.families["cn-equity:swing"]!.dailyAxis[0]).toBe(dates[140]);
  expect(
    source.families["cn-equity:swing"]!.missing.some((m) =>
      m.includes("low-zone"),
    ),
  ).toBe(false);
  expect(source.families["cn-equity:low-zone"]!.missing.join()).toContain(
    "sh000300",
  );
  expect(source.families["crypto:swing"]!.dailyAxis[0]).toBe(nativeDays[70]);
  expect(source.families["crypto:breakout"]!.dailyAxis).toContain("2020-03-10");
  expect(source.families["crypto:breakout"]!.missing.join()).toContain(
    "2020-03-10",
  );
  expect(source.families["crypto:swing"]!.missing).toEqual([]);
  for (const key of ["crypto-day", "crypto-4h"] as const) {
    const instruments = source.markets[key].request.instruments;
    expect(instruments.map((i) => i.symbol)).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(
      instruments.every((i) => ["BTCUSDT", "ETHUSDT"].includes(i.symbol)),
    ).toBe(true);
    expect(source.markets[key].bookFacts.benchmark?.symbol).toBe("BTCUSDT");
  }
  const sidecar = JSON.parse(await readFile(source.manifestPath, "utf8"));
  expect(sidecar.configHash).toBe(hash(configBytes));
  expect(
    sidecar.identities.classic.files.map((f: { hash: string }) => f.hash),
  ).toEqual([hash(priceBytes), hash(panelZip), hash(financial)]);
  expect(sidecar.rankCache.periods).toEqual(lifecycleRpsPeriods);
  expect(sidecar.rankCache.pool).toEqual(stocks.map((s) => s.symbol));
  expect(sidecar.identities.classic.normalized.executionSymbols).toEqual(
    targetSymbols,
  );
  expect(sidecar.labels.crypto4h).toContain("END");
  expect(sidecar.resources.derivedCacheBytes).toBeLessThan(512 * 1024 ** 2);
  const checksum = join(
    binanceRoot,
    "data/spot/monthly/klines/BTCUSDT/1d/BTCUSDT-1d-2020-01.zip.CHECKSUM",
  );
  await writeFile(checksum, "0".repeat(64) + "  BTCUSDT-1d-2020-01.zip");
  await expect(
    binanceArchiveSource({
      symbol: "cxBTCUSDT",
      period: "day",
      configuredRoot: binanceRoot,
      to: "2020-03-20",
      now: options.now,
    }),
  ).rejects.toThrow("CHECKSUM");
});
