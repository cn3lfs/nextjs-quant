import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Summarizes the raw R3/S4 batch archives under `.codex-runs/r3-results` into
 * a readable table. Read-only aggregation — never recomputes a backtest.
 *
 * S4 fix (docs/trading-skills-next-round-plan.md §2 item 3, executor brief on
 * this round): the row key MUST be the archived preset id (the JSON
 * filename), never `raw.spec?.strategy`. 161/162 B2/B5 composite presets
 * resolve to the same `spec.strategy` ("dual-breakout"; 1 resolves to
 * "boll-band-recovery" — see src/lib/research-risk-presets.ts:616-620), so
 * keying by `spec.strategy` collapsed 161 independently-run trials into one
 * table row and would support a false "component has no effect" conclusion.
 * `spec.strategy` is still surfaced as a separate `resolvedStrategy` column
 * so a reader can see the collapse risk directly, but it is never used as an
 * identity key here.
 *
 * Hard constraint (this round's dispatch / next-round-plan.md §5): the
 * five-minute anchor window (2000-01-04..2022-11-30) must be reported in a
 * table separate from the daily/monthly anchor window, even though the two
 * windows currently happen to share the same start/end dates — the
 * underlying bar granularity and per-day availability are not comparable.
 * This script splits every section into two parts (五分钟锚 / 日线·月线锚)
 * using each record's `anchor` field (written by scripts/r3-batch-runner.ts);
 * for older archives lacking that field it falls back to inferring anchor
 * from the raw JSON's `spec.management.growthIntraday` / wyckoff-hourly
 * strategy name.
 */
type Row = {
  batch: string;
  presetId: string;
  resolvedStrategy: string;
  anchor: "five-minute" | "daily-or-monthly";
  chanUnverifiedBaseline: boolean;
  label: string;
  devEvents: number;
  valEvents: number;
  signalCount: number;
  winRate: number | null;
  payoff: number | null;
  expectancy: number | null;
  trades: number;
  tradeExcluded: number;
  topTradeReason: string;
  poolExcluded: number;
  topPoolReason: string;
};

const root = ".codex-runs/r3-results";

const top = (counts: Record<string, number>) => {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries.length ? `${entries[0]![0]}（${entries[0]![1]}）` : "";
};

const wyckoffHourlyStrategies = new Set([
  "wy-daily-hourly",
  "wy-week-day-hour",
]);
const isChanFiveMinuteName = (id: string) =>
  (id.startsWith("chan-zhongyin-") ||
    (id.startsWith("chan-") && id.endsWith("-c4"))) &&
  id.includes("-five-");
const isChanBaseline = (id: string) => id.startsWith("chan-");

type RecordsMeta = Map<
  string,
  {
    label: string;
    anchor?: "five-minute" | "daily-or-monthly";
    chanUnverifiedBaseline?: boolean;
  }
>;

function loadRecordsMeta(batchDir: string): RecordsMeta {
  const meta: RecordsMeta = new Map();
  const recordsPath = join(root, batchDir, "records.json");
  if (!existsSync(recordsPath)) return meta;
  try {
    const records = JSON.parse(readFileSync(recordsPath, "utf8")) as Array<{
      presetId?: string | null;
      strategy?: string | null; // pre-S4 archives used this field name
      label: string;
      anchor?: "five-minute" | "daily-or-monthly";
      chanUnverifiedBaseline?: boolean;
    }>;
    for (const record of records) {
      const id = record.presetId ?? record.strategy;
      if (id) meta.set(id, record);
    }
  } catch {
    /* Malformed/partial records.json: fall back to raw-file inference below. */
  }
  return meta;
}

const rows: Row[] = [];
for (const batch of readdirSync(root)) {
  const dir = join(root, batch, "raw");
  if (!existsSync(dir)) continue;
  // 冒烟目录是同一批的预跑，不计入结果表。
  if (/smoke/.test(batch)) continue;
  const meta = loadRecordsMeta(batch);
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
      spec?: { strategy?: string; management?: { growthIntraday?: unknown } };
      partitions?: {
        partition: string;
        events: number;
        eventStatistics?: {
          count: number;
          winRate: number | null;
          payoffRatio: number | null;
          expectancy: number | null;
        };
        simulation?: {
          trades?: unknown[];
          excluded?: { reason?: string }[];
          statistics?: { count: number };
        };
      }[];
      exclusions?: { reason?: string }[];
      status?: string;
      error?: string;
    };
    // Identity key: always the archived filename (== preset id), never
    // raw.spec?.strategy (see module doc above — that field collapses).
    const presetId = file.replace(/\.json$/, "");
    const resolvedStrategy = raw.spec?.strategy ?? presetId;
    const known = meta.get(presetId);
    const anchor: Row["anchor"] =
      known?.anchor ??
      (raw.spec?.management?.growthIntraday != null ||
      wyckoffHourlyStrategies.has(resolvedStrategy) ||
      isChanFiveMinuteName(resolvedStrategy)
        ? "five-minute"
        : "daily-or-monthly");
    const chanUnverifiedBaseline =
      known?.chanUnverifiedBaseline ?? isChanBaseline(resolvedStrategy);
    const development = raw.partitions?.find(
      (p) => p.partition === "development",
    );
    const validation = raw.partitions?.find(
      (p) => p.partition !== "development",
    );
    const tradeReasons: Record<string, number> = {};
    let trades = 0;
    let tradeExcluded = 0;
    for (const partition of raw.partitions ?? []) {
      trades += partition.simulation?.statistics?.count ?? 0;
      for (const item of partition.simulation?.excluded ?? []) {
        tradeExcluded += 1;
        const reason = item.reason ?? "未记录原因";
        tradeReasons[reason] = (tradeReasons[reason] ?? 0) + 1;
      }
    }
    const poolReasons: Record<string, number> = {};
    for (const item of raw.exclusions ?? []) {
      const reason = item.reason ?? "未记录原因";
      poolReasons[reason] = (poolReasons[reason] ?? 0) + 1;
    }
    const label =
      known?.label ??
      (raw.status === "failed"
        ? String(raw.error ?? "").includes("missing") ||
          String(raw.error ?? "").includes("缺")
          ? "数据不足"
          : "规则实现失败"
        : "（records.json 缺该项，未在批次交付登记标签）");
    rows.push({
      batch,
      presetId,
      resolvedStrategy,
      anchor,
      chanUnverifiedBaseline,
      label,
      devEvents: development?.events ?? 0,
      valEvents: validation?.events ?? 0,
      signalCount: development?.eventStatistics?.count ?? 0,
      winRate: development?.eventStatistics?.winRate ?? null,
      payoff: development?.eventStatistics?.payoffRatio ?? null,
      expectancy: development?.eventStatistics?.expectancy ?? null,
      trades,
      tradeExcluded,
      topTradeReason: top(tradeReasons),
      poolExcluded: raw.exclusions?.length ?? 0,
      topPoolReason: top(poolReasons),
    });
  }
}

