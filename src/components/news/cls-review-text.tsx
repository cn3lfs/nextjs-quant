"use client";

/** The whole text stays in one scroll container; no pagination. */
export function ClsReviewText({
  text,
  label,
}: {
  text: string;
  label: string;
  /** Accepted for retired callers; the full text is always rendered at once. */
  locate?: string;
}) {
  return (
    <pre
      aria-label={label}
      className="max-h-[75vh] overflow-auto whitespace-pre-wrap break-words rounded bg-nc-inset p-3 text-xs leading-6"
    >
      {text}
    </pre>
  );
}
