import {
  tradeWorkspacePageSchema,
  tradeWorkspaceId,
  tradeSignalOptionsSchema,
  tradePositionPageSchema,
  tradeAdjustmentPageSchema,
} from "~/lib/portfolio/trade-workspace";
import {
  tradeWorkspacePage,
  tradeWorkspaceDetail,
  tradeWorkspaceExport,
  tradeWorkspaceCsv,
  tradeSignalOptions,
  tradeAdjustmentPage,
  tradeAdjustmentDetail,
} from "../../db/trade-workspace-query";
import {
  tradeWorkspacePositions,
  tradeWorkspaceComparison,
} from "../../portfolio/trade-workspace-service";
import { mockEnabled } from "../../portfolio/mock/mock-trading-service";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";
import {
  disciplineRequestSchema,
  startDiscipline,
  disciplineStatus,
  cancelDiscipline,
  exportDiscipline,
} from "../../portfolio/discipline-service";
import { DeliveryStore } from "../../db/delivery-store";
import { sqlite as chartSqlite } from "../../db";
import { z } from "zod";
import { settings } from "../../infra/settings";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";
import {
  generateTicketSchema,
  listTicketsSchema,
  ticketIdSchema,
  generateRebalanceTicket,
  listRebalanceTickets,
  confirmRebalanceTicket,
  cancelRebalanceTicket,
  recheckRebalanceTicket,
} from "../../portfolio/rebalance-ticket-service";

export const portfolioRouter = createTRPCRouter({
  rebalanceTicketGenerate: p("portfolio", "configure")
    .input(generateTicketSchema)
    .mutation(({ input }) => generateRebalanceTicket(input)),
  rebalanceTicketList: p("portfolio", "read")
    .input(listTicketsSchema)
    .query(({ input }) => listRebalanceTickets(input)),
  rebalanceTicketConfirm: p("portfolio", "configure")
    .input(ticketIdSchema)
    .mutation(({ input }) => confirmRebalanceTicket(input)),
  rebalanceTicketCancel: p("portfolio", "configure")
    .input(ticketIdSchema)
    .mutation(({ input }) => cancelRebalanceTicket(input)),
  rebalanceTicketRecheck: p("portfolio", "configure")
    .input(ticketIdSchema)
    .mutation(({ input }) => recheckRebalanceTicket(input)),
  tradeWorkspaceEnvironment: p("portfolio", "read").query(() => ({
    today: chinaClock(Date.now()).date,
    mockEnabled: mockEnabled(),
  })),
  tradeWorkspacePage: p("portfolio", "read")
    .input(tradeWorkspacePageSchema)
    .query(({ input }) => tradeWorkspacePage(chartSqlite(), input)),
  tradeWorkspaceDetail: p("portfolio", "read")
    .input(tradeWorkspaceId)
    .query(({ input }) => tradeWorkspaceDetail(chartSqlite(), input)),
  tradeWorkspacePositions: p("portfolio", "read")
    .input(tradePositionPageSchema)
    .query(({ input }) => tradeWorkspacePositions(input)),
  tradeWorkspaceSignals: p("portfolio", "read")
    .input(tradeSignalOptionsSchema)
    .query(({ input }) => tradeSignalOptions(chartSqlite(), input)),
  tradeWorkspaceAdjustments: p("portfolio", "read")
    .input(tradeAdjustmentPageSchema)
    .query(({ input }) => tradeAdjustmentPage(chartSqlite(), input)),
  tradeWorkspaceAdjustment: p("portfolio", "read")
    .input(z.string().regex(/^[a-f0-9]{64}$/))
    .query(({ input }) => tradeAdjustmentDetail(chartSqlite(), input)),
  tradeWorkspaceComparison: p("portfolio", "read").query(() =>
    tradeWorkspaceComparison(),
  ),
  tradeWorkspaceExport: p("portfolio", "read")
    .input(
      z.object({
        filters: tradeWorkspacePageSchema,
        format: z.enum(["json", "csv"]),
      }),
    )
    .query(({ input }) => {
      const result = tradeWorkspaceExport(chartSqlite(), input.filters);
      return {
        filename: `local-trades-${result.version.slice(0, 12)}.${input.format}`,
        mime:
          input.format === "csv"
            ? "text/csv;charset=utf-8"
            : "application/json",
        content:
          input.format === "csv"
            ? tradeWorkspaceCsv(result.trades)
            : JSON.stringify(result, null, 2),
        count: result.count,
      };
    }),
  disciplineStart: p("portfolio", "compute")
    .input(disciplineRequestSchema)
    .mutation(({ input }) => {
      const store = new DeliveryStore(chartSqlite()),
        config = settings();
      const ledger = store.accountSnapshot(input.account);
      return startDiscipline(input.account, {
        ...ledger,
        openingCash: input.openingCash,
        stopCosts: input.stopCosts,
        tdxRoot: config.tdxRoot,
        calendar: config.calendar,
      });
    }),
  disciplineStatus: p("portfolio", "read")
    .input(z.string().uuid())
    .query(({ input }) => disciplineStatus(input)),
  disciplineCancel: p("portfolio", "configure")
    .input(z.string().uuid())
    .mutation(({ input }) => cancelDiscipline(input)),
  disciplineExport: p("portfolio", "read")
    .input(z.string().uuid())
    .query(({ input }) => exportDiscipline(input)),
});
