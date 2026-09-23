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
});
