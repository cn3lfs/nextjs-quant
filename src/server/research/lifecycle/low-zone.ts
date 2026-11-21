import type { Bar } from "trading-strategy-core/bars";
import {
  classicFinancialFeatures,
  type Csi800Stock,
  type MarketLowZoneInput,
} from "trading-strategies";
import {
  financialVisibleAt,
  type FinancialReportSnapshot,
} from "trading-strategy-core/financial";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parseIndustryMembers } from "../../market/industry-blocks";
import { readBars } from "../../market/bar-store/read-bars";

import {
  type LifecycleFamilyAxis,
  type LifecycleSourceBundle,
  type LifecycleLowZoneIndex,
  type LifecycleSourceOptions,
  type SourceStage,
} from "./source-types";
import {
  LifecycleSourceBudgetError,
  bytesHash,
  contentHash,
  lifecycleRawPrefixHash,
  hashFile,
  verifiedSourceJson,
  sourceDiskBoundary,
  normalizedArtifact,
  orderedBars,
  immutableFile,
} from "./source-artifacts";
import { dayMs, axis } from "./source-axis";

const defaultLowMembership =
  "D:/quant-data/wdz-blocks/2026-11-07/Blocks/市场分类/沪深300.txt";
const defaultLowMembershipHash =
  "f756d51c59b843dff757c839a95968fd58c5755e2199065b14a6304124f4a6d9";
type FrozenFinancial = {
  version: "csi800-financial-1";
  priceHash: string;
  reports: Record<string, FinancialReportSnapshot[]>;
  caps: Record<string, Record<string, number | null>>;
  seriesSources: Record<string, { hash: string }>;
};
/** Reuse the existing PIT TTM/equity numerators with actual date-matched GP16
 * market caps. Missing dates, nonpositive numerators and absent reports stay null. */
export function lifecycleFinancialValuations(
  financial: FrozenFinancial,
  symbols: readonly string[],
  calendar: readonly string[],
  sourceHash: string,
  purpose:
    | "first-vintage"
    | "current-revision-diagnostic" = "current-revision-diagnostic",
) {
  const values: (MarketLowZoneInput["valuations"][number] & {
    vintage?: "current-revision";
    knownAt?: null;
  })[] = [];
  for (const symbol of symbols) {
    const caps = financial.caps[symbol] ?? {},
      history = financial.reports[symbol] ?? [],
      source = `Frozen current-revision financial ${sourceHash}; PIT announcements enforced; GP16 ${financial.seriesSources[symbol]?.hash ?? "missing"}; not first-vintage certified`;
    let featureKey = "",
      features: ReturnType<typeof classicFinancialFeatures> = null;
    for (const date of calendar) {
      // Absent source dates stay absent facts; explicit null/duplicate caps
      // are retained. Neither case becomes a synthetic zero denominator.
      if (!Object.hasOwn(caps, date)) continue;
      if (purpose === "current-revision-diagnostic") {
        let visible = 0,
          latest = "";
        for (const report of history)
          if (financialVisibleAt(report, date)) {
            visible++;
            if (report.reportDate > latest) latest = report.reportDate;
          }
        // Equal visible counts identify the same report set; report freshness can expire independently.
        const key = `${visible}:${(Date.parse(date) - Date.parse(latest)) / dayMs > 550}`;
        if (featureKey !== key) {
          features = classicFinancialFeatures(history, date);
          featureKey = key;
        }
      }
      const cap = financial.caps[symbol]?.[date] ?? null;
      const positive = (value: number | null | undefined) =>
        value != null && Number.isFinite(value) && value > 0;
      const net = features?.valuationNumerators["earnings-yield"],
        equity = features?.valuationNumerators["book-to-price"];
      values.push({
        symbol,
        date,
        availableAt: date,
        ...(purpose === "first-vintage"
          ? { knownAt: null, vintage: "current-revision" as const }
          : {}),
        marketCap: positive(cap) ? cap : null,
        pe: positive(cap) && positive(net) ? cap! / net! : null,
        pb: positive(cap) && positive(equity) ? cap! / equity! : null,
        source,
        hash: sourceHash,
      });
    }
  }
  return values;
}

/** Choose an axis from source completeness and declared warmup only. Entry,
 * depth, percentile values and portfolio outcomes never participate. */
