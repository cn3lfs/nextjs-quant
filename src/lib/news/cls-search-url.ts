export const CLS_ALLOWED_HOST = "www.cls.cn";
export const CLS_SEARCH_BASE = "https://www.cls.cn/searchPage";

export function defaultClsSearchKeyword(symbol: string, name?: string | null) {
  const trimmed = name?.trim();
  if (
    trimmed &&
    trimmed !== "—" &&
    trimmed.toLowerCase() !== symbol.toLowerCase()
  )
    return trimmed;
  return symbol.replace(/^(sh|sz|bj|cx)/i, "");
}

export function buildClsSearchUrl(keyword: string) {
  const trimmed = keyword.trim();
  return trimmed
    ? `${CLS_SEARCH_BASE}?keyword=${encodeURIComponent(trimmed)}&type=all`
    : `${CLS_SEARCH_BASE}?type=all`;
}

export function isAllowedClsUrl(rawUrl: string) {
  try {
    const { protocol, hostname } = new URL(rawUrl);
    return (
      protocol === "https:" &&
      (hostname === CLS_ALLOWED_HOST || hostname.endsWith(".cls.cn"))
    );
  } catch {
    return false;
  }
}
