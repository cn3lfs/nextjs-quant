export function trustedRequest(
  host: string,
  origin: string | null,
  client: string | null,
  sessionToken?: string,
  providedToken?: string,
) {
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) || client !== "workbench")
    return false;
  if (origin && origin !== `http://${host}`) return false;
  return !sessionToken || providedToken === sessionToken;
}
