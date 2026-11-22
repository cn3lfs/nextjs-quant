import { fileURLToPath } from "node:url";
import { runLocalChecks } from "./lib/local-check.mjs";

try {
  if (process.env.QUANT_CHECK_ACTIVE === "1")
    throw new Error(
      "A check is already active; nested check commands are refused",
    );
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--build"))
    throw new Error("Usage: pnpm check [--build]");
  const result = await runLocalChecks({
    workspaceRoot: fileURLToPath(new URL("..", import.meta.url)),
    pnpmCli: process.env.npm_execpath,
    checkRoot: process.env.QUANT_CHECK_ROOT,
    includeBuild: args.includes("--build"),
    stepTimeoutMs: process.env.QUANT_CHECK_STEP_TIMEOUT_MS || undefined,
  });
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