rows.sort((a, b) => b.signalCount - a.signalCount);
const percent = (value: number | null) =>
  value === null ? "—" : `${(value * 100).toFixed(2)}%`;
const ratio = (value: number | null) =>
  value === null ? "—" : value.toFixed(2);

function renderSection(heading: string, subset: Row[], lines: string[]) {
  const byLabel: Record<string, number> = {};
  for (const row of subset) byLabel[row.label] = (byLabel[row.label] ?? 0) + 1;
  const withSignals = subset.filter((row) => row.signalCount > 0);
  const poolBlocked = subset.filter(
    (row) => row.signalCount === 0 && row.poolExcluded > 0,
  );

  lines.push(`## ${heading}（${subset.length} 个）`);
  lines.push("");
  lines.push("### 按结果标签分布");
  lines.push("");
  lines.push("| 标签 | 数量 |");
  lines.push("| --- | --- |");
  for (const [label, count] of Object.entries(byLabel).sort(
    (a, b) => b[1] - a[1],
  ))
    lines.push(`| ${label} | ${count} |`);
  lines.push("");
  lines.push(`### 产出信号的项（${withSignals.length} 个）——信号层事件统计`);
  lines.push("");
  lines.push(
    "期望值为固定持有期的单次事件平均收益，未扣交易摩擦、未经可成交性检验。标 † 的项依赖 czsc 输出，其基线未经验证（czsc-tdx 自带 tests 断言本身有误），不得据此判断算法正确性。",
  );
  lines.push("");
  lines.push(
    "| Preset ID | 解析后 strategy | 批 | 开发期信号 | 胜率 | 盈亏比 | 期望 | 交易 | 交易被拒主因 |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of withSignals.slice(0, 80))
    lines.push(
      `| \`${row.presetId}\`${row.chanUnverifiedBaseline ? " †" : ""} | \`${row.resolvedStrategy}\` | ${row.batch} | ${row.signalCount} | ${percent(row.winRate)} | ${ratio(row.payoff)} | ${percent(row.expectancy)} | ${row.trades} | ${row.topTradeReason} |`,
    );
  if (withSignals.length > 80)
    lines.push(
      `| … 其余 ${withSignals.length - 80} 个见归档 | | | | | | | | |`,
    );
  lines.push("");
  lines.push(`### 零信号且全池排除的项（${poolBlocked.length} 个）`);
  lines.push("");
  lines.push("| Preset ID | 解析后 strategy | 批 | 排除证券数 | 排除主因 |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const row of poolBlocked.slice(0, 60))
    lines.push(
      `| \`${row.presetId}\` | \`${row.resolvedStrategy}\` | ${row.batch} | ${row.poolExcluded} | ${row.topPoolReason} |`,
    );
  if (poolBlocked.length > 60)
    lines.push(`| … 其余 ${poolBlocked.length - 60} 个见归档 | | | | |`);
  lines.push("");
  lines.push("### 阻塞归因汇总");
  lines.push("");
  const allPool: Record<string, number> = {};
  const allTrade: Record<string, number> = {};
  for (const row of subset) {
    if (row.topPoolReason)
      allPool[row.topPoolReason.replace(/（\d+）$/, "")] =
        (allPool[row.topPoolReason.replace(/（\d+）$/, "")] ?? 0) + 1;
    if (row.topTradeReason)
      allTrade[row.topTradeReason.replace(/（\d+）$/, "")] =
        (allTrade[row.topTradeReason.replace(/（\d+）$/, "")] ?? 0) + 1;
  }
  lines.push("**证券池层排除主因（按出现该主因的项数）**");
  lines.push("");
  lines.push("| 原因 | 项数 |");
  lines.push("| --- | --- |");
  for (const [reason, count] of Object.entries(allPool).sort(
    (a, b) => b[1] - a[1],
  ))
    lines.push(`| ${reason} | ${count} |`);
  lines.push("");
  lines.push("**交易模拟层排除主因（按出现该主因的项数）**");
  lines.push("");
  lines.push("| 原因 | 项数 |");
  lines.push("| --- | --- |");
  for (const [reason, count] of Object.entries(allTrade).sort(
    (a, b) => b[1] - a[1],
  ))
    lines.push(`| ${reason} | ${count} |`);
  lines.push("");
}

const dailyRows = rows.filter((row) => row.anchor === "daily-or-monthly");
const fiveMinuteRows = rows.filter((row) => row.anchor === "five-minute");

const lines: string[] = [];
lines.push("# R3/S4 真实回测结果表（只读汇总，非效果判断）");
lines.push("");
lines.push(
  `由 \`scripts/r3-result-table.ts\` 从 \`.codex-runs/r3-results\` 的原始归档汇总，共 ${rows.length} 个具名 preset。**信号统计是固定持有期的事件观察，不是可成交业绩**。`,
);
lines.push("");
lines.push("## 0. 必读标注（适用于本表全部行）");
lines.push("");
lines.push(
  "- **存活/成分偏差，方向不保守**：证券池为通达信·成分·中证A500的**当前成分**快照，非时点历史成分。隐含“后来还活着且还在池里”——历史上曾被剔除、退市或从未纳入的证券不在样本中，这通常使结果好看于历史真实可交易情形。S5（时点成分）完成前，本表任何一行都带这个偏差。",
);
lines.push(
  "- **公司行动覆盖是较强证据，不是证明**：`dataset.actionCoverage` 永远不会是 `full`（只有 `partial`/`missing`）；本地 GBBQ 覆盖判定说的是“在一个我们拒绝称之为完整的源里没查到记录”，不等于“没发生过”。",
);
lines.push(
  "- **五分钟锚窗口与日线/月线锚窗口分表**：两者数值恰好都是 2000-01-04..2022-11-30，但 bar 粒度与逐日可用性不同，不是同一种统计口径，本表按 §1/§2 分开列出，不得跨表比较信号数、胜率等指标。",
);
lines.push(
  "- **czsc 未经验证基线**（标 †）：依赖 czsc 输出的方法（chan-native / chan-c4 系列）建立在未经验证的基线上——czsc-tdx 自带的 tests 断言本身有误（连笔都画错），不得据其判断实现正确性。",
);
lines.push(
  "- **固定输入测试通过只是程序证据，不是盈利证据**；回测结果是历史统计，不构成盈利预期。",
);
lines.push("");
renderSection("1. 日线/月线锚", dailyRows, lines);
renderSection("2. 五分钟锚", fiveMinuteRows, lines);

const out = "docs/trading-skills-r3-results.md";
writeFileSync(out, `${lines.join("\n")}\n`, "utf8");
console.log(
  `已写出 ${out}：共 ${rows.length} 个 preset（日线/月线锚 ${dailyRows.length}、五分钟锚 ${fiveMinuteRows.length}）`,
);
