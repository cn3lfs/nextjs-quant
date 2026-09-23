import { z } from "zod";
import { relative } from "node:path";

const failureSchema = z
  .object({
    file: z.string().min(1),
    line: z.number().int().positive(),
    assertion: z.string().min(1),
    reason: z.string().min(1),
    reviewWhen: z.string().min(1),
  })
  .strict();
export function knownFailures(markdown: string) {
  const block = /```json\s*([\s\S]*?)```/.exec(markdown);
  if (!block) throw new Error("Missing known-failure JSON block");
  return z.array(failureSchema).parse(JSON.parse(block[1]!));
}
const reportSchema = z.object({
  numTotalTests: z.number().positive(),
  numFailedTests: z.number(),
  numRuntimeErrorTestSuites: z.number().optional(),
  testResults: z
    .array(
      z.object({
        name: z.string(),
        status: z.string(),
        message: z.string().optional(),
        assertionResults: z.array(
          z.object({ fullName: z.string(), status: z.string() }),
        ),
      }),
    )
    .min(1),
});
export function compareFailures(
  raw: unknown,
  registered: ReturnType<typeof knownFailures>,
  root = process.cwd(),
) {
  const report = reportSchema.parse(raw);
  const key = (file: string, assertion: string) =>
    JSON.stringify([file.replaceAll("\\", "/"), assertion]);
  const actual: string[] = [];
  const errors: string[] = [];
  for (const file of report.testResults) {
    const failed = file.assertionResults.filter((a) => a.status === "failed");
    if ((file.status === "failed" && !failed.length) || file.message)
      errors.push(`Suite load/runtime error: ${file.name}`);
    actual.push(
      ...failed.map((a) => key(relative(root, file.name), a.fullName)),
    );
  }
  if (report.numRuntimeErrorTestSuites) errors.push("Runtime error suites");
  if (actual.length !== report.numFailedTests)
    errors.push("Failure count mismatch");
  const expected = registered.map((f) => key(f.file, f.assertion));
  if (new Set(expected).size !== expected.length)
    errors.push("Duplicate registered failures");
  for (const item of actual)
    if (!expected.includes(item)) errors.push(`Unexpected failure: ${item}`);
  for (const item of expected)
    if (!actual.includes(item))
      errors.push(`Registered failure disappeared: ${item}`);
  return errors;
}
export function spotTests(
  files: string[],
  imports?: ReadonlyMap<string, ReadonlySet<string>>,
) {
  if (
    !files.length ||
    files.some(
      (f) => !/^tests\/[\w./-]+\.test\.ts$/.test(f) || f.includes(".."),
    )
  )
    throw new Error("Pass explicit tests/<module>/*.test.ts paths");
  const suites = [
    "tests/research-backtest/research-contracts.test.ts",
    "tests/research-backtest/research-registry-ui.test.ts",
  ];
  function dependencies(file: string, seen = new Set<string>()) {
    if (seen.has(file)) return seen;
    seen.add(file);
    for (const dependency of imports?.get(file) ?? [])
      dependencies(dependency, seen);
    return seen;
  }
  const affected = suites.filter((suite) => {
    if (!imports)
      return files.some((file) =>
        /research|trading-method|strategy|indicators|breakout|czsc/.test(file),
      );
    const inputs = dependencies(suite);
    return files.some(
      (file) =>
        file === suite ||
        [...(imports.get(file) ?? [])].some((dependency) =>
          inputs.has(dependency),
        ),
    );
  });
  return [...new Set([...files, ...affected])];
}
