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
/**
 * Pool accounting per batch, counted in SYMBOLS (not strategies). The manager
 * flagged (2026-09-19) that the "排除主因（按策略数）" table understates reasons
 * that hit every strategy at once: with `spec.start = 2000-01-04`, the 61-bar
 * warmup requirement (src/server/research-signals.ts:259-265) rejects every
 * symbol whose first daily bar is later than ~1999-08-31, i.e. ~80% of the
 * intent pool, for every strategy — it only looked small before S2 because the
 * corporate-action gate (193/44 strategies) dominated per-strategy tallies.
 */
const poolByBatch = new Map<
  string,
  Map<
    string,
    {
      intent: number;
      warmup: number;
      other: number;
      presets: number;
      topOtherReason: string;
    }
  >
>();
for (const batch of readdirSync(root)) {
  const dir = join(root, batch, "raw");
  if (!existsSync(dir)) continue;
  // 冒烟目录是同一批的预跑，不计入结果表。
  if (/smoke/.test(batch)) continue;
  const meta = loadRecordsMeta(batch);
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
      spec?: {
        strategy?: string;
        symbols?: string[];
        management?: { growthIntraday?: unknown };
      };
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
    const intent = raw.spec?.symbols?.length ?? 0;
    const warmup = Object.entries(poolReasons)
      .filter(([reason]) => reason.includes("预热"))
      .reduce((sum, [, count]) => sum + count, 0);
    // Normalize the per-symbol event count so variants of the same reason
    // ("研究窗口内 2 处…" / "…9 处…") aggregate into one row.
    const normalized: Record<string, number> = {};
    for (const [reason, count] of Object.entries(poolReasons))
      if (!reason.includes("预热")) {
        const key = reason.replace(/研究窗口内\s*\d+\s*处/, "研究窗口内 N 处");
        normalized[key] = (normalized[key] ?? 0) + count;
      }
    const otherReasons = Object.entries(normalized);
    const other = otherReasons.reduce((sum, [, count]) => sum + count, 0);
    const shapes = poolByBatch.get(batch) ?? new Map();
    const shapeKey = `${intent}/${warmup}/${other}`;
    const shape = shapes.get(shapeKey) ?? {
      intent,
      warmup,
      other,
      presets: 0,
      topOtherReason: "",
    };
    shape.presets += 1;
    if (otherReasons.length) {
      const [reason, count] = otherReasons.sort((a, b) => b[1] - a[1])[0]!;
      shape.topOtherReason = `${reason}（${count}）`;
    }
    shapes.set(shapeKey, shape);
    poolByBatch.set(batch, shapes);
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
  lines.push(
    "口径说明：本表按**项（preset）**计数，只统计每项**占比最高**的那一条原因，因此会系统性低估**对每一项都发生**的原因。61 根预热就是这种原因——它按**每股**移除约 80% 的意图池（见 §0.5），却只会在少数项里当上「主因」。不要把本表的数字读成「只影响这么多项」。",
  );
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
// A batch whose raw/ has files but no records.json is mid-flight (the driver
// writes records.json only in its final assembly run), so the table is a
// snapshot rather than a finished batch result. Say so mechanically instead of
// letting a partial archive read as a complete one.
const inProgress = [...new Set(rows.map((row) => row.batch))]
  .filter((batch) => !existsSync(join(root, batch, "records.json")))
  .sort();
if (inProgress.length)
  lines.push(
    `**进行中快照**：${inProgress.join("、")} 的 \`records.json\` 尚未生成（装配未完成），本批在表中的行数少于方法表要求的预设数，是**未跑完**而不是零信号。续跑命令见 \`.codex-runs/s4-delivery.md\`。`,
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
lines.push("## 0.5 证券池与有效池（按每股计数，不是按项计数）");
lines.push("");
lines.push(
  "研究窗口起点 2000-01-04 与「研究起点之前至少需要 61 根预热日线」（`src/server/research-signals.ts:259-265`：`if (first < warmup) throw new Error(...)`，`warmup` 非双均线策略为 61）叠加后，**本地首根日线晚于约 1999-08-31 的证券会被整只拒绝**，对每一个策略都如此。有效池因此不是「当前成分」，而是成分里**上市最早的那一批**——这是叠加在「当前成分回溯 + 存活偏差」之上的第二层偏差，方向同样是**不保守**（隐含「当时已上市且活到今天且仍在池里」）。",
);
lines.push("");
lines.push(
  "| 批 | 意图池（`spec.symbols`） | 因预热排除 | 其他原因排除 | 有效池 | 该取值的项数 | 其他原因主因 |",
);
lines.push("| --- | --- | --- | --- | --- | --- | --- |");
for (const [batch, shapes] of [...poolByBatch].sort((a, b) =>
  a[0] < b[0] ? -1 : 1,
)) {
  for (const shape of [...shapes.values()].sort(
    (a, b) => b.presets - a.presets,
  ))
    lines.push(
      `| ${batch} | ${shape.intent} | ${shape.warmup} | ${shape.other} | ${shape.intent - shape.warmup - shape.other} | ${shape.presets} | ${shape.topOtherReason || "—"} |`,
    );
}
lines.push("");
lines.push(
  "**有效池为 0 的含义**：该组项下没有任何证券同时满足预热与研究所需的覆盖证明，因此它们产出的是「无交易」而不是「策略无效」——例如量价族要求「量能可比性覆盖」（除权事件的 GBBQ `floatSharesBefore/floatSharesAfter` 逐条齐全），本批实测被该条整体拒绝。这类行必须读作**数据覆盖缺口**，不是策略结论。",
);
lines.push("");
lines.push(
  "年龄分布证据（逐项，不是百分比断言）：`.codex-runs/s4-delivery.md` §「预热偏差」列出意图池与有效池各自的**首根日线年份直方图**。实测：中证A500 当前成分 500 只中有效 **96** 只（19.2%），有效池的首根日线年份全部落在 1991–1999（最晚 1999-08-31），被排除的 404 只覆盖 1999-11 至 2023；B3 的 160 只抽样中有效 **33** 只（20.6%），分布同向。",
);
lines.push("");
renderSection("1. 日线/月线锚", dailyRows, lines);
renderSection("2. 五分钟锚", fiveMinuteRows, lines);

const out = "docs/trading-skills-r3-results.md";
writeFileSync(out, `${lines.join("\n").replace(/\n+$/, "")}\n`, "utf8");
console.log(
  `已写出 ${out}：共 ${rows.length} 个 preset（日线/月线锚 ${dailyRows.length}、五分钟锚 ${fiveMinuteRows.length}）`,
);
