// Formatting is Prettier's job. Typed checks use the existing tsconfig.
// rules-of-hooks would have caught React #310 (a hook after an early return);
// exhaustive-deps stays off because effects here deliberately list partial
// dependencies (see component comments) and the rule's advice would change
// behaviour.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import { sqliteBoundaryRule } from "./scripts/lib/sqlite-boundary-rule.mjs";

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
    files: ["src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    rules: {
      // The graph checker can follow literal paths, including lazy imports.
      // Variable paths must be expressed as an explicit map of literal loaders.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportExpression:not([source.type='Literal']):not([source.type='TemplateLiteral'][source.expressions.length=0])",
          message: "动态 import 必须使用固定路径，便于检查依赖边界与循环。",
        },
        {
          selector:
            "CallExpression[callee.name='require']:not([arguments.0.type='Literal']):not([arguments.0.type='TemplateLiteral'][arguments.0.expressions.length=0])",
          message: "require 必须使用固定路径，便于检查依赖边界与循环。",
        },
        {
          selector:
            "CallExpression[callee.object.name='module'][callee.property.name='require']:not([arguments.0.type='Literal']):not([arguments.0.type='TemplateLiteral'][arguments.0.expressions.length=0])",
          message: "module.require 必须使用固定路径，便于检查依赖边界与循环。",
        },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // Existing eslint-disable comments document intent for other tools.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    plugins: {
      "react-hooks": reactHooks,
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // Explicit void marks background intent, not rejection handling. Query
      // refreshes expose failures through query state; other work needs a handler.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Business SQL belongs to db; source-owned external databases and the
    // independent bounded diagnostics store keep their own connection lifecycle.
    files: ["src/server/**/*.ts"],
    ignores: [
      "src/server/db/**",
      "src/server/data-sources/cls/cls-news.ts",
      "src/server/infra/runtime-errors.ts",
      "src/server/news/cls-news-workflow.ts",
    ],
    plugins: {
      repositories: { rules: { "no-raw-sqlite": sqliteBoundaryRule } },
    },
    rules: { "repositories/no-raw-sqlite": "error" },
  },
  {
    // These use cases own multi-repository atomicity or a process-identity claim.
    // Only transaction callbacks are allowed; prepare/exec remain forbidden.
    files: [
      "src/server/mcp-health.ts",
      "src/server/monitoring/intraday-job.ts",
      "src/server/infra/lease.ts",
      "src/server/market/securities.ts",
      "src/server/screening/rps-observation-job.ts",
      "src/server/portfolio/trade-review-service.ts",
      "src/server/portfolio/mock/mock-trading-service.ts",
      "src/server/portfolio/delivery-preview-workspace.ts",
      "src/server/jobs/five-minute-batch.ts",
    ],
    rules: {
      "repositories/no-raw-sqlite": ["error", { allowTransactions: true }],
    },
  },
  {
    files: ["src/components/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["~/server/**", "**/server/**"],
              allowTypeImports: true,
              message:
                "共享类型可使用 import type；前端与共享 lib 不得执行服务端模块。",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/server/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "~/components/**",
                "**/components/**",
                "~/app/**",
                "**/app/**",
              ],
              allowTypeImports: true,
              message: "服务端不得执行 UI 模块；共享逻辑应归入 lib。",
            },
          ],
        },
      ],
    },
  },
];
