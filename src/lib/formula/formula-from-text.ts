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
  // Empty means nothing in the request is expressible (normalized to "0;").
  source: z.string().trim().max(4000),
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
    "- HHV/LLV 包含当日：创N日新高写 H>=HHV(H,N) 或 H>REF(HHV(H,N),1)，创N日新低写 L<=LLV(L,N) 或 L<REF(LLV(L,N),1)；不要写 L<LLV(L,N) 这类永不成立的条件。",
    "- 放量等模糊说法取常见默认（如 VOL>MA(VOL,5)*1.5），把默认假设写进 explanation，不要写进 unsupported。",
    "- 无法用上述函数和字段表达的条件（如资金流、财务、估值、题材板块）放进 unsupported，并且不得用行情字段近似或冒充它们（例如不能用成交量冒充资金流、用收盘价冒充市盈率），也不要编造字段；更不能用其他技术面条件（均线、RPS、放量等）替代题材、板块、财务类条件。",
    "- unsupported 只列需求中明确提到、但无法表达的条件；都能表达时为空数组 []。",
    "- 如果需求中没有任何可表达的条件，source 输出 0; 表示不选股。",
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
