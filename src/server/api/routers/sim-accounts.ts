import { z } from "zod";
import {
  futuresSimAccountCreateSchema,
  futuresSimOrderConfirmSchema,
  futuresSimOrderPreviewSchema,
} from "~/lib/portfolio/futures-sim";
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
import { tradeInputSchema } from "~/lib/portfolio/trade-ledger";
import { sqlite } from "../../db";
import {
  confirmFuturesSimOrder,
  createFuturesSimAccount,
  listFuturesSimAccounts,
  previewFuturesSimOrder,
} from "../../portfolio/futures-sim-service";
import {
  confirmMockOrder,
  openMockAccount,
  previewMockOrder,
  queryMockOrderStatus,
  queryMockOverview,
  readMockAccountMeta,
  refreshMockShareholders,
  setMockEnabled,
} from "../../portfolio/mock/mock-trading-service";
import {
  deleteThsLiveAccount,
  listThsLiveAccounts,
  readThsLiveAccountSnapshot,
  saveThsLiveAccount,
  thsLiveAccountSaveSchema,
} from "../../portfolio/ths-live-account-service";
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

const accountOrOrderId = z.object({ id: z.string().min(1) }).strict();

export const simAccountsRouter = createTRPCRouter({
  futuresSimAccountsList: p("portfolio", "read").query(() =>
    listFuturesSimAccounts(),
  ),
  futuresSimAccountCreate: p("portfolio", "configure")
    .input(futuresSimAccountCreateSchema)
    .mutation(({ input }) => createFuturesSimAccount(input)),
  futuresSimOrderPreview: p("portfolio", "read")
    .input(futuresSimOrderPreviewSchema)
    .mutation(({ input }) => previewFuturesSimOrder(input)),
  futuresSimOrderConfirm: p("portfolio", "configure")
    .input(futuresSimOrderConfirmSchema)
    .mutation(({ input }) => confirmFuturesSimOrder(input)),
  thsMockMeta: p("portfolio", "read").query(() => readMockAccountMeta()),
  thsMockToggle: p("portfolio", "configure")
    .input(z.object({ enabled: z.boolean() }).strict())
    .mutation(({ input }) => setMockEnabled(input.enabled)),
  thsMockOpenAccount: p("portfolio", "configure").mutation(() =>
    openMockAccount(),
  ),
  thsMockRecoverAccount: p("portfolio", "configure").mutation(() =>
    refreshMockShareholders(),
  ),
  thsMockOverview: p("portfolio", "read").mutation(() => queryMockOverview()),
  thsMockPreviewOrder: p("portfolio", "read")
    .input(tradeInputSchema)
    .mutation(({ input }) => previewMockOrder(input)),
  thsMockConfirmOrder: p("portfolio", "configure")
    .input(accountOrOrderId)
    .mutation(({ input }) => confirmMockOrder(input.id)),
  thsMockOrderStatus: p("portfolio", "read")
    .input(accountOrOrderId)
    .mutation(({ input }) => queryMockOrderStatus(input.id)),
  thsLiveAccountsList: p("portfolio", "read").query(() =>
    listThsLiveAccounts(),
  ),
  thsLiveAccountSave: p("portfolio", "configure")
    .input(thsLiveAccountSaveSchema)
    .mutation(({ input }) => saveThsLiveAccount(input)),
  thsLiveAccountDelete: p("portfolio", "configure")
    .input(accountOrOrderId)
    .mutation(({ input }) => deleteThsLiveAccount(input.id)),
  thsLiveAccountSnapshot: p("portfolio", "read")
    .input(accountOrOrderId)
    .mutation(({ input }) => readThsLiveAccountSnapshot(input.id)),
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
