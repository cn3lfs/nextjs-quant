"use client";
import { useEffect } from "react";
import {
  sortableHeaderSelector,
  toggleHeaderSort,
} from "~/lib/common/table-sort";

/** Click any table header to sort its rows (asc → desc → original). One
 *  delegated listener covers every table rendered in the workbench. */
export function TableSortProvider() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (!target || target.closest("button,a,input,select,textarea,label"))
        return;
      const header = target.closest(sortableHeaderSelector);
      if (header instanceof HTMLElement) toggleHeaderSort(header);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  return null;
}