export function lifecycleLowZoneAxis(
  input: MarketLowZoneInput | undefined,
  minimumBars: number,
  years = 10,
): LifecycleFamilyAxis {
  if (!input || !input.calendar.length)
    return axis([], ["cn-day"], minimumBars, null, [
      "low-zone: primary sh000300 source/membership absent",
    ]);
  const calendar = input.calendar,
    byDate = new Map(
      input.constituents
        .filter((s) => s.index === input.index.symbol)
        .map((s) => [s.date, s]),
    );
  const valuations = new Map<
    string,
    Map<string, MarketLowZoneInput["valuations"][number]>
  >();
  for (const fact of input.valuations) {
    if (
      Date.parse(fact.availableAt) > Date.parse(`${fact.date}T15:00:00+08:00`)
    )
      continue;
    const rows = valuations.get(fact.date) ?? new Map();
    if (rows.has(fact.symbol))
      throw new Error("Duplicate date-matched low-zone valuation source");
    rows.set(fact.symbol, fact);
    valuations.set(fact.date, rows);
  }
  const presence = new Map(
    input.stocks.map((stock) => {
      const dates = new Set(stock.bars.map((b) => b.date)),
        prefix = [0],
        first = stock.bars[0]?.date ?? "9999",
        firstIndex = calendar.findIndex((d) => d >= first);
      for (const day of calendar)
        prefix.push(prefix.at(-1)! + (dates.has(day) ? 1 : 0));
      return [stock.symbol, { first, firstIndex, prefix }] as const;
    }),
  );
  const coverage: { date: string; complete: boolean; missing: string[] }[] = [];
  let firstWindow = 0,
    validValuations = 0,
    firstValuation: string | null = null;
  const validPrefix = [0];
  for (let i = 0; i < calendar.length; i++) {
    const date = calendar[i]!,
      minimum = new Date(date),
      windowStart = new Date(date);
    minimum.setUTCFullYear(minimum.getUTCFullYear() - 5);
    windowStart.setUTCFullYear(windowStart.getUTCFullYear() - years);
    const minimumDate = minimum.toISOString().slice(0, 10),
      start = windowStart.toISOString().slice(0, 10);
    while (calendar[firstWindow]! < start) firstWindow++;
    const missing: string[] = [],
      snapshot = byDate.get(date),
      symbols =
        snapshot &&
        (snapshot.basis === "current-labelled" ||
          Date.parse(snapshot.availableAt) <=
            Date.parse(`${date}T15:00:00+08:00`))
          ? snapshot.symbols
          : [],
      facts = valuations.get(date);
    if (!symbols.length) missing.push("membership");
    const prices = symbols.filter((symbol) => {
      const source = presence.get(symbol);
      return (
        source &&
        source.first <= minimumDate &&
        source.prefix[i + 1]! - source.prefix[firstWindow]! >= minimumBars &&
        source.prefix[i + 1]! -
          source.prefix[Math.max(firstWindow, source.firstIndex)]! ===
          i + 1 - Math.max(firstWindow, source.firstIndex)
      );
    }).length;
    if (!symbols.length || prices / symbols.length < 0.6)
      missing.push("price-warmup/coverage");
    const rows = symbols.map((s) => facts?.get(s)),
      positive = (v: number | null | undefined) =>
        v != null && Number.isFinite(v) && v > 0;
    const total =
      rows.length && rows.every((r) => positive(r?.marketCap))
        ? rows.reduce((n, r) => n + r!.marketCap!, 0)
        : null;
    if (total === null) missing.push("unknown-full-membership-cap-denominator");
    for (const key of ["pe", "pb"] as const) {
      const cap = rows.reduce(
        (n, r) =>
          n +
          (positive(r?.marketCap) && positive(r?.[key]) ? r!.marketCap! : 0),
        0,
      );
      if (total === null || cap / total < 0.6)
        missing.push(`${key}-market-cap-coverage`);
    }
    const valid =
      total !== null && !missing.some((m) => m.includes("market-cap-coverage"));
    if (valid) {
      validValuations++;
      firstValuation ??= date;
    }
    validPrefix.push(validValuations);
    if (
      !firstValuation ||
      firstValuation > minimumDate ||
      validPrefix[i + 1]! - validPrefix[firstWindow]! < minimumBars
    )
      missing.push("valuation-five-year/warmup");
    if (
      input.index.bars[0]!.date > minimumDate ||
      i - firstWindow + 1 < minimumBars
    )
      missing.push("index-warmup");
    coverage.push({ date, complete: missing.length === 0, missing });
  }
  const first = coverage.findIndex((c) => c.complete);
  const missing =
    first < 0
      ? [
          "low-zone: no source-complete common axis; full CSI300 denominator/PE/PB or maximum price/valuation warmup missing",
          ...coverage
            .filter((c) => c.missing.some((m) => !m.includes("warmup")))
            .map((c) => `low-zone:${c.date}: ${c.missing.join(",")}`),
        ]
      : coverage
          .slice(first)
          .filter((c) => !c.complete)
          .map(
            (c) => `low-zone:${c.date}: ${c.missing.join(",")}; date retained`,
          );
  return axis(
    first < 0 ? [] : calendar.slice(first),
    ["cn-day"],
    minimumBars,
    calendar[0] ?? null,
    missing,
  );
}

