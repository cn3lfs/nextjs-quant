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
  const suites = ["tests/research-backtest/research-contracts.test.ts"];
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
