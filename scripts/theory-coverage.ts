import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { unifiedStrategyCatalog } from "../packages/trading-strategies/src/unified";
import { theoryDefinitions } from "../packages/trading-strategies/src/theory-catalog";

export type TheoryCoverageCard = {
  theoryId: string;
  name: string;
  source: string;
  status: string;
  strategyIds: string[];
  evidence: string[];
  reason: string;
  batch: string;
  sourceReview: string;
};
export type TheoryCoverage = {
  version: number;
  asOf: string;
  meaning: string;
  cards: TheoryCoverageCard[];
};
const statuses = new Set([
  "existing-proxy",
  "new-proxy",
  "component",
  "engineering",
  "data-gap",
  "interpretation",
]);
const folder = "docs/research/theory-implementation";

/** Validate bindings against the actual catalogue rather than inferring implementation from a family. */
export async function validateTheoryCoverage(
  data: TheoryCoverage,
  root = process.cwd(),
) {
  const original = await readFile(
    resolve(root, "docs/research/theory-to-pseudocode/coverage.md"),
    "utf8",
  );
  const expected = new Map(
    [
      ...original.matchAll(
        /\| \[(F\d{2}\.\d{2})\]\(([^)]+)\)\s*\|\s*([^|]+)\|/g,
      ),
    ].map((m) => [
      m[1]!,
      { source: `../theory-to-pseudocode/${m[2]!}`, name: m[3]!.trim() },
    ]),
  );
  if (expected.size !== 228 || data.cards.length !== expected.size)
    throw new Error("理论覆盖数量不完整");
  const ids = new Set<string>();
  const catalog = new Map(unifiedStrategyCatalog.map((d) => [d.id, d]));
  for (const card of data.cards) {
    if (!expected.has(card.theoryId) || ids.has(card.theoryId))
      throw new Error(`理论ID重复或未知: ${card.theoryId}`);
    ids.add(card.theoryId);
    const origin = expected.get(card.theoryId)!;
    if (card.source !== origin.source || card.name !== origin.name)
      throw new Error(`理论来源或名称错配: ${card.theoryId}`);
    if (!statuses.has(card.status) || !card.reason.trim() || !card.batch.trim())
      throw new Error(`去向或理由缺失: ${card.theoryId}`);
    if (
      ["existing-proxy", "new-proxy"].includes(card.status) &&
      !card.strategyIds.length
    )
      throw new Error(`可执行代理缺绑定: ${card.theoryId}`);
    for (const id of card.strategyIds) {
      if (catalog.get(id)?.implementation !== "implemented")
        throw new Error(`代理未实现: ${card.theoryId} -> ${id}`);
    }
    if (new Set(card.strategyIds).size !== card.strategyIds.length)
      throw new Error(`重复绑定: ${card.theoryId}`);
    const [relative, anchor] = card.source.split("#");
    const source = await readFile(resolve(root, folder, relative!), "utf8");
    if (!anchor || !source.includes(`id="${anchor}"`))
      throw new Error(`来源锚点失效: ${card.theoryId}`);
    for (const path of card.evidence)
      await readFile(resolve(root, path), "utf8");
  }
  for (const definition of theoryDefinitions) {
    const card = data.cards.find((c) => c.theoryId === definition.theoryId);
    if (!card || !card.strategyIds.includes(definition.id))
      throw new Error(`新增规则缺理论映射: ${definition.id}`);
  }
}

export function renderTheoryCoverage(data: TheoryCoverage) {
  const counts = [...statuses]
    .map(
      (status) =>
        `${status}: ${data.cards.filter((c) => c.status === status).length}`,
    )
    .join("；");
  const batches = [...new Set(data.cards.map((c) => c.batch))]
    .sort()
    .map(
      (batch) =>
        `${batch}: ${data.cards.filter((c) => c.batch === batch).length}`,
    )
    .join("；");
  const bound = new Set(data.cards.flatMap((c) => c.strategyIds));
  const existing = new Set(
    data.cards
      .filter((c) => c.status === "existing-proxy")
      .flatMap((c) => c.strategyIds),
  );
  const fresh = new Set(
    data.cards
      .filter((c) => c.status === "new-proxy")
      .flatMap((c) => c.strategyIds),
  );
  const components = data.cards.filter((c) => c.status === "component");
  const evidenced = components.filter((c) => c.evidence.length > 0).length;
  return `# 理论到策略工程覆盖\n\n${data.meaning}\n\n核对日期：${data.asOf}。共 ${data.cards.length} 张卡。${counts}。\n\n## 读取方式\n\n- existing-proxy：已有可执行本地规则；与原法的差异见理由。\n- new-proxy：本轮新增可执行代理（周期以策略定义为准）；必须通过目录绑定验证，不代表通过收益检验。\n- component：指标、分析、风险或执行组件，不计独立交易策略；是否已有代码见证据。\n- engineering：输入已有或容易取得，但该卡交易包装/模型尚待工程，不能称已交付。\n- data-gap：所需历史时点或执行输入未齐，不补造数据。\n- interpretation：仍含原法解释/人工证据，机械代理需另命名。\n\n映射事实源为 [coverage.json](coverage.json)。运行 \`pnpm exec tsx scripts/theory-coverage.ts --check\` 验证228张卡、原研究锚点、文件证据和所有策略绑定；\`--write\` 更新此表。原研究来源与人工留项仍全部有效。\n\n## 生成统计\n\n- 分批：${batches}。\n- 策略绑定：唯一 ${bound.size}；existing-proxy 唯一 ${existing.size}；new-proxy 唯一 ${fresh.size}。\n- component：共 ${components.length} 张；有代码证据 ${evidenced} 张；其余 ${components.length - evidenced} 张为理论/分析组件，不表示已有可执行代码。\n- engineering 逐卡就绪评估见 [closure-readiness.md](closure-readiness.md)；P4 排期不改变本表 status。\n\n## 分批推进\n\nB1融合已有规则与新增代理，先做因果及成交检查；B2推进价格结构、周期、多周期、截面和财务中输入就绪的工程，逐卡更新状态；B3核验历史财报、题材/事件、盘口、多腿与解释证据。B2/B3不是一概删除或永远排除。\n\n收益研究按全部实际尝试计数：训练/开发集初筛与有限优化，未使用时段只在锁定候选后评价；已反复查看的历史只能作开发数据，缺干净留出则前向观察。禁止只报告获胜参数。沪深当前成分前视和BTC/ETH单一市场共同暴露单独标记。\n\n## 逐项去向\n\n| 理论 | 去向 | 策略绑定 | 具体边界或剩余工作 |\n| --- | --- | --- | --- |\n${data.cards.map((c) => `| [${c.theoryId} ${c.name}](${c.source}) | ${c.status} | ${c.strategyIds.map((id) => "\u0060" + id + "\u0060").join("、") || "—"} | ${c.reason.replaceAll("|", "/")} |`).join("\n")}\n`;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const data = JSON.parse(
    await readFile(resolve(root, folder, "coverage.json"), "utf8"),
  ) as TheoryCoverage;
  await validateTheoryCoverage(data, root);
  const report = renderTheoryCoverage(data);
  if (process.argv.includes("--write"))
    await writeFile(resolve(root, folder, "README.md"), report);
  else if (
    (await readFile(resolve(root, folder, "README.md"), "utf8")) !== report
  )
    throw new Error("覆盖表与JSON不一致；运行 --write");
  process.stdout.write(`理论覆盖验证通过：${data.cards.length} cards\n`);
}
