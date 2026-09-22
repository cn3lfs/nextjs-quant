/** Current westock CLI forwards bfq literally; Tencent expects an empty fqtype.
 * Verified against independent unadjusted historical OHLC (docs/data-sources.md).
 * Keep this confined to the child CLI's explicit unadjusted kline requests. */
export function westockUnadjustedRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): RequestInit | undefined {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (
    url.origin !== "https://proxy.finance.qq.com" ||
    url.pathname !== "/cgi/cgi-bin/openai/openclaw/proxy" ||
    typeof init?.body !== "string"
  )
    return init;
  let body: { params?: { fqtype?: unknown; codes?: unknown; ktype?: unknown } };
  try {
    body = JSON.parse(init.body);
  } catch {
    return init;
  }
  const params = body?.params;
  if (
    params?.fqtype !== "bfq" ||
    !Array.isArray(params.codes) ||
    !params.codes.length ||
    !params.codes.every(
      (code) =>
        typeof code === "string" &&
        /^(?:(sh|sz|bj)\d{6}|pt[0-9A-Z]{6,12})$/.test(code),
    ) ||
    !["day", "week", "month", "m1", "m5", "m15", "m30", "m60"].includes(
      String(params.ktype),
    )
  )
    return init;
  return {
    ...init,
    body: JSON.stringify({ ...body, params: { ...params, fqtype: "" } }),
  };
}
