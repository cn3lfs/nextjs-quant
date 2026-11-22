function settlementInstant(date: string, settlementDays: 0 | 1) {
  const zoned = /(?:Z|[+-]\d{2}:\d{2})$/.test(date);
  return Date.parse(
    zoned
      ? date
      : `${date.replace(" ", "T")}${settlementDays === 1 ? "+08:00" : "Z"}`,
  );
}
export function settlementDate(date: string, settlementDays: 0 | 1) {
  if (date.length === 10) return date;
  return new Date(
    settlementInstant(date, settlementDays) +
      (settlementDays === 1 ? 8 * 3600000 : 0),
  )
    .toISOString()
    .slice(0, 10);
}
/** Default equity lots settle by Shanghai calendar day. Explicit entitlement
 * instants retain their finer boundary, including equivalent timezone labels. */
export function lotAvailable(
  lot: { bought: string; availableOn?: string },
  date: string,
  settlementDays: 0 | 1,
) {
  if (lot.availableOn !== undefined) {
    // Preserve the legacy date-only replay contract when no intraday instant exists.
    if (date.length === 10) return lot.availableOn <= date;
    if (lot.availableOn.length === 10)
      return lot.availableOn <= settlementDate(date, settlementDays);
    return (
      settlementInstant(lot.availableOn, settlementDays) <=
      settlementInstant(date, settlementDays)
    );
  }
  return (
    settlementDays === 0 ||
    settlementDate(lot.bought, settlementDays) <
      settlementDate(date, settlementDays)
  );
}

export function replaySellableDate(date: string, settlementDays: 0 | 1) {
  const day = settlementDate(date, settlementDays);
  const midnight = Date.parse(day + "T00:00:00Z");
  return new Date(midnight + settlementDays * 86400000)
    .toISOString()
    .slice(0, 10);
}
