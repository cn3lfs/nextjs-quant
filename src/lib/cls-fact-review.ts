import { z } from "zod";

export const clsFactReviewSchema = z.object({
  reportId: z.string().min(1).max(200),
  sectionId: z.string().regex(/^[a-f0-9]{64}$/),
  quote: z.string().trim().min(1).max(3000),
  verdict: z.enum(["supported", "contradicted", "unresolved"]),
  evidence: z.string().trim().min(1).max(5000),
});
export type ClsFactReview = z.infer<typeof clsFactReviewSchema> & {
  id: string;
  reviewedAt: number;
};

export function clsFactStatistics(reviews: readonly ClsFactReview[]) {
  const latest = new Map<string, ClsFactReview>();
  for (const review of [...reviews].sort(
    (a, b) => a.reviewedAt - b.reviewedAt || a.id.localeCompare(b.id),
  ))
    latest.set(
      `${review.reportId}:${review.sectionId}:${review.quote}`,
      review,
    );
  const rows = [...latest.values()];
  const supported = rows.filter((row) => row.verdict === "supported").length;
  const contradicted = rows.filter(
    (row) => row.verdict === "contradicted",
  ).length;
  return {
    reviewed: rows.length,
    supported,
    contradicted,
    unresolved: rows.length - supported - contradicted,
    supportRate:
      supported + contradicted ? supported / (supported + contradicted) : null,
  };
}
