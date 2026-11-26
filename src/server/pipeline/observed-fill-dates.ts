/** Supplement the router's validated fill IDs with timestamps from the same
 * authenticated reconciliation response. Never issue a second request. */
export function observeFillDates(fetcher: typeof fetch) {
  const timestamps = new Map<string, number | null>();
  const read: typeof fetch = async (input, init) => {
    const response = await fetcher(input, init);
    const path = new URL(
      input instanceof Request ? input.url : input.toString(),
    ).pathname;
    if (
      !response.ok ||
      ![
        "/api/v3/myTrades",
        "/api/v5/trade/fills-history",
        "/v5/execution/list",
      ].includes(path)
    )
      return response;
    try {
      const raw = await response.clone().json();
      const rows = Array.isArray(raw) ? raw : (raw?.data ?? raw?.result?.list);
      if (Array.isArray(rows))
        for (const row of rows) {
          const id = String(row.id ?? row.tradeId ?? row.execId);
          const time = Number(row.time ?? row.ts ?? row.execTime);
          const valid =
            Number.isSafeInteger(time) &&
            time > 0 &&
            Number.isFinite(new Date(time).getTime());
          timestamps.set(
            id,
            valid && (!timestamps.has(id) || timestamps.get(id) === time)
              ? time
              : null,
          );
        }
    } catch {
      /* The adapter validates the actual fill. A missing timestamp stays unknown. */
    }
    return response;
  };
  function firstDate(ids: readonly string[]) {
    if (!ids.length) return null;
    let first = Infinity;
    for (const id of ids) {
      const time = timestamps.get(id);
      if (!time) return null;
      first = Math.min(first, time);
    }
    return new Date(first).toISOString().slice(0, 10);
  }
  return { read, firstDate };
}
