import { z } from "zod";
import {
  simAccountCashFlowSchema,
  simAccountCreateSchema,
  simAccountDeleteSchema,
  simAccountDetailQuerySchema,
  simAccountRenameSchema,
  simOrderConfirmSchema,
  simOrderPreviewSchema,
  simPlanBindingSchema,
} from "~/lib/portfolio/sim-accounts";
import { sqlite } from "../../db";
import {
  confirmSimOrder,
  createSimAccount,
  deleteSimAccount,
  getSimAccountDetail,
  listSimAccounts,
  postSimCashFlow,
  previewSimOrder,
  renameSimAccount,
  simPlanBindingGet,
  simPlanBindingSave,
} from "../../portfolio/sim-accounts/service";
import { capabilityProcedure as p, createTRPCRouter } from "../trpc";

export const simAccountsRouter = createTRPCRouter({
  simAccountsList: p("portfolio", "read").query(() =>
    listSimAccounts(sqlite()),
  ),
  simAccountDetail: p("portfolio", "read")
    .input(simAccountDetailQuerySchema)
    .query(({ input }) => getSimAccountDetail(input, sqlite())),
  simAccountCreate: p("portfolio", "configure")
    .input(simAccountCreateSchema)
    .mutation(({ input }) => createSimAccount(input, sqlite())),
  simAccountRename: p("portfolio", "configure")
    .input(simAccountRenameSchema)
    .mutation(({ input }) => renameSimAccount(input, sqlite())),
  simAccountCashFlow: p("portfolio", "configure")
    .input(simAccountCashFlowSchema)
    .mutation(({ input }) => postSimCashFlow(input, sqlite())),
  simAccountDelete: p("portfolio", "configure")
    .input(simAccountDeleteSchema)
    .mutation(({ input }) => deleteSimAccount(input, sqlite())),
  simOrderPreview: p("portfolio", "read")
    .input(simOrderPreviewSchema)
    .mutation(({ input }) => previewSimOrder(input, sqlite())),
  simOrderConfirm: p("portfolio", "configure")
    .input(simOrderConfirmSchema)
    .mutation(({ input }) => confirmSimOrder(input, sqlite())),
  simPlanBindingGet: p("portfolio", "read")
    .input(z.string().min(1))
    .query(({ input }) => simPlanBindingGet(input, sqlite())),
  simPlanBindingSave: p("portfolio", "configure")
    .input(simPlanBindingSchema)
    .mutation(({ input }) => simPlanBindingSave(input, sqlite())),
});
