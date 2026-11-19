import type { RouterOutputs } from "~/trpc/react";

export type CatalogEntry = RouterOutputs["strategyCenterCatalog"][number];
export type CatalogQuery = {
  data?: RouterOutputs["strategyCenterCatalog"];
  error: { message: string } | null;
  isLoading: boolean;
  refetch: () => unknown;
};
export type HistoryJob = RouterOutputs["strategyCenterHistory"][number];
export type HistoryQuery = {
  data?: RouterOutputs["strategyCenterHistory"];
  error: { message: string } | null;
  isLoading: boolean;
  refetch: () => unknown;
};
