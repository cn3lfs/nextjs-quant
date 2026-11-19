import type { PortfolioInstrument } from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";
import {
  parseGbbqFile,
  adjustmentFactors,
  applyAdjustmentAtAnchor,
} from "tstdx/local";
import { type Csi800Stock } from "trading-strategies";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { researchCorporateActions } from "../corporate-actions";
import { columnCacheDirectory } from "../../market/bar-store/column-cache";

import {
  type LifecycleSignalOrigin,
  type LifecycleSourceOptions,
} from "./source-types";
import {
  sourceCacheBudget,
  LifecycleSourceBudgetError,
  bytesHash,
  contentHash,
  barTuples,
  lifecycleRawPrefixHash,
  memoryBoundary,
  hashFile,
  derivedBytes,
  immutableFile,
} from "./source-artifacts";

export type ExecutionFacts = {
  bars: Bar[];
  signalBars: Bar[];
  actions: NonNullable<PortfolioInstrument["actions"]>;
  sourceHash: string;
  shardHash: string;
  execution?: PortfolioInstrument["execution"];
  origin?: unknown;
};
export async function frozenGbbqSource(
  output: string,
  options: LifecycleSourceOptions,
  rawHash: string,
  configHash: string,
  frozenAt: string,
) {
  const key = contentHash({
      version: "lifecycle-gbbq-source-1",
      rawHash,
      configHash,
    }),
    index = join(output, `gbbq-${key}.json`);
  let pointer: {
    path: string;
    hash: string;
    sourcePath: string;
    sourceHash: string;
    capturedAt: string;
  };
  try {
    pointer = JSON.parse(await readFile(index, "utf8")) as typeof pointer;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (options.tdxRoot === null && !options.gbbqPath)
      throw new Error("Explicit GBBQ source disabled");
    const sourcePath =
        options.gbbqPath ??
        join(options.tdxRoot ?? "E:/new_tdx64", "T0002/hq_cache/gbbq"),
      bytes = await readFile(sourcePath),
      hash = bytesHash(bytes);
    if (options.expectedGbbqHash && hash !== options.expectedGbbqHash)
      throw new Error("GBBQ initial capture bytes/hash mismatch");
    if (
      (await derivedBytes(output)) +
        (await derivedBytes(columnCacheDirectory())) +
        bytes.length >
      sourceCacheBudget
    )
      throw new LifecycleSourceBudgetError(
        "GBBQ capture exceeds512MiB source budget",
      );
    await mkdir(output, { recursive: true });
    const path = join(output, `gbbq-${hash}.bin`);
    await immutableFile(path, bytes);
    pointer = {
      path,
      hash,
      sourcePath: resolve(sourcePath),
      sourceHash: hash,
      capturedAt: frozenAt,
    };
    await immutableFile(index, JSON.stringify(pointer, null, 2));
  }
  const bytes = await readFile(pointer.path);
  if (bytesHash(bytes) !== pointer.hash)
    throw new Error("Frozen GBBQ blob changed");
  if (options.expectedGbbqHash && pointer.hash !== options.expectedGbbqHash)
    throw new Error(
      "Frozen GBBQ capture differs from explicitly selected source",
    );
  const decoded = parseGbbqFile(bytes);
  return {
    events: decoded.events,
    identity: {
      ...pointer,
      indexPath: index,
      indexHash: await hashFile(index),
      parserHash: await hashFile("packages/tstdx/src/local/gbbq.ts"),
      parserKeyHash: await hashFile("packages/tstdx/src/local/gbbq-key.ts"),
      runtimeHash: await hashFile("packages/tstdx/dist/local/gbbq.js"),
      runtimeKeyHash: await hashFile("packages/tstdx/dist/local/gbbq-key.js"),
      issues: decoded.issues,
      recordCount: decoded.recordCount,
      bias: "Current captured TDX revision, not certified historical first release",
    },
  };
}
export async function freezeSignalBasis(
  stocks: readonly Csi800Stock[],
  facts: Map<string, ExecutionFacts>,
  gbbq: Awaited<ReturnType<typeof frozenGbbqSource>>,
  output: string,
  rawSource: { path: string; hash: string },
  end: string,
  pendingRankBytes: number,
) {
  const origins: LifecycleSignalOrigin[] = [],
    signals = new Map<string, Bar[]>(),
    raws = new Map<string, Bar[]>(),
    missing: string[] = [];
  for (const stock of stocks) {
    memoryBoundary(stock.bars.length * 320);
    const normalized = facts.get(stock.symbol),
      union = new Map(stock.bars.map((b) => [b.date, b]));
    for (const bar of normalized?.bars ?? [])
      if (!union.has(bar.date)) union.set(bar.date, bar);
    const raw = [...union.values()].sort((a, b) =>
        a.date.localeCompare(b.date),
      ),
      startDate = stock.bars[0]!.date,
      through = raw.at(-1)!.date,
      events = gbbq.events.get(stock.symbol) ?? [];
    if (raw[0]!.date !== startDate)
      throw new Error(
        "Frozen source origin moved before declared first raw bar",
      );
    const factors = adjustmentFactors(raw, events),
      anchor = { date: startDate, factor: factors[0]!.factor },
      signalBars = applyAdjustmentAtAnchor(raw, factors, anchor);
    const tuples = barTuples(raw),
      plain = JSON.stringify(tuples),
      decodedContentHash = bytesHash(plain),
      path = join(output, `raw-${stock.symbol}-${decodedContentHash}.json.gz`);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
      if (
        bytesHash(gunzipSync(bytes, { maxOutputLength: 128 * 1024 ** 2 })) !==
        decodedContentHash
      )
        throw new Error("Frozen source prefix conflicts with content identity");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      bytes = gzipSync(plain);
      if (
        (await derivedBytes(output)) +
          (await derivedBytes(columnCacheDirectory())) +
          pendingRankBytes +
          bytes.length >
        sourceCacheBudget
      )
        throw new LifecycleSourceBudgetError(
          "Symbol raw-prefix cache exceeds512MiB source budget",
        );
      await immutableFile(path, bytes);
    }
    const origin: LifecycleSignalOrigin = {
      symbol: stock.symbol,
      startDate,
      through,
      anchor,
      rawSource: {
        format: "bar-tuples-1",
        path,
        hash: bytesHash(bytes),
        decodedContentHash,
        upstream: normalized?.origin ?? {
          kind: "original-price",
          ...rawSource,
        },
      },
      rawPrefixHash: lifecycleRawPrefixHash(raw),
      eventsPrefixHash: contentHash(
        events.filter((e) => e.date >= startDate && e.date <= through),
      ),
      factorsPrefixHash: contentHash(factors),
      signalPrefixHash: lifecycleRawPrefixHash(signalBars),
      ...(normalized
        ? {
            legacyForwardComparisonHash: lifecycleRawPrefixHash(
              normalized.signalBars,
            ),
          }
        : {}),
    };
    origins.push(origin);
    signals.set(stock.symbol, signalBars);
    raws.set(stock.symbol, raw);
    if (normalized) {
      const oldActions = normalized.actions.filter(
        (a) => a.date >= startDate && a.date <= end,
      );
      try {
        const actions = researchCorporateActions(
            events,
            `Frozen GBBQ ${gbbq.identity.hash}`,
            startDate,
            end,
          ),
          economic = (rows: NonNullable<PortfolioInstrument["actions"]>) =>
            rows.map((a) => [
              a.date,
              a.availableAt,
              a.dividend,
              a.bonus,
              a.shareFactor ?? 1,
              a.rightsRatio ?? 0,
              a.rightsPrice ?? 0,
              a.sharesSellableAt ?? a.date,
            ]);
        if (
          contentHash(economic(oldActions)) !== contentHash(economic(actions))
        )
          missing.push(
            `actions:${stock.symbol}: frozen capture and new GBBQ economic action prefix differ; both identities retained`,
          );
        normalized.actions = actions;
      } catch (error) {
        missing.push(
          `actions:${stock.symbol}: frozen GBBQ scenario unsupported: ${error instanceof Error ? error.message : "source unavailable"}`,
        );
      }
      normalized.bars = raw;
      normalized.signalBars = signalBars;
    }
  }
  return {
    signals,
    raws,
    missing,
    proof: {
      version: "tdx-first-raw-anchor-1" as const,
      arithmetic: "rawOHLC*(F(t)/F(firstFrozenRawDate))" as const,
      factorAlgorithmHash: contentHash({
        source: gbbq.identity.parserHash,
        sourceKey: gbbq.identity.parserKeyHash,
        runtime: gbbq.identity.runtimeHash,
        runtimeKey: gbbq.identity.runtimeKeyHash,
        version: "tdx-first-raw-anchor-1",
      }),
      gbbq: gbbq.identity,
      origins,
    },
  };
}
