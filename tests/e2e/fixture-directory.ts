import { existsSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Validate before Playwright clears outputDir or a fixture writes files. */
export function fixtureDirectory(input: string) {
  const workspace = resolve(".test-data");
  const directory = resolve(input);
  const within = relative(workspace, directory);
  if (
    !within ||
    isAbsolute(within) ||
    within === ".." ||
    within.startsWith(`..${sep}`)
  )
    throw new Error("P0 acceptance requires a child directory of .test-data");
  for (let path = directory; ; path = dirname(path)) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error(`Linked fixture path refused: ${path}`);
    if (dirname(path) === path) return directory;
  }
}
