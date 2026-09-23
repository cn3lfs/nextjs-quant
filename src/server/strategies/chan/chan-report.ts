import { createHash } from "node:crypto";
import type { Snapshot } from "~/lib/domain";
import { chanMethod } from "./chan-method";
import { chanCitationRules, chanReportSchema } from "./chan-report-schema";
import { completedBarFilter } from "trading-strategy-core/completed-bars";
import { researchModel, structured } from "../../research/research";
import { get, put } from "../../db";
import { sharedRead } from "../../infra/shared-read";
import type { z } from "zod";

export function chanWindow(snapshot: Snapshot, now: number) {
  if (
    snapshot.historicalAsOf &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.historicalAsOf) ||
      !Number.isFinite(Date.parse(snapshot.historicalAsOf)) ||
      new Date(snapshot.historicalAsOf).toISOString().slice(0, 10) !==
        snapshot.historicalAsOf)
  )
    throw new Error("历史截止日无效");
  if (
    !["day", "5m"].includes(snapshot.period) ||
    snapshot.adjustment !== "none"
  )
    throw new Error("缠论标注仅支持明确不复权的日线或五分钟行情");
  let previous = -Infinity;
  for (const bar of snapshot.bars) {
    const pattern =
      snapshot.period === "day"
        ? /^\d{4}-\d{2}-\d{2}$/
        : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;
    const time = Date.parse(bar.date);
    const normalized = Number.isFinite(time)
      ? new Date(
          time + (snapshot.period === "5m" ? 8 * 3600000 : 0),
        ).toISOString()
      : "";
    if (
      !pattern.test(bar.date) ||
      normalized.slice(0, snapshot.period === "day" ? 10 : 19) !==
        bar.date.slice(0, snapshot.period === "day" ? 10 : 19) ||
      time <= previous ||
      ![bar.open, bar.high, bar.low, bar.close, bar.volume, bar.amount].every(
        Number.isFinite,
      ) ||
      bar.low <= 0 ||
      bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.low > Math.min(bar.open, bar.close) ||
      bar.volume < 0 ||
      bar.amount < 0
    )
      throw new Error("缠论标注行情日期、顺序或数值无效");
    previous = time;
  }
  const completed = completedBarFilter(snapshot.period, now);
  const bars = snapshot.bars
    .filter(
      (bar) =>
        completed(bar.date) &&
        (!snapshot.historicalAsOf ||
          bar.date.slice(0, 10) <= snapshot.historicalAsOf),
    )
    .slice(-300)
    .map((bar) => ({ ...bar }));
  if (bars.length < 3) throw new Error("缠论标注至少需要三根已完成K线");
  const content = {
    snapshotId: snapshot.id,
    symbol: snapshot.symbol,
    source: snapshot.source,
    period: snapshot.period,
    adjustment: snapshot.adjustment,
    historicalAsOf: snapshot.historicalAsOf ?? null,
    bars,
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex");
  return {
    id: `chan-window-${hash}`,
    hash,
    ...content,
    asOf: bars.at(-1)!.date,
    levelStatus: "观察图周期不等于已验证走势级别",
  };
}
type Method = Awaited<ReturnType<typeof chanMethod>>;
type Result = z.infer<ReturnType<typeof chanReportSchema>>;
export type ChanReport = {
  id: string;
  createdAt: number;
  model: string;
  question: string;
  tokens: number;
  mode: "annotation-only";
  automaticSignals: false;
  method: Method;
  evidence: ReturnType<typeof chanWindow>;
  result: Result;
};
const shared = sharedRead<ChanReport>();
export async function analyzeChan(
  snapshot: Snapshot,
  question: string,
  signal?: AbortSignal,
  model = researchModel(),
  now = Date.now(),
) {
  signal?.throwIfAborted();
  if (!question.trim() || question.length > 2000)
    throw new Error("请输入2000字以内的研究问题");
  const evidence = chanWindow(snapshot, now),
    method = await chanMethod();
  signal?.throwIfAborted();
  const id = `chan-report-${createHash("sha256").update(JSON.stringify({ evidence, method, question, model })).digest("hex")}`;
  return shared(
    id,
    async (abort) => {
      const schema = chanReportSchema(
        method.passages,
        evidence.id,
        evidence.bars.length,
      );
      const cached = get<ChanReport>(id);
      if (cached) {
        if (
          cached.id !== id ||
          cached.mode !== "annotation-only" ||
          cached.automaticSignals !== false ||
          cached.model !== model ||
          cached.question !== question ||
          JSON.stringify(cached.method) !== JSON.stringify(method) ||
          JSON.stringify(cached.evidence) !== JSON.stringify(evidence) ||
          !Number.isFinite(cached.createdAt) ||
          cached.createdAt < 0 ||
          !Number.isInteger(cached.tokens) ||
          cached.tokens < 0 ||
          !schema.safeParse(cached.result).success
        )
          throw new Error("缠论缓存报告校验失败，未调用模型或覆盖原记录");
        return cached;
      }
      const prompt = `缠论标注研究，问题：${question}
方法引用条目（只按ID引用，由应用显示原文、课号和出处）：${JSON.stringify(method)}
阶段引用白名单：${JSON.stringify(chanCitationRules(method.passages))}
每个阶段只能从其allowedPassageIds选择1至8个不重复ID。即使别的文件讨论相同概念，也不得跨章节引用：morphology只用02-morphology.md，center只用03-center-and-trend.md，dynamics只用04-dynamics.md，points只用05-trading-points.md；conclusion可使用任一已提供ID。必须逐字符复制真实ID，不能缩写或自行生成。先选择对应章节定义，再解释其适用前提；不得只为通过校验而引用与解释无关的条目。
行情证据：${JSON.stringify(evidence)}
只做人工复核用的假设标注，不输出已确认的笔、线段、中枢、背驰或买卖点。未实现递归级别及算法验收；图周期不是走势级别。MACD或均线交叉不等于缠论买点。不得把原文中的必然盈利、绝对安全当作当前行情收益保证。历史截止后信息不得加入。每阶段解释适用定义、必要前提、反证和待补资料；后续课文修订须注明，不能仅凭早期定义断言成立。
输出JSON：{title,summary,stages:[{id,status,summary,citations,passageIds,missing,annotations:[{startIndex,endIndex,label,verification}]}],risks,nextSteps}。
五阶段依次morphology/center/dynamics/points/conclusion。status只能hypothesis或missing，missing至少一项。hypothesis必须有真实K线索引区间，索引从0开始，annotations最多8项，不能写超出行情窗口的价格/日期。citations每阶段恰好为["${evidence.id}"]。前四阶段passageIds须引用对应形态/中枢/动力/买卖点文件，结论可引用任意已给条目。不要输出原文副本、计算评级、订单、资金或信号字段。`;
      const reply = await structured(prompt, schema, model, abort);
      const result = schema.parse(reply.data);
      if (!Number.isInteger(reply.tokens) || reply.tokens < 0)
        throw new Error("模型用量记录无效");
      abort.throwIfAborted();
      const report: ChanReport = {
        id,
        createdAt: Date.now(),
        model,
        question,
        tokens: reply.tokens,
        mode: "annotation-only",
        automaticSignals: false,
        method,
        evidence,
        result,
      };
      put("chan-report", id, report);
      return report;
    },
    signal,
  );
}
