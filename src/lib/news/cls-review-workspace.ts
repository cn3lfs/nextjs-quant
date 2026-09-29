import { z } from "zod";

export const clsReviewDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value,
    "日期无效",
  );
const cursor = z.string().min(1).max(2048).optional();
export const clsReviewReportQuery = z
  .object({
    title: z.string().trim().max(100).default(""),
    from: clsReviewDate.optional(),
    to: clsReviewDate.optional(),
    unknownDate: z.boolean().default(false),
    cursor,
  })
  .refine(
    (value) => !value.from || !value.to || value.from <= value.to,
    "日期范围无效",
  );
export const clsReviewFactQuery = z.object({
  reportId: z.string().min(1).max(200),
  mode: z.enum(["current", "history"]).default("current"),
  verdict: z.enum(["supported", "contradicted", "unresolved"]).optional(),
  cursor,
});
export const clsReviewVerificationQuery = z.object({
  date: clsReviewDate,
  cursor,
});
export const clsReviewVerificationIdentity = z.object({
  date: clsReviewDate,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ClsReportQuery = z.infer<typeof clsReviewReportQuery>;
export type ClsFactQuery = z.infer<typeof clsReviewFactQuery>;

/** UTF-16 boundaries move together so segments neither split nor lose surrogate pairs. */
export function clsTextChunk(text: string, page: number) {
  const boundary = (offset: number) => {
    const code = text.charCodeAt(offset);
    return code >= 0xdc00 && code <= 0xdfff ? offset - 1 : offset;
  };
  return text.slice(boundary(page * 8000), boundary((page + 1) * 8000));
}

export type ClsFactDraft = {
  sectionId: string;
  quote: string;
  evidence: string;
  verdict: "supported" | "contradicted" | "unresolved";
  revision: number;
};
export const emptyClsFactDraft = (): ClsFactDraft => ({
  sectionId: "",
  quote: "",
  evidence: "",
  verdict: "unresolved",
  revision: 0,
});
export const clsDraftDirty = (draft: ClsFactDraft) =>
  !!(draft.quote || draft.evidence);
/** A completion may clear only the revision that was actually submitted. */
export function clearSubmittedClsDraft(
  drafts: Record<string, ClsFactDraft>,
  id: string,
  revision: number,
) {
  if (drafts[id]?.revision !== revision) return drafts;
  return {
    ...drafts,
    [id]: { ...emptyClsFactDraft(), revision: revision + 1 },
  };
}
