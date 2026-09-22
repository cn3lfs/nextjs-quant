import { build } from "esbuild";
import { constants } from "node:fs";
import { mkdir, copyFile, readFile } from "node:fs/promises";

export async function prepareCzscTestRuntime() {
  await mkdir("runtime/czsc", { recursive: true });
  const source = "vendor/czsc/CZSC64.dll";
  const destination = "runtime/czsc/CZSC64.dll";
  // Windows locks loaded DLLs. Never truncate the shared binary in beforeAll:
  // another running app/worker can own it even with fileParallelism:false.
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!(await readFile(source)).equals(await readFile(destination)))
    throw new Error(
      "CZSC runtime DLL differs from vendor; stop its owners and rebuild runtime",
    );
  await build({
    entryPoints: ["src/server/strategies/chan/czsc-worker.ts"],
    outfile: "runtime/czsc-worker.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["koffi"],
    target: "node22",
  });
}
