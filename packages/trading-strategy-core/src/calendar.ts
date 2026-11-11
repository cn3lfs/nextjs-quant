export function isoWeek(date: string): readonly [number, number] {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw new Error("日期必须有效、唯一且升序");
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const isoYear = t.getUTCFullYear();
  const week = Math.ceil(
    ((t.getTime() - Date.UTC(isoYear, 0, 1)) / 86400000 + 1) / 7,
  );
  return [isoYear, week];
}
