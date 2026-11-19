import { readdirSync } from "node:fs";

export function connectionSourcePaths() {
  const base = "src/components/workbench/connections";
  return [
    `${base}.tsx`,
    ...readdirSync(base)
      .filter((file) => file.endsWith(".tsx"))
      .sort()
      .map((file) => `${base}/${file}`),
  ];
}
