const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');

const BASE_URL = config.upbit.baseUrl;

function buildQueryString(params = {}) {
  const entries = [];

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        entries.push(`${key}=${item}`);
      }
    } else {
      entries.push(`${key}=${value}`);
    }
  }

  return entries.join('&');
}

function createAuthHeader(params = {}) {
  const payload = {
    access_key: config.upbit.accessKey,
    nonce: uuidv4(),
  };

  const queryString = buildQueryString(params);
  if (queryString) {
    payload.query_hash = crypto
      .createHash('sha512')
      .update(queryString, 'utf-8')
      .digest('hex');
    payload.query_hash_alg = 'SHA512';
  }

  const token = jwt.sign(payload, config.upbit.secretKey, {
    algorithm: 'HS512',
  });

  return {
    Authorization: `Bearer ${token}`,
  };
}

async function publicGet(path, params = {}) {
  const response = await axios.get(`${BASE_URL}${path}`, {
    params,
    timeout: 10000,
  });
  return response.data;
}

async function privateGet(path, params = {}) {
  const headers = createAuthHeader(params);
  const response = await axios.get(`${BASE_URL}${path}`, {
    params,
    headers,
    timeout: 10000,
  });
  return response.data;
}

async function privatePost(path, body = {}) {
  const headers = {
    ...createAuthHeader(body),
    'Content-Type': 'application/json; charset=utf-8',
  };

  const response = await axios.post(`${BASE_URL}${path}`, body, {
    headers,
    timeout: 10000,
  });
  return response.data;
}

async function getMinuteCandles(market, unit = 1, count = 200) {
  return publicGet(`/v1/candles/minutes/${unit}`, { market, count });
}

async function getAccounts() {
  return privateGet('/v1/accounts');
}

async function getOrderChance(market) {
  return privateGet('/v1/orders/chance', { market });
}

async function getOrder(uuid) {
  return privateGet('/v1/order', { uuid });
}

async function marketBuy(market, krwAmount) {
  const body = {
    market,
    side: 'bid',
    ord_type: 'price',
    price: String(Math.floor(krwAmount)),
    identifier: `buy_${market}_${Date.now()}`,
  };

  if (config.bot.dryRun) {
    return { dry_run: true, body };
  }

  return privatePost('/v1/orders', body);
}

async function marketSell(market, volume) {
  const body = {
    market,
    side: 'ask',
    ord_type: 'market',
    volume: String(volume),
    identifier: `sell_${market}_${Date.now()}`,
  };

  if (config.bot.dryRun) {
    return { dry_run: true, body };
  }

  return privatePost('/v1/orders', body);
}

function findBalance(accounts, currency) {
  const item = accounts.find(v => v.currency === currency);
  return item ? Number(item.balance) : 0;
}

function getBaseCurrency(market) {
  return market.split('-')[1];
}

module.exports = {
  getMinuteCandles,
  getAccounts,
  getOrderChance,
  getOrder,
  marketBuy,
  marketSell,
  findBalance,
  getBaseCurrency,
};