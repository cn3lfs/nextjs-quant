import { fileURLToPath } from "node:url";
import { buildPackage } from "./lib/package-build.mjs";

try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--force"))
    throw new Error("Usage: build-package.mjs [--force]");
  const result = buildPackage({
    workspaceRoot: fileURLToPath(new URL("..", import.meta.url)),
    packageRoot: process.cwd(),
    force: args.includes("--force"),
  });
  console.log(`[${result.name}] ${result.status} (${result.elapsedMs} ms)`);
} catch (error) {
  console.error(error.message);
  process.exitCode =
    Number.isInteger(error.status) && error.status > 0 ? error.status : 1;
}
