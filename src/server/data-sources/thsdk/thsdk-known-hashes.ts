export type KnownThsdkDll = {
  version: string;
  bytes: number;
  sha256: string;
  source: string;
};

/**
 * Pinned upstream DLL vendored in `vendor/thsdk/hq.dll` and copied to
 * `runtime/thsdk/hq.dll` during runtime preparation.
 */
export const BUNDLED_THSDK_DLL: KnownThsdkDll = {
  version: "2.0.2",
  bytes: 11_536_896,
  sha256: "d396628429f0c08809b069a20a8dd38bd4718d0361f48f41a061f688aa8323f0",
  source: "PyPI thsdk-2.0.2 windows/amd64 hq.dll",
};

/**
 * Only hashes verified against the upstream release may be staged without an
 * explicit opt-in. New releases must be added here after independent hashing.
 */
export const KNOWN_THSDK_DLLS: readonly KnownThsdkDll[] = [BUNDLED_THSDK_DLL];

export function findKnownThsdkDll(sha256: string): KnownThsdkDll | undefined {
  const normalized = sha256.trim().toLowerCase();
  return KNOWN_THSDK_DLLS.find((dll) => dll.sha256 === normalized);
}
