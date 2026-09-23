import { settingsSchema } from "~/lib/domain";
import { saveSettings } from "../../infra/settings";
import { createTRPCRouter, publicProcedure as p } from "../trpc";
export const settingsRouter = createTRPCRouter({
  saveSettings: p
    .input(settingsSchema)
    .mutation(({ input }) => saveSettings(input)),
});
