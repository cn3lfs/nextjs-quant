import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { posix, resolve } from "node:path";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { build } from "esbuild";
import type { ClassicWeek } from "../../../packages/trading-strategies/src/csi800-composite";
import type { Bar } from "trading-strategy-core/bars";

export const classicOracleCommit = "ec7d38099859ace507647a2432074afdc7a57a1e";
export const classicOracleManifest =
  ".data/csi800-factors-20261108-115614/manifest.json";
export const oracleHash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function restoreHistoricalBytes(bytes: Buffer, expected: string) {
  if (oracleHash(bytes) === expected) return { bytes, eol: "git-bytes" };
  const restored = Buffer.from(
    bytes.toString("utf8").replace(/\r?\n/g, "\r\n"),
  );
  if (oracleHash(restored) === expected)
    return { bytes: restored, eol: "restored-crlf" };
  throw new Error("Historical source bytes do not match frozen manifest");
}
export function assertOracleContributors(
  inputs: Record<string, { bytesInOutput: number }>,
  approved: ReadonlySet<string>,
) {
  for (const [path, input] of Object.entries(inputs))
    if (
      input.bytesInOutput > 0 &&
      path !== "oracle-wrapper" &&
      !approved.has(path)
    )
      throw new Error(`Unverified source contributes to oracle: ${path}`);
}
async function fileHash(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Compile only the exact historical pure target algorithm, never its execution engine. */
export async function buildClassicOracle(output: string) {
  const manifest = JSON.parse(
    await readFile(classicOracleManifest, "utf8"),
  ) as { codeHashes: Record<string, string> };
  const sources = new Map<string, Buffer>();
  const restored: { path: string; sha256: string; eol: string }[] = [];
  for (const [path, expected] of Object.entries(manifest.codeHashes)) {
    if (path === "pnpm-lock.yaml") continue; // Explicit missing original lock; zero dependency contribution is enforced below.
    const source = restoreHistoricalBytes(
      execFileSync("git", ["show", `${classicOracleCommit}:${path}`], {
        maxBuffer: 16000000,
      }),
      expected,
    );
    sources.set(path, source.bytes);
    restored.push({ path, sha256: expected, eol: source.eol });
  }
  const unlisted = new Map<string, string>();
  const readGit = (path: string) => {
    const known = sources.get(path);
    if (known) return known;
    const bytes = execFileSync(
      "git",
      ["show", `${classicOracleCommit}:${path}`],
      { maxBuffer: 16000000, stdio: ["ignore", "pipe", "ignore"] },
    );
    sources.set(path, bytes);
    unlisted.set(path, oracleHash(bytes));
    return bytes;
  };
  const locate = (path: string) => {
    const candidates = /\.(?:[jt]s|json)$/.test(path)
      ? [path.replace(/\.js$/, ".ts"), path]
      : [`${path}.ts`, `${path}/index.ts`];
    for (const candidate of candidates) {
      try {
        readGit(candidate);
        return candidate;
      } catch {
        /* Only try supported source filenames. */
      }
    }
    throw new Error(`Missing historical module: ${path}`);
  };
  const result = await build({
    stdin: {
      contents: `export {buildClassicSchedule,classicCommonWindow} from "historic:packages/quant-backtest/src/csi800-composite.ts";export {csi800SignalBars} from "historic:packages/quant-backtest/src/csi800-signal.ts";export {csi800ClassicFactors} from "historic:packages/quant-backtest/src/csi800-factors.ts";`,
      sourcefile: "oracle-wrapper",
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    metafile: true,
    treeShaking: true,
    plugins: [
      {
        name: "verified-historical-source",
        setup(api) {
          api.onResolve({ filter: /^historic:/ }, (args) => ({
            path: args.path.slice(9),
            namespace: "historical",
            sideEffects: false,
          }));
          api.onResolve({ filter: /.*/, namespace: "historical" }, (args) => {
            if (args.path.startsWith("."))
              return {
                path: locate(
                  posix.normalize(
                    posix.join(posix.dirname(args.importer), args.path),
                  ),
                ),
                namespace: "historical",
                sideEffects: false,
              };
            if (args.path.startsWith("trading-strategy-core/"))
              return {
                path: locate(
                  `packages/trading-strategy-core/src/${args.path.slice("trading-strategy-core/".length)}`,
                ),
                namespace: "historical",
                sideEffects: false,
              };
            // These pure-library imports may only disappear through tree shaking. Any
            // surviving external or bundled contribution is rejected after compilation.
            return { path: args.path, external: true, sideEffects: false };
          });
          api.onLoad({ filter: /.*/, namespace: "historical" }, (args) => ({
            contents: readGit(args.path),
            loader: args.path.endsWith(".json") ? "json" : "ts",
          }));
        },
      },
    ],
  });
  const verified = new Set(restored.map((s) => `historical:${s.path}`));
  for (const item of Object.values(result.metafile!.outputs)) {
    if (item.imports.length)
      throw new Error(
        `Oracle retains external runtime dependencies: ${JSON.stringify(item.imports)}`,
      );
    assertOracleContributors(item.inputs, verified);
  }
  await mkdir(output, { recursive: true });
  const enginePath = resolve(output, "historical-target-engine.mjs"),
    engine = result.outputFiles[0]!.contents;
  await writeFile(enginePath, engine);
  const audit = {
    version: "historical-classic-source-reconstruction-1",
    commit: classicOracleCommit,
    restored,
    resolvedButNotApproved: [...unlisted].map(([path, sha256]) => ({
      path,
      sha256,
    })),
    missingOriginalLock: manifest.codeHashes["pnpm-lock.yaml"],
    boundary:
      "Exact target-algorithm/source and fixed-input reconstruction only. Original lock bytes unavailable; no unverified or third-party source contributes output. This is not a full environment byte replay.",
    engineHash: oracleHash(engine),
    metafile: result.metafile,
  };
  await writeFile(
    resolve(output, "source-manifest.json"),
    JSON.stringify(audit, null, 2),
  );
  const api = (await import(pathToFileURL(enginePath).href)) as {
    csi800ClassicFactors: { direction: number }[];
    buildClassicSchedule: typeof import("../../../packages/trading-strategies/src/csi800-composite").buildClassicSchedule;
    classicCommonWindow: typeof import("../../../packages/trading-strategies/src/csi800-composite").classicCommonWindow;
    csi800SignalBars: (stock: {
      symbol: string;
      bars: Bar[];
      actions: {
        date: string;
        dividend: number;
        bonus: number;
        rights?: number;
        rightsPrice?: number;
        unsupported: boolean;
      }[];
    }) => Bar[];
  };
  return { api, audit };
}

export async function reconstructClassicTargets(output: string) {
  const destination = resolve(output),
    allowed = resolve(".test-data/lifecycle-20261116/oracle");
  if (destination !== allowed)
    throw new Error(
      "Oracle output must use the approved task/oracle directory",
    );
  if (
    !process.env.QUANT_DATA_DIR ||
    !/^[A-Za-z]:[\\/]/.test(process.env.QUANT_DATA_DIR)
  )
    throw new Error("Explicit isolated absolute QUANT_DATA_DIR required");
  const startedAt = new Date().toISOString(),
    { api, audit } = await buildClassicOracle(destination);
  const fixture: ClassicWeek = {
    date: "2026-11-06",
    nextDate: "2026-11-09",
    marketBudget: 1,
    rows: ["a", "b"].map((symbol, i) => ({
      symbol,
      values: api.csi800ClassicFactors.map((f) => (i + 1) * f.direction),
      volatility: 0.1 + i * 0.1,
      amihud: 1,
      positiveEquity: true,
      reportDate: "2026-06-30",
      announcementDate: "2026-08-01",
      availableFrom: "2026-08-02",
      marketCap: 100000,
    })),
  };
  const fixtureResult = api.buildClassicSchedule(
    [fixture],
    { model: "classic-five", count: 2, risk: "none" },
    () => null,
  );
  if (
    !isDeepStrictEqual(fixtureResult.audit[0]!.selected, ["b", "a"]) ||
    Object.values(fixtureResult.allocations[0]!.weights).some((w) => w !== 0.15)
  )
    throw new Error("Historical oracle small fixture failed");
  const missingRisk = api.buildClassicSchedule(
    [fixture],
    { model: "classic-five", count: 2, risk: "volatility" },
    () => null,
  );
  if (
    !missingRisk.audit[0]!.riskMissing ||
    Object.values(missingRisk.allocations[0]!.weights).some((w) => w !== 0)
  )
    throw new Error("Historical oracle missing-risk negative control failed");
  const manifest = JSON.parse(await readFile(classicOracleManifest, "utf8"));
  const paths = [
    {
      path: manifest.inputs.pricePath as string,
      hash: manifest.inputs.priceHash as string,
    },
    {
      path: manifest.panel.path as string,
      hash: manifest.panel.fileHash as string,
    },
    {
      path: manifest.inputs.financial.path as string,
      hash: manifest.inputs.financial.fileHash as string,
    },
  ];
  for (const source of paths)
    if ((await fileHash(source.path)) !== source.hash)
      throw new Error(`Frozen input hash mismatch: ${source.path}`);
  const price = JSON.parse(
    await readFile(manifest.inputs.pricePath, "utf8"),
  ) as {
    end: string;
    stocks: Parameters<typeof api.csi800SignalBars>[0][];
    benchmark: Bar[];
  };
  const panelBytes = gunzipSync(await readFile(manifest.panel.path));
  if (oracleHash(panelBytes) !== manifest.panel.contentHash)
    throw new Error("Frozen panel content hash mismatch");
  const weeks = JSON.parse(panelBytes.toString("utf8")) as ClassicWeek[];
  const common = api.classicCommonWindow(weeks);
  if (
    common.start !== manifest.commonStart ||
    common.firstSignal !== manifest.firstSignal
  )
    throw new Error("Frozen common date axis differs");
  const series = new Map(
    price.stocks.map((s) => [
      s.symbol,
      new Map(api.csi800SignalBars(s).map((b) => [b.date, b.close])),
    ]),
  );
  const dates = price.benchmark.map((b) => b.date),
    indices = new Map(dates.map((d, i) => [d, i]));
  const riskAt = (symbol: string, date: string) => {
    const index = indices.get(date),
      history = series.get(symbol);
    if (index === undefined || index < 60 || !history) return null;
    const closes = dates
      .slice(index - 60, index + 1)
      .map((d) => history.get(d));
    return closes.some((c) => c === undefined || !(c > 0))
      ? null
      : closes.slice(1).map((c, i) => c! / closes[i]! - 1);
  };
  const targets = api.buildClassicSchedule(
    weeks,
    {
      model: "classic-five",
      count: 20,
      risk: "volatility",
      startSignal: common.firstSignal!,
    },
    riskAt,
  );
  const targetBytes = JSON.stringify(targets),
    targetHash = oracleHash(targetBytes);
  if (Buffer.byteLength(targetBytes) > 1800000)
    throw new Error("Targets exceed the approved 2MiB oracle disk budget");
  await writeFile(
    resolve(destination, "classic-five-base-targets.json"),
    targetBytes,
  );
  const record = {
    version: "classic-target-reconstruction-1",
    status: "reconstructed-targets-only",
    startedAt,
    completedAt: new Date().toISOString(),
    sourceManifest: classicOracleManifest,
    sourceManifestHash: oracleHash(await readFile(classicOracleManifest)),
    engineHash: audit.engineHash,
    inputHashes: paths,
    panelContentHash: manifest.panel.contentHash,
    targetHash,
    bytes: Buffer.byteLength(targetBytes),
    commonStart: common.start,
    firstSignal: common.firstSignal,
    finalDate: targets.allocations.at(-1)?.date,
    weeks: targets.allocations.length,
    missingRiskWeeks: targets.audit.filter((a) => a.riskMissing).length,
    maximumResidentMiB: process.resourceUsage().maxRSS / 1024,
    boundary:
      "Reconstructed from exact historical pure algorithm and hash-matching inputs, not recovered original targets; no return/fill simulation. New L3 governance overlays are deliberately absent from these BASE oracle targets.",
  };
  await writeFile(
    resolve(destination, "reconstruction-manifest.json"),
    JSON.stringify(record, null, 2),
  );
  return record;
}
