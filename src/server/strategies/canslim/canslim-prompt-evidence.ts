import { z } from "zod";
import type { Evidence } from "~/lib/domain";
const patternsSchema = z
  .object({
    technical: z
      .object({
        version: z.enum(["canslim-technical-3", "canslim-technical-4"]),
        patterns: z.record(
          z
            .object({
              candidates: z.array(
                z.object({ qualified: z.boolean() }).passthrough(),
              ),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();
const membershipSchema = z
  .object({
    version: z.literal("rs-membership-2"),
    membershipCodes: z.array(z.string()),
  })
  .passthrough();

/** Projection for the prompt only: the report retains the original evidence. */
export function canslimPromptEvidence(evidence: Evidence[]) {
  return evidence.map((item) => {
    let raw: unknown;
    try {
      raw = JSON.parse(item.text);
    } catch {
      return item;
    }
    const omitted: string[] = [];
    let payload = raw;
    if (item.id.startsWith("canslim-technical-")) {
      const parsed = patternsSchema.safeParse(raw);
      if (parsed.success) {
        payload = {
          ...parsed.data,
          technical: {
            ...parsed.data.technical,
            patterns: Object.fromEntries(
              Object.entries(parsed.data.technical.patterns).map(
                ([name, pattern]) => [
                  name,
                  {
                    ...pattern,
                    candidateCount: pattern.candidates.length,
                    omittedUnqualifiedCount: pattern.candidates.filter(
                      (c) => !c.qualified,
                    ).length,
                    candidates: pattern.candidates.flatMap(
                      (candidate, originalIndex) =>
                        candidate.qualified
                          ? [{ ...candidate, originalIndex }]
                          : [],
                    ),
                  },
                ],
              ),
            ),
          },
        };
        omitted.push(
          "未合格形态候选的逐项明细已省略；保留总数、所有合格候选及其原始索引。不得推断被省略候选的具体失败原因。",
        );
      }
    }
    if (item.envelope?.source === "hithink-astock-selector/membership-audit") {
      const parsed = membershipSchema.safeParse(raw);
      if (parsed.success) {
        const { membershipCodes, ...rest } = parsed.data;
        payload = {
          ...rest,
          archivedMembershipCodeCount: membershipCodes.length,
        };
        omitted.push(
          "完整证券代码名单仅在原始档案中保存；差异名单和全部审计结论仍保留，不能据此声明全市场完整性已验证。",
        );
      }
    }
    if (!omitted.length) return item;
    return {
      ...item,
      text: JSON.stringify(payload),
      promptProjection: {
        version: "canslim-prompt-evidence-1",
        omitted,
        originalPayloadHash: item.envelope?.payloadHash ?? null,
        note: "text是提示词投影；envelope指纹对应完整归档原文，不对应投影。引用仍使用原Evidence ID。",
      },
    };
  });
}
