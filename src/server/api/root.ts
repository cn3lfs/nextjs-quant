import { cryptoTradingRouter } from "./routers/crypto-trading";
import { alertsRouter } from "./routers/alerts";
import { paperRouter } from "./routers/paper";
import { simAccountsRouter } from "./routers/sim-accounts";
import { accountsRouter } from "./routers/accounts";
import { marketRouter } from "./routers/market";
import { screeningRouter } from "./routers/screening";
import { strategyRouter } from "./routers/strategy";
import { researchRouter } from "./routers/research";
import { portfolioRouter } from "./routers/portfolio";
import { portfolioLedgerRouter } from "./routers/portfolio-ledger";
import { portfolioReviewRouter } from "./routers/portfolio-review";
import { portfolioAdmissionRouter } from "./routers/portfolio-admission";
import { newsRouter } from "./routers/news";
import { monitoringRouter } from "./routers/monitoring";
import { jobsRouter } from "./routers/jobs";
import { settingsRouter } from "./routers/settings";
import { integrationsRouter } from "./routers/integrations";
import { financialRouter } from "./routers/financial";
import { strategyCenterRouter } from "./routers/strategy-center";
import { strategyLabRouter } from "./routers/strategy-lab";
import { barReplayRouter } from "./routers/bar-replay";
import { createCallerFactory, mergeTRPCRouters } from "./trpc";

export const appRouter = mergeTRPCRouters(
  strategyLabRouter,
  accountsRouter,
  paperRouter,
  simAccountsRouter,
  alertsRouter,
  marketRouter,
  barReplayRouter,
  screeningRouter,
  strategyRouter,
  researchRouter,
  portfolioRouter,
  portfolioLedgerRouter,
  portfolioReviewRouter,
  portfolioAdmissionRouter,
  newsRouter,
  monitoringRouter,
  jobsRouter,
  settingsRouter,
  integrationsRouter,
  financialRouter,
  strategyCenterRouter,
  cryptoTradingRouter,
);
export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
