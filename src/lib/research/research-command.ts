import { z } from "zod";
export const researchCommandSchema = z.discriminatedUnion("command", [
  z
    .object({
      command: z.literal("inspect"),
      market: z.enum(["cn-equity", "crypto"]),
    })
    .strict(),
  z
    .object({
      command: z.literal("verify-input"),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);
