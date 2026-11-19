import type { PortfolioInstrument } from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";
import { type Csi800Stock } from "trading-strategies";
import { readFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { researchExecutionAt } from "../corporate-actions";
import { researchCorporateActions } from "../corporate-actions";
import { readBars } from "../../market/bar-store/read-bars";
import { columnCacheDirectory } from "../../market/bar-store/column-cache";

import { type LifecycleSourceOptions } from "./source-types";
import {
  sourceCacheBudget,
  LifecycleSourceBudgetError,
  bytesHash,
  contentHash,
  hashFile,
  derivedBytes,
  normalizedArtifact,
  orderedBars,
  immutableFile,
} from "./source-artifacts";
import { type ExecutionFacts, frozenGbbqSource } from "./signal-basis";

const defaultExecutionCapture = {
  equityPointerPath: ".test-data/r2a5/equity-pointer.json",
  rosterPointerPath: ".test-data/r2a5/csi800-pointer.json",
  correctionPath: ".test-data/lifecycle-20261116/l3/source-correction.json",
  expectedEquityHash:
    "0711ca3b3ece57c5ca53795ab352cbe176889072604ee77397ad225852b71f41",
  expectedRosterHash:
    "bd28be57f28ffdd9cc86c4a43037fb31547a168fb5ec518b99fa5ea93dab5aa7",
  expectedExecutionCount: 799,
  excludedSymbols: ["sz000831"],
};
type NormalizedRow = {
  symbol: string;
  columns: (string | number)[][];
  actions?: PortfolioInstrument["actions"];
  sourceHash: string;
  adjustmentReference: string | null;
  execution?: Readonly<
    Record<string, NonNullable<ReturnType<typeof researchExecutionAt>>>
  >;
};
export function lifecycleSupplementKey(
  symbol: string,
  rawHash: string,
  configHash: string,
  first: string,
  end: string,
) {
  return contentHash({
    version: "lifecycle-tdx-supplement-1",
    symbol,
    rawHash,
    configHash,
    first,
    end,
  });
}
async function frozenTdxSupplement(
  symbol: string,
  stock: Csi800Stock,
  options: LifecycleSourceOptions,
  output: string,
  rawHash: string,
  configHash: string,
  end: string,
  pendingRankBytes: number,
  gbbq: Awaited<ReturnType<typeof frozenGbbqSource>>,
) {
  const first = stock.bars[0]!.date,
    key = lifecycleSupplementKey(symbol, rawHash, configHash, first, end),
    pointerPath = join(output, `supplement-${symbol}-${key}.json`);
  let metadata: {
    captureKey: string;
    origin: unknown;
    quality: { gaps: string[] };
  };
  try {
    metadata = JSON.parse(
      await readFile(pointerPath, "utf8"),
    ) as typeof metadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const root = options.tdxRoot;
    if (root === null)
      throw new Error(
        "Supplement raw source disabled; no frozen capture exists",
      );
    const tdxRoot = root ?? "E:/new_tdx64",
      snapshot = await readBars({
        instrument: { market: "cn-equity", symbol },
        period: "day",
        adjustment: "forward",
        freezeRaw: true,
        root: tdxRoot,
        source: "local",
        live: false,
        to: end,
        now: options.now ?? Date.now(),
      });
    if (
      !snapshot.rawBars ||
      snapshot.rawBars.length !== snapshot.bars.length ||
      snapshot.rawBars.some((b, i) => b.date !== snapshot.bars[i]!.date)
    )
      throw new Error("Supplement lacks aligned original raw/forward source");
    const raw = snapshot.rawBars.filter(
        (b) => b.date >= first && b.date <= end,
      ),
      adjusted = new Map(snapshot.bars.map((b) => [b.date, b])),
      events = gbbq.events.get(symbol) ?? [];
    const actions = researchCorporateActions(
        events,
        `Frozen GBBQ ${gbbq.identity.hash}`,
        first,
        end,
      ),
      gaps: string[] = [];
    if (snapshot.barStore.priceRepaired || snapshot.sourceNote)
      gaps.push(
        `${symbol}: repaired raw supplement; ${snapshot.sourceNote ?? "price-repaired"}`,
      );
    if (raw.at(-1)?.date !== end)
      gaps.push(
        `${symbol}: missing-tail last=${raw.at(-1)?.date ?? "none"}, expected=${end}; terminal conversion/settlement not certified, no synthetic quote/cash`,
      );
    if (snapshot.barStore.formingDates.length)
      gaps.push(`${symbol}: supplement contains forming bars`);
    const execution = Object.fromEntries(
      raw.map((b, i) => [
        b.date,
        researchExecutionAt(symbol, b, raw[i - 1], actions)!,
      ]),
    );
    const row: NormalizedRow = {
      symbol,
      sourceHash: snapshot.hash,
      adjustmentReference: snapshot.barStore.adjustmentReference,
      actions,
      execution,
      columns: raw.map((b) => {
        const s = adjusted.get(b.date)!;
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
    const sourcePath = join(
        tdxRoot,
        "vipdoc",
        symbol.slice(0, 2),
        "lday",
        `${symbol}.day`,
      ),
      origin = {
        kind: "tdx-supplement",
        symbol,
        first,
        end,
        sourcePath: resolve(sourcePath),
        sourceFileHash: await hashFile(sourcePath),
        snapshotHash: snapshot.hash,
        adjustmentReference: snapshot.barStore.adjustmentReference,
        gbbqPath: gbbq.identity.path,
        gbbqHash: gbbq.identity.hash,
        eventsHash: contentHash(events.filter((e) => e.date <= end)),
        executionAssumptions:
          "researchExecutionAt same-day board scenarios; historical ST/IPO/queues remain unverified",
      };
    const plain = JSON.stringify([row]),
      bytes = gzipSync(plain),
      hash = bytesHash(bytes),
      path = join(output, `supplement-${symbol}-${hash}.json.gz`);
    if (
      (await derivedBytes(output)) +
        (await derivedBytes(columnCacheDirectory())) +
        pendingRankBytes +
        bytes.length >
      sourceCacheBudget
    )
      throw new LifecycleSourceBudgetError(
        "Supplement capture exceeds512MiB source budget",
      );
    await immutableFile(path, bytes);
    const pointer = {
      path,
      sha256: hash,
      bytes: bytes.length,
      captureKey: key,
      origin,
      quality: { gaps },
    };
    await immutableFile(pointerPath, JSON.stringify(pointer, null, 2));
    metadata = pointer;
  }
  if (metadata.captureKey !== key)
    throw new Error(
      "Frozen supplement identity conflicts with original raw window",
    );
  const captured = await normalizedArtifact<NormalizedRow[]>(pointerPath);
  return {
    ...captured,
    identity: {
      ...captured.identity,
      origin: metadata.origin,
      quality: metadata.quality,
    },
  };
}
export async function normalizedExecutionSources(
  options: LifecycleSourceOptions,
  stocks: readonly Csi800Stock[],
  rawHash: string,
  configHash: string,
  end: string,
  output: string,
  pendingRankBytes: number,
  gbbq: Awaited<ReturnType<typeof frozenGbbqSource>>,
) {
  const capture = options.executionCapture ?? defaultExecutionCapture;
  const correctionBytes = await readFile(capture.correctionPath),
    correction = JSON.parse(correctionBytes.toString()) as {
      version: string;
      rawPrice: { sha256: string; symbols: number };
      preregistrationSha256: string;
      execution: {
        equitySha256: string;
        rosterSha256: string;
        symbols: number;
        equityPointerSha256?: string;
        rosterPointerSha256?: string;
        rosterScopeMismatch?: { rawOnly: string[]; captureOnly: string[] };
      };
    };
  if (
    correction.version !== "lifecycle-source-correction-1" ||
    correction.rawPrice.sha256 !== rawHash ||
    correction.rawPrice.symbols !== stocks.length ||
    correction.preregistrationSha256 !== configHash ||
    correction.execution.equitySha256 !== capture.expectedEquityHash ||
    correction.execution.rosterSha256 !== capture.expectedRosterHash ||
    correction.execution.symbols !== capture.expectedExecutionCount
  )
    throw new Error(
      "Source correction proof does not match raw/RPS/execution layers",
    );
  const equity = await normalizedArtifact<{
    eligible: string[];
    shards: string[];
    audit: { symbol: string; accepted: boolean; reason: string }[];
  }>(capture.equityPointerPath, capture.expectedEquityHash);
  const roster = await normalizedArtifact<{
    constituents: string[];
    symbols: string[];
    excluded: { symbol: string; reason: string }[];
  }>(capture.rosterPointerPath, capture.expectedRosterHash);
  if (
    (correction.execution.equityPointerSha256 &&
      correction.execution.equityPointerSha256 !==
        equity.identity.pointerHash) ||
    (correction.execution.rosterPointerSha256 &&
      correction.execution.rosterPointerSha256 !== roster.identity.pointerHash)
  )
    throw new Error(
      "Frozen normalized pointer file bytes differ from correction proof",
    );
  const sorted = (values: readonly string[]) => [...values].sort();
  if (
    contentHash(sorted(equity.value.eligible)) !==
      contentHash(sorted(roster.value.symbols)) ||
    roster.value.symbols.length !== capture.expectedExecutionCount ||
    contentHash(sorted(roster.value.excluded.map((r) => r.symbol))) !==
      contentHash(sorted(capture.excludedSymbols)) ||
    contentHash(
      sorted(
        equity.value.audit.filter((a) => !a.accepted).map((a) => a.symbol),
      ),
    ) !== contentHash(sorted(capture.excludedSymbols))
  )
    throw new Error(
      "Frozen raw800 and execution799 roster layers differ from proof",
    );
  if (
    new Set(roster.value.symbols).size !== roster.value.symbols.length ||
    new Set(equity.value.shards).size !== equity.value.shards.length ||
    equity.value.shards.some((s) => !/^equity-\d+$/.test(s))
  )
    throw new Error("Duplicate or non-equity normalized source shard");
  const originalSymbols = stocks.map((s) => s.symbol),
    rawOnly = originalSymbols.filter(
      (s) => !roster.value.constituents.includes(s),
    ),
    captureOnly = roster.value.constituents.filter(
      (s) => !originalSymbols.includes(s),
    ),
    scope = correction.execution.rosterScopeMismatch ?? {
      rawOnly: [],
      captureOnly: [],
    };
  if (
    contentHash(sorted(rawOnly)) !== contentHash(sorted(scope.rawOnly)) ||
    contentHash(sorted(captureOnly)) !== contentHash(sorted(scope.captureOnly))
  )
    throw new Error(
      "Raw/capture roster scope mismatch is not covered by approved correction",
    );
  const targetSymbols = originalSymbols.filter(
    (s) => !capture.excludedSymbols.includes(s),
  );
  if (targetSymbols.length !== capture.expectedExecutionCount)
    throw new Error("Original execution target count changed");
  const rawBySymbol = new Map(stocks.map((s) => [s.symbol, s])),
    facts = new Map<string, ExecutionFacts>(),
    missing: string[] = [],
    shards: unknown[] = [],
    audit: {
      symbol: string;
      sharedRawDates: number;
      newRawDates: number;
      rawMismatches: number;
      rawMismatchDates: string[];
      signalPolicy: string;
      sourceHash: string;
      adjustmentReference: string | null;
    }[] = [];
  const parts = [
    ...equity.value.shards.map((name) => ({ kind: "artifact" as const, name })),
    ...rawOnly
      .filter((s) => targetSymbols.includes(s))
      .map((symbol) => ({ kind: "supplement" as const, symbol })),
  ];
  for (const part of parts) {
    let shard:
      | Awaited<ReturnType<typeof normalizedArtifact<NormalizedRow[]>>>
      | Awaited<ReturnType<typeof frozenTdxSupplement>>;
    try {
      shard =
        part.kind === "artifact"
          ? await normalizedArtifact<NormalizedRow[]>(
              join(
                dirname(capture.equityPointerPath),
                `${part.name}-pointer.json`,
              ),
            )
          : await frozenTdxSupplement(
              part.symbol,
              rawBySymbol.get(part.symbol)!,
              options,
              output,
              rawHash,
              configHash,
              end,
              pendingRankBytes,
              gbbq,
            );
    } catch (error) {
      if (error instanceof LifecycleSourceBudgetError) throw error;
      if (part.kind === "artifact") throw error;
      missing.push(
        `execution:${part.symbol}: supplement unavailable: ${error instanceof Error ? error.message : "source unavailable"}`,
      );
      continue;
    }
    shards.push(shard.identity);
    if ("quality" in shard.identity) {
      const quality = shard.identity.quality as { gaps: string[] };
      missing.push(...quality.gaps);
    }
    for (const row of shard.value) {
      if (captureOnly.includes(row.symbol)) continue;
      if (
        !targetSymbols.includes(row.symbol) ||
        !rawBySymbol.has(row.symbol) ||
        facts.has(row.symbol)
      ) {
        missing.push(
          `execution:${row.symbol}: unexpected/duplicate normalized capture row`,
        );
        continue;
      }
      const original = rawBySymbol.get(row.symbol)!,
        rawDates = new Map(original.bars.map((b) => [b.date, b])),
        first = original.bars[0]?.date;
      if (!first || !Array.isArray(row.actions)) {
        missing.push(
          `execution:${row.symbol}: raw anchor or normalized actions unavailable`,
        );
        continue;
      }
      let sharedRawDates = 0,
        newRawDates = 0;
      const mismatchDates: string[] = [],
        bars: Bar[] = [],
        signalBars: Bar[] = [];
      for (const columns of row.columns) {
        const date = String(columns[0]);
        if (date < first || date > end) continue;
        if (columns.length !== 13) {
          missing.push(
            `execution:${row.symbol}:${date}: normalized OHLC columns unavailable`,
          );
          continue;
        }
        const raw: Bar = {
          date,
          open: Number(columns[1]),
          high: Number(columns[2]),
          low: Number(columns[3]),
          close: Number(columns[4]),
          volume: Number(columns[5]),
          amount: Number(columns[6]),
        };
        const prior = rawDates.get(date);
        if (prior) {
          sharedRawDates++;
          if (
            ["open", "high", "low", "close", "volume", "amount"].some(
              (key) =>
                prior[key as keyof Omit<Bar, "date">] !==
                raw[key as keyof Omit<Bar, "date">],
            )
          )
            mismatchDates.push(date);
        } else newRawDates++;
        bars.push(prior ?? raw);
        signalBars.push({
          date,
          open: Number(columns[7]),
          high: Number(columns[8]),
          low: Number(columns[9]),
          close: Number(columns[10]),
          volume: Number(columns[11]),
          amount: Number(columns[12]),
        });
      }
      orderedBars(bars, `${row.symbol}:normalized raw`);
      orderedBars(signalBars, `${row.symbol}:normalized signal`);
      const dates = new Set(bars.map((b) => b.date)),
        omitted = original.bars.filter((b) => !dates.has(b.date));
      if (omitted.length)
        missing.push(
          `execution:${row.symbol}: normalized capture omits ${omitted.length} original raw dates; dates hash ${contentHash(omitted.map((b) => b.date))}`,
        );
      if (mismatchDates.length)
        missing.push(
          `execution:${row.symbol}: ${mismatchDates.length} raw common-date mismatches; first ${mismatchDates[0]}; dates hash ${contentHash(mismatchDates)}`,
        );
      const actions = row.actions.filter((a) => a.date <= end);
      for (const action of actions)
        if (
          !action.evidence ||
          action.availableAt > action.date ||
          [
            action.dividend,
            action.bonus,
            action.rightsRatio ?? 0,
            action.rightsPrice ?? 0,
          ].some((n) => !Number.isFinite(n) || n < 0) ||
          (action.shareFactor !== undefined &&
            (!Number.isFinite(action.shareFactor) || action.shareFactor <= 0))
        )
          throw new Error(
            "Invalid normalized frozen corporate-action evidence",
          );
      facts.set(row.symbol, {
        bars,
        signalBars,
        actions,
        sourceHash: row.sourceHash,
        shardHash: shard.identity.hash,
        ...(row.execution ? { execution: row.execution } : {}),
        origin: shard.identity,
      });
      audit.push({
        symbol: row.symbol,
        sharedRawDates,
        newRawDates,
        rawMismatches: mismatchDates.length,
        rawMismatchDates: mismatchDates,
        signalPolicy:
          "Legacy frozen forward OHLC is comparison only; active signals rebuilt independently from frozen GBBQ at first raw anchor",
        sourceHash: row.sourceHash,
        adjustmentReference: row.adjustmentReference,
      });
    }
  }
  for (const symbol of targetSymbols)
    if (!facts.has(symbol))
      missing.push(`execution:${symbol}: normalized frozen source absent`);
  return {
    facts,
    executionSymbols: targetSymbols,
    missing,
    identity: {
      correctionPath: resolve(capture.correctionPath),
      correctionHash: bytesHash(correctionBytes),
      equity: equity.identity,
      roster: roster.identity,
      excluded: roster.value.excluded,
      shards,
      audit,
      rawSymbols: stocks.map((s) => s.symbol),
      executionSymbols: targetSymbols,
      rawOnly,
      captureOnly,
      reusedCaptureSymbols: targetSymbols.filter((s) =>
        roster.value.symbols.includes(s),
      ),
      supplementSymbols: rawOnly,
      rpsBasis:
        "Original800 constituent cross section; common raw dates verified and normalized-capture extra dates separately audited. All800 active signals use actual frozen GBBQ at each original first-raw anchor, with identical common endpoint eligibility for all nine periods; legacy forward columns are comparison only.",
    },
  };
}
