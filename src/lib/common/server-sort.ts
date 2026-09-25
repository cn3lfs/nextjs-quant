import { z } from "zod";

/** One-column sort sent with paged queries; mirrors TanStack SortingState. */
export const tableSortSchema = z
  .object({ id: z.string().min(1).max(40), desc: z.boolean() })
  .nullable()
  .default(null);
export type TableSort = z.infer<typeof tableSortSchema>;

type Key = string | number | null | undefined;
const collator = new Intl.Collator("zh-CN", { numeric: true });

/**
 * Sorts the complete result set before paging. Unknown columns keep the
 * caller's default order; missing values stay last in both directions and
 * ties keep the default order (stable).
 */
export function sortTableRows<T>(
  rows: readonly T[],
  sort: TableSort | undefined,
  keys: Record<string, (row: T) => Key>,
): T[] {
  const key = sort ? keys[sort.id] : undefined;
  if (!sort || !key) return [...rows];
  const sign = sort.desc ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, value: key(row) }))
    .sort((a, b) => {
      const x = a.value,
        y = b.value;
      const missingX = x == null || (typeof x === "number" && !Number.isFinite(x)),
        missingY = y == null || (typeof y === "number" && !Number.isFinite(y));
      if (missingX || missingY)
        return missingX === missingY ? a.index - b.index : missingX ? 1 : -1;
      const order =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : collator.compare(String(x), String(y));
      return order * sign || a.index - b.index;
    })
    .map((item) => item.row);
}

/** TanStack SortingState ⇄ TableSort for DataTable props. */
export const sortingState = (sort: TableSort | undefined) =>
  sort ? [{ id: sort.id, desc: sort.desc }] : [];
export function nextTableSort(
  updater: unknown,
  current: TableSort | undefined,
): TableSort {
  const state = (
    typeof updater === "function"
      ? (updater as (s: { id: string; desc: boolean }[]) => unknown)(
          sortingState(current),
        )
      : updater
  ) as { id: string; desc: boolean }[];
  const first = state[0];
  return first ? { id: first.id, desc: first.desc } : null;
}
