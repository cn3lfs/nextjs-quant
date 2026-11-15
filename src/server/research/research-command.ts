import { isAbsolute } from "node:path";
import type { z } from "zod";
import { researchCommandSchema } from "~/lib/research/research-command";
import { validationScoreboardPage } from "../db/validation-scoreboard";
import { readValidationInput } from "./validation-artifacts";

/** Shared by research CLI and the Lab worker. This UI-safe subset reads existing
 * evidence only, with no capture, publish, subscription or external data calls. */
export async function executeResearchCommand(
  raw: z.input<typeof researchCommandSchema>,
) {
  const input = researchCommandSchema.parse(raw);
  if (!process.env.QUANT_DATA_DIR || !isAbsolute(process.env.QUANT_DATA_DIR))
    throw new Error("研究命令须显式设置绝对 QUANT_DATA_DIR");
  if (input.command === "inspect") {
    const page = validationScoreboardPage({ market: input.market, page: 0 });
    return {
      command: input.command,
      market: input.market,
      total: page.total,
      metadata: page.metadata,
      boundary: "只读既有成绩单；完整分页在实验室查看",
    };
  }
  const frozen = await readValidationInput(input.hash);
  return {
    command: input.command,
    hash: input.hash,
    market: frozen.input.market,
    start: frozen.input.start,
    end: frozen.input.end,
    datasets: frozen.datasets.map((d) => ({
      period: d.period,
      instruments: d.instruments.length,
      observations: d.dates.length,
    })),
    boundary: "输入内容哈希、策略与评价版本校验通过；不表示策略有效",
  };
}
