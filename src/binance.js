const axios = require('axios');
const crypto = require('crypto');
const config = require('./config');

const BASE_URL = config.binance.baseUrl;

function buildQueryString(params = {}) {
  return new URLSearchParams(
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  ).toString();
}

function sign(queryString) {
  return crypto
    .createHmac('sha256', config.binance.secretKey)
    .update(queryString)
    .digest('hex');
}

async function publicGet(path, params = {}) {
  const response = await axios.get(`${BASE_URL}${path}`, {
    params,
    timeout: 10000,
  });
  return response.data;
}

async function privateRequest(method, path, params = {}) {
  const queryString = buildQueryString({
    ...params,
    timestamp: Date.now(),
  });

  const signature = sign(queryString);
  const url = `${BASE_URL}${path}?${queryString}&signature=${signature}`;

  const response = await axios({
    method,
    url,
    headers: {
      'X-MBX-APIKEY': config.binance.apiKey,
    },
    timeout: 10000,
  });

  return response.data;
}

function mapKlineToCandle(kline) {
  return {
    trade_price: Number(kline[4]),
    high_price: Number(kline[2]),
    low_price: Number(kline[3]),
    candle_acc_trade_volume: Number(kline[5]),
  };
}

async function getMinuteCandles(symbol, unit = 1, count = 200) {
  const interval = `${unit}m`;
  const data = await publicGet('/api/v3/klines', {
    symbol,
    interval,
    limit: count,
  });

  return data.map(mapKlineToCandle);
}

async function getAccounts() {
  const data = await privateRequest('GET', '/api/v3/account');
  return data.balances || [];
}

async function getOrder(symbol, orderId) {
  return privateRequest('GET', '/api/v3/order', {
    symbol,
    orderId,
  });
}

async function getExchangeInfo(symbol) {
  const data = await publicGet('/api/v3/exchangeInfo', { symbol });
  return data.symbols?.[0] || null;
}

function getFilter(symbolInfo, filterType) {
  return (symbolInfo?.filters || []).find(v => v.filterType === filterType) || null;
}

async function getSymbolRules(symbol) {
  const symbolInfo = await getExchangeInfo(symbol);
  if (!symbolInfo) {
    throw new Error(`심볼 정보를 찾을 수 없음: ${symbol}`);
  }

  const lotSize = getFilter(symbolInfo, 'LOT_SIZE');
  const marketLotSize = getFilter(symbolInfo, 'MARKET_LOT_SIZE');
  const minNotional = getFilter(symbolInfo, 'MIN_NOTIONAL');
  const notional = getFilter(symbolInfo, 'NOTIONAL');

  return {
    symbolInfo,
    baseAsset: symbolInfo.baseAsset,
    quoteAsset: symbolInfo.quoteAsset,
    status: symbolInfo.status,
    quantityMin: Number(marketLotSize?.minQty || lotSize?.minQty || 0),
    quantityStep: Number(marketLotSize?.stepSize || lotSize?.stepSize || 0),
    minNotional: Number(
      notional?.minNotional ||
      minNotional?.minNotional ||
      0
    ),
  };
}

function findBalance(accounts, asset) {
  const item = accounts.find(v => v.asset === asset);
  return item ? Number(item.free) : 0;
}

function getBaseCurrency(symbol) {
  const quote = config.bot.quoteAsset.toUpperCase();
  if (symbol.endsWith(quote)) {
    return symbol.slice(0, -quote.length);
  }
  return symbol;
}

function floorToStep(value, step) {
  if (!step || step <= 0) return value;
  const precision = String(step).includes('.')
    ? String(step).split('.')[1].replace(/0+$/, '').length
    : 0;
  const floored = Math.floor(value / step) * step;
  return Number(floored.toFixed(precision));
}

async function marketBuy(symbol, quoteAmount) {
  const qty = Number(quoteAmount);

  const params = {
    symbol,
    side: 'BUY',
    type: 'MARKET',
    quoteOrderQty: qty,
    newClientOrderId: `buy_${symbol}_${Date.now()}`,
    newOrderRespType: 'FULL',
  };

  if (config.bot.dryRun) {
    return {
      dry_run: true,
      symbol,
      side: 'BUY',
      quoteOrderQty: qty,
      fills: [],
    };
  }

  return privateRequest('POST', '/api/v3/order', params);
}

async function marketSell(symbol, quantity) {
  const rules = await getSymbolRules(symbol);
  const sellQty = floorToStep(Number(quantity), rules.quantityStep);

  if (sellQty <= 0) {
    throw new Error(`매도 수량이 0 이하로 계산됨: ${symbol}`);
  }

  const params = {
    symbol,
    side: 'SELL',
    type: 'MARKET',
    quantity: sellQty,
    newClientOrderId: `sell_${symbol}_${Date.now()}`,
    newOrderRespType: 'FULL',
  };

  if (config.bot.dryRun) {
    return {
      dry_run: true,
      symbol,
      side: 'SELL',
      quantity: sellQty,
      fills: [],
    };
  }

  return privateRequest('POST', '/api/v3/order', params);
}

module.exports = {
  getMinuteCandles,
  getAccounts,
  getOrder,
  getExchangeInfo,
  getSymbolRules,
  marketBuy,
  marketSell,
  findBalance,
  getBaseCurrency,
  floorToStep,
};