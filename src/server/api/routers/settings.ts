import { z } from "zod";
import { settingsSchema } from "~/lib/domain";
import { connectionCheckSchema } from "~/lib/settings/connection-check";
import { checkConnection } from "../../market/connection-check";
import { saveSettings, settings } from "../../infra/settings";
import {
  binanceCredentialStatus,
  checkCryptoConnectivity,
  clearBinanceCredential,
  preserveCryptoSettings,
  saveBinanceCredential,
  saveCryptoSettings,
} from "../../infra/crypto-connectivity";
import {
  cancelCryptoDemoOrder,
  confirmCryptoDemoOrder,
  cryptoDemoAccount,
  cryptoDemoDiagnostics,
  cryptoDemoEnabled,
  cryptoDemoTrades,
  previewCryptoDemoOrder,
  setCryptoDemoEnabled,
} from "../../portfolio/crypto-demo-service";
import { createTRPCRouter, publicProcedure as p } from "../trpc";
import { fiveMinuteInput } from "~/lib/settings/five-minute-import";
import {
  startFiveMinutePreview,
  fiveMinuteBatch,
  runFiveMinuteBatch,
  fiveMinuteHistory,
  exportFiveMinuteBatch,
} from "../../jobs/five-minute-batch";
export const settingsRouter = createTRPCRouter({
  previewFiveMinuteImport: p
    .input(
      fiveMinuteInput.extend({ tdxRoot: z.string().trim().min(1).max(1000) }),
    )
    .mutation(({ input }) => startFiveMinutePreview(input, input.tdxRoot)),
  fiveMinuteImport: p
    .input(
      z.object({
        id: z.string().uuid(),
        page: z.number().int().min(0).default(0),
        filter: z.string().max(30).default(""),
      }),
    )
    .query(({ input }) => fiveMinuteBatch(input.id, input.page, input.filter)),
  fiveMinuteImportHistory: p
    .input(z.object({ page: z.number().int().min(0).default(0) }))
    .query(({ input }) => fiveMinuteHistory(input.page)),
  exportFiveMinuteImport: p
    .input(z.string().uuid())
    .mutation(({ input }) => exportFiveMinuteBatch(input)),
  executeFiveMinuteImport: p
    .input(z.object({ id: z.string().uuid(), restore: z.boolean() }))
    .mutation(({ input }) => runFiveMinuteBatch(input.id, null, input.restore)),
  checkConnection: p
    .input(connectionCheckSchema)
    .mutation(({ input, signal }) =>
      checkConnection(settings(), input, signal),
    ),
  // The 数字货币 panel owns outboundProxy and binanceTestnet.
  saveSettings: p
    .input(settingsSchema)
    .mutation(({ input }) => saveSettings(preserveCryptoSettings(input))),
  cryptoSettings: p.query(() => {
    const { outboundProxy, binanceTestnet } = settings();
    return { outboundProxy, binanceTestnet };
  }),
  saveCryptoSettings: p
    .input(z.unknown())
    .mutation(({ input }) => saveCryptoSettings(input)),
  cryptoConnectivity: p
    .input(z.object({ proxy: z.string().trim().max(200).optional() }))
    .mutation(({ input }) => checkCryptoConnectivity(input.proxy)),
  binanceCredentialStatus: p.query(() => binanceCredentialStatus()),
  saveBinanceCredential: p
    .input(z.unknown())
    .mutation(({ input }) => saveBinanceCredential(input)),
  clearBinanceCredential: p.mutation(() => clearBinanceCredential()),
  // Binance simulated trading: manual, previewed orders only.
  cryptoDemoStatus: p.query(async () => ({
    enabled: cryptoDemoEnabled(),
    credential: await binanceCredentialStatus(),
    diagnostics: cryptoDemoDiagnostics(),
  })),
  setCryptoDemoEnabled: p
    .input(z.boolean())
    .mutation(({ input }) => setCryptoDemoEnabled(input)),
  cryptoDemoAccount: p.query(() => cryptoDemoAccount()),
  cryptoDemoTrades: p
    .input(z.string())
    .query(({ input }) => cryptoDemoTrades(input)),
  previewCryptoDemoOrder: p
    .input(z.unknown())
    .mutation(({ input }) => previewCryptoDemoOrder(input)),
  confirmCryptoDemoOrder: p
    .input(z.string())
    .mutation(({ input }) => confirmCryptoDemoOrder(input)),
  cancelCryptoDemoOrder: p
    .input(z.unknown())
    .mutation(({ input }) => cancelCryptoDemoOrder(input)),
});
