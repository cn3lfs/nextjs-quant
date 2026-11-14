import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replayAllocationStudy } from "../../packages/quant-backtest/src/allocation-profile.js";
import { csi800ClassicRecipes } from "../../packages/trading-strategies/src/csi800-factors.js";
import {
  buildClassicSchedule,
  type ClassicWeek,
  type ClassicScheduleOptions,
  type ClassicModel,
} from "../../packages/trading-strategies/src/csi800-composite.js";
import { evaluatePerformance, performancePeriods } from "quant-performance";
import { csi800TradeEvaluation } from "./csi800-trade-evaluation.js";
import {
  saveCompressed,
  type ClassicPriceInput,
} from "./csi800-factor-data.js";

export async function runClassicMatrix(
  price: ClassicPriceInput,
  weeks: ClassicWeek[],
  start: string,
  firstSignal: string,
  riskAt: (symbol: string, date: string) => readonly number[] | null,
  out: string,
) {
  const benchmarkIndex = new Map(price.benchmark.map((b, i) => [b.date, i]));
  const summary: ReturnType<typeof summarize>[] = [];
  const failed: { id: string; model: ClassicModel; reason: string }[] = [];
  const schedules = new Map<
    ClassicModel,
    ReturnType<typeof buildClassicSchedule>
  >();
  function summarize(
    id: string,
    model: ClassicModel,
    result: ReturnType<typeof replayAllocationStudy>,
  ) {
    const points = result.curve.map((p) => {
      const i = benchmarkIndex.get(p.date)!;
      return {
        date: p.date,
        value: p.equity,
        benchmarkReturn:
          price.benchmark[i]!.close / price.benchmark[i - 1]!.close - 1,
      };
    });
    const slice = (from: string, to: string) => {
      const rows = points.filter((p) => p.date >= from && p.date <= to);
      const index = points.findIndex((p) => p.date === rows[0]?.date);
      return evaluatePerformance(
        points[index - 1]?.value ?? price.initial,
        rows,
      );
    };
    const segments = {
      development: slice(start, "2022-12-31"),
      validation: slice("2023-01-01", "2024-12-31"),
      observation: slice("2025-01-01", price.end),
    };
    const rolling = [];
    const firstYear = +start.slice(0, 4) + (start.slice(5) === "01-01" ? 0 : 1);
    for (let year = firstYear + 3; year <= +price.end.slice(0, 4); year++)
      rolling.push({
        year,
        training: slice(`${year - 3}-01-01`, `${year - 1}-12-31`),
        test: slice(`${year}-01-01`, `${year}-12-31`),
      });
    return {
      id,
      model,
      tradeEvaluation: csi800TradeEvaluation(
        result.fills.map((f) => ({ ...f, side: f.side as "buy" | "sell" })),
        price.stocks,
      ).evaluation,
      options: result.options,
      evaluation: evaluatePerformance(price.initial, points),
      segments,
      annual: performancePeriods(price.initial, points, "year"),
      rolling,
      trades: result.fills.length,
      fees: result.fills.reduce((s, f) => s + f.fee, 0),
      rejected: result.rejected.length,
      averageExposure: result.curve.reduce(
        (s, p) => s + p.exposure / result.curve.length,
        0,
      ),
    };
  }
  async function run(
    id: string,
    options: ClassicScheduleOptions,
    slippageBps = 10,
    delay = 1,
  ) {
    console.log(`组合实验 ${id} ${slippageBps}bp 延迟${delay}`);
    const schedule = buildClassicSchedule(
      weeks,
      { ...options, startSignal: firstSignal },
      riskAt,
    );
    try {
      const result = replayAllocationStudy(
        price.stocks,
        price.benchmark,
        {
          start,
          end: price.end,
          initial: price.initial,
          mode: "scheduled",
          slippageBps,
          delay,
        },
        schedule.allocations,
      );
      const stats = summarize(id, options.model, result);
      const archive = await saveCompressed(join(out, `${id}.json.gz`), {
        ...stats,
        result,
        schedule,
      });
      summary.push(stats);
      await writeFile(
        join(out, "matrix-progress.json"),
        JSON.stringify(
          { status: "running", summary, failed, latestArchive: archive },
          null,
          2,
        ),
      );
      console.log(
        `${id}: 年化${((stats.evaluation.annualReturn.value ?? 0) * 100).toFixed(2)}% 回撤${((stats.evaluation.maxDrawdown.value ?? 0) * 100).toFixed(2)}%`,
      );
    } catch (error) {
      const failure = { id, model: options.model, reason: String(error) };
      failed.push(failure);
      await writeFile(
        join(out, `${id}-failed.json`),
        JSON.stringify(
          { status: "failed", ...failure, options, slippageBps, delay },
          null,
          2,
        ),
      );
      await writeFile(
        join(out, "matrix-progress.json"),
        JSON.stringify({ status: "running", summary, failed }, null, 2),
      );
      console.log(`${id}: 失败 ${failure.reason}`);
    }
    return schedule;
  }
  const models: ClassicModel[] = [
    "pool-equal",
    "eligible-equal",
    ...csi800ClassicRecipes.map((r) => r.id),
  ];
  for (const model of models) schedules.set(model, await run(model, { model }));
  const priorities: ClassicModel[] = [
    "quality-value-momentum",
    "classic-five",
    "combined",
    "combined-defensive",
  ];
  const candidates = summary.filter(
    (r) =>
      priorities.includes(r.model) &&
      start <= "2020-01-01" &&
      (r.segments.development.maxDrawdown.value ?? 1) <= 0.3 &&
      r.segments.development.calmar.value !== null,
  );
  const best = candidates.length
    ? Math.max(...candidates.map((r) => r.segments.development.calmar.value!))
    : null;
  const finalists = candidates
    .filter(
      (r) =>
        best !== null && best - r.segments.development.calmar.value! < 0.02,
    )
    .sort((a, b) => priorities.indexOf(a.model) - priorities.indexOf(b.model));
  const selected = finalists[0]?.model ?? null;
  const tested = selected ?? "combined-defensive";
  const decision = {
    selected,
    stressModel: tested,
    reason: selected
      ? "仅开发段回撤<=30%并按Calmar/简化优先规则选型"
      : "没有开发合格候选，固定S11作诊断压力测试，不推荐",
    candidates: candidates.map((r) => ({
      model: r.model,
      development: r.segments.development,
    })),
  };
  await writeFile(
    join(out, "selection.json"),
    JSON.stringify(decision, null, 2),
  );
  for (const slip of [20, 30])
    await run(`${tested}-slip${slip}`, { model: tested }, slip);
  await run(`${tested}-delay2`, { model: tested }, 10, 2);
  for (const count of [15, 30])
    await run(`${tested}-count${count}`, { model: tested, count });
  for (const omit of ["value", "quality", "momentum"] as const)
    await run(`${tested}-without-${omit}`, { model: tested, omit });
  await run("combined-market-only", { model: "combined", risk: "market" });
  await run("combined-volatility-only", {
    model: "combined",
    risk: "volatility",
  });
  const budgets = new Map(
    schedules.get("combined-defensive")!.audit.map((r) => [r.date, r.exposure]),
  );
  await run("eligible-equal-same-budget", {
    model: "eligible-equal",
    budgetOverride: budgets,
  });
  await writeFile(
    join(out, "matrix-summary.json"),
    JSON.stringify(
      {
        status: "complete",
        start,
        end: price.end,
        decision,
        summary,
        failed,
        benchmark: "sh000906 price index; dividend mismatch remains",
      },
      null,
      2,
    ),
  );
  const fmt = (v: number | null) =>
    v === null ? "—" : `${(v * 100).toFixed(2)}%`;
  const lines = [
    "# 中证800经典技术＋财务组合实验",
    `共同窗口：${start}—${price.end}；当前成分；初始${price.initial}元。`,
    `选型：${selected ?? "没有合格候选"}。${decision.reason}`,
    "",
    "| 实验 | 年化收益 | 最大回撤 | 平均股票暴露 |",
    "| --- | ---: | ---: | ---: |",
    ...summary.map(
      (r) =>
        `| ${r.id} | ${fmt(r.evaluation.annualReturn.value)} | ${fmt(r.evaluation.maxDrawdown.value)} | ${fmt(r.averageExposure)} |`,
    ),
    "",
    ...failed.map((r) => `失败 ${r.id}: ${r.reason}`),
    "",
    "当前池、现存修订财报、公司行动即时到账和历史ST/限价情景等限制保留；价格基准与含股息组合口径不同。后段为时间分段观察，不是未见样本前瞻业绩。",
  ];
  await writeFile(join(out, "research-report.md"), lines.join("\n"));
  return { decision, summary };
}
