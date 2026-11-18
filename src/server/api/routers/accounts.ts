import { z } from "zod";
import {
  accountPageSchema,
  accountReviewSettingsSchema,
  stopStatusFor,
  tradeLinkSchema,
} from "~/lib/portfolio/account-workspace";
import {
  loadAccountBook,
  pageAccountBook,
  accountPositionDetail,
  accountAttribution,
  accountTradePage,
  linkAccountTrade,
} from "../../portfolio/account-workspace-service";
import {
  accountLinkSuggestions,
  confirmAccountLinks,
  saveTradeJournal,
  accountExecutionQuality,
  accountWeeklyReview,
} from "../../portfolio/account-review-service";
import {
  batchTradeLinksSchema,
  tradeJournalSchema,
  reviewTradeFingerprint,
} from "~/lib/portfolio/account-review";
import { AccountReviewRepository } from "../../db/account-review-repository";
import { monthlyAccountReview } from "../../portfolio/account-monthly-review";
import { settings, saveSettings } from "../../infra/settings";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";
const reviewDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (d) =>
      Number.isFinite(Date.parse(d)) &&
      new Date(d).toISOString().slice(0, 10) === d,
    "日期无效",
  );
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
    // Same read classification as the unified holdings list: no extra quote.
    const touched = book.positions
      .filter((p) => stopStatusFor(p) === "touched")
      .sort((a, b) => a.id.localeCompare(b.id));
    return { items: touched.slice(0, 20), total: touched.length };
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
  accountLinkSuggestions: p("portfolio", "read")
    .input(z.object({ batchId: z.string().max(200).optional() }).default({}))
    .query(async ({ input }) =>
      accountLinkSuggestions(await loadAccountBook(), input.batchId),
    ),
  confirmAccountLinks: p("portfolio", "configure")
    .input(batchTradeLinksSchema)
    .mutation(async ({ input }) =>
      confirmAccountLinks(input, await loadAccountBook()),
    ),
  accountJournalContext: p("portfolio", "read")
    .input(z.string().min(1).max(500))
    .query(async ({ input }) => {
      const book = await loadAccountBook(),
        trade = book.trades.find((t) => t.id === input);
      if (!trade) throw new Error("成交不存在");
      const fingerprint = reviewTradeFingerprint(trade),
        journal = new AccountReviewRepository().journal(input);
      return {
        trade,
        fingerprint,
        factVersion: book.facts.version,
        journal: journal?.fingerprint === fingerprint ? journal : null,
      };
    }),
  saveTradeJournal: p("portfolio", "configure")
    .input(tradeJournalSchema)
    .mutation(async ({ input }) =>
      saveTradeJournal(input, await loadAccountBook()),
    ),
  accountExecutionQuality: p("portfolio", "read")
    .input(
      z.object({
        from: reviewDate,
        to: reviewDate,
        page: z.number().int().min(0).max(100000).default(0),
      }),
    )
    .query(async ({ input }) => {
      const result = accountExecutionQuality(
        await loadAccountBook(),
        input.from,
        input.to,
      );
      const rows = result.rows.sort(
        (a, b) =>
          b.date.localeCompare(a.date) || a.tradeId.localeCompare(b.tradeId),
      );
      return {
        ...result,
        total: rows.length,
        rows: rows.slice(input.page * 20, (input.page + 1) * 20),
      };
    }),
  accountWeeklyReview: p("portfolio", "read")
    .input(reviewDate)
    .query(async ({ input }) =>
      accountWeeklyReview(await loadAccountBook(), input),
    ),
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
