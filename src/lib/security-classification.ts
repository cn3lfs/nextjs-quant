/**
 * 证券目录中已在本机 vipdoc 中观察到三位价格精度的场内基金代码族。
 * 59 暂不加入：当前数据目录没有对应文件，不能仅凭 issue 预先扩展规则。
 */
const SH_FUND_PREFIXES = ["50", "51", "52", "53", "56", "58"] as const;
const SZ_FUND_PREFIXES = ["15", "16"] as const;
const shFundPattern = new RegExp(`^sh(?:${SH_FUND_PREFIXES.join("|")})\\d{4}$`);
const szFundPattern = new RegExp(`^sz(?:${SZ_FUND_PREFIXES.join("|")})\\d{4}$`);

export function isPriceScaleThreeFund(symbol: string) {
  return shFundPattern.test(symbol) || szFundPattern.test(symbol);
}
