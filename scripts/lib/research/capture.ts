import {
  task,
  config,
  prior,
  json,
  artifact,
  digest,
  delivery,
  type CompactInstrument,
  type EquityManifest,
} from "./context";
import { readArtifact } from "./context";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { calculateRps, type RpsSecurity } from "quant-rps";
import { historicalLowSeries } from "trading-strategies";
import { readBars } from "../../../src/server/market/bar-store/read-bars";
import { corporateActions } from "../../../src/server/market/bar-store/corporate-actions";
import { researchCorporateActions } from "../../../src/server/research/corporate-actions";
import { captureLowZoneFinancials } from "../../../src/server/research/validation-financials";
import { readFinancialPoolHistory } from "../../../src/server/data-sources/tdx/local-financial-files";
import type { ValidationUniverse } from "../../../src/server/research/validation-universe";
if (config.batch !== "R2a-5")
  throw new Error("Expanded capture requires R2a-5 config");
const old = await json<{
  constituents: string[];
  benchmark: unknown;
  sourceSha256: string;
  source: string;
}>(join(config.predecessor, "csi800.json"));
const roster = [...old.constituents].sort();
const rps = JSON.parse(await prior<string>("rps-root")) as {
  inputChunks: string[];
  rankChunks: string[];
  calendar: string[];
  dates: string[];
  universe: ValidationUniverse;
  sources: { symbol: string; hash: string }[];
};
const pack = await prior<{ blocks: Record<string, string> }>("rps-pack-index");
async function block<T>(hash: string): Promise<T> {
  const rows = await prior<{ hash: string; text: string }[]>(
    pack.blocks[hash]!,
  );
  const row = rows.find((r) => r.hash === hash);
  if (!row || digest(row.text) !== hash)
    throw new Error("Frozen full-market RPS input drift");
  return JSON.parse(row.text) as T;
}
const command = process.argv[2];
if (command === "prepare") {
  for (const name of [
    "crypto-coverage.json",
    "book-presets.json",
    "native-progress.json",
  ])
    await writeFile(
      join(task, name),
      await readFile(join(config.predecessor, name)),
    );
  await delivery({
    chanSubset: {
      status: "capture-complete",
      source: join(config.predecessor, "native-progress.json"),
      rule: "Reuse frozen causal observations, no new DLL capture",
    },
    nextStart:
      "Run audit, capture rps, capture equity, then study. Original archives remain at predecessor root.",
  });
} else if (command === "rps") {
  const stocks: RpsSecurity[] = [];
  for (const hash of rps.inputChunks) {
    const chunk = await block<{
      stocks: {
        symbol: string;
        name: string;
        firstDate: string;
        unsupportedDates: string[];
        closes: [string, number, number][];
      }[];
    }>(hash);
    stocks.push(
      ...chunk.stocks.map((s) => ({
        ...s,
        closes: new Map(
          s.closes.map(([d, close, volume]) => [d, { close, volume }]),
        ),
      })),
    );
  }
  if (stocks.length !== 5564)
    throw new Error("Frozen cross-section must remain 5564");
  const members = new Map(rps.universe.members.map((m) => [m.symbol, m]));
  const values = new Map(
    roster.map((s) => [s, new Float64Array(rps.dates.length * 9).fill(NaN)]),
  );
  const started = Date.now();
  for (const [i, date] of rps.dates.entries()) {
    const day = calculateRps(
      stocks.filter((s) => {
        const m = members.get(s.symbol);
        return (
          (!m?.listingDate || m.listingDate <= date) &&
          (!m?.delistingDate || m.delistingDate > date)
        );
      }),
      rps.calendar,
      date,
      [20, 50, 120],
    );
    for (const row of day.rows) {
      const v = values.get(row.symbol);
      if (v)
        row.values.forEach((p, j) => {
          if (p) {
            v[i * 9 + j * 3] = p.return;
            v[i * 9 + j * 3 + 1] = p.rank;
            v[i * 9 + j * 3 + 2] = p.rps;
          }
        });
    }
    if (i % 250 === 0)
      console.log(
        JSON.stringify({
          phase: "rps",
          done: i,
          total: rps.dates.length,
          elapsedMs: Date.now() - started,
        }),
      );
  }
  // The original eligible symbols prove expansion did not change their ranks.
  let compared = 0;
  for (const hash of rps.rankChunks)
    for (const row of (
      await block<{ rows: { symbol: string; values: (number | null)[] }[] }>(
        hash,
      )
    ).rows) {
      const current = values.get(row.symbol);
      if (!current) continue;
      row.values.forEach((v, i) => {
        if (v === null ? !Number.isNaN(current[i]!) : v !== current[i])
          throw new Error(`RPS parity ${row.symbol}/${i}`);
        compared++;
      });
    }
  const pointers = [];
  for (let i = 0; i < roster.length; i += 80)
    pointers.push(
      await artifact(
        `ranks-${i / 80}`,
        roster.slice(i, i + 80).map((symbol) => ({
          symbol,
          values: [...values.get(symbol)!].map((v) =>
            Number.isNaN(v) ? null : v,
          ),
        })),
      ),
    );
  await writeFile(
    join(task, "rps-expanded.json"),
    JSON.stringify(
      {
        pointers,
        dates: rps.dates,
        stocks: stocks.length,
        retained: roster.length,
        compared,
        elapsedMs: Date.now() - started,
      },
      null,
      2,
    ),
  );
  await delivery({
    csi800Coverage: {
      status: "rps-expanded",
      crossSection: 5564,
      ranked: 800,
      comparedOriginalValues: compared,
    },
  });
} else if (command === "equity") {
  process.env.QUANT_RESEARCH_BAR_STORE_DIR = resolve(
    ".test-data/r1a/data/bar-store",
  );
  if (digest(await readFile(old.source)) !== old.sourceSha256)
    throw new Error("CSI800 roster source changed");
  const rankManifest = await json<{
    pointers: { path: string; sha256: string }[];
  }>(join(task, "rps-expanded.json"));
  const ranks = new Map<string, (number | null)[]>();
  for (const p of rankManifest.pointers)
    for (const r of await readArtifact<
      { symbol: string; values: (number | null)[] }[]
    >(p))
      ranks.set(r.symbol, r.values);
  const actions = await corporateActions(config.root);
  const financial = await readFinancialPoolHistory(config.root, roster, {
    asOf: config.end,
    strict: true,
    limit: 160,
    fieldIds: [96, 271],
  });
  const manifest: EquityManifest = {
    eligible: [],
    shards: [],
    benchmark: [],
    audit: [],
  };
  const index = await readBars({
    root: config.root,
    instrument: { market: "cn-equity", symbol: "sh000906" },
    period: "day",
    adjustment: "none",
    to: config.end,
  });
  manifest.benchmark = index.bars;
  for (let start = 0; start < roster.length; start += 80) {
    const name = `equity-${start / 80}`;
    let rows: CompactInstrument[] = [];
    for (const symbol of roster.slice(start, start + 80)) {
      try {
        const backward = await readBars({
          root: config.root,
          instrument: { market: "cn-equity", symbol },
          period: "day",
          adjustment: "backward",
          to: config.end,
        });
        if (
          backward.hash !== rps.sources.find((s) => s.symbol === symbol)?.hash
        )
          throw new Error("Raw/GBBQ source differs from frozen RPS");
        const view = await readBars({
          root: config.root,
          instrument: { market: "cn-equity", symbol },
          period: "day",
          adjustment: "forward",
          freezeRaw: true,
          to: config.end,
        });
        if (view.sourceNote)
          throw new Error(`Repaired raw source: ${view.sourceNote}`);
        const raw = view.rawBars!;
        if (raw.at(-1)?.date !== config.end)
          throw new Error(
            `Tail ends ${raw.at(-1)?.date}; not certified delisting`,
          );
        const events = researchCorporateActions(
          actions.events.get(symbol) ?? [],
          actions.fingerprint,
          "2010-01-01",
          config.end,
        );
        const capture = await captureLowZoneFinancials(
          config.root,
          symbol,
          view.bars.map((b) => b.date),
          financial,
        );
        rows.push({
          symbol,
          sourceHash: view.hash,
          adjustmentReference: view.barStore.adjustmentReference,
          rps: ranks.get(symbol)!,
          actions: events,
          columns: raw.map((b, i) => {
            const a = view.bars[i]!;
            if (a.date !== b.date) throw new Error("Unaligned prices");
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
          lowFacts: capture.facts.map((f) => [
            f.date,
            f.pe ?? null,
            f.pb ?? null,
          ]),
          lowObservations: historicalLowSeries(
            view.bars,
            {},
            capture.facts,
          ).filter(
            (o, i, a) =>
              i === 0 ||
              o.depth !== a[i - 1]!.depth ||
              o.targetShare !== a[i - 1]!.targetShare ||
              o.recovery !== a[i - 1]!.recovery ||
              o.confidence !== a[i - 1]!.confidence,
          ),
        });
        if ((manifest.audit.length + 1) % 10 === 0)
          console.log(
            JSON.stringify({
              phase: "source-audit",
              done: manifest.audit.length + 1,
            }),
          );
        manifest.eligible.push(symbol);
        manifest.audit.push({
          symbol,
          accepted: true,
          reason:
            "GBBQ action scenario supported; raw/forward/frozen full-market source identity checked",
        });
      } catch (e) {
        manifest.audit.push({
          symbol,
          accepted: false,
          reason: e instanceof Error ? e.message : "Input audit failed",
        });
      }
    }
    const pointer = await artifact(name, rows);
    await writeFile(
      join(task, `${name}-pointer.json`),
      JSON.stringify(pointer),
    );
    manifest.shards.push(name);
    rows = [];
    await delivery({
      csi800Coverage: {
        status: "capturing",
        completed: manifest.audit.length,
        accepted: manifest.eligible.length,
        excluded: manifest.audit.filter((a) => !a.accepted),
      },
    });
    console.log(
      JSON.stringify({
        phase: "equity-capture",
        completed: manifest.audit.length,
        accepted: manifest.eligible.length,
      }),
    );
  }
  const pointer = await artifact("equity-input", manifest);
  await writeFile(join(task, "equity-pointer.json"), JSON.stringify(pointer));
  const csi = {
    ...old,
    symbols: manifest.eligible,
    executableCount: manifest.eligible.length,
    excluded: manifest.audit.filter((a) => !a.accepted),
    benchmark: {
      name: "CSI800000906 raw index, no dividends",
      hash: index.hash,
      bars: index.bars,
    },
  };
  const cp = await artifact("csi800-input", csi);
  await writeFile(join(task, "csi800-pointer.json"), JSON.stringify(cp));
  await writeFile(
    join(task, "csi800.json"),
    JSON.stringify(
      {
        ...csi,
        benchmark: {
          ...csi.benchmark,
          bars: index.bars.length,
          start: index.bars[0]?.date,
          end: index.bars.at(-1)?.date,
        },
      },
      null,
      2,
    ),
  );
  await delivery({
    csi800Coverage: {
      status: "complete",
      before: 258,
      after: manifest.eligible.length,
      total: 800,
      excluded: csi.excluded,
      sourceSha256: old.sourceSha256,
    },
    corporateActions: {
      status: "supported-and-captured",
      tests: 31,
      before: 258,
      after: manifest.eligible.length,
      policy:
        "Explicit GBBQ research entitlement scenario; no rights subscription; whole-share floor and no fabricated fractional cash",
    },
  });
} else throw new Error("capture requires rps|equity");
process.exit(0);
