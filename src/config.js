require('dotenv').config();

function num(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`환경변수 ${name} 숫자 변환 실패: ${raw}`);
  }
  return parsed;
}

function bool(name, defaultValue = false) {
  const raw = String(process.env[name] ?? defaultValue).toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'y';
}

const config = {
  binance: {
    apiKey: process.env.BINANCE_API_KEY,
    secretKey: process.env.BINANCE_SECRET_KEY,
    baseUrl: process.env.BINANCE_BASE_URL || 'https://api.binance.com',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-5-mini',
  },

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: num('DB_PORT', 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'autotrade',
    connLimit: num('DB_CONN_LIMIT', 10),
  },

  bot: {
    markets: (process.env.MARKETS || 'BTCUSDT')
      .split(',')
      .map(v => v.trim().toUpperCase())
      .filter(Boolean),

    loopSeconds: num('LOOP_SECONDS', 20),
    dryRun: bool('DRY_RUN', true),

    rsiPeriod: num('RSI_PERIOD', 14),
    buyRsiMax: num('BUY_RSI_MAX', 35),
    aiBuyScoreMin: num('AI_BUY_SCORE_MIN', 75),

    softStopPercent: num('SOFT_STOP_PERCENT', 5),
    softTakePercent: num('SOFT_TAKE_PERCENT', 5),
    hardStopPercent: num('HARD_STOP_PERCENT', 7),
    hardTakePercent: num('HARD_TAKE_PERCENT', 10),

    maxStopExtendCount: num('MAX_STOP_EXTEND_COUNT', 1),
    maxStopExtendMinutes: num('MAX_STOP_EXTEND_MINUTES', 10),
    maxTakeExtendMinutes: num('MAX_TAKE_EXTEND_MINUTES', 30),

    trailingStopMin: num('TRAILING_STOP_MIN', 1.0),
    trailingStopMax: num('TRAILING_STOP_MAX', 2.0),

    quoteAsset: process.env.QUOTE_ASSET || 'USDT',
    quoteReserve: num('QUOTE_RESERVE', 10),
    minNotionalBuffer: num('MIN_NOTIONAL_BUFFER', 1),
  },
};

module.exports = config;