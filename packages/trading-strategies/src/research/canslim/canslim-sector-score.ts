/** Competition ranks and complete pool sizes supplied by the source adapter. */
export function canslimSectorObservationPoints(
  sectorRank: number,
  sectorCount: number,
  stockRank: number,
) {
  const base =
    stockRank === 1 ? 6 : stockRank <= 3 ? 5 : stockRank <= 10 ? 3 : 0;
  return sectorRank > sectorCount / 2 ? Math.min(3, base) : base;
}
