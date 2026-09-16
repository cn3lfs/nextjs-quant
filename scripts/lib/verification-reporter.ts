import { writeFileSync } from "node:fs";
import type { Reporter } from "vitest/node";
// Vitest custom reporter loading requires a default export. JSON alone omits unhandled errors.
export default class VerificationReporter implements Reporter {
  onTestRunEnd(
    ...[_modules, errors, reason]: Parameters<
      NonNullable<Reporter["onTestRunEnd"]>
    >
  ) {
    const target = process.env.QUANT_VERIFY_RUNTIME_REPORT;
    if (!target) throw new Error("Missing isolated verification report path");
    writeFileSync(
      target,
      JSON.stringify({ reason, errors: errors.map((e) => e.message) }),
    );
  }
}
