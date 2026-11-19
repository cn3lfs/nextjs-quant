/** Publish and collection moments are separate instants; both display in
 * Beijing time with an explicit date and seconds, independent of the host
 * timezone. Invalid or empty values keep the existing placeholder. */
export const NEWS_TIME_FALLBACK = "未知";

const full = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const short = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function toDate(value: number | string | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Full Beijing date and time: 2026/11/18 21:35:22. */
export function newsTime(value: number | string | null | undefined): string {
  const date = toDate(value);
  return date ? full.format(date) : NEWS_TIME_FALLBACK;
}

/** Compact Beijing month, day and time: 11/18 21:35:22. */
export function newsTimeShort(
  value: number | string | null | undefined,
): string {
  const date = toDate(value);
  return date ? short.format(date) : NEWS_TIME_FALLBACK;
}

/** ISO instant for the <time dateTime> attribute; undefined when unusable. */
export function newsTimeIso(
  value: number | string | null | undefined,
): string | undefined {
  return toDate(value)?.toISOString();
}
