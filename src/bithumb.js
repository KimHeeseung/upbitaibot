const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');

const BASE_URL = config.bithumb.baseUrl;

function buildQueryString(params = {}) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function createAuthHeader(params = {}) {
  const payload = {
    access_key: config.bithumb.accessKey,
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

  const token = jwt.sign(payload, config.bithumb.secretKey);

  return {
    Authorization: `Bearer ${token}`,
  };
}

function toBithumbMarket(market) {
  if (!market) return market;
  return market.startsWith('KRW-') ? market : `KRW-${market}`;
}

function fromLegacyCandleRow(row) {
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

function chunkArray(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

async function getTicker(market) {
  const target = toBithumbMarket(market);
  const res = await axios.get(`${BASE_URL}/v1/ticker`, {
    params: { markets: target },
    timeout: 10000,
  });
  return res.data;
}

async function getTickers(markets = []) {
  const chunks = chunkArray(markets.map(toBithumbMarket), 50);
  const results = [];

  for (const chunk of chunks) {
    try {
      const res = await axios.get(`${BASE_URL}/v1/ticker`, {
        params: { markets: chunk.join(',') },
        timeout: 10000,
      });

      if (Array.isArray(res.data)) {
        results.push(...res.data);
      } else if (res.data) {
        results.push(res.data);
      }
    } catch (err) {
      const perMarket = await Promise.all(
        chunk.map(async (market) => {
          try {
            const row = await getTicker(market);
            return Array.isArray(row) ? row[0] : row;
          } catch (e) {
            return null;
          }
        })
      );

      results.push(...perMarket.filter(Boolean));
    }
  }

  return results;
}

async function getAllMarkets() {
  const res = await axios.get(`${BASE_URL}/v1/market/all`, {
    timeout: 10000,
  });

  const rows = Array.isArray(res.data) ? res.data : [];
  return rows
    .filter((item) => typeof item.market === 'string' && item.market.startsWith('KRW-'))
    .map((item) => ({ market: item.market }));
}

async function getWarningMarkets() {
  try {
    const res = await axios.get(`${BASE_URL}/v1/market/virtual_asset_warning`, {
      timeout: 10000,
    });

    return (res.data || [])
      .map((item) => item.market)
      .filter(Boolean);
  } catch (err) {
    return [];
  }
}

async function getMinuteCandles(market, unit = 1, count = 120) {
  const target = toBithumbMarket(market);

  try {
    const res = await axios.get(`${BASE_URL}/v1/candles/minutes/${unit}`, {
      params: {
        market: target,
        count,
      },
      timeout: 10000,
    });

    const rows = Array.isArray(res.data) ? res.data : [];
    if (rows.length) {
      return rows;
    }
  } catch (err) {
    // fallback
  }

  const symbol = target.replace('KRW-', '');
  const legacy = await axios.get(
    `${BASE_URL}/public/candlestick/${symbol}_KRW/${unit}m`,
    { timeout: 10000 }
  );

  const legacyRows = legacy?.data?.data || [];
  return legacyRows.map(fromLegacyCandleRow);
}

async function getAccounts() {
  const headers = createAuthHeader();
  const res = await axios.get(`${BASE_URL}/v1/accounts`, {
    headers,
    timeout: 10000,
  });
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
    timeout: 10000,
  });

  return res.data;
}

async function getOrder(uuid) {
  const params = { uuid };
  const headers = createAuthHeader(params);

  const res = await axios.get(`${BASE_URL}/v1/order`, {
    headers,
    params,
    timeout: 10000,
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
    timeout: 10000,
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
    timeout: 10000,
  });

  return res.data;
}

function findBalance(accounts, currency) {
  const item = (accounts || []).find((v) => v.currency === currency);
  return item ? Number(item.balance) : 0;
}

function getBaseCurrency(market) {
  return market.split('-')[1];
}

module.exports = {
  getTicker,
  getTickers,
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
