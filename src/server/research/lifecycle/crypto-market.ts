import type { Bar } from "trading-strategy-core/bars";
import { marketRules } from "trading-strategy-core/market-rules";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { binanceArchiveSource } from "../../market/bar-store/binance-archive-source";
import { publicDataFiles } from "../../data-sources/binance/public-data-store";

import {
  lifecycleConfigHash,
  type LifecycleMarketSource,
  type LifecycleSourceOptions,
  type SourceStage,
} from "./source-types";
import {
  LifecycleSourceBudgetError,
  bytesHash,
  contentHash,
  sourceDiskBoundary,
  orderedBars,
} from "./source-artifacts";
import { dayMs, dayAfter, naturalDays } from "./source-axis";

const defaultBinanceRoot =
  "D:/github/nextjs-quant/.test-data/r2a4/data/market-data/binance-public-data";
/** Daily source labels identify openings. 4h labels are exact END boundaries;
 * a UTC day is complete only with 04/08/12/16/20/next00, including midnight. */
export function lifecycleCryptoCoverage(
  bars: readonly Bar[],
  period: "day" | "4h",
) {
  orderedBars(bars, `crypto-${period}`);
  const groups = new Map<string, Set<number>>();
  for (const bar of bars) {
    const time = Date.parse(bar.date),
      completion = period === "day" ? time + dayMs : time,
      step = period === "day" ? dayMs : 4 * 3600000;
    if (time % step !== 0) throw new Error("Off-grid native crypto source");
    const date = new Date(completion - 1).toISOString().slice(0, 10),
      values = groups.get(date) ?? new Set<number>();
    values.add(completion);
    groups.set(date, values);
  }
  const complete = [...groups]
    .filter(([date, times]) => {
      const start = Date.parse(date),
        step = period === "day" ? dayMs : 4 * 3600000;
      return Array.from(
        { length: dayMs / step },
        (_, i) => start + (i + 1) * step,
      ).every((t) => times.has(t));
    })
    .map(([d]) => d)
    .sort();
  const observed = [...groups.keys()].sort();
  const days = observed.length
    ? naturalDays(observed[0]!, observed.at(-1)!)
    : [];
  const completed = new Set(complete);
  return {
    complete,
    missing: days.filter((d) => !completed.has(d)),
    first: complete[0] ?? null,
    last: complete.at(-1) ?? null,
  };
}

