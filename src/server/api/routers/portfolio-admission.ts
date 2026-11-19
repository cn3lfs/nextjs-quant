import {
  admissionPageSchema,
  tradeReviewAdmissionSource,
  pageStrategyAdmission,
  exportStrategyAdmission,
} from "../../research/performance/strategy-admission-service";
import { z } from "zod";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";

import { accountReview } from "./portfolio-review-source";

export const portfolioAdmissionRouter = createTRPCRouter({
  tradeReviewAdmission: p("portfolio", "read")
    .input(admissionPageSchema.extend({ account: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const review = await accountReview(input.account);
      return pageStrategyAdmission(
        tradeReviewAdmissionSource(review.snapshot, review.fullTradingDays),
        input,
        false,
      );
    }),
  tradeReviewAdmissionExport: p("portfolio", "read")
    .input(
      admissionPageSchema
        .pick({ params: true })
        .extend({ account: z.string().trim().min(1) }),
    )
    .query(async ({ input }) => {
      const review = await accountReview(input.account);
      return exportStrategyAdmission(
        tradeReviewAdmissionSource(review.snapshot, review.fullTradingDays),
        input.params,
        false,
      );
    }),
});
