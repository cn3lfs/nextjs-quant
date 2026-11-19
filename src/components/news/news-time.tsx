import type { ReactElement } from "react";
import { newsTime, newsTimeIso, newsTimeShort } from "~/lib/news/news-time";

/** Renders a moment as Beijing time. Compact mode is for list buttons; the
 * full form keeps the year visible in details. Invalid values render the
 * existing placeholder without a machine-readable timestamp. */
export function NewsTime({
  value,
  short = false,
}: {
  value: number | string | null | undefined;
  short?: boolean;
}): ReactElement {
  const text = short ? newsTimeShort(value) : newsTime(value);
  const iso = newsTimeIso(value);
  return iso ? <time dateTime={iso}>{text}</time> : <>{text}</>;
}