export async function captureCryptoMarkets(
  options: LifecycleSourceOptions,
  output: string,
  frozenAt: string,
  projectedRankPath: string,
  rankByteLength: number,
  stage: SourceStage,
) {
  const binanceRoot = resolve(options.binanceRoot ?? defaultBinanceRoot),
    cryptoSources: Record<
      string,
      {
        bars: Bar[];
        hash: string;
        files: unknown[];
        missing: string[];
        coverage: ReturnType<typeof lifecycleCryptoCoverage>;
      }
    > = {};
  // The immutable L3 registration declares this cap in axes.crypto.end.
  const registeredCutoff =
    (options.expectedConfigHash ?? lifecycleConfigHash) === lifecycleConfigHash
      ? "2026-11-13"
      : undefined;
  const now = Date.parse(frozenAt);
  const through = registeredCutoff
    ? Date.parse(dayAfter(registeredCutoff))
    : now;
  for (const period of ["day", "4h"] as const)
    for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
      const key = `${symbol}:${period}`,
        interval = period === "day" ? "1d" : "4h";
      try {
        const paths = await publicDataFiles(
          binanceRoot,
          symbol,
          interval,
          0,
          registeredCutoff ? through - 1 : through,
        );
        if (paths.some((p) => !p.endsWith(".zip")))
          throw new Error(
            "Unchecksummed live CSV is not an original official archive",
          );
        await sourceDiskBoundary(
          output,
          projectedRankPath,
          rankByteLength,
          paths.length * (period === "day" ? 31 : 186) * 64 + 16384,
        );
        const snapshot = await binanceArchiveSource({
          symbol: `cx${symbol}`,
          period,
          configuredRoot: binanceRoot,
          to: registeredCutoff,
          now,
        });
        if (!snapshot)
          throw new Error("Native original official archive missing");
        const bars = registeredCutoff
          ? snapshot.bars.filter((b) =>
              period === "day"
                ? b.date <= registeredCutoff
                : Date.parse(b.date) <= through,
            )
          : snapshot.bars;
        const coverage = lifecycleCryptoCoverage(bars, period),
          missing = coverage.missing.map(
            (d) => `native:${key}: incomplete UTC day ${d}`,
          );
        if (snapshot.sourceNote)
          missing.push(`native:${key}: ${snapshot.sourceNote}`);
        if (snapshot.sourceVersions?.length !== paths.length)
          throw new Error("Native file set changed during source freeze");
        const nativeManifests = [];
        // The existing public-data writer owns ONE monthly manifest per
        // symbol/interval; that index also contains daily official ZIPs.
        for (const directory of [
          join(binanceRoot, "data/spot/monthly/klines", symbol, interval),
        ]) {
          const path = join(directory, "manifest.json"),
            bytes = await readFile(path);
          const value = JSON.parse(bytes.toString()) as {
            version: number;
            symbol: string;
            interval: string;
            files: { path: string; sha256: string }[];
          };
          if (
            value.version !== 1 ||
            value.symbol !== symbol ||
            value.interval !== interval ||
            !Array.isArray(value.files)
          )
            throw new Error("Native archive manifest identity mismatch");
          for (let i = 0; i < paths.length; i++)
            if (
              !value.files.some(
                (f) =>
                  resolve(f.path) === resolve(paths[i]!) &&
                  f.sha256 === snapshot.sourceVersions![i],
              )
            )
              throw new Error("Native ZIP differs from its archive manifest");
          nativeManifests.push({ path, hash: bytesHash(bytes) });
        }
        const archiveFiles: unknown[] = [...nativeManifests];
        for (let i = 0; i < paths.length; i++)
          archiveFiles.push({
            path: paths[i]!,
            hash: snapshot.sourceVersions?.[i],
            checksumHash: bytesHash(await readFile(paths[i]! + ".CHECKSUM")),
          });
        cryptoSources[key] = {
          bars,
          hash: snapshot.hash,
          files: archiveFiles,
          coverage,
          missing,
        };
      } catch (error) {
        if (error instanceof LifecycleSourceBudgetError) throw error;
        cryptoSources[key] = {
          bars: [],
          hash: contentHash({ key, unavailable: true }),
          files: [],
          coverage: { complete: [], missing: [], first: null, last: null },
          missing: [
            `native:${key}: ${error instanceof Error ? error.message : "source unavailable"}`,
          ],
        };
      }
    }
  for (const [key, source] of Object.entries(cryptoSources))
    await stage(
      `crypto:cutoff:${key}:${registeredCutoff ? "registered" : "source-coverage"}:${registeredCutoff ?? source.coverage.last ?? "unavailable"}`,
    );
  await stage("crypto:captured");
  const cryptoMarket = (period: "day" | "4h"): LifecycleMarketSource => {
    const sources = ["BTCUSDT", "ETHUSDT"].map(
        (s) => cryptoSources[`${s}:${period}`]!,
      ),
      calendar = [
        ...new Set(sources.flatMap((s) => s.bars.map((b) => b.date))),
      ].sort();
    const benchmark = cryptoSources["BTCUSDT:day"]!.bars;
    const identity = {
      root: binanceRoot,
      period,
      symbols: ["BTCUSDT", "ETHUSDT"],
      native: sources.map((s) => ({
        hash: s.hash,
        files: s.files,
        missing: s.missing,
      })),
      benchmarkHash: cryptoSources["BTCUSDT:day"]!.hash,
      costs: marketRules.crypto.costs!,
    };
    return {
      request: {
        market: "crypto",
        initial: 1000000,
        calendar,
        instruments: ["BTCUSDT", "ETHUSDT"].map((symbol, i) => ({
          symbol,
          market: "crypto",
          bars: sources[i]!.bars,
          signalBars: sources[i]!.bars,
          actions: [],
          execution: {
            evidence:
              "Native Binance archive; research quantity grid 0.000001, not historical venue-filter certification",
            minimum: 0.000001,
            step: 0.000001,
            tradable: true,
            limitUp: null,
            limitDown: null,
          },
        })),
        costs: identity.costs,
      },
      benchmark,
      bookFacts: {
        benchmark: { symbol: "BTCUSDT", bars: benchmark },
        roundTripCost:
          (2 * (identity.costs.commissionBps + identity.costs.slippageBps) +
            identity.costs.sellTaxBps) /
          10000,
      },
      inputHash: contentHash(identity),
      source: `Native official Binance ${binanceRoot} ${period}`,
      missing: sources.flatMap((s) => s.missing),
    };
  };

  return {
    binanceRoot,
    cryptoSources,
    // The caller intersects the complete-day coverage of each family's required series.
    cap:
      registeredCutoff ??
      Object.values(cryptoSources)
        .flatMap((s) => (s.coverage.last ? [s.coverage.last] : []))
        .sort()
        .at(-1) ??
      frozenAt.slice(0, 10),
    day: cryptoMarket("day"),
    fourHour: cryptoMarket("4h"),
  };
}
