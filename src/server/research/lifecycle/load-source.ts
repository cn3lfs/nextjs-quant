import { readFile, stat, mkdir, readdir, appendFile } from "node:fs/promises";
import { resolve, isAbsolute, relative, join, dirname } from "node:path";
import { columnCacheDirectory } from "../../market/bar-store/column-cache";

import {
  lifecycleConfigHash,
  lifecycleRpsPeriods,
  type LifecycleFamilyAxis,
  type LifecycleSourceBundle,
  type LifecycleSourceOptions,
  type SourceStage,
} from "./source-types";
import {
  sourceCacheBudget,
  processBudget,
  bytesHash,
  contentHash,
  memoryBoundary,
  immutableFile,
} from "./source-artifacts";
import {
  dayAfter,
  naturalDays,
  type Registration,
  familyWarmup,
  axis,
} from "./source-axis";
import { lifecycleLowZoneAxis } from "./low-zone";
import { captureCnMarket } from "./cn-market";
import { captureCryptoMarkets } from "./crypto-market";

let loaded: { key: string; bundle: Promise<LifecycleSourceBundle> } | undefined;
/** Source-only load. Native readers authenticate their durable files; no venue
 * fetch, production settings read, trial execution or result-based axis choice. */
export function loadLifecycleSource(
  configPath = "research/configs/l3.json",
  options: LifecycleSourceOptions = {},
): Promise<LifecycleSourceBundle> {
  const key = JSON.stringify([resolve(configPath), options]);
  if (loaded?.key === key) return loaded.bundle;
  if (loaded)
    throw new Error(
      "One shared lifecycle source per process; start a separate isolated fixture process for another source",
    );
  const bundle = readLifecycleSource(configPath, options).catch(
    (error: unknown) => {
      if (loaded?.key === key) loaded = undefined;
      throw error;
    },
  );
  loaded = { key, bundle };
  return bundle;
}

