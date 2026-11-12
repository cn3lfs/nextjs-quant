import { z } from "zod";
import {
  accountViewSchema,
  accountSyncSchema,
} from "../../crypto-trading/account-model";
import {
  cryptoAccountView,
  syncCryptoAccount,
} from "../../crypto-trading/account-service";
import { configSchema } from "../../crypto-trading/model";
import {
  cryptoBotStatus,
  saveCryptoBot,
  saveCryptoBotCredential,
  diagnoseCryptoBot,
  controlCryptoBot,
  cancelCryptoBotOrder,
} from "../../crypto-trading/service";
import { createTRPCRouter, publicProcedure as p } from "../trpc";

const accountId = z
  .string()
  .regex(/^(binance-(demo|testnet)|okx-demo|bybit-demo)$/);
export const cryptoTradingRouter = createTRPCRouter({
  cryptoAccountView: p
    .input(accountViewSchema)
    .query(({ input }) => cryptoAccountView(input)),
  syncCryptoAccount: p
    .input(accountSyncSchema)
    .mutation(({ input }) => syncCryptoAccount(input)),
  cryptoBotStatus: p
    .input(accountId)
    .query(({ input }) => cryptoBotStatus(input)),
  saveCryptoBot: p
    .input(configSchema)
    .mutation(({ input }) => saveCryptoBot(input)),
  saveCryptoBotCredential: p
    .input(
      z
        .object({
          id: accountId,
          apiKey: z.string().trim().min(1).max(256),
          apiSecret: z.string().trim().min(1).max(256),
          passphrase: z.string().min(1).max(256).optional(),
        })
        .strict(),
    )
    .mutation(({ input }) => saveCryptoBotCredential(input)),
  diagnoseCryptoBot: p
    .input(accountId)
    .mutation(({ input }) => diagnoseCryptoBot(input)),
  controlCryptoBot: p
    .input(
      z
        .object({ id: accountId, action: z.enum(["start", "pause", "stop"]) })
        .strict(),
    )
    .mutation(({ input }) => controlCryptoBot(input)),
  cancelCryptoBotOrder: p
    .input(
      z.object({ id: accountId, clientId: z.string().min(1).max(64) }).strict(),
    )
    .mutation(({ input }) => cancelCryptoBotOrder(input)),
});
