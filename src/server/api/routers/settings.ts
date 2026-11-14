import { z } from "zod";
import { settingsSchema } from "~/lib/domain";
import { connectionCheckSchema } from "~/lib/settings/connection-check";
import { checkConnection } from "../../market/connection-check";
import { newsSourceSettingsSchema } from "~/lib/settings/news-source-settings";
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
export const settingsRouter = createTRPCRouter({
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
    .input(newsSourceSettingsSchema)
    .mutation(({ input }) => checkNewsSources(settings(), input)),
  // The 数字货币 panel owns outboundProxy and binanceTestnet.
  saveSettings: p("settings", "configure")
    .input(settingsSchema)
    .mutation(({ input }) => saveSettings(preserveCryptoSettings(input))),
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
