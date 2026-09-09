import { createHash } from "node:crypto";
import type { Evidence } from "~/lib/domain";
import type { WalkForwardResult } from "~/lib/walk-forward";
import { evidenceEnvelope } from "./evidence";
import { get } from "./db";
import { background } from "./jobs";
import { analyze, researchModel } from "./research";
export function perBarReturn(totalReturn: number, bars: number): number | null {
  if (
    !Number.isFinite(totalReturn) ||
    totalReturn <= -100 ||
    !Number.isInteger(bars) ||
    bars <= 0
  )
    return null;
  return Math.expm1(Math.log1p(totalReturn / 100) / bars) * 100;
}
export function walkForwardEvidence(result: WalkForwardResult): Evidence {
  if (
    result.version !== "walk-forward-1" ||
    !result.id ||
    !result.createdAt ||
    !result.folds.length ||
    result.summary.folds !== result.folds.length
  )
    throw new Error("滚动检验档案不完整");
  const frequencies: Record<string, number> = {};
  const folds = result.folds.map((fold, index) => {
    const selected = fold.training[0];
    if (
      !selected ||
      fold.trainEnd >= fold.testStart ||
      (index > 0 && result.folds[index - 1]!.testEnd >= fold.testStart) ||
      fold.test.equity.length !== result.options.testBars
    )
      throw new Error("滚动检验区间无法核验");
    const key = `${fold.selected.fast}/${fold.selected.slow}`;
    frequencies[key] = (frequencies[key] ?? 0) + 1;
    return {
      round: index + 1,
      trainStart: fold.trainStart,
      trainEnd: fold.trainEnd,
      testStart: fold.testStart,
      testEnd: fold.testEnd,
      selected: fold.selected,
      trainReturn: selected.totalReturn,
      testReturn: fold.test.totalReturn,
      trainPerBarReturn: perBarReturn(
        selected.totalReturn,
        result.options.trainBars,
      ),
      testPerBarReturn: perBarReturn(
        fold.test.totalReturn,
        result.options.testBars,
      ),
      testDrawdown: fold.test.maxDrawdown,
      testTrades: fold.test.trades.length,
      insufficientCash: fold.test.diagnostics.insufficientCash,
      untradable: fold.test.diagnostics.untradable,
      benchmarkGrossReturn: fold.benchmarkReturn,
      buyHoldNet: fold.test.benchmark
        ? {
            version: fold.test.benchmark.version,
            totalReturn: fold.test.benchmark.totalReturn,
            maxDrawdown: fold.test.benchmark.maxDrawdown,
            excessReturnPoints: fold.test.benchmark.excessReturnPoints,
            entry: fold.test.benchmark.trade,
            cash: fold.test.benchmark.cash,
            shares: fold.test.benchmark.shares,
          }
        : null,
    };
  });
  const payload = {
    version: "walk-forward-explanation-2",
    benchmarkDefinition:
      "benchmarkGrossReturn是同标的测试首日开盘至末日收盘价格涨幅，不含成本、整手及成交约束。buyHoldNet是同窗口同资金同成本的买入持有研究模拟；null表示旧档案未保存，不从价格涨幅推算。excessReturnPoints是策略与该模拟收益率的百分点差，不是市场指数超额或风险调整alpha。",
    archiveId: result.id,
    archiveHash: createHash("sha256")
      .update(JSON.stringify(result))
      .digest("hex"),
    symbol: result.symbol,
    snapshotId: result.snapshotId,
    sourceHash: result.sourceHash,
    dataRange: result.dataRange,
    corporateActions: result.corporateActions ?? null,
    initial: result.initial,
    baseStrategy: result.baseStrategy,
    options: result.options,
    candidates: result.candidates,
    warmupBars: result.warmupBars,
    unusedTailBars: result.unusedTailBars,
    summary: result.summary,
    diagnostics: {
      parameterFrequency: frequencies,
      zeroTradeFolds: folds.filter((f) => f.testTrades === 0).length,
      insufficientCashFolds: folds.filter((f) => f.insufficientCash > 0).length,
    },
    normalization:
      "每根几何平均收益 = ((1+区间收益/100)^(1/区间根数)-1)*100；单位为%，不是年化或收益预测。null表示无法计算。",
    costs: result.folds[0]!.test.costs,
    assumptions: result.assumptions,
    folds,
  };
  const envelope = evidenceEnvelope(payload, {
    source: "local/walk-forward",
    symbol: result.symbol,
    type: "bars",
    asOf: result.folds.at(-1)!.testEnd,
    publishedAt: null,
    fetchedAt: result.createdAt,
    currency: "CNY",
    unit: { return: "%", capital: "元", duration: "日线根数" },
    adjustment: "none",
    reportPeriod: null,
    quality: "partial",
    warnings: [
      "训练和测试长度不同，不能直接用原始总收益差判断衰减；每根几何收益只是同口径描述，不是统计显著性证明。",
      "每轮独立资金，不是连续组合；价格涨幅未扣费，不能与含成本买入持有基准混用。旧档案缺少净基准时不推算。",
      "不复权和历史交易规则未完整还原，不能宣称已通过实盘或正式策略业绩验证。",
    ],
  });
  return {
    id: `walk-forward-evidence-${envelope.payloadHash.slice(0, 24)}`,
    source: "本机滚动样本外检验及JS诊断",
    asOf: envelope.asOf!,
    text: JSON.stringify(payload),
    envelope,
  };
}
export function explainWalkForwardJob(id: string) {
  const record = get<WalkForwardResult>(id);
  if (!record) throw new Error("滚动检验档案不存在");
  const evidence = walkForwardEvidence(record),
    model = researchModel(false);
  return background(
    "research",
    { kind: "walk-forward-explanation", contextId: id, model },
    (_job, signal) =>
      analyze(
        id,
        "解释这份滚动样本外研究模拟的稳定性、训练与测试差异、参数选择集中度和局限。所有数值引用JS结果，不自行重算。训练/测试长度不同，不直接比较总收益；可描述每根几何平均收益，但不能据此证明显著性。检查零成交和资金不足是否造成表面低波动。逐轮资金重置不能拼成连续账户。严格区分未扣费价格涨幅与同成本买入持有基准；只引用已提供的收益百分点差，不称风险调整alpha或市场指数超额。净基准为null时明确旧档案缺项，不推算。不能利用测试结果重新选出赢家参数、给出交易建议或宣称验证通过；提出独立后续实验。正文用中文解释覆盖和截止，不直接罗列JSON字段名。",
        [evidence],
        signal,
        "general",
        model,
      ),
    {
      kind: "walk-forward-explanation",
      hash: evidence.envelope!.payloadHash,
      model,
    },
  );
}
