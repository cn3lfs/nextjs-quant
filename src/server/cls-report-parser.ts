import { createHash } from "node:crypto";

export type ClsDirection = "bullish" | "bearish" | "neutral" | "unknown";
export type ClsReportSection = {
  id: string;
  name: string;
  line: number;
  endLine: number;
  text: string;
  direction: ClsDirection;
  confidence: "high" | "medium" | "low" | "unknown";
  mentionedSymbols: string[];
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Format adapter only: never infers recommendations from company mentions or
 * executes markdown/embedded instructions. Line evidence refers to original text.
 */
export function parseClsReport(markdown: string) {
  if (!markdown.trim()) throw new Error("报告为空");
  if (Buffer.byteLength(markdown, "utf8") > 2 * 1024 * 1024)
    throw new Error("报告超过2MiB");
  if (markdown.includes("\0")) throw new Error("报告包含非法空字符");
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const title =
    lines
      .find((line) => /^#\s+/.test(line))
      ?.replace(/^#\s+/, "")
      .trim() ?? "未命名报告";
  const dateMatch = markdown.match(
    /(?:分析日期|报告日期)[*\s]*[：:]\s*(\d{4}-\d{2}-\d{2})/,
  );
  const value = dateMatch?.[1];
  const reportDate =
    value &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
      ? value
      : null;
  const sections: ClsReportSection[] = [];
  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index]!.match(/^###\s+(?:\d+\.\d+\s+)?(.+)$/);
    if (!heading) continue;
    let end = index + 1;
    while (end < lines.length && !/^#{1,3}\s/.test(lines[end]!)) end++;
    const name = heading[1]!.split(/[（(]/)[0]!.trim();
    const text = lines.slice(index, end).join("\n");
    const explicitDirection = text
      .match(
        /(?:情绪方向|方向)[*\s]*[：:]\s*(?:[🟢🔴🟡⚪]\s*)?([^\n｜|）]+)/u,
      )?.[1]
      ?.trim();
    let direction: ClsDirection = "unknown";
    // Mixed qualifiers are intentionally neutral; no narrative sentiment guessing.
    if (explicitDirection) {
      if (/中性|混合|多空|分化/.test(explicitDirection)) direction = "neutral";
      else if (/^(偏多|看多|利好)/.test(explicitDirection))
        direction = "bullish";
      else if (/^(偏空|看空|利空)/.test(explicitDirection))
        direction = "bearish";
    }
    const confidenceText = text.match(/信心\s*[：:]\s*(高|中|低)/)?.[1];
    const confidence =
      confidenceText === "高"
        ? "high"
        : confidenceText === "中"
          ? "medium"
          : confidenceText === "低"
            ? "low"
            : "unknown";
    const mentionedSymbols = new Set<string>();
    for (const match of text.matchAll(/\b(sh|sz)(\d{6})\b/gi))
      mentionedSymbols.add(`${match[1]!.toLowerCase()}${match[2]}`);
    for (const match of text.matchAll(/\b(\d{6})\.(SH|SZ)\b/gi))
      mentionedSymbols.add(`${match[2]!.toLowerCase()}${match[1]}`);
    sections.push({
      id: hash(`${index + 1}:${text}`),
      name,
      line: index + 1,
      endLine: end,
      text,
      direction,
      confidence,
      mentionedSymbols: [...mentionedSymbols].sort(),
    });
    index = end - 1;
  }
  return {
    version: "cls-markdown-1" as const,
    hash: hash(markdown),
    title,
    reportDate,
    markdown,
    sections,
    warnings: [
      ...(!reportDate ? ["原文没有有效报告日期，需核对"] : []),
      ...(!sections.length ? ["未识别到三级章节，需核对报告格式"] : []),
      "报告日期和文件修改时间不能单独证明盘前完成；盘前样本以系统实际固定时间为准",
      "股票提及不是推荐，未显式给出方向的章节不自动生成方向预测",
    ],
  };
}
export type ParsedClsReport = ReturnType<typeof parseClsReport>;
