/**
 * Display-value table sorting shared by every table in the workbench: native
 * `<table>`, the shadcn `Table`, and the ARIA grid used by `GridTable`.
 * Values are read from rendered cell text, the way broker terminals sort
 * what the user sees. Pure helpers are exported for tests.
 */
export type SortDirection = "asc" | "desc";
type SortValue = { kind: "empty" } | { kind: "number"; value: number } | {
  kind: "text";
  value: string;
};

const units: [RegExp, number][] = [
  [/万亿$/, 1e12],
  [/亿$/, 1e8],
  [/万$/, 1e4],
  [/千$/, 1e3],
  [/[kK]$/, 1e3],
  [/[mM]$/, 1e6],
  [/[bB]$/, 1e9],
];

/** Parses one cell's display text into a comparable value. */
export function parseSortValue(raw: string): SortValue {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || /^[-—–·/]+$/.test(text) || text === "N/A")
    return { kind: "empty" };
  // Dates and times compare correctly as text; keep them out of numbers.
  if (/^\d{4}[-/]\d{1,2}([-/]\d{1,2})?/.test(text))
    return { kind: "text", value: text };
  let numeric = text
    .replace(/[,，]/g, "")
    .replace(/^[¥$￥]/, "")
    .replace(/(元|股|手|倍|只|家|次|天|日|根|个|笔|%|‰|pp|bp)$/i, "")
    .trim();
  let scale = 1;
  for (const [pattern, factor] of units)
    if (pattern.test(numeric)) {
      numeric = numeric.replace(pattern, "");
      scale = factor;
      break;
    }
  if (/^[+-−]?\d+(\.\d+)?$/.test(numeric)) {
    const value = Number(numeric.replace("−", "-")) * scale;
    if (Number.isFinite(value)) return { kind: "number", value };
  }
  return { kind: "text", value: text };
}

const collator = new Intl.Collator("zh-CN", { numeric: true });
/** Empty values always sort last; numbers before text within one column. */
export function compareSortValues(
  a: SortValue,
  b: SortValue,
  direction: SortDirection,
) {
  if (a.kind === "empty" || b.kind === "empty")
    return a.kind === b.kind ? 0 : a.kind === "empty" ? 1 : -1;
  const sign = direction === "asc" ? 1 : -1;
  if (a.kind === "number" && b.kind === "number")
    return (a.value - b.value) * sign;
  if (a.kind !== b.kind) return a.kind === "number" ? -1 : 1;
  return collator.compare(String(a.value), String(b.value)) * sign;
}

/** Stable sort of row groups by a key; ties keep their original order. */
export function sortGroups<T>(
  groups: readonly T[],
  valueOf: (group: T) => string,
  direction: SortDirection,
) {
  return groups
    .map((group, index) => ({ group, index, value: parseSortValue(valueOf(group)) }))
    .sort(
      (a, b) =>
        compareSortValues(a.value, b.value, direction) || a.index - b.index,
    )
    .map((item) => item.group);
}

// ---------------------------------------------------------------- DOM layer

type Grid = {
  table: HTMLElement;
  body: HTMLElement;
  headers: HTMLElement[];
  rows: HTMLElement[];
  cells: (row: HTMLElement) => HTMLElement[];
};
type State = {
  column: number;
  direction: SortDirection;
  original: HTMLElement[];
  observer: MutationObserver;
};
const states = new WeakMap<HTMLElement, State>();

function gridOf(header: HTMLElement): { grid: Grid; column: number } | null {
  if (header.closest("[data-sortable='false']")) return null;
  // Server-sorted DataTable columns keep their own sort button.
  if (header.querySelector("[data-slot='data-table-sort']")) return null;
  if (header.tagName === "TH") {
    const table = header.closest("table");
    const headRow = header.parentElement;
    const body = table?.tBodies[0];
    if (!table || !headRow || !body || headRow.parentElement?.tagName !== "THEAD")
      return null;
    // Only the last header row maps one-to-one onto body cells.
    const thead = headRow.parentElement as HTMLTableSectionElement;
    if (thead.rows[thead.rows.length - 1] !== headRow) return null;
    let column = 0;
    for (const cell of Array.from((headRow as HTMLTableRowElement).cells)) {
      if (cell === header) break;
      column += (cell as HTMLTableCellElement).colSpan;
    }
    if (header.getAttribute("colspan") && Number(header.getAttribute("colspan")) > 1)
      return null;
    const cells = (row: HTMLElement) =>
      Array.from((row as HTMLTableRowElement).cells) as HTMLElement[];
    return {
      column,
      grid: {
        table,
        body,
        headers: Array.from((headRow as HTMLTableRowElement).cells) as HTMLElement[],
        rows: Array.from(body.rows) as HTMLElement[],
        cells,
      },
    };
  }
  if (header.getAttribute("role") === "columnheader") {
    const headRow = header.closest("[role='row']") as HTMLElement | null;
    const table = header.closest("[role='table'],[role='grid']") as HTMLElement | null;
    if (!headRow || !table || headRow.parentElement !== table) return null;
    const headers = Array.from(
      headRow.querySelectorAll(":scope > [role='columnheader']"),
    ) as HTMLElement[];
    return {
      column: headers.indexOf(header),
      grid: {
        table,
        body: table,
        headers,
        rows: (Array.from(table.children) as HTMLElement[]).filter(
          (row) => row !== headRow && row.getAttribute("role") === "row",
        ),
        cells: (row) =>
          Array.from(row.querySelectorAll(":scope > [role='cell']")) as HTMLElement[],
      },
    };
  }
  return null;
}

