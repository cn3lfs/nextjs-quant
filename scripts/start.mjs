import { spawn } from "node:child_process";
const server = spawn(process.execPath, [".next/standalone/server.js"], {
  stdio: "inherit",
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    PORT: process.env.PORT ?? "3000",
  },
});
for (const event of ["SIGINT", "SIGTERM"])
  process.on(event, () => server.kill());
server.on("exit", (code) => process.exit(code ?? 1));
