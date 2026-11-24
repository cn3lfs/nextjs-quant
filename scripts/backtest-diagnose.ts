import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  BookControl,
  UniversePoolDisclosure,
} from "./lib/backtest-diagnose/types";
import type { DiagnoseBookKey } from "./lib/backtest-diagnose/strategy-specs";
import { coreBookCapacity } from "../src/server/research/diagnose/sleeve-attribution";
import {
  CORE_5_SYMBOLS,
  resolveUniversePreset,
} from "./lib/backtest-diagnose/universe-presets";

/**
 * Diagnostic backtest CLI. Isolation is resolved and applied to the process
 * before any application module is imported, so no default settings database
 * or production data directory can be opened by the import graph.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dataRoot = join(repoRoot, ".test-data");
const defaultStrategies = [
  "dual-ma",
  "turtle",
  "rsi2",
  "double-breakout",
  "formula",
];
const costScenarios = ["fixed", "base", "double-cost"] as const;
const executionProfiles = ["strict", "clamp", "no-slippage"] as const;
const capacityPolicies = ["clip", "reject"] as const;

type Args = {
  book?: DiagnoseBookKey;
  bookControl: BookControl;
  family?: string;
  holdoutStart?: string;
  plan: boolean;
  symbols: string[];
  pool?: UniversePoolDisclosure;
  strategies: string[];
  controls: string[];
  start: string;
  end: string;
  tdxRoot: string;
  initial: number;
  cost: (typeof costScenarios)[number];
  mode: "per-symbol" | "portfolio" | "both";
  outDir: string;
  dataDir: string;
  nativeCacheDir?: string;
  limit?: number;
  executionProfile: (typeof executionProfiles)[number];
  maxParticipation?: number;
  capacityPolicy?: (typeof capacityPolicies)[number];
};

function usage() {
  return [
    "用法：pnpm exec tsx scripts/backtest-diagnose.ts --tdx-root <绝对路径> [选项]",
    "  --pool        core-5 | core-12 | chan-core-7 | core-30-v1（与 --symbols 互斥）",
    "  --symbols     逗号分隔标的（默认 sh600519,sz000001,sh601318,sz000333,sz300750）",
    "  --strategies  信号策略（默认 dual-ma,turtle,rsi2,double-breakout,formula）",
    "  --family      ch14-exits 或逗号分隔的同族策略键；默认 portfolio，联合计算历史留出与 CSCV",
    "  --book-control none | equal-month-end | risk-parity-60（默认 none，现金划转对照用于 --book core-4）",
    "  --strategies  新增 research-chan-hold-cash-zd-atr、research-chan-ch04、research-chan-ch07、research-chan-ch12",
    "  --book core-4  四个等权分仓共享同日同票成交额的 0.5%（clip），仅 portfolio 模式，与 --strategies 互斥。组合默认单独运行，可用 --controls 添加对照",
    "  --holdout      启用历史留出复核，默认切点 2023-01-01",
    "  --holdout-start YYYY-MM-DD  启用历史留出复核并指定切点",
    "  --controls    对照（默认 hold）",
    "  --start       auto | YYYY-MM-DD（默认 auto）",
    "  --end         YYYY-MM-DD（默认 2026-11-20）",
    "  --initial     初始资金（默认 1000000）",
    "  --cost        fixed | base | double-cost（默认 base）",
    "  --mode        per-symbol | portfolio | both（默认 both）",
    "  --out         输出目录（默认 .test-data/backtest-diagnose/out）",
    "  --data-dir    隔离 QUANT_DATA_DIR，必须在 <repo>/.test-data 下",
    "  --native-cache-dir  原生缠论前缀缓存目录，必须在 <repo>/.test-data 下",
    "  --limit       只跑前 N 个单元（冒烟）",
    "  --execution-profile strict | clamp | no-slippage（默认 strict）",
    "  --max-participation  成交额参与率上限 (0,1]（core-4 默认 0.005，其余默认关闭）",
    "  --capacity-policy    clip | reject（core-4 默认 clip，其余启用容量时默认 reject）",
    "  --plan        只打印诊断单元，不读取行情",
  ].join("\n");
}

function parseList(value: string, name: string) {
  // The Windows pnpm PowerShell shim joins unquoted comma-separated arguments with spaces.
  const rows = value.split(/[,\s]+/).filter(Boolean);
  if (!rows.length) throw new Error(`${name} 不能为空`);
  if (new Set(rows).size !== rows.length) throw new Error(`${name} 不能重复`);
  return rows;
}

function parseDate(value: string, name: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error(`${name} 须为 YYYY-MM-DD：${value}`);
  return value;
}

export function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  let plan = false;
  let holdout = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--holdout") {
      holdout = true;
      continue;
    }
    if (arg === "--plan") {
      plan = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`未知参数：${arg}\n${usage()}`);
    const value = argv[++index];
    if (value === undefined)
      throw new Error(`参数 ${arg} 缺少取值\n${usage()}`);
    if (
      ![
        "--pool",
        "--symbols",
        "--strategies",
        "--book",
        "--book-control",
        "--family",
        "--holdout-start",
        "--controls",
        "--start",
        "--end",
        "--tdx-root",
        "--initial",
        "--cost",
        "--mode",
        "--out",
        "--data-dir",
        "--native-cache-dir",
        "--limit",
        "--execution-profile",
        "--max-participation",
        "--capacity-policy",
      ].includes(arg)
    )
      throw new Error(`未知参数：${arg}\n${usage()}`);
    values.set(arg, value);
  }
  if (values.has("--pool") && values.has("--symbols"))
    throw new Error("--pool 与 --symbols 不能同时使用，请选择一种证券池输入");
  const tdxRoot = values.get("--tdx-root");
  if (!tdxRoot) throw new Error("必须提供 --tdx-root（通达信根目录绝对路径）");
  if (!isAbsolute(tdxRoot))
    throw new Error(`--tdx-root 须为绝对路径：${tdxRoot}`);
  const end = parseDate(values.get("--end") ?? "2026-11-20", "--end");
  const start = values.get("--start") ?? "auto";
  if (start !== "auto") parseDate(start, "--start");
  const initial = Number(values.get("--initial") ?? "1000000");
  if (!Number.isFinite(initial) || initial <= 0)
    throw new Error("--initial 须为正数");
  const cost = (values.get("--cost") ?? "base") as Args["cost"];
  if (!costScenarios.includes(cost))
    throw new Error(`--cost 须为 ${costScenarios.join(" | ")}`);
  const book = values.get("--book");
  if (book !== undefined && book !== "core-4")
    throw new Error("--book 须为 core-4");
  if (book && values.has("--strategies"))
    throw new Error("--book 与 --strategies 互斥");
  const bookControl = values.get("--book-control") ?? "none";
  if (
    bookControl !== "none" &&
    bookControl !== "equal-month-end" &&
    bookControl !== "risk-parity-60"
  )
    throw new Error("--book-control 取值无效");
  if (!book && bookControl !== "none")
    throw new Error("--book-control 需要 --book");
  const family = values.get("--family");
  if (
    family !== undefined &&
    (!family.trim() || book || values.has("--strategies"))
  )
    throw new Error("--family 需要同族名称，且与 --book、--strategies 互斥");
  const holdoutStart =
    values.get("--holdout-start") ??
    (holdout || family ? "2023-01-01" : undefined);
  if (holdoutStart !== undefined) {
    parseDate(holdoutStart, "--holdout-start");
    if (new Date(holdoutStart).toISOString().slice(0, 10) !== holdoutStart)
      throw new Error("--holdout-start 日期无效");
  }
  const mode = (values.get("--mode") ??
    (book || family ? "portfolio" : "both")) as Args["mode"];
  if (book && mode !== "portfolio")
    throw new Error("--book 仅支持 portfolio 模式");
  if (!["per-symbol", "portfolio", "both"].includes(mode))
    throw new Error("--mode 须为 per-symbol | portfolio | both");
  const limitRaw = values.get("--limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    throw new Error("--limit 须为正整数");
  const executionProfile = (values.get("--execution-profile") ??
    "strict") as Args["executionProfile"];
  if (!executionProfiles.includes(executionProfile))
    throw new Error(
      `--execution-profile 须为 ${executionProfiles.join(" | ")}`,
    );
  const maxParticipationRaw = values.get("--max-participation");
  const bookCapacity = book && coreBookCapacity;
  const maxParticipation =
    maxParticipationRaw === undefined
      ? bookCapacity?.maxParticipation
      : Number(maxParticipationRaw);
  if (
    maxParticipation !== undefined &&
    (!Number.isFinite(maxParticipation) ||
      maxParticipation <= 0 ||
      maxParticipation > 1)
  )
    throw new Error("--max-participation 须为 (0,1] 内的有限小数");
  const capacityRaw = values.get("--capacity-policy");
  if (capacityRaw !== undefined && maxParticipation === undefined)
    throw new Error("--capacity-policy 须与 --max-participation 同时提供");
  const capacityPolicy =
    capacityRaw === undefined
      ? maxParticipation === undefined
        ? undefined
        : (bookCapacity?.capacityPolicy ?? "reject")
      : (capacityRaw as Args["capacityPolicy"]);
  if (
    capacityPolicy !== undefined &&
    !capacityPolicies.includes(capacityPolicy)
  )
    throw new Error(`--capacity-policy 须为 ${capacityPolicies.join(" | ")}`);
  const poolName = values.get("--pool");
  const preset =
    poolName === undefined ? undefined : resolveUniversePreset(poolName);
  let pool: UniversePoolDisclosure | undefined;
  if (preset) {
    pool = {
      id: preset.id,
      label: preset.label,
      symbolCount: preset.symbols.length,
      survivorBiasDisclosure: `${preset.survivorBiasDisclosure} 首次披露财报版本仍有缺口。`,
      ...(preset.id === "core-30-v1" && {
        overlapWithCore12: preset.overlapWithCore12,
      }),
      members: Object.entries(preset.metadata).map(([symbol, metadata]) => ({
        symbol,
        ...metadata,
      })),
    };
  }
  return {
    plan,
    symbols: values.has("--symbols")
      ? parseList(values.get("--symbols")!, "--symbols")
      : [...(preset?.symbols ?? CORE_5_SYMBOLS)],
    pool,
    book,
    holdoutStart,
    bookControl,
    family,
    strategies:
      book || family
        ? []
        : parseList(
            values.get("--strategies") ?? defaultStrategies.join(","),
            "--strategies",
          ),
    controls:
      (book || family) && !values.has("--controls")
        ? []
        : parseList(values.get("--controls") ?? "hold", "--controls"),
    start,
    end,
    tdxRoot: resolve(tdxRoot),
    initial,
    cost,
    mode,
    outDir: resolve(
      values.get("--out") ??
        join(repoRoot, ".test-data", "backtest-diagnose", "out"),
    ),
    dataDir: (() => {
      const raw = values.get("--data-dir") ?? process.env.QUANT_DATA_DIR ?? "";
      return raw ? resolve(raw) : "";
    })(),
    nativeCacheDir: (() => {
      const raw = values.get("--native-cache-dir");
      return raw ? resolve(raw) : undefined;
    })(),
    limit,
    executionProfile,
    maxParticipation,
    capacityPolicy,
  };
}

function realDirectoryPath(path: string): string {
  // lstat sees dangling links, so realpath errors for them fail closed.
  if (lstatSync(path, { throwIfNoEntry: false }))
    return realpathSync.native(path);
  const parent = dirname(path);
  if (parent === path) throw new Error(`找不到已存在的父目录：${path}`);
  return join(realDirectoryPath(parent), basename(path));
}

function contains(root: string, path: string) {
  const offset = relative(root, path);
  return (
    offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
  );
}

async function main() {
  if (process.argv.slice(2).includes("--help")) {
    console.log(usage());
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (!args.dataDir)
    throw new Error(
      `必须提供 --data-dir 或 QUANT_DATA_DIR（须在 ${dataRoot} 下）`,
    );
  const production = realDirectoryPath(
    resolve(process.env.LOCALAPPDATA ?? homedir(), "QuantWorkbench"),
  );
  const tdx = realDirectoryPath(args.tdxRoot);
  const allowed = join(realpathSync.native(repoRoot), ".test-data");

  function isolatedPath(flag: string, path: string) {
    const real = realDirectoryPath(path);
    const label = `${flag} ${path}（实际路径 ${real}）`;
    if (contains(production, real))
      throw new Error(`${label} 位于生产数据目录 ${production} 内`);
    if (contains(tdx, real))
      throw new Error(`${label} 位于通达信目录 ${tdx} 内`);
    if (!contains(allowed, real) || !relative(allowed, real))
      throw new Error(`${label} 必须位于 ${allowed} 下`);
    return real;
  }

  const dataDir = isolatedPath("--data-dir", args.dataDir);
  const requestedOut = lstatSync(args.outDir, { throwIfNoEntry: false });
  if (requestedOut && !requestedOut.isDirectory())
    throw new Error(`--out 须为真实目录：${args.outDir}`);
  const out = isolatedPath("--out", args.outDir);
  if (args.nativeCacheDir !== undefined) {
    const existing = lstatSync(args.nativeCacheDir, { throwIfNoEntry: false });
    if (existing && !existing.isDirectory())
      throw new Error(
        `--native-cache-dir 须为真实目录：${args.nativeCacheDir}`,
      );
  }
  const nativeCacheDir =
    args.nativeCacheDir === undefined
      ? undefined
      : isolatedPath("--native-cache-dir", args.nativeCacheDir);
  // Applied before every dynamic app import below.
  process.env.QUANT_DATA_DIR = dataDir;

  if (args.plan) {
    const { planDiagnoseCells } =
      await import("./lib/backtest-diagnose/strategy-specs");
    const cells = planDiagnoseCells({
      book: args.book,
      family: args.family,
      symbols: args.symbols,
      strategies: args.strategies,
      controls: args.controls,
      mode: args.mode,
    });
    const perSymbol = cells.filter((cell) => cell.mode === "per-symbol").length;
    if (args.family) console.log(`联合留出家族：${args.family}`);
    if (args.book) console.log(`分配政策：${args.bookControl}`);
    if (args.holdoutStart) console.log(`历史留出切点：${args.holdoutStart}`);
    console.log(
      `诊断单元共 ${cells.length} 个（per-symbol ${perSymbol} / portfolio ${cells.length - perSymbol}）`,
    );
    console.log(
      `窗口：${args.start === "auto" ? "auto（首根日线 + 策略预热）" : args.start} ~ ${args.end}`,
    );
    console.log(
      `执行情景：${args.executionProfile}；参与率上限：${args.maxParticipation ?? "关闭"}；容量策略：${args.capacityPolicy ?? "未启用"}`,
    );
    cells.forEach((cell, index) =>
      console.log(
        `[${index + 1}] ${cell.mode} ${cell.strategy} ${cell.symbols.join("+")}`,
      ),
    );
    return;
  }

  function createMissingDirectories(path: string) {
    if (!lstatSync(path, { throwIfNoEntry: false })) {
      createMissingDirectories(dirname(path));
      try {
        mkdirSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (!lstatSync(path).isDirectory())
      throw new Error(`输出路径须为真实目录：${path}`);
  }

  createMissingDirectories(out);
  const parent = isolatedPath("--out", realpathSync.native(out));
  const timestamp = new Date().toISOString().replace(/:/g, "-");
  const prefix = `run-${timestamp}-${process.pid}`;
  let runRoot: string;
  for (let suffix = 0; ; suffix++) {
    runRoot = join(parent, suffix ? `${prefix}-${suffix}` : prefix);
    try {
      mkdirSync(runRoot);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (!lstatSync(runRoot).isDirectory())
    throw new Error(`输出路径须为真实目录：${runRoot}`);
  runRoot = isolatedPath("--out", realpathSync.native(runRoot));
  console.log(`运行输出目录：${runRoot}`);

  const { runDiagnose } = await import("./lib/backtest-diagnose/run");
  const { closeCzsc } = await import("../src/server/strategies/chan/czsc");
  const { cells, reportPath } = await runDiagnose({
    book: args.book,
    holdoutStart: args.holdoutStart,
    family: args.family,
    bookControl: args.bookControl,
    symbols: args.symbols,
    pool: args.pool,
    strategies: args.strategies,
    controls: args.controls,
    mode: args.mode,
    start: args.start,
    end: args.end,
    tdxRoot: args.tdxRoot,
    initial: args.initial,
    cost: args.cost,
    outDir: runRoot,
    limit: args.limit,
    executionProfile: args.executionProfile,
    maxParticipation: args.maxParticipation,
    capacityPolicy: args.capacityPolicy,
    nativeCacheDir,
    log: (line) => console.log(line),
  }).finally(closeCzsc);
  const counts = {
    ok: cells.filter((cell) => cell.status === "ok").length,
    blocked: cells.filter((cell) => cell.status === "blocked").length,
    failed: cells.filter((cell) => cell.status === "failed").length,
  };
  console.log(
    `完成 ${cells.length} 个单元：ok ${counts.ok} / blocked ${counts.blocked} / failed ${counts.failed}`,
  );
  console.log(`报告：${reportPath}`);
  if (counts.failed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  try {
    await main();
  } catch (error) {
    console.error(
      `回测诊断失败：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
