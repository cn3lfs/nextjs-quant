import { checkDependencies } from "./lib/dependency-check";

try {
  const graph = await checkDependencies();
  for (const violation of graph.summary.violations) {
    console.error(
      `[${violation.rule.name}] ${violation.from} -> ${violation.to}`,
    );
    if (violation.cycle)
      console.error(
        `  cycle: ${violation.cycle.map((entry) => entry.name).join(" -> ")}`,
      );
  }
  for (const cycle of graph.packageCycles)
    console.error(
      `[no-workspace-package-cycle] mutually dependent packages: ${cycle.join(", ")}`,
    );
  console.log(
    `Dependencies: ${graph.summary.totalCruised} modules, ${graph.summary.totalDependenciesCruised} edges, ${graph.summary.error} module errors, ${graph.packageCycles.length} package cycles`,
  );
  process.exitCode = graph.summary.error || graph.packageCycles.length ? 1 : 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
