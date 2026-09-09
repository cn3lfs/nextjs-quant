import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
await mkdir(".next/standalone/.next", { recursive: true });
await cp(".next/static", ".next/standalone/.next/static", { recursive: true });
await cp("public", ".next/standalone/public", { recursive: true });
await cp("runtime", ".next/standalone/runtime", { recursive: true });
await mkdir(".next/standalone/node-runtime", { recursive: true });
await cp(process.execPath, ".next/standalone/node-runtime/node.exe");
await mkdir(".next/standalone/third-party-notices", { recursive: true });
await cp(
  join(dirname(process.execPath), "LICENSE"),
  ".next/standalone/third-party-notices/Node-LICENSE",
);
await cp(
  "node_modules/lightweight-charts/LICENSE",
  ".next/standalone/third-party-notices/Lightweight-Charts-LICENSE",
);
await cp(
  "THIRD_PARTY_NOTICES.md",
  ".next/standalone/third-party-notices/README.md",
);