/** A data row plus any following detail rows that do not match the header
 *  column count (expanded details, notes); they move together. */
function groupRows(grid: Grid, rows: HTMLElement[]) {
  const width = grid.headers.reduce(
    (n, h) => n + ((h as HTMLTableCellElement).colSpan || 1),
    0,
  );
  const groups: HTMLElement[][] = [];
  const trailing: HTMLElement[] = [];
  for (const row of rows) {
    const span = grid
      .cells(row)
      .reduce((n, c) => n + ((c as HTMLTableCellElement).colSpan || 1), 0);
    if (span === width) groups.push([row]);
    else if (groups.length) groups.at(-1)!.push(row);
    else trailing.push(row);
  }
  return { groups, trailing };
}

function cellText(grid: Grid, row: HTMLElement, column: number) {
  let offset = 0;
  for (const cell of grid.cells(row)) {
    if (offset === column) return cell.innerText ?? cell.textContent ?? "";
    offset += (cell as HTMLTableCellElement).colSpan || 1;
  }
  return "";
}

function apply(grid: Grid, state: State) {
  state.observer.disconnect();
  const present = new Set(grid.rows);
  // Rows React added since the first sort join the original order at the end.
  const original = [
    ...state.original.filter((row) => present.has(row)),
    ...grid.rows.filter((row) => !state.original.includes(row)),
  ];
  state.original = original;
  const { groups, trailing } = groupRows(grid, original);
  const sorted = sortGroups(
    groups,
    (group) => cellText(grid, group[0]!, state.column),
    state.direction,
  );
  const anchor = grid.rows.at(-1)?.nextSibling ?? null;
  for (const row of [...trailing, ...sorted.flat()])
    grid.body.insertBefore(row, anchor);
  let offset = 0;
  grid.headers.forEach((header) => {
    const active = offset === state.column;
    offset += (header as HTMLTableCellElement).colSpan || 1;
    header.setAttribute(
      "aria-sort",
      active ? (state.direction === "asc" ? "ascending" : "descending") : "none",
    );
    if (active) header.dataset.sortDirection = state.direction;
    else delete header.dataset.sortDirection;
  });
  state.observer.observe(grid.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

function restore(grid: Grid, state: State) {
  state.observer.disconnect();
  const present = new Set(grid.rows);
  const anchor = grid.rows.at(-1)?.nextSibling ?? null;
  for (const row of state.original)
    if (present.has(row)) grid.body.insertBefore(row, anchor);
  for (const header of grid.headers) {
    header.removeAttribute("aria-sort");
    delete header.dataset.sortDirection;
  }
  states.delete(grid.table);
}

/** Cycles a header through ascending → descending → original order. */
export function toggleHeaderSort(header: HTMLElement) {
  const found = gridOf(header);
  if (!found || found.column < 0) return false;
  const { grid, column } = found;
  const current = states.get(grid.table);
  if (current && current.column === column && current.direction === "desc") {
    restore(grid, current);
    return true;
  }
  const state: State = current ?? {
    column,
    direction: "asc",
    original: grid.rows,
    observer: new MutationObserver(() => {
      // React re-rendered rows or text: re-apply the active sort next frame.
      requestAnimationFrame(() => {
        const live = states.get(grid.table);
        const refreshed = gridOf(header);
        if (live && refreshed && grid.table.isConnected) apply(refreshed.grid, live);
      });
    }),
  };
  state.direction =
    current && current.column === column ? "desc" : "asc";
  state.column = column;
  states.set(grid.table, state);
  apply(grid, state);
  return true;
}

/** Headers that the global sorter handles (for cursor and keyboard focus). */
export const sortableHeaderSelector =
  "table:not([data-sortable='false']) > thead > tr:last-child > th, [role='table']:not([data-sortable='false']) > [role='row'] > [role='columnheader']";
