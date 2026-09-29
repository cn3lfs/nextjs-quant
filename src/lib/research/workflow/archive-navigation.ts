import { archiveHistoryInput, type ArchiveFilter } from "./archive-history";

export function archiveSearch(filter: ArchiveFilter) {
  const params = new URLSearchParams();
  if (filter.kinds) params.set("kinds", filter.kinds.join(","));
  for (const key of ["keyword", "symbol", "from", "to"] as const)
    if (filter[key]) params.set(key, filter[key]!);
  return params.toString();
}
export function parseArchiveSearch(search: string): ArchiveFilter {
  const params = new URLSearchParams(search);
  const parsed = archiveHistoryInput.safeParse({
    kinds: params.get("kinds")?.split(","),
    keyword: params.get("keyword") ?? undefined,
    symbol: params.get("symbol") ?? undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
  });
  return parsed.success ? parsed.data : {};
}
export function archiveReturnHref(search: string) {
  const query = archiveSearch(
    parseArchiveSearch(new URLSearchParams(search).get("archive") ?? ""),
  );
  return `/reports${query ? `?${query}` : ""}`;
}
