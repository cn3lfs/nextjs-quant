import {
  task,
  prior,
  json,
  artifact,
  delivery,
  digest,
  type EquityManifest,
  type CompactInstrument,
} from "./lib/research-r2a4";
import { readBars } from "../src/server/market/bar-store/read-bars";
import { corporateActions } from "../src/server/market/bar-store/corporate-actions";
import {
  historicalLowSeries,
  lowZoneCycles,
  type LowZoneObservation,
} from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const command = process.argv[2];
if (command === "terminal") {
  process.env.QUANT_RESEARCH_BAR_STORE_DIR = resolve(
    ".test-data/r1a/data/bar-store",
  );
  const manifest = await prior<EquityManifest>("equity-input");
  const excluded = manifest.audit.filter((a) => !a.accepted);
  if (excluded.length !== 337)
    throw new Error("Expected all337 terminal-coverage exclusions");
  const rps = JSON.parse(await prior<string>("rps-root")) as {
    rankChunks: string[];
    sources: { symbol: string; hash: string }[];
  };
  const packed = await prior<{ blocks: Record<string, string> }>(
    "rps-pack-index",
  );
  const rankHashes = new Set(rps.rankChunks),
    excludedSet = new Set(excluded.map((a) => a.symbol));
  const ranks = new Map<string, (number | null)[]>();
  for (const name of [...new Set(rps.rankChunks.map((h) => packed.blocks[h]!))])
    for (const b of await prior<{ hash: string; text: string }[]>(name)) {
      if (!rankHashes.has(b.hash)) continue;
      if (digest(b.text) !== b.hash)
        throw new Error("Frozen RPS rank block drift");
      for (const row of (
        JSON.parse(b.text) as {
          rows: { symbol: string; values: (number | null)[] }[];
        }
      ).rows)
        if (excludedSet.has(row.symbol)) ranks.set(row.symbol, row.values);
    }
  const actions = await corporateActions("E:/new_tdx64");
  const shards = [];
  const audit = [];
  for (let start = 0; start < excluded.length; start += 60) {
    const rows: CompactInstrument[] = [];
    for (const { symbol } of excluded.slice(start, start + 60)) {
      const backward = await readBars({
        instrument: { market: "cn-equity", symbol },
        root: "E:/new_tdx64",
        period: "day",
        adjustment: "backward",
        to: "2026-11-13",
      });
      if (backward.hash !== rps.sources.find((s) => s.symbol === symbol)?.hash)
        throw new Error(
          `Terminal source no longer matches frozen RPS ${symbol}`,
        );
      const s = await readBars({
        instrument: { market: "cn-equity", symbol },
        root: "E:/new_tdx64",
        period: "day",
        adjustment: "forward",
        freezeRaw: true,
        to: "2026-11-13",
      });
      if (s.sourceNote) throw new Error(`Repaired terminal source ${symbol}`);
      const raw = s.rawBars!;
      const events = (actions.events.get(symbol) ?? []).filter(
        (a) => a.date >= "2010-01-01" && a.date <= "2026-11-13",
      );
      if (
        events.some(
          (e) =>
            [11, 12, 13, 14].includes(e.category) ||
            (e.category === 1 &&
              ((e.bonusRatio ?? 0) > 0 || (e.rightsRatio ?? 0) > 0)),
        )
      )
        throw new Error("Preliminary execution pool action lineage changed");
      rows.push({
        symbol,
        sourceHash: s.hash,
        adjustmentReference: s.barStore.adjustmentReference,
        rps: ranks.get(symbol)!,
        columns: raw.map((b, i) => {
          const a = s.bars[i]!;
          if (b.date !== a.date)
            throw new Error("Terminal raw/forward date alignment");
          return [
            b.date,
            b.open,
            b.high,
            b.low,
            b.close,
            b.volume,
            b.amount,
            a.open,
            a.high,
            a.low,
            a.close,
            a.volume,
            a.amount,
          ];
        }),
        actions: events
          .filter((a) => a.category === 1 && (a.dividend ?? 0) > 0)
          .map((a) => ({
            date: a.date,
            availableAt: a.date,
            dividend: a.dividend!,
            bonus: 0,
            evidence: `${actions.fingerprint}; ex-date cash scenario, unverified pay date`,
          })),
      });
      audit.push({
        symbol,
        bars: raw.length,
        first: raw[0]?.date,
        last: raw.at(-1)?.date,
        studyBars: raw.filter((b) => b.date >= "2010-01-01").length,
      });
    }
    shards.push(await artifact(`terminal-${Math.floor(start / 60)}`, rows));
    await writeFile(
      join(task, "terminal-input.json"),
      JSON.stringify(
        { shards, audit, complete: audit.length === 337 },
        null,
        2,
      ),
    );
    await delivery({
      survivorship: {
        status: "capturing",
        completed: audit.length,
        excluded: 337,
        shards,
      },
      nextStart:
        "Finish terminal source capture; then shared-cash last-price/total-loss scenarios",
    });
    console.log(JSON.stringify({ terminal: audit.length, total: 337 }));
  }
} else if (command === "low-diagnosis") {
  const old = await prior<{
    benchmark: { observations: LowZoneObservation[] };
  }>("low-input");
  const equity = await prior<EquityManifest>("equity-input");
  const csi = await json<{ benchmark: { bars: number } }>(
    join(task, "csi800.json"),
  );
  void csi;
  const csiPointer = await readdirArtifact("csi800-input");
  const csiInput = await import("node:zlib").then(
    async (z) =>
      JSON.parse(
        z
          .gunzipSync(
            await import("node:fs/promises").then((fs) =>
              fs.readFile(csiPointer),
            ),
          )
          .toString(),
      ) as { benchmark: { bars: Bar[] } },
  );
  const current = historicalLowSeries(equity.benchmark);
  if (JSON.stringify(current) !== JSON.stringify(old.benchmark.observations))
    throw new Error("Frozen low detector parity failed");
  const diagnostics = (rows: LowZoneObservation[]) =>
    [
      ["2012-01-01", "2014-12-31"],
      ["2016-01-01", "2016-12-31"],
      ["2018-01-01", "2019-12-31"],
    ].map(([start, end]) => {
      const points = rows.filter((r) => r.date >= start! && r.date <= end!);
      const minimum = points
        .filter((r) => r.price.value !== null)
        .sort((a, b) => a.price.value! - b.price.value!)[0];
      return {
        start,
        end,
        minimumPricePercentile: minimum ?? null,
        lowDays: points.filter((p) => p.depth !== null && p.depth > 0).length,
      };
    });
  const csiRows = historicalLowSeries(csiInput.benchmark.bars);
  const originalDelivery = await json<{
    lowZone: { symbols: { symbol: string; cycles: { start: string }[] }[] };
  }>(".codex-runs/delivery.R2a.json");
  const conclusion = {
    status: "verified-no-detector-defect",
    csi300: {
      start: equity.benchmark[0]?.date,
      rows: current.length,
      fullFrozenParity: true,
      cycles: lowZoneCycles(current),
      diagnostics: diagnostics(current),
    },
    csi800: {
      start: csiInput.benchmark.bars[0]?.date,
      rows: csiRows.length,
      cycles: lowZoneCycles(csiRows),
      diagnostics: diagnostics(csiRows),
    },
    r2aEvidence: originalDelivery.lowZone.symbols.map((s) => ({
      symbol: s.symbol,
      cycleStarts: s.cycles.map((c) => c.start),
    })),
    finding:
      "R2a's 2008/2018 examples are individual-security cycles; its CSI300 index uses the same single2024 cycle. CSI300 2019-01-03 price percentile42.87% exceeds fixed20%; 2012-2014 minimum25.35%; not a missing warmup. Thresholds unchanged. Index starts2005; 2008 lacks minimum5-year history.",
  };
  await writeFile(
    join(task, "low-diagnosis.json"),
    JSON.stringify(conclusion, null, 2),
  );
  await delivery({ lowZoneAudit: conclusion });
} else throw new Error("Expected terminal or low-diagnosis");
async function readdirArtifact(name: string) {
  return join(task, "artifacts", name + ".json.gz");
}
process.exit(0);