async function readLifecycleSource(
  configPath: string,
  options: LifecycleSourceOptions,
): Promise<LifecycleSourceBundle> {
  const isolated = process.env.QUANT_DATA_DIR;
  if (!isolated || !isAbsolute(isolated))
    throw new Error("Explicit isolated absolute QUANT_DATA_DIR required");
  const configBytes = await readFile(configPath),
    configHash = bytesHash(configBytes);
  if (configHash !== (options.expectedConfigHash ?? lifecycleConfigHash))
    throw new Error("Frozen lifecycle registration bytes changed");
  const config = JSON.parse(configBytes.toString()) as Registration;
  if (
    contentHash(config.rankSource.periods) !== contentHash(lifecycleRpsPeriods)
  )
    throw new Error("Registered RPS periods changed");
  const output = resolve(
    options.outputRoot ?? join(config.resources.mutableOutputRoot, "source"),
  );
  const authorized = [
    resolve(isolated),
    resolve(".test-data/lifecycle-20261116/l3"),
  ].some((root) => {
    const child = relative(root, output);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  });
  if (!authorized)
    throw new Error(
      "Source cache must stay within the task's isolated output roots",
    );
  const stage: SourceStage = async (name) => {
    const memory = process.memoryUsage();
    await mkdir(dirname(output), { recursive: true });
    await appendFile(
      join(dirname(output), "source-memory.jsonl"),
      JSON.stringify({
        stage: name,
        at: new Date().toISOString(),
        pid: process.pid,
        ...memory,
        nativeMaxRss: process.resourceUsage().maxRSS * 1024,
        limitBytes: processBudget,
      }) + "\n",
    );
    memoryBoundary();
  };
  await stage("source:start");
  const frozenAt = new Date(options.now ?? Date.now()).toISOString();

  const {
    cn,
    cnIdentity,
    firstSignal,
    finalDate,
    lowZone,
    rankPath,
    rankBytes,
    rankAudit,
  } = await captureCnMarket(
    config,
    options,
    output,
    configHash,
    frozenAt,
    stage,
  );
  const cnCalendar = cn.request.calendar;
  const cnMissing = cn.missing;
  const { binanceRoot, cryptoSources, cap, day, fourHour } =
    await captureCryptoMarkets(
      options,
      output,
      frozenAt,
      rankPath,
      rankBytes.byteLength,
      stage,
    );
  const markets = {
    "cn-day": cn,
    "crypto-day": day,
    "crypto-4h": fourHour,
  };
  const families: Record<string, LifecycleFamilyAxis> = {};
  for (const { family } of config.families) {
    const warmup = familyWarmup(config, family);
    if (family === "cn-equity:swing") {
      const { start, end } = config.axes.cnSwing;
      const axisDays = [
        ...new Set([
          start,
          ...cnCalendar.filter((d) => d >= start && d <= end),
          end,
        ]),
      ].sort();
      const missing = [...cnMissing];
      if (!cnCalendar.includes(start) || !cnCalendar.includes(end))
        missing.push(
          "axis: declared CN start/end missing; declared boundaries are preserved",
        );
      if (cnCalendar.indexOf(start) < warmup - 1)
        missing.push(
          "warmup: declared CN axis lacks maximum registered source warmup",
        );
      families[family] = axis(
        axisDays,
        ["cn-day"],
        warmup,
        cnCalendar[0] ?? null,
        missing,
        firstSignal,
        finalDate,
      );
    } else if (family === "cn-equity:low-zone") {
      const coverage = lifecycleLowZoneAxis(lowZone.input, warmup);
      families[family] = axis(
        coverage.dailyAxis,
        ["cn-day"],
        warmup,
        coverage.warmupStart,
        [...coverage.missing, ...lowZone.sourceInfo.financial.missing],
        undefined,
        coverage.targetThrough,
      );
    } else {
      const periods = [
        ...new Set(
          config.main
            .filter((m) => m.family === family)
            .map((m) => m.strategy.period),
        ),
      ];
      const keys = [
        ...new Set([
          ...(periods.includes("day") ? ["crypto-day" as const] : []),
          ...(periods.includes("4h") ? ["crypto-4h" as const] : []),
          "crypto-day" as const,
        ]),
      ];
      const needed = [
        ...new Set([
          ...periods.flatMap((p) =>
            ["BTCUSDT", "ETHUSDT"].map((s) => `${s}:${p}`),
          ),
          "BTCUSDT:day",
        ]),
      ].map((key) => ({ key, ...cryptoSources[key]! }));
      const missing = needed.flatMap((s) => s.missing),
        starts = needed.map((s) => s.coverage.first),
        ends = needed.map((s) => s.coverage.last);
      if (starts.some((s) => s === null) || ends.some((s) => s === null)) {
        families[family] = axis([], keys, warmup, null, [
          ...missing,
          "axis: required native source absent; no common axis fabricated",
        ]);
        continue;
      }
      const warmupStart = starts
          .filter((s): s is string => s !== null)
          .sort()
          .at(-1)!,
        start = dayAfter(warmupStart, warmup - 1),
        end = [cap, ...ends.filter((s): s is string => s !== null)].sort()[0]!;
      const dailyAxis = naturalDays(start, end);
      for (const source of needed) {
        const complete = new Set(source.coverage.complete);
        for (const day of naturalDays(warmupStart, end))
          if (!complete.has(day))
            missing.push(
              `axis:${source.key}: ${day} missing; retained in shared axis/warmup`,
            );
      }
      families[family] = axis(dailyAxis, keys, warmup, warmupStart, [
        ...new Set(missing),
      ]);
    }
  }
  await stage("families:axis-frozen");
  const identities = {
    configHash,
    marketIdentities: Object.fromEntries(
      Object.entries(markets).map(([key, source]) => [key, source.inputHash]),
    ),
    classic: cnIdentity,
    lowZone: {
      ...lowZone.sourceInfo,
      indices: lowZone.sourceInfo.indices.map(({ bars, ...source }) => ({
        ...source,
        first: bars[0]?.date,
        last: bars.at(-1)?.date,
        count: bars.length,
      })),
      inputRoles: lowZone.input
        ? {
            index: lowZone.input.index.symbol,
            calendarHash: contentHash(lowZone.input.calendar),
            stocks: lowZone.input.stocks.map((s) => s.symbol),
            valuationRows: lowZone.input.valuations.length,
          }
        : null,
    },
    crypto: {
      root: binanceRoot,
      series: Object.fromEntries(
        Object.entries(cryptoSources).map(([key, s]) => [
          key,
          {
            hash: s.hash,
            files: s.files,
            coverage: s.coverage,
            missing: s.missing,
          },
        ]),
      ),
    },
    families,
  };
  const inputHash = contentHash(identities);
  await stage("source:identity-hashed");
  const manifestOutput = join(output, `source-${inputHash}.json`);
  let originalFrozenAt = frozenAt,
    originalBarStoreBytes: number | undefined;
  try {
    const prior = JSON.parse(await readFile(manifestOutput, "utf8")) as {
      frozenAt: string;
      resources?: { nativeReadColumnCacheBytes?: number };
    };
    if (!Number.isFinite(Date.parse(prior.frozenAt)))
      throw new Error("Frozen source timestamp invalid");
    originalFrozenAt = prior.frozenAt;
    originalBarStoreBytes = prior.resources?.nativeReadColumnCacheBytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Current-labelled membership is a biased snapshot, not historical
  // availability. Reuse the persisted capture instant for the same identity.
  if (lowZone.input)
    lowZone.input.constituents = lowZone.input.constituents.map((snapshot) => ({
      ...snapshot,
      availableAt: originalFrozenAt,
    }));
  let barStoreBytes = 0;
  try {
    for (const file of await readdir(columnCacheDirectory(), {
      withFileTypes: true,
    }))
      if (file.isFile())
        barStoreBytes += (await stat(join(columnCacheDirectory(), file.name)))
          .size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const sourceManifest = {
    version: "lifecycle-source-1",
    frozenAt: originalFrozenAt,
    configHash,
    inputHash,
    identities,
    biasTags: [
      "frozen-CSI800-labelled-roster-effective-date-uncertified",
      "roster-three-in-three-out-versus-later-R2a5-capture",
      "current-industry-lookahead-or-missing",
      "historical-ST-IPO-queue-unverified",
      "current-CSI300-membership-lookahead",
      "low-zone-coverage-must-be-verified",
    ],
    labels: {
      cnDay: "YYYY-MM-DD completed exchange date",
      cryptoDay: "YYYY-MM-DD opening UTC day; completes next00",
      crypto4h: "ISO END label; completion-1ms determines its UTC day",
    },
    rankCache: { path: rankPath, ...rankAudit },
    resources: {
      processes: 1,
      nodeHeapMiB: 4096,
      derivedCacheBytes: rankBytes.byteLength,
      nativeReadColumnCacheBytes: originalBarStoreBytes ?? barStoreBytes,
      derivedCacheLimit: sourceCacheBudget,
      sharedOriginalObjects: true,
      perTrialClone: false,
    },
    boundary:
      "Source freeze/read adapters only. No strategy or equity returns executed. firstSignal is a pre-axis seed; targetThrough and valuationThrough are separate. Missing facts remain explicit.",
  };
  const manifestOutputBytes = JSON.stringify(sourceManifest, null, 2);
  await stage("source:manifest-serialized");
  if (
    rankBytes.byteLength + Buffer.byteLength(manifestOutputBytes) >
    sourceCacheBudget
  )
    throw new Error("Lifecycle derived source cache exceeds512MiB");
  memoryBoundary();
  await mkdir(output, { recursive: true });
  const existing = await readdir(output, { withFileTypes: true });
  let existingBytes = 0;
  for (const file of existing) {
    if (!file.isFile())
      throw new Error("Unexpected non-file in lifecycle derived cache");
    existingBytes += (await stat(join(output, file.name))).size;
  }
  const additional =
    (existing.some((f) => f.name === rankPath.slice(output.length + 1))
      ? 0
      : rankBytes.byteLength) +
    (existing.some((f) => f.name === manifestOutput.slice(output.length + 1))
      ? 0
      : Buffer.byteLength(manifestOutputBytes));
  if (existingBytes + additional + barStoreBytes > sourceCacheBudget)
    throw new Error(
      "Total lifecycle derived source cache exceeds512MiB; preserve existing inputs",
    );
  await immutableFile(rankPath, rankBytes);
  await immutableFile(manifestOutput, manifestOutputBytes);
  await stage("source:complete");
  return {
    version: "lifecycle-source-1",
    configHash,
    frozenAt: originalFrozenAt,
    inputHash,
    source: `Immutable source sidecar ${manifestOutput}`,
    biasTags: sourceManifest.biasTags,
    markets,
    families,
    lowZoneSources: lowZone.sourceInfo,
    ...(lowZone.input ? { lowZoneInput: lowZone.input } : {}),
    manifestPath: manifestOutput,
  };
}
