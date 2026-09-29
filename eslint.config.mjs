// Lint only what catches real defects cheaply. Formatting is Prettier's job.
// rules-of-hooks would have caught React #310 (a hook after an early return);
// exhaustive-deps stays off because effects here deliberately list partial
// dependencies (see component comments) and the rule's advice would change
// behaviour.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      ".next/**",
      "release/**",
      "runtime/**",
      "node_modules/**",
      "packages/*/dist/**",
      "**/*.d.ts",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    // Existing eslint-disable comments document intent for other tools.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
];
