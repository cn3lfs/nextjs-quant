import { theoryRangeDefinitions } from "./theory-range.js";
import { theoryAdvancedDefinitions } from "./theory-advanced.js";
import { theoryDailyDefinitions } from "./theory-daily.js";
import { theoryStructureDefinitions } from "./theory-structure.js";
export const theoryDefinitions = [
  ...theoryDailyDefinitions,
  ...theoryStructureDefinitions,
  ...theoryAdvancedDefinitions,
  ...theoryRangeDefinitions,
] as const;
