export interface AccountInfo {
  balances: { asset: string; free: string; locked: string }[];
}

export interface ApiRestrictions {
  ipRestrict: boolean;
  enableReading: boolean;
  enableWithdrawals?: boolean;
  enableInternalTransfer?: boolean;
  enableMargin?: boolean;
  enableFutures?: boolean;
  enableSpotAndMarginTrading?: boolean;
  enableVanillaOptions?: boolean;
  enablePortfolioMarginTrading?: boolean;
  permitsUniversalTransfer?: boolean;
  enableFixApiTrade?: boolean;
}

export interface TickerPrice {
  symbol: string;
  price: string;
}

export interface Ticker24h {
  symbol: string;
  priceChangePercent: string;
  lastPrice: string;
}

export interface MyTrade {
  symbol: string;
  id: number;
  orderId: number;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
}

export interface ConvertTradeFlow {
  list: {
    orderId: number | string;
    orderStatus: string;
    fromAsset: string;
    fromAmount: string;
    toAsset: string;
    toAmount: string;
    ratio: string;
    createTime: number;
  }[];
  moreData: boolean;
}

/** [openTime, open, high, low, close, volume, closeTime, ...] */
export type Kline = [number, string, string, string, string, string, number, ...unknown[]];