async function frozenLowZoneIndex(
  symbol: "sh000300" | "sh000001",
  options: LifecycleSourceOptions,
  output: string,
  configHash: string,
  priceHash: string,
  frozenAt: string,
  rankPath: string,
  rankBytes: number,
): Promise<LifecycleLowZoneIndex> {
  const role = symbol === "sh000300" ? "primary" : "diagnostic",
    root = options.tdxRoot === undefined ? "E:/new_tdx64" : options.tdxRoot,
    sourcePath = root ? join(root, "vipdoc/sh/lday", `${symbol}.day`) : "",
    key = contentHash({
      version: "lifecycle-index-1",
      symbol,
      configHash,
      priceHash,
      through: "2026-11-13",
    }),
    pointerPath = join(output, `index-${symbol}-${key}.json`);
  try {
    try {
      await stat(pointerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!root) throw new Error("Explicit TDX source disabled");
      const sourceHash = await hashFile(sourcePath),
        snapshot = await readBars({
          instrument: { market: "cn-equity", symbol },
          period: "day",
          adjustment: "none",
          root,
          source: "local",
          live: false,
          to: "2026-11-13",
          now: Date.parse(frozenAt),
        });
      if ((await hashFile(sourcePath)) !== sourceHash)
        throw new Error("Index source changed during immutable capture");
      const missing: string[] = [];
      if (snapshot.barStore.formingDates.length)
        missing.push(`${symbol}: source includes forming bars`);
      if (snapshot.barStore.priceRepaired)
        missing.push(
          `${symbol}: repaired source; diagnostic price is not certified original`,
        );
      const value = {
          version: "lifecycle-index-1",
          key,
          capturedAt: frozenAt,
          symbol,
          role,
          bars: snapshot.bars,
          sourcePath,
          hash: snapshot.hash,
          sourceHash,
          missing,
          barsHash: lifecycleRawPrefixHash(snapshot.bars),
        },
        plain = JSON.stringify(value),
        bytes = gzipSync(plain),
        hash = bytesHash(bytes),
        path = join(output, `index-${symbol}-${hash}.json.gz`);
      await sourceDiskBoundary(
        output,
        rankPath,
        rankBytes,
        bytes.length + 1024,
      );
      await immutableFile(path, bytes);
      await immutableFile(
        pointerPath,
        JSON.stringify({ path, sha256: hash, bytes: bytes.length }, null, 2),
      );
    }
    const archive = await normalizedArtifact<
      LifecycleLowZoneIndex & { version: string; key: string; barsHash: string }
    >(pointerPath);
    if (
      archive.value.version !== "lifecycle-index-1" ||
      archive.value.key !== key ||
      archive.value.symbol !== symbol ||
      lifecycleRawPrefixHash(archive.value.bars) !== archive.value.barsHash
    )
      throw new Error("Frozen index capture identity mismatch");
    orderedBars(archive.value.bars, `${symbol}:immutable index`);
    const { bars, hash, sourceHash, missing } = archive.value;
    return {
      symbol,
      role,
      bars,
      hash,
      sourceHash,
      sourcePath: archive.value.sourcePath,
      missing,
      archive: archive.identity,
    };
  } catch (error) {
    if (error instanceof LifecycleSourceBudgetError) throw error;
    // Existing immutable identities must fail closed instead of resampling E:.
    try {
      await stat(pointerPath);
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== "ENOENT") throw probe;
      return {
        symbol,
        role,
        bars: [],
        sourcePath,
        hash: contentHash({ symbol, unavailable: true }),
        sourceHash: "",
        missing: [
          `${symbol}: ${error instanceof Error ? error.message : "source unavailable"}`,
        ],
      };
    }
    throw error;
  }
}

async function readFinancialValuations(
  financial: { path: string; hash: string },
  priceHash: string,
  symbols: readonly string[],
  calendar: readonly string[],
  stage: SourceStage,
) {
  await stage("financial:before-decode");
  const facts = await verifiedSourceJson<FrozenFinancial>(
    financial.path,
    financial.hash,
    { maxOutputLength: 768 * 1024 ** 2 },
  );
  await stage("financial:decoded");
  if (
    facts.version !== "csi800-financial-1" ||
    facts.priceHash !== priceHash ||
    !facts.reports ||
    !facts.caps ||
    !facts.seriesSources
  )
    throw new Error("Frozen low-zone financial source identity/shape mismatch");
  const selected = new Set(symbols);
  for (const map of [facts.caps, facts.reports, facts.seriesSources])
    for (const symbol of Object.keys(map))
      if (!selected.has(symbol)) delete map[symbol];
  await stage("financial:selected-membership");
  const values: MarketLowZoneInput["valuations"][number][] = [];
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i]!;
    values.push(
      ...lifecycleFinancialValuations(
        facts,
        [symbol],
        calendar,
        financial.hash,
        "first-vintage",
      ),
    );
    delete facts.caps[symbol];
    delete facts.reports[symbol];
    delete facts.seriesSources[symbol];
    if (i % 50 === 49) await stage(`financial:projected-${i + 1}`);
  }
  await stage("financial:projected");
  return values;
}

