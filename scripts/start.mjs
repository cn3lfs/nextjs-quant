import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { assertStandaloneReady } from "./desktop-guards.mjs";

try {
  await assertStandaloneReady(process.cwd());
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const server = spawn(
  process.execPath,
  [resolve(".next/standalone/server.js")],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      PORT: process.env.PORT ?? "3000",
    },
  },
);
for (const event of ["SIGINT", "SIGTERM"])
  process.on(event, () => server.kill());
server.on("exit", (code) => process.exit(code ?? 1));
server.on("error", (error) => {
  console.error(`启动服务失败：${error.message}`);
  process.exitCode = 1;
});
