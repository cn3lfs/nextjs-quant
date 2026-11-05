import { isMarketIndex } from "../../../lib/market/market-indices";

/** WDZ/Weisheng volume policy: index lots, repo thousand-yuan face value,
 * securities in shares/units. SH/SZ alone never identifies an asset class. */
export function fiveMinuteVolumePolicy(symbol: string) {
  const code = symbol.toLowerCase();
  if (isMarketIndex(code) || /^sh99999[789]$/.test(code)) return 1;
  if (/^(sh204\d{3}|sz1318\d{2})$/.test(code)) return 1;
  return /^sh688\d{3}$/.test(code) ? 2 : 0;
}

export function legacyFiveMinuteVolume(raw: number) {
  const value = raw * 100;
  return value >= 0x80000000 ? 0 : value;
}

/** Keep in sync with volume_value in native/tdx-import/wdz.c.
 * Only an unambiguous amount/volume price match may override the fallback.
 * 0.001 tolerates CSV price rounding; the relative tolerance covers Single rounding. */
export function normalizeFiveMinuteVolume(
  raw: number,
  amount: number,
  low: number,
  high: number,
  policy: number,
) {
  if (policy === 1) return raw;
  let factor = policy === 2 ? 1 : 100;
  if (raw > 0 && amount > 0) {
    const tolerance = 0.001 + high * 0.000001;
    const matches = [100, 1, 0.01].filter((candidate) => {
      const price = amount / (raw * candidate);
      return price >= low - tolerance && price <= high + tolerance;
    });
    if (matches.length === 1) factor = matches[0]!;
  }
  return Math.round(raw * factor);
}
