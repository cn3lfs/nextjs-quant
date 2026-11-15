import { z } from "zod";
import {
  accountPageSchema,
  accountReviewSettingsSchema,
  tradeLinkSchema,
} from "~/lib/portfolio/account-workspace";
import {
  loadAccountBook,
  pageAccountBook,
  accountPositionDetail,
  accountAttribution,
  accountTradePage,
  linkAccountTrade,
  freezeAccountExpectation,
} from "../../portfolio/account-workspace-service";
import { monthlyAccountReview } from "../../portfolio/account-monthly-review";
import { settings, saveSettings } from "../../infra/settings";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";
export const accountsRouter = createTRPCRouter({
  accountTrades: p("portfolio", "read")
    .input(
      z.object({
        page: z.number().int().nonnegative().max(1000000).default(0),
        kind: z
          .enum(["real", "paper", "exchange-simulation", "all"])
          .default("real"),
        symbol: z.string().max(80).default(""),
        tradeId: z.string().max(500).optional(),
      }),
    )
    .query(async ({ input }) =>
      accountTradePage(await loadAccountBook(), input),
    ),
  accountRiskPositions: p("portfolio", "read").query(async () => {
    const book = await loadAccountBook();
    return {
      items: book.positions
        .filter((p) => p.price !== null && p.stop !== null && p.price <= p.stop)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, 20),
      total: book.positions.filter(
        (p) => p.price !== null && p.stop !== null && p.price <= p.stop,
      ).length,
    };
  }),
  accountPositions: p("portfolio", "read")
    .input(accountPageSchema)
    .query(async ({ input }) =>
      pageAccountBook(await loadAccountBook(), input),
    ),
  accountPosition: p("portfolio", "read")
    .input(
      z.object({
        id: z.string().min(1).max(500),
        page: z.number().int().nonnegative().max(1000000).default(0),
      }),
    )
    .query(async ({ input }) =>
      accountPositionDetail(await loadAccountBook(), input.id, input.page),
    ),
  accountAttribution: p("portfolio", "read").query(async () =>
    accountAttribution(await loadAccountBook()),
  ),
  accountMonthlyReview: p("portfolio", "read")
    .input(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/))
    .query(async ({ input }) =>
      monthlyAccountReview(await loadAccountBook(), input),
    ),
  linkAccountTrade: p("portfolio", "configure")
    .input(tradeLinkSchema)
    .mutation(async ({ input }) =>
      linkAccountTrade(input, await loadAccountBook()),
    ),
  freezeAccountExpectation: p("portfolio", "configure")
    .input(z.string().min(1).max(200))
    .mutation(({ input }) => freezeAccountExpectation(input)),
  accountReviewSettings: p("portfolio", "read").query(
    () => settings().accountReview,
  ),
  saveAccountReviewSettings: p("portfolio", "configure")
    .input(accountReviewSettingsSchema)
    .mutation(
      ({ input }) =>
        saveSettings({ ...settings(), accountReview: input }).accountReview,
    ),
});
