import { auditLocalFinancialFiles } from "../src/server/data-sources/tdx/local-financial-audit";
const root = process.argv[2];
if (!root)
  throw new Error(
    "用法：pnpm exec tsx scripts/audit-tdx-financials.ts <通达信根目录> [--zip] [--files]",
  );
const result = await auditLocalFinancialFiles(root, {
  verifyZip: process.argv.includes("--zip"),
  progress: (done, total) =>
    process.stderr.write(`财务审计 ${done}/${total}\n`),
});
const { files, ...summary } = result;
process.stdout.write(
  JSON.stringify(
    process.argv.includes("--files")
      ? result
      : {
          ...summary,
          failures: files.filter(
            (f) => !["valid", "placeholder"].includes(f.status),
          ),
        },
    null,
    2,
  ) + "\n",
);
if (files.some((file) => file.status === "invalid")) process.exitCode = 1;
