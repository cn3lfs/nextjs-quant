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
import { createCallerFactory, mergeTRPCRouters } from "./trpc";

export const appRouter = mergeTRPCRouters(
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
);
export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
