import type { Bar } from "trading-strategy-core/bars";
import { marketRules } from "trading-strategy-core/market-rules";
import type { StrategyBookFacts } from "trading-strategies";
import {
  csi800SignalBars,
  type Csi800Stock,
  type ClassicWeek,
} from "trading-strategies";
import { readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { researchExecutionAt } from "../corporate-actions";
import { readIndustryBlocks } from "../../market/industry-blocks";

import {
  lifecycleRpsPeriods,
  type LifecycleMarketSource,
  type LifecycleSourceOptions,
  type SourceStage,
} from "./source-types";
import {
  bytesHash,
  contentHash,
  hashFile,
  verifiedSourceJson,
  sourceDiskBoundary,
  orderedBars,
} from "./source-artifacts";
import { type Registration } from "./source-axis";
import { frozenGbbqSource, freezeSignalBasis } from "./signal-basis";
import { normalizedExecutionSources } from "./execution-capture";
import { captureLowZoneSources } from "./low-zone";
import { buildLifecycleRps } from "./rps";

const defaultIndustryRoot = "D:/quant-data/wdz-blocks/2026-11-07/Blocks";
const defaultIndustryHash =
  "73c2a6d4bf5d876e30a1d14ce789285747109334f87a03e7224de0313542825b";

export async function captureCnMarket(
  config: Registration,
  options: LifecycleSourceOptions,
  output: string,
  configHash: string,
  frozenAt: string,
  stage: SourceStage,
) {
  const manifestPath = resolve(
    options.classicManifestPath ??
      ".data/csi800-factors-20261108-115614/manifest.json",
  );
  const reconstructionPath = resolve(
    options.reconstructionPath ??
      ".test-data/lifecycle-20261116/oracle/reconstruction-manifest.json",
  );
  const [manifestBytes, reconstructionBytes] = await Promise.all([
    readFile(manifestPath),
    readFile(reconstructionPath),
  ]);
  const manifest = JSON.parse(manifestBytes.toString()) as {
    inputs: {
      pricePath: string;
      priceHash: string;
      financial: { path: string; fileHash: string };
    };
    panel: { path: string; fileHash: string; contentHash: string };
    commonStart: string;
    firstSignal: string;
  };
  const oracle = JSON.parse(reconstructionBytes.toString()) as {
    sourceManifestHash: string;
    inputHashes: { path: string; hash: string }[];
    panelContentHash: string;
    commonStart: string;
    firstSignal: string;
    finalDate: string;
  };
  if (
    oracle.sourceManifestHash !== bytesHash(manifestBytes) ||
    oracle.panelContentHash !== manifest.panel.contentHash ||
    oracle.commonStart !== manifest.commonStart ||
    oracle.firstSignal !== manifest.firstSignal
  )
    throw new Error("Classic oracle/source manifest mismatch");
  const files = [
    { path: manifest.inputs.pricePath, hash: manifest.inputs.priceHash },
    { path: manifest.panel.path, hash: manifest.panel.fileHash },
    {
      path: manifest.inputs.financial.path,
      hash: manifest.inputs.financial.fileHash,
    },
  ];
  for (const file of files) {
    if (
      !oracle.inputHashes.some(
        (f) => resolve(f.path) === resolve(file.path) && f.hash === file.hash,
      ) ||
      (await hashFile(file.path)) !== file.hash
    )
      throw new Error(`Frozen classic source hash mismatch: ${file.path}`);
  }
  const price = await verifiedSourceJson<{
    stocks: Csi800Stock[];
    benchmark: Bar[];
    end: string;
  }>(files[0]!.path, files[0]!.hash);
  await stage("price:parsed");
  if (price.stocks.length !== (options.expectedRawPoolSize ?? 800))
    throw new Error(
      "Frozen original raw CSI800 price-pool size differs from exact source identity",
    );
  orderedBars(price.benchmark, "cn benchmark");
  const weeks = await verifiedSourceJson<ClassicWeek[]>(
    manifest.panel.path,
    manifest.panel.fileHash,
    { maxOutputLength: 1024 ** 3, contentHash: manifest.panel.contentHash },
  );
  await stage("panel:parsed");
  if (
    !weeks.some((w) => w.date === manifest.firstSignal) ||
    !weeks.some((w) => w.date === oracle.finalDate)
  )
    throw new Error(
      "Classic first signal/final target absent from source panel",
    );
  const cnCalendar = price.benchmark.map((b) => b.date);
  if (
    config.axes.cnSwing.start !== manifest.commonStart ||
    config.axes.cnSwing.end !== price.end ||
    cnCalendar.indexOf(manifest.firstSignal) < 0 ||
    cnCalendar.indexOf(manifest.commonStart) !==
      cnCalendar.indexOf(manifest.firstSignal) + 1 ||
    oracle.finalDate > price.end
  )
    throw new Error(
      "Declared CN first-signal/first-fill/target/valuation source boundaries differ",
    );
  const baselineRisk = price.stocks.map((stock) => ({
    symbol: stock.symbol,
    bars: csi800SignalBars(stock).map(({ date, close }) => ({ date, close })),
  }));
  await stage("baseline:compact");
  const pendingRankBytes =
    price.stocks.length *
    Math.max(0, cnCalendar.length - Math.max(...lifecycleRpsPeriods)) *
    lifecycleRpsPeriods.length *
    4;
  const gbbq = await frozenGbbqSource(
    output,
    options,
    manifest.inputs.priceHash,
    configHash,
    frozenAt,
  );
  const normalized = await normalizedExecutionSources(
    options,
    price.stocks,
    manifest.inputs.priceHash,
    configHash,
    price.end,
    output,
    pendingRankBytes,
    gbbq,
  );
  await stage("execution:normalized");
  const basis = await freezeSignalBasis(
    price.stocks,
    normalized.facts,
    gbbq,
    output,
    files[0]!,
    price.end,
    pendingRankBytes,
  );
  await stage("signals:first-anchor");
  const causalStocks = price.stocks.map((stock) => ({
    ...stock,
    bars: basis.raws.get(stock.symbol)!,
    signalBars: basis.signals.get(stock.symbol)!,
    actions: [],
  }));
  const rps = buildLifecycleRps(causalStocks, cnCalendar, lifecycleRpsPeriods);
  await stage("rps:shared-view");
  const cnMissing: string[] = [...normalized.missing, ...basis.missing];
  type Status = {
    symbol: string;
    suspensionFrom: string;
    suspensionNoticePublishedOn?: string;
    suspensionSource: string;
    listingEndsOn: string;
    listingNoticePublishedOn: string;
    listingSource: string;
    classification: string;
  };
  const statusPath =
    options.terminalStatusPath === undefined
      ? ".test-data/lifecycle-20261116/l3/terminal-status-evidence.json"
      : options.terminalStatusPath;
  const statusBytes = statusPath ? await readFile(statusPath) : null,
    status = statusBytes
      ? (JSON.parse(statusBytes.toString()) as {
          version: string;
          events: Status[];
        })
      : null;
  if (status && status.version !== "lifecycle-terminal-status-evidence-1")
    throw new Error("Terminal status evidence schema differs");
  const statuses = new Map(
    status?.events.map((event) => [event.symbol, event]) ?? [],
  );
  for (let i = 0; i < cnMissing.length; i++) {
    const event = status?.events.find((e) =>
      cnMissing[i]!.startsWith(`${e.symbol}: missing-tail`),
    );
    if (event)
      cnMissing[i] =
        `${event.symbol}: known suspension effective ${event.suspensionFrom}; termination notice ${event.listingNoticePublishedOn}, effective ${event.listingEndsOn}; unsupported merger conversion/settlement accounting, raw tail retained without synthetic cash/quotes; ${event.listingSource}`;
  }
  let industries: StrategyBookFacts["industries"];
  let industryIdentity: unknown = null;
  const industryRoot =
    options.industryRoot === undefined
      ? defaultIndustryRoot
      : options.industryRoot;
  if (industryRoot) {
    const industry = await readIndustryBlocks(industryRoot);
    const expected =
      options.expectedIndustryHash ??
      (industryRoot === defaultIndustryRoot ? defaultIndustryHash : undefined);
    if (expected && industry.hash !== expected)
      throw new Error("Frozen industry Blocks source hash mismatch");
    industryIdentity = industry;
    const groups = new Map<string, Set<string>>();
    for (const file of industry.files)
      for (const symbol of file.members) {
        const names = groups.get(symbol) ?? new Set<string>();
        names.add(file.name);
        groups.set(symbol, names);
      }
    const date = new Date(Math.max(...industry.files.map((f) => f.mtimeMs)))
      .toISOString()
      .slice(0, 10);
    industries = [...groups].map(([symbol, names]) => ({
      symbol,
      date,
      availableAt: date,
      groups: [...names].sort(),
      source: `current Blocks full membership ${industry.hash}`,
      basis: "current" as const,
    }));
  } else
    cnMissing.push(
      "industry: no frozen current-labelled industry source/hash supplied",
    );
  const cnInstruments = normalized.executionSymbols.flatMap((symbol) => {
    const facts = normalized.facts.get(symbol);
    if (!facts) return [];
    return [
      {
        symbol,
        market: "cn-equity" as const,
        bars: facts.bars,
        signalBars: facts.signalBars,
        actions: facts.actions,
        external: { rps: rps.rpsBySymbol.get(symbol)! },
        execution:
          facts.execution ??
          ((
            bar: Readonly<Bar> | undefined,
            previous: Readonly<Bar> | undefined,
          ) => researchExecutionAt(symbol, bar, previous, facts.actions)),
      },
    ];
  });
  const longest = Math.max(...lifecycleRpsPeriods);
  const admissionSources = cnInstruments.map((instrument) => {
    const bars = new Map(instrument.bars.map((b) => [b.date, b])),
      first = instrument.bars[0]?.date,
      firstIndex = first ? cnCalendar.findIndex((d) => d >= first) : -1,
      prefix = [0];
    for (const d of cnCalendar)
      prefix.push(prefix.at(-1)! + (bars.has(d) ? 0 : 1));
    return { symbol: instrument.symbol, bars, firstIndex, prefix };
  });
  const admissionAudit: {
    date: string;
    preObservationOrWarmup: string[];
    knownNoTurnover: string[];
    knownStatusUnavailable: string[];
    unknown: string[];
  }[] = [];
  const memberships = cnCalendar.map((date, i) => {
    const symbols: string[] = [],
      preObservationOrWarmup: string[] = [],
      knownNoTurnover: string[] = [],
      knownStatusUnavailable: string[] = [],
      unknown: string[] = [];
    for (const source of admissionSources) {
      if (source.firstIndex < 0 || i < source.firstIndex + longest) {
        preObservationOrWarmup.push(source.symbol);
        continue;
      }
      const observedStatus = statuses.get(source.symbol),
        knownAt =
          observedStatus?.suspensionNoticePublishedOn ??
          observedStatus?.listingNoticePublishedOn;
      if (
        observedStatus &&
        knownAt &&
        date >= knownAt &&
        date >= observedStatus.suspensionFrom
      ) {
        knownStatusUnavailable.push(
          `${source.symbol}: ${date >= observedStatus.listingEndsOn ? "unsupported-conversion-after-listing-end" : "known-suspension"}; knownAt=${knownAt}; effectiveFrom=${observedStatus.suspensionFrom}`,
        );
        continue;
      }
      const bar = source.bars.get(date),
        start = Math.max(source.firstIndex, i - longest),
        missingWindow = source.prefix[i + 1]! - source.prefix[start]!;
      if (!bar || missingWindow > 0) {
        unknown.push(
          `${source.symbol}: source hole in required structure/endpoint window`,
        );
        continue;
      }
      if (!rps.isEligible(source.symbol, date)) {
        const endpoints = [
          date,
          ...lifecycleRpsPeriods.map((p) => cnCalendar[i - p]!),
        ].map((d) => source.bars.get(d));
        if (endpoints.some((b) => !b))
          unknown.push(`${source.symbol}: missing declared RPS endpoint`);
        else if (endpoints.some((b) => b!.volume <= 0 || b!.amount <= 0))
          knownNoTurnover.push(source.symbol);
        else
          unknown.push(
            `${source.symbol}: normalized RPS adjustment not proved`,
          );
        continue;
      }
      symbols.push(source.symbol);
    }
    admissionAudit.push({
      date,
      preObservationOrWarmup,
      knownNoTurnover,
      knownStatusUnavailable,
      unknown,
    });
    return {
      strategyId: "lifecycle-source-cn",
      date,
      availableAt: date,
      symbols,
      basis: "current-labelled",
      source:
        "Frozen execution799 mask plus source-only common132 warmup/endpoint eligibility; not historical IPO or PIT membership certification",
    };
  });
  for (const row of admissionAudit)
    if (row.date >= manifest.firstSignal && row.unknown.length)
      cnMissing.push(
        `eligibility:${row.date}: ${row.unknown.join(";")}; date retained`,
      );
  const cnIdentity = {
    files,
    manifestHash: bytesHash(manifestBytes),
    reconstructionHash: bytesHash(reconstructionBytes),
    industry: industryIdentity,
    rps: rps.audit,
    normalized: normalized.identity,
    signalBasis: basis.proof,
    terminalStatus:
      statusPath && statusBytes
        ? {
            path: resolve(statusPath),
            hash: bytesHash(statusBytes),
            evidence: status,
            availabilityPolicy:
              "Daily admission uses only proven suspension publication dates; absent suspension publication uses the proven listing-notice date conservatively. Later status retrieval never backdates historical knowledge. Conversion and terminal accounting remain unsupported.",
          }
        : null,
    baselineRisk: {
      source: manifest.inputs.priceHash,
      originalSymbols: price.stocks.map((s) => s.symbol),
      policy:
        "Original800 csi800SignalBars and original actions; normalized actions never rewrite BASE risk",
      signalAlgorithmHash: await hashFile(
        "packages/trading-strategies/src/csi800-signal.ts",
      ),
    },
    admission: {
      strategyId: "lifecycle-source-cn",
      rowHash: contentHash(memberships),
      audit: admissionAudit,
      basis:
        "current-labelled execution snapshot; pre-first-observation/technical warmup is known not eligible, an internal history hole is unknown",
    },
    costs: {
      ...marketRules["cn-equity"].costs!,
      sellTaxSchedule: { kind: "cn-equity-historical" as const, multiplier: 1 },
    },
  };
  const cn: LifecycleMarketSource = {
    request: {
      market: "cn-equity",
      initial: 1000000,
      calendar: cnCalendar,
      instruments: cnInstruments,
      memberships,
      costs: cnIdentity.costs,
    },
    benchmark: price.benchmark,
    bookFacts: {
      benchmark: { symbol: "sh000906", bars: price.benchmark },
      classicWeeks: weeks,
      classicRiskSeries: baselineRisk,
      ...(industries ? { industries } : {}),
    },
    inputHash: contentHash(cnIdentity),
    source: `classic raw800 ${manifestPath}; RPS same800 cross section; separately frozen normalized799 execution mask`,
    missing: cnMissing,
    rawUniverse: {
      symbols: price.stocks.map((s) => s.symbol),
      source: manifest.inputs.pricePath,
      hash: manifest.inputs.priceHash,
    },
    executionUniverse: {
      symbols: normalized.executionSymbols,
      source:
        "Original raw800 minus frozen831 exclusion; target799 unchanged, distinct from later capture-directory roster",
      hash: contentHash(normalized.executionSymbols),
    },
    signalBasis: basis.proof,
  };
  const projectedRankPath = join(output, `ranks-${rps.audit.rankHash}.f32`);
  await stage("admission:built");
  let indexCacheEstimate = 0;
  const sourceTdxRoot =
    options.tdxRoot === undefined ? "E:/new_tdx64" : options.tdxRoot;
  if (sourceTdxRoot)
    for (const symbol of ["sh000300", "sh000001"]) {
      try {
        indexCacheEstimate +=
          (await stat(join(sourceTdxRoot, "vipdoc/sh/lday", `${symbol}.day`)))
            .size *
            2 +
          16384;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  await sourceDiskBoundary(
    output,
    projectedRankPath,
    rps.rankBytes.byteLength,
    indexCacheEstimate,
  );
  const lowZone = await captureLowZoneSources(
    options,
    files[2]!,
    manifest.inputs.priceHash,
    price.end,
    price.stocks,
    rps.signals,
    frozenAt,
    output,
    configHash,
    projectedRankPath,
    rps.rankBytes.byteLength,
    stage,
  );
  await stage("low-zone:captured");

  return {
    cn,
    cnIdentity,
    firstSignal: manifest.firstSignal,
    finalDate: oracle.finalDate,
    lowZone,
    rankPath: projectedRankPath,
    rankBytes: rps.rankBytes,
    rankAudit: rps.audit,
  };
}
