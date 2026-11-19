import { PageGrid } from "../../panels";
import { CryptoConnections } from "../../common/crypto-connections";
import { BinanceHistory } from "../../common/binance-history";

export function CryptoSection() {
  return (
    <PageGrid>
      <CryptoConnections />
      <BinanceHistory />
    </PageGrid>
  );
}
