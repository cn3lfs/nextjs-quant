import { cryptoTradingRouter } from "./routers/crypto-trading";
import { alertsRouter } from "./routers/alerts";
import { marketRouter } from "./routers/market";
import { screeningRouter } from "./routers/screening";
import { strategyRouter } from "./routers/strategy";
import { researchRouter } from "./routers/research";
import { portfolioRouter } from "./routers/portfolio";
import { newsRouter } from "./routers/news";
import { monitoringRouter } from "./routers/monitoring";
import { jobsRouter } from "./routers/jobs";
import { settingsRouter } from "./routers/settings";
import { integrationsRouter } from "./routers/integrations";
import { financialRouter } from "./routers/financial";
import { strategyCenterRouter } from "./routers/strategy-center";
import { createCallerFactory, mergeTRPCRouters } from "./trpc";

export const appRouter = mergeTRPCRouters(
  alertsRouter,
  marketRouter,
  screeningRouter,
  strategyRouter,
  researchRouter,
  portfolioRouter,
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
