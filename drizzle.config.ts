import type { Config } from "drizzle-kit";
import { join } from "node:path";
import { homedir } from "node:os";
export default {
  schema: "./src/server/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: join(
      process.env.QUANT_DATA_DIR ??
        join(process.env.LOCALAPPDATA ?? homedir(), "QuantWorkbench"),
      "quant.sqlite",
    ),
  },
  tablesFilter: ["records"],
} satisfies Config;
