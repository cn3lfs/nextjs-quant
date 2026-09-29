import { z } from "zod";
import {
  arities,
  futureFunctions,
  marketFields,
  rpsFields,
} from "./tdx-formula-check";
import type { FormulaIssue } from "./tdx-formula-syntax";

/** What the model must return; the formula is text for our own DSL, never code. */
export const formulaDraftSchema = z.object({
  source: z.string().trim().min(1).max(4000),
  explanation: z
    .array(z.object({ line: z.string(), meaning: z.string() }))
    .max(40),
  unsupported: z.array(z.string()).max(20),
});
export type FormulaDraft = z.infer<typeof formulaDraftSchema>;

/**
 * Prompt for turning a Chinese screening request into a TDX selection formula.
 * The function and field lists come from the engine itself, so the model is
 * never told about anything the checker would reject.
 */
export function formulaPrompt(
  request: string,
  issues: readonly FormulaIssue[] = [],
  previous?: string,
) {
  const functions = Object.entries(arities)
    .map(([name, n]) => `${name}/${n}`)
    .join(" ");
  return [
    "把下面的选股需求写成一个通达信日线选股公式。",
    `需求：${request}`,
    "",
    "规则：",
    "- 只能使用这些函数（名称/参数个数）：" + functions,
    `- 行情字段：${Object.keys(marketFields).join(" ")}`,
    `- RPS 字段（上一完成交易日的强度，0–100）：${Object.keys(rpsFields).join(" ")}`,
    `- 禁止未来函数：${futureFunctions.join(" ")}`,
    "- 中间变量用 := 赋值；必须恰好有一个输出语句（用冒号 : 或单独表达式），它就是选股条件。",
    "- 没有内置 MACD/KDJ/BOLL 函数，需用 EMA、SMA、HHV、LLV、STD 组合，例如 DIF:=EMA(C,12)-EMA(C,26); DEA:=EMA(DIF,9); 金叉为 CROSS(DIF,DEA)。",
    "- 放量等模糊说法取常见默认（如 VOL>MA(VOL,5)*1.5），并在解释中写明这是默认假设。",
    "- 无法用上述函数和字段表达的条件（如资金流、财务、题材）放进 unsupported，不要忽略，也不要编造字段。",
    ...(issues.length
      ? [
          "",
          `上一次生成的公式未通过校验：\n${previous ?? ""}`,
          "校验错误：" +
            issues
              .map(
                (i) =>
                  `第${i.line}行${i.name ? ` ${i.name}` : ""}：${i.reason}`,
              )
              .join("；"),
          "请修正后重新输出。",
        ]
      : []),
    "",
    '输出 json：{"source":"公式全文，语句以分号结尾，可换行","explanation":[{"line":"公式中的一句","meaning":"中文含义"}],"unsupported":["无法表达的条件"]}',
  ].join("\n");
}