export async function captureLowZoneSources(
  options: LifecycleSourceOptions,
  financial: { path: string; hash: string },
  priceHash: string,
  sourceEnd: string,
  stocks: readonly Csi800Stock[],
  signals: readonly (readonly Bar[])[],
  frozenAt: string,
  output: string,
  configHash: string,
  rankPath: string,
  rankBytes: number,
  stage: SourceStage,
) {
  const indices: LifecycleLowZoneIndex[] = [];
  for (const symbol of ["sh000300", "sh000001"] as const) {
    indices.push(
      await frozenLowZoneIndex(
        symbol,
        options,
        output,
        configHash,
        priceHash,
        frozenAt,
        rankPath,
        rankBytes,
      ),
    );
  }
  let membership: LifecycleSourceBundle["lowZoneSources"]["membership"] = null;
  const membershipPath =
    options.lowZoneMembershipPath === undefined
      ? defaultLowMembership
      : options.lowZoneMembershipPath;
  if (membershipPath) {
    const bytes = await readFile(membershipPath),
      hash = bytesHash(bytes),
      expected =
        options.expectedLowZoneMembershipHash ??
        (membershipPath === defaultLowMembership
          ? defaultLowMembershipHash
          : undefined);
    if (expected && expected !== hash)
      throw new Error("Frozen primary CSI300 membership hash mismatch");
    membership = {
      path: membershipPath,
      hash,
      symbols: parseIndustryMembers(bytes, membershipPath),
      basis: "current-labelled",
    };
  }
  const primary = indices.find((i) => i.role === "primary")!,
    commonIndexBars = primary.bars.filter((b) => b.date <= sourceEnd),
    calendar = commonIndexBars.map((b) => b.date),
    missing = [...primary.missing];
  if (!membership)
    missing.push(
      "primary sh000300 current-labelled membership source absent; no CSI800 substitution",
    );
  const sourcePool = new Set(stocks.map((s) => s.symbol)),
    outsidePool = membership?.symbols.filter((s) => !sourcePool.has(s)) ?? [];
  if (outsidePool.length)
    missing.push(
      `membership: full current CSI300 includes symbols outside frozen original price pool: ${outsidePool.join(",")}; denominator retained`,
    );
  let valuations: MarketLowZoneInput["valuations"] = [],
    decoded = false;
  if (options.decodeLowZoneFinancials) {
    valuations = await readFinancialValuations(
      financial,
      priceHash,
      membership?.symbols ?? [],
      calendar,
      stage,
    );
    decoded = true;
    missing.push(
      "financial: first disclosure vintage and revision knownAt unavailable; PE/PB remain unknown",
    );
  } else
    missing.push(
      "financial: original csi800-financial-1 has PIT reports, date-matched caps and GP16 source hashes; full frozen financial decode deferred to the explicit source resource gate",
    );
  const sourceInfo = {
    indices,
    membership,
    financial: {
      ...financial,
      format:
        "csi800-financial-1: reports[symbol][] PIT dates; caps[symbol][date] positive-MV/null; seriesSources[symbol].hash (original GP16)",
      decoded,
      missing,
    },
  };
  const stockSymbols = new Set(membership?.symbols ?? []);
  const input: MarketLowZoneInput | undefined =
    membership && primary.bars.length
      ? {
          calendar,
          index: {
            symbol: "sh000300",
            bars: commonIndexBars,
            source: `TDX original local ${primary.sourcePath}`,
            hash: primary.sourceHash,
          },
          stocks: stocks.flatMap((stock, i) =>
            stockSymbols.has(stock.symbol)
              ? [
                  {
                    symbol: stock.symbol,
                    bars: signals[i]!,
                    source: `Frozen classic causal signal history ${priceHash}`,
                    hash: priceHash,
                  },
                ]
              : [],
          ),
          constituents: calendar.map((date) => ({
            index: "sh000300" as const,
            date,
            availableAt: frozenAt,
            source: `Current CSI300 membership ${membership.path}; lookahead sensitivity only`,
            hash: membership.hash,
            symbols: membership.symbols,
            basis: "current-labelled" as const,
          })),
          valuations,
        }
      : undefined;
  return { sourceInfo, input };
}
