import { createHash } from "node:crypto";
import type { Snapshot } from "~/lib/domain";
import type { CalendarReference } from "./data-health";
import { wyckoffFrames } from "./wyckoff-frames";
import { wyckoffMethod } from "./wyckoff-method";
import {
  wyckoffMarketForReport,
  type gatherWyckoffMarket,
} from "./wyckoff-market";
import {
  wyckoffPromptFrames,
  wyckoffPromptVersion,
} from "./wyckoff-prompt-frames";
import {
  wyckoffReportSchema,
  wyckoffStageFiles,
  wyckoffStages,
} from "./wyckoff-report-schema";
import { get, put } from "./db";
import { structured, researchModel } from "./research";
import { sharedRead } from "./shared-read";
import type { z } from "zod";
export type WyckoffReport = {
  id: string;
  createdAt: number;
  model: string;
  question: string;
  tokens: number;
  automaticSignals: false;
  mode: "research-hypotheses";
  promptVersion: string;
  market: ReturnType<typeof wyckoffMarketForReport> | null;
  frames: ReturnType<typeof wyckoffFrames>;
  method: Awaited<ReturnType<typeof wyckoffMethod>>;
  result: z.infer<ReturnType<typeof wyckoffReportSchema>>;
};
const shared = sharedRead<WyckoffReport>();
export async function analyzeWyckoff(
  day: Snapshot,
  minute: Snapshot | null,
  calendar: CalendarReference,
  question: string,
  signal?: AbortSignal,
  model = researchModel(),
  now = Date.now(),
  marketData: Awaited<ReturnType<typeof gatherWyckoffMarket>> | null = null,
) {
  signal?.throwIfAborted();
  question = question.trim();
  if (!question || question.length > 2000)
    throw new Error("请输入2000字以内的威科夫研究问题");
  const frames = wyckoffFrames(day, minute, calendar, now),
    method = await wyckoffMethod();
  signal?.throwIfAborted();
  const context = {
    frames,
    market: marketData ? wyckoffMarketForReport(marketData, frames) : null,
    method,
    question,
    model,
    promptVersion: wyckoffPromptVersion,
  };
  const id = `wyckoff-report-${createHash("sha256").update(JSON.stringify(context)).digest("hex")}`;
  return shared(
    id,
    async (abort) => {
      const schema = wyckoffReportSchema(frames),
        cached = get<WyckoffReport>(id);
      if (cached) {
        if (
          cached.id !== id ||
          cached.automaticSignals !== false ||
          cached.mode !== "research-hypotheses" ||
          !Number.isFinite(cached.createdAt) ||
          cached.createdAt < 0 ||
          !Number.isInteger(cached.tokens) ||
          cached.tokens < 0 ||
          JSON.stringify({
            frames: cached.frames,
            market: cached.market,
            method: cached.method,
            question: cached.question,
            model: cached.model,
            promptVersion: cached.promptVersion,
          }) !== JSON.stringify(context) ||
          !schema.safeParse(cached.result).success
        )
          throw new Error("威科夫缓存报告校验失败，未覆盖原档案");
        return cached;
      }
      const prompt = `威科夫研究问题：${question}
方法资料：${JSON.stringify(method)}
证据档案：${JSON.stringify(wyckoffPromptFrames(frames))}
市场RS计算证据：${JSON.stringify(context.market)}
若市场RS为computed，可以解读该明确区间的对大盘比率变化，但行业基准、TR起点及企业行动核验尚缺，relativeStrength阶段仍必须missing；不能把单基准计算当作完整RS阶段通过。市场基准缺失则明确说明来源不可用。
K线bars使用数组行，列顺序见barColumns；索引和原档案一致，日期为bars[index][0]，不得把行序号当日期。不可用小时价格行已省略，状态、条数和缺口仍需披露。简洁输出，每阶段摘要建议150字以内，缺口和反证使用短句，不重复整份方法资料。
只作有反证条件的研究假设。缺口必须逐项披露，不以主力意图作为已知事实。周线排除项不可隐藏，小时noHourly时禁止小时事件或当前入场确认，aligned仅指样本时点对齐。未验证VSA/VP/P&F算法，不编造数值评分、成交分布、目标价、资金、胜率或仓位；不复权不能声称已排除企业行动。完整市场环境、双基准RS与P&F依据仍不足，environment/relativeStrength/targets必须missing，说明所需资料。其余阶段也不得声称confirmed/supported。
输出JSON：{title,summary,stages:[{id,status,summary,citations,methodFiles,missing}],events:[{timeframe,index,date,name,status,rationale,invalidation}],risks,nextSteps}。
stages依次${wyckoffStages.join("/")}，status只能hypothesis或missing，每阶段missing至少一项。citations固定["${frames.hash}"]。
methodFiles只用文件名（不加references/），按此白名单选择1至3个不重复文件：${JSON.stringify(wyckoffStageFiles)}。
events最多20项，全部status=hypothesis；timeframe=daily/weekly/hourly，index从0开始，date必须逐字等于对应bars[index][0]。事件名只能PS/SC/AR/ST/Spring/SOS/LPS/BC/UT/UTAD/SOW/LPSY/other。少于30根的周期或不可用小时不得标事件，没有充分证据则空数组。risks至少3项，nextSteps至少1项。不得增加订单、评分或目标价字段。`;
      const reply = await structured(prompt, schema, model, abort);
      const result = schema.parse(reply.data);
      if (!Number.isInteger(reply.tokens) || reply.tokens < 0)
        throw new Error("威科夫模型用量无效");
      abort.throwIfAborted();
      const report: WyckoffReport = {
        id,
        createdAt: Date.now(),
        ...context,
        tokens: reply.tokens,
        automaticSignals: false,
        mode: "research-hypotheses",
        result,
      };
      put("wyckoff-report", id, report);
      return report;
    },
    signal,
  );
}
