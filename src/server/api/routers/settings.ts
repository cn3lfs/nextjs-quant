import { z } from "zod";
import { settingsSchema } from "~/lib/domain";
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
export const settingsRouter = createTRPCRouter({
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
