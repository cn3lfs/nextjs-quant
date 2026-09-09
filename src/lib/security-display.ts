/** Presentation only: never mutate archived snapshots or model evidence. */
export function securityDisplayName(
  symbol: string,
  names: Record<string, string>,
  archived?: string,
) {
  const known = names[symbol]?.trim();
  if (known && known.toLowerCase() !== symbol.toLowerCase()) return known;
  const old = archived?.trim();
  return old && old.toLowerCase() !== symbol.toLowerCase() ? old : "名称待补全";
}
export function archivedNameHint(
  symbol: string,
  names: Record<string, string>,
  archived?: string,
) {
  return archived && securityDisplayName(symbol, names, archived) !== archived
    ? `归档名称：${archived}；当前显示采用证券主档，原始证据未改写。`
    : undefined;
}
