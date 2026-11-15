import { isAbsolute } from "node:path";
// The manager deliberately supplies the target. Never silently open the default DB.
if (!process.env.QUANT_DATA_DIR || !isAbsolute(process.env.QUANT_DATA_DIR))
  throw new Error("请显式设置绝对路径 QUANT_DATA_DIR");
const { registerPaperCandidates } =
  await import("../src/server/paper/registration");
const { PaperRepository } = await import("../src/server/db/paper-repository");
const { get } = await import("../src/server/db");
console.log(
  JSON.stringify(
    registerPaperCandidates(
      new PaperRepository(),
      Date.now(),
      get("paper-settings") ?? {},
    ),
  ),
);
