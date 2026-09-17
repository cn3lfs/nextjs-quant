import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 把 R3 的原始 JSON 归档汇总成可读结果表。只读归档，不重算回测。 */
type Row = {
  batch: string;
  strategy: string;
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
const labelsPath = ".codex-runs/delivery.json";
const labels = new Map<string, string>();
if (existsSync(labelsPath)) {
  const delivery = JSON.parse(readFileSync(labelsPath, "utf8")) as {
    completedMethods?: {
      records?: { strategy: string | null; label: string }[];
    }[];
  };
  for (const method of delivery.completedMethods ?? [])
    for (const record of method.records ?? [])
      if (record.strategy) labels.set(record.strategy, record.label);
}

const top = (counts: Record<string, number>) => {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries.length ? `${entries[0]![0]}（${entries[0]![1]}）` : "";
};

const rows: Row[] = [];
for (const batch of readdirSync(root)) {
  const dir = join(root, batch, "raw");
  if (!existsSync(dir)) continue;
  // 冒烟目录是同一批的预跑，不计入结果表。
  if (/smoke/.test(batch)) continue;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
      spec?: { strategy?: string };
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
    };
    const strategy = raw.spec?.strategy ?? file.replace(/\.json$/, "");
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
    rows.push({
      batch,
      strategy,
      label: labels.get(strategy) ?? "（未在交付登记）",
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

const byLabel: Record<string, number> = {};
for (const row of rows) byLabel[row.label] = (byLabel[row.label] ?? 0) + 1;
const withSignals = rows.filter((row) => row.signalCount > 0);
const poolBlocked = rows.filter(
  (row) => row.signalCount === 0 && row.poolExcluded > 0,
);

const lines: string[] = [];
lines.push("# R3 首次真实回测结果表（只读汇总，非效果判断）");
lines.push("");
lines.push(
  `由 \`scripts/r3-result-table.ts\` 从 \`.codex-runs/r3-results\` 的原始归档汇总，共 ${rows.length} 个具名策略。**信号统计是固定持有期的事件观察，不是可成交业绩**；交易模拟当前普遍为 0，原因见下。`,
);
lines.push("");
lines.push("## 1. 按结果标签分布");
lines.push("");
lines.push("| 标签 | 策略数 |");
lines.push("| --- | --- |");
for (const [label, count] of Object.entries(byLabel).sort(
  (a, b) => b[1] - a[1],
))
  lines.push(`| ${label} | ${count} |`);
lines.push("");
lines.push(`## 2. 产出信号的策略（${withSignals.length} 个）——信号层事件统计`);
lines.push("");
lines.push(
  "期望值为固定持有期的单次事件平均收益，未扣交易摩擦、未经可成交性检验。",
);
lines.push("");
lines.push(
  "| 策略 | 批 | 开发期信号 | 胜率 | 盈亏比 | 期望 | 交易 | 交易被拒主因 |",
);
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const row of withSignals.slice(0, 60))
  lines.push(
    `| \`${row.strategy}\` | ${row.batch} | ${row.signalCount} | ${percent(row.winRate)} | ${ratio(row.payoff)} | ${percent(row.expectancy)} | ${row.trades} | ${row.topTradeReason} |`,
  );
if (withSignals.length > 60)
  lines.push(`| … 其余 ${withSignals.length - 60} 个见归档 | | | | | | | |`);
lines.push("");
lines.push(`## 3. 零信号且全池排除的策略（${poolBlocked.length} 个）`);
lines.push("");
lines.push("| 策略 | 批 | 排除证券数 | 排除主因 |");
lines.push("| --- | --- | --- | --- |");
for (const row of poolBlocked.slice(0, 40))
  lines.push(
    `| \`${row.strategy}\` | ${row.batch} | ${row.poolExcluded} | ${row.topPoolReason} |`,
  );
if (poolBlocked.length > 40)
  lines.push(`| … 其余 ${poolBlocked.length - 40} 个见归档 | | | |`);
lines.push("");
lines.push("## 4. 阻塞归因汇总");
lines.push("");
const allPool: Record<string, number> = {};
const allTrade: Record<string, number> = {};
for (const row of rows) {
  if (row.topPoolReason)
    allPool[row.topPoolReason.replace(/（\d+）$/, "")] =
      (allPool[row.topPoolReason.replace(/（\d+）$/, "")] ?? 0) + 1;
  if (row.topTradeReason)
    allTrade[row.topTradeReason.replace(/（\d+）$/, "")] =
      (allTrade[row.topTradeReason.replace(/（\d+）$/, "")] ?? 0) + 1;
}
lines.push("**证券池层排除主因（按出现该主因的策略数）**");
lines.push("");
lines.push("| 原因 | 策略数 |");
lines.push("| --- | --- |");
for (const [reason, count] of Object.entries(allPool).sort(
  (a, b) => b[1] - a[1],
))
  lines.push(`| ${reason} | ${count} |`);
lines.push("");
lines.push("**交易模拟层排除主因（按出现该主因的策略数）**");
lines.push("");
lines.push("| 原因 | 策略数 |");
lines.push("| --- | --- |");
for (const [reason, count] of Object.entries(allTrade).sort(
  (a, b) => b[1] - a[1],
))
  lines.push(`| ${reason} | ${count} |`);
lines.push("");

const out = "docs/trading-skills-r3-results.md";
writeFileSync(out, `${lines.join("\n")}\n`, "utf8");
console.log(
  `已写出 ${out}：${rows.length} 个策略，其中 ${withSignals.length} 个产出信号、${poolBlocked.length} 个全池排除`,
);
