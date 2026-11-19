import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import * as sourceModel from "tstdx/financial-model";
import tstdxPackage from "../../tstdx/package.json";
import corePackage from "../package.json";
import * as financial from "../src/financial/index.js";

it("resolves each package export directly to its pure financial module", () => {
  expect(tstdxPackage.exports["./financial-model"]).toEqual({
    types: "./dist/financial-data/index.d.ts",
    import: "./dist/financial-data/index.js",
  });
  expect(corePackage.exports["./financial"]).toEqual({
    types: "./dist/financial/index.d.ts",
    import: "./dist/financial/index.js",
  });
});

it("exposes only the reviewed source model values and pure strategy calculations", () => {
  const sourceExports = {
    financialAvailableFrom: sourceModel.financialAvailableFrom,
    financialCatalog: sourceModel.financialCatalog,
    financialDate: sourceModel.financialDate,
    financialField: sourceModel.financialField,
    financialMappingVersion: sourceModel.financialMappingVersion,
    financialSummaryFieldSlots: sourceModel.financialSummaryFieldSlots,
    financialVisibleAt: sourceModel.financialVisibleAt,
    projectFinancialFields: sourceModel.projectFinancialFields,
    projectFinancialSummary: sourceModel.projectFinancialSummary,
    seriesValueDefinition: sourceModel.seriesValueDefinition,
    sourceFinancialValue: sourceModel.sourceFinancialValue,
  };
  expect(Object.keys(financial).sort()).toEqual(
    [
      ...Object.keys(sourceExports),
      "combineFinancialConditions",
      "compareFinancialNumber",
      "evaluateFinancialConditions",
      "financialMetricSeries",
      "financialMetrics",
      "financialVersions",
    ].sort(),
  );
  for (const key of Object.keys(
    sourceExports,
  ) as (keyof typeof sourceExports)[]) {
    expect(financial[key], key).toBe(sourceExports[key]);
  }
});

it("keeps financial dependencies inside the two pure layers even for type imports", () => {
  const layers = [
    { path: "../src/financial/", external: ["tstdx/financial-model"] },
    { path: "../../tstdx/src/financial-data/", external: [] },
  ];
  for (const layer of layers) {
    const directory = new URL(layer.path, import.meta.url);
    for (const file of readdirSync(directory, { recursive: true }).map(
      String,
    )) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(
        new URL(file.replaceAll("\\", "/"), directory),
        "utf8",
      );
      const { importedFiles } = ts.preProcessFile(source, true, true);
      for (const { fileName } of importedFiles) {
        expect(
          /^\.\/[\w-]+\.js$/.test(fileName) ||
            layer.external.includes(fileName),
          `${layer.path}${file} -> ${fileName}`,
        ).toBe(true);
      }
    }
  }
});
