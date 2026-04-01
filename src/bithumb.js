const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');

const BASE_URL = 'https://api.bithumb.com';

function buildQueryString(params = {}) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function createAuthHeader(params = {}) {
  const payload = {
    access_key: process.env.BITHUMB_ACCESS_KEY,
    nonce: uuidv4(),
    timestamp: Date.now(),
  };

  const queryString = buildQueryString(params);

  if (queryString) {
    payload.query_hash = crypto
      .createHash('sha512')
      .update(queryString, 'utf-8')
      .digest('hex');
    payload.query_hash_alg = 'SHA512';
  }

  const token = jwt.sign(payload, process.env.BITHUMB_SECRET_KEY);

  return {
    Authorization: `Bearer ${token}`,
  };
}

function toBithumbMarket(market) {
  if (!market) return market;
  return market.startsWith('KRW-') ? market : `KRW-${market}`;
}

function fromLegacyCandleRow(row) {
  // 구형 public/candlestick 응답이 배열인 경우 대응
  // 보통 [timestamp, open, close, high, low, volume]
  const ts = Number(row[0]);
  const open = Number(row[1]);
  const close = Number(row[2]);
  const high = Number(row[3]);
  const low = Number(row[4]);
  const volume = Number(row[5]);

  return {
    candle_date_time_kst: new Date(ts).toISOString(),
    opening_price: open,
    trade_price: close,
    high_price: high,
    low_price: low,
    candle_acc_trade_volume: volume,
  };
}

// ---------------- PUBLIC ----------------

async function getTicker(market) {
  const target = toBithumbMarket(market);
  const res = await axios.get(`${BASE_URL}/v1/ticker`, {
    params: { markets: target },
  });
  return res.data;
}

async function getAllMarkets() {
  const res = await axios.get(`${BASE_URL}/v1/market/all`);
  return (res.data || [])
    .map(item => item.market)
    .filter(market => typeof market === 'string' && market.startsWith('KRW-'));
}

async function getWarningMarkets() {
  try {
    const res = await axios.get(`${BASE_URL}/v1/market/virtual_asset_warning`);
    return (res.data || [])
      .map(item => item.market)
      .filter(Boolean);
  } catch (err) {
    return [];
  }
}

async function getMinuteCandles(market, unit = 1, count = 120) {
  const target = toBithumbMarket(market);

  // 1순위: 신규 v1 캔들 엔드포인트 시도
  try {
    const res = await axios.get(`${BASE_URL}/v1/candles/minutes/${unit}`, {
      params: {
        market: target,
        count,
      },
    });

    const rows = Array.isArray(res.data) ? res.data : [];

    if (rows.length) {
      return rows;
    }
  } catch (err) {
    // fallback below
  }

  // 2순위: 현재 사용 중이던 구형 public candlestick fallback
  const symbol = target.replace('KRW-', '');
  const legacy = await axios.get(
    `${BASE_URL}/public/candlestick/${symbol}_KRW/${unit}m`
  );

  const legacyRows = legacy?.data?.data || [];
  return legacyRows.map(fromLegacyCandleRow);
}

// 기존 코드 호환용
async function getCandles(market) {
  return getMinuteCandles(market, 1, 120);
}

// ---------------- PRIVATE ----------------

async function getAccounts() {
  const headers = createAuthHeader();
  const res = await axios.get(`${BASE_URL}/v1/accounts`, { headers });
  return res.data;
}

async function getOrderChance(market) {
  const params = {
    market: toBithumbMarket(market),
  };
  const headers = createAuthHeader(params);

  const res = await axios.get(`${BASE_URL}/v1/orders/chance`, {
    headers,
    params,
  });

  return res.data;
}

async function getOrder(uuid) {
  const params = { uuid };
  const headers = createAuthHeader(params);

  const res = await axios.get(`${BASE_URL}/v1/order`, {
    headers,
    params,
  });

  return res.data;
}

async function marketBuy(market, krwAmount) {
  const body = {
    market: toBithumbMarket(market),
    side: 'bid',
    price: String(Math.floor(krwAmount)),
    ord_type: 'price',
  };

  if (config.bot.dryRun) {
    return { dry_run: true, body };
  }

  const headers = createAuthHeader(body);

  const res = await axios.post(`${BASE_URL}/v1/orders`, body, {
    headers,
  });

  return res.data;
}

async function marketSell(market, volume) {
  const body = {
    market: toBithumbMarket(market),
    side: 'ask',
    volume: String(volume),
    ord_type: 'market',
  };

  if (config.bot.dryRun) {
    return { dry_run: true, body };
  }

  const headers = createAuthHeader(body);

  const res = await axios.post(`${BASE_URL}/v1/orders`, body, {
    headers,
  });

  return res.data;
}

function findBalance(accounts, currency) {
  const item = (accounts || []).find(v => v.currency === currency);
  return item ? Number(item.balance) : 0;
}

function getBaseCurrency(market) {
  return market.split('-')[1];
}

module.exports = {
  getTicker,
  getCandles,
  getMinuteCandles,
  getAllMarkets,
  getWarningMarkets,
  getAccounts,
  getOrderChance,
  getOrder,
  marketBuy,
  marketSell,
  findBalance,
  getBaseCurrency,
};
