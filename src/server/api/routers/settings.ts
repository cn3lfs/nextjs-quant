import { z } from "zod";
import { settingsSchema } from "~/lib/domain";
import { connectionCheckSchema } from "~/lib/settings/connection-check";
import { checkConnection } from "../../market/connection-check";
import { newsSourceSettingsRefinedSchema } from "~/lib/settings/news-source-settings";
import { checkNewsSources } from "../../news/news-source-check";
import { saveSettings, settings } from "../../infra/settings";
import {
  checkCryptoConnectivity,
  preserveCryptoSettings,
  saveCryptoSettings,
} from "../../infra/crypto-connectivity";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";
import { fiveMinuteInput } from "~/lib/settings/five-minute-import";
import {
  startFiveMinutePreview,
  startFiveMinuteDirect,
  fiveMinuteBatch,
  runFiveMinuteBatch,
  exportFiveMinuteBatch,
} from "../../jobs/five-minute-batch";
import { fiveMinuteHistoryPage as fiveMinuteHistory } from "~/server/db/five-minute-imports";
import { startBinanceBackfill } from "../../jobs/binance-public-data-service";
import {
  publicDataStatus,
  publicDataRoot,
} from "../../data-sources/binance/public-data-store";
import { localDirectorySchema } from "~/lib/settings/local-source-settings";
import { background, runWorker } from "../../jobs/jobs";
import {
  databaseStatus,
  backupDatabase,
  saveBackupSettings,
  backupSettingsSchema,
} from "../../db/backups";
import {
  workspacePreferences,
  saveWorkspacePreferences,
  workspacePreferencesPatch,
} from "../../db/workspace-preferences";
export const settingsRouter = createTRPCRouter({
  workspacePreferences: p("settings", "read").query(() =>
    workspacePreferences(),
  ),
  saveWorkspacePreferences: p("settings", "configure")
    .input(workspacePreferencesPatch)
    .mutation(({ input }) => saveWorkspacePreferences(input)),
  verifyBinancePublicData: p("settings", "compute").mutation(() => {
    const root = publicDataRoot(settings().binancePublicDataRoot);
    return background(
      "market-data-backfill",
      { source: "binance-archive-audit", root },
      (job) => runWorker({ type: "binance-archive-audit", root }, job.id),
    );
  }),
  exportBinancePublicData: p("settings", "read").mutation(() =>
    publicDataStatus(publicDataRoot(settings().binancePublicDataRoot)),
  ),
  databaseStatus: p("settings", "read").query(() => databaseStatus()),
  backupDatabase: p("settings", "configure").mutation(() => backupDatabase()),
  saveBackupSettings: p("settings", "configure")
    .input(backupSettingsSchema)
    .mutation(({ input }) => saveBackupSettings(input)),
  configureBinancePublicDataRoot: p("settings", "configure")
    .input(localDirectorySchema)
    .mutation(({ input }) => {
      publicDataRoot(input);
      saveSettings({ ...settings(), binancePublicDataRoot: input });
      return { root: publicDataRoot(input) };
    }),
  binancePublicDataStatus: p("settings", "read").query(() =>
    publicDataStatus(publicDataRoot(settings().binancePublicDataRoot)),
  ),
  startBinancePublicDataBackfill: p("dataImport", "compute")
    .input(
      z.object({ includeOneMinute: z.boolean().default(false) }).default({}),
    )
    .mutation(({ input }) => startBinanceBackfill(input.includeOneMinute)),
  startFiveMinuteImport: p("dataImport", "compute")
    .input(
      fiveMinuteInput.extend({ tdxRoot: z.string().trim().min(1).max(1000) }),
    )
    .mutation(({ input }) => startFiveMinuteDirect(input, input.tdxRoot)),
  previewFiveMinuteImport: p("dataImport", "compute")
    .input(
      fiveMinuteInput.extend({ tdxRoot: z.string().trim().min(1).max(1000) }),
    )
    .mutation(({ input }) => startFiveMinutePreview(input, input.tdxRoot)),
  fiveMinuteImport: p("dataImport", "read")
    .input(
      z.object({
        id: z.string().uuid(),
        page: z.number().int().min(0).default(0),
        filter: z.string().max(30).default(""),
      }),
    )
    .query(({ input }) => fiveMinuteBatch(input.id, input.page, input.filter)),
  fiveMinuteImportHistory: p("dataImport", "read")
    .input(z.object({ page: z.number().int().min(0).default(0) }))
    .query(({ input }) => fiveMinuteHistory(input.page)),
  exportFiveMinuteImport: p("dataImport", "compute")
    .input(z.string().uuid())
    .mutation(({ input }) => exportFiveMinuteBatch(input)),
  executeFiveMinuteImport: p("dataImport", "compute")
    .input(z.object({ id: z.string().uuid(), restore: z.boolean() }))
    .mutation(({ input }) => runFiveMinuteBatch(input.id, null, input.restore)),
  checkConnection: p("settings", "compute")
    .input(connectionCheckSchema)
    .mutation(({ input, signal }) =>
      checkConnection(settings(), input, signal),
    ),
  checkNewsSources: p("settings", "compute")
    .input(newsSourceSettingsRefinedSchema)
    .mutation(({ input }) => checkNewsSources(settings(), input)),
  // Dedicated panels own crypto connection and account-review settings.
  saveSettings: p("settings", "configure")
    .input(settingsSchema)
    .mutation(({ input }) =>
      saveSettings({
        ...preserveCryptoSettings(input),
        alerts: { ...input.alerts, mode: settings().alerts.mode },
        accountReview: settings().accountReview,
      }),
    ),
  cryptoSettings: p("cryptoSimulation", "read").query(() => {
    const { outboundProxy, binanceTestnet } = settings();
    return { outboundProxy, binanceTestnet };
  }),
  saveCryptoSettings: p("cryptoSimulation", "configure")
    .input(z.unknown())
    .mutation(({ input }) => saveCryptoSettings(input)),
  cryptoConnectivity: p("cryptoSimulation", "compute")
    .input(z.object({ proxy: z.string().trim().max(200).optional() }))
    .mutation(({ input }) => checkCryptoConnectivity(input.proxy)),
});
