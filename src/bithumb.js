const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');

const BASE_URL = 'https://api.bithumb.com';

function buildQueryString(params = {}) {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
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

// ---------------- PUBLIC ----------------

async function getTicker(market) {
  const symbol = market.replace('KRW-', '');
  const res = await axios.get(`${BASE_URL}/v1/ticker?markets=KRW-${symbol}`);
  return res.data;
}

async function getCandles(market) {
  const symbol = market.replace('KRW-', '');
  const res = await axios.get(
    `${BASE_URL}/public/candlestick/${symbol}_KRW/1m`
  );
  return res.data.data;
}

// ---------------- PRIVATE ----------------

async function getAccounts() {
  const headers = createAuthHeader();
  const res = await axios.get(`${BASE_URL}/v1/accounts`, { headers });
  return res.data;
}

async function marketBuy(market, krwAmount) {
  const symbol = market.replace('KRW-', '');

  const body = {
    market: `KRW-${symbol}`,
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
  const symbol = market.replace('KRW-', '');

  const body = {
    market: `KRW-${symbol}`,
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
  const item = accounts.find(v => v.currency === currency);
  return item ? Number(item.balance) : 0;
}

function getBaseCurrency(market) {
  return market.split('-')[1];
}

module.exports = {
  getTicker,
  getCandles,
  getAccounts,
  marketBuy,
  marketSell,
  findBalance,
  getBaseCurrency,
};