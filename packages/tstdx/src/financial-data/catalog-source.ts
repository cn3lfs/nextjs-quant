import { bkSourceEntries } from "./catalog-bk.js";
import { fnSourceEntries } from "./catalog-fn.js";
import { goSourceEntries } from "./catalog-go.js";
import { gpSourceEntries } from "./catalog-gp.js";
import { scSourceEntries } from "./catalog-sc.js";
import type { FinancialSourceRow } from "./catalog-types.js";

export type { FinancialSourceRow } from "./catalog-types.js";

export const financialSourceRows: readonly FinancialSourceRow[] = [
  ...fnSourceEntries,
  ...gpSourceEntries,
  ...bkSourceEntries,
  ...scSourceEntries,
  ...goSourceEntries,
].map(([code, section, label]) => ({ code, section, label }));
