// Writes only .test-data/r13-browser. Stop its server, then remove that directory.
// Re-running imports idempotently. If interrupted, the same directory is the cleanup target.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { put, sqlite } from "../src/server/db";
import { settingsSchema } from "../src/lib/domain";
import { commitDeliveryImport } from "../src/server/delivery-import-service";
import { r13Days, r13Statement } from "./r13-scale-fixture";
const directory = resolve(".test-data/r13-browser");
if (resolve(process.env.QUANT_DATA_DIR ?? "") !== directory)
  throw new Error("Set isolated QUANT_DATA_DIR=.test-data/r13-browser");
const root = join(directory, "tdx");
await mkdir(join(root, "vipdoc/sh/lday"), { recursive: true });
const bytes = Buffer.alloc(r13Days.length * 32);
for (const [i, day] of r13Days.entries()) {
  const offset = i * 32;
  bytes.writeUInt32LE(Number(day.replaceAll("-", "")), offset);
  for (let k = 0; k < 4; k++) bytes.writeUInt32LE(1000, offset + 4 + k * 4);
  bytes.writeFloatLE(10000, offset + 20);
  bytes.writeUInt32LE(1000, offset + 24);
}
for (const symbol of ["sh600000", "sh000001", "sh000300"])
  await writeFile(join(root, `vipdoc/sh/lday/${symbol}.day`), bytes);
put(
  "settings",
  "settings",
  settingsSchema.parse({
    tdxRoot: root,
    calendar: r13Days,
    autoAnalysis: false,
    autoNewsAnalysis: false,
  }),
);
commitDeliveryImport(
  r13Statement(),
  { account: "R13合成规模", source: "generic", fileName: "r13-scale.csv" },
  sqlite(),
);
sqlite().close();
console.log(
  "R13 synthetic fixture: 785 rounds / 2543 fills / 1265 dates. No production data.",
);
