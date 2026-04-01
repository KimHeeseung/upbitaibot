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

const exchangeName = (process.env.EXCHANGE || 'upbit').toLowerCase();

const config = {
  exchange: exchangeName,

  upbit: {
    accessKey: process.env.UPBIT_ACCESS_KEY || '',
    secretKey: process.env.UPBIT_SECRET_KEY || '',
    baseUrl: 'https://api.upbit.com',
  },

  bithumb: {
    accessKey: process.env.BITHUMB_ACCESS_KEY || '',
    secretKey: process.env.BITHUMB_SECRET_KEY || '',
    baseUrl: 'https://api.bithumb.com',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
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
    markets: (process.env.MARKETS || 'KRW-BTC,KRW-ETH,KRW-XRP')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),

    useAllKrwMarkets: bool('USE_ALL_KRW_MARKETS', true),
    excludeWarningMarkets: bool('EXCLUDE_WARNING_MARKETS', true),

    loopSeconds: num('LOOP_SECONDS', 20),
    dryRun: bool('DRY_RUN', true),

    rsiPeriod: num('RSI_PERIOD', 14),
    buyRsiMax: num('BUY_RSI_MAX', 60),
    aiBuyScoreMin: num('AI_BUY_SCORE_MIN', 45),

    softStopPercent: num('SOFT_STOP_PERCENT', 5),
    softTakePercent: num('SOFT_TAKE_PERCENT', 5),
    hardStopPercent: num('HARD_STOP_PERCENT', 7),
    hardTakePercent: num('HARD_TAKE_PERCENT', 10),

    maxStopExtendCount: num('MAX_STOP_EXTEND_COUNT', 1),
    maxStopExtendMinutes: num('MAX_STOP_EXTEND_MINUTES', 10),
    maxTakeExtendMinutes: num('MAX_TAKE_EXTEND_MINUTES', 30),

    trailingStopMin: num('TRAILING_STOP_MIN', 1.0),
    trailingStopMax: num('TRAILING_STOP_MAX', 2.0),

    krwReserve: num('KRW_RESERVE', 1000),
    maxBuyKrw: num('MAX_BUY_KRW', 0),

    minHoldProfitPct: num('MIN_HOLD_PROFIT_PCT', 0.3),

    preTickerTopCount: num('PRE_TICKER_TOP_COUNT', 25),
    topCandidateCount: num('TOP_CANDIDATE_COUNT', 10),
    aiTargetCount: num('AI_TARGET_COUNT', 5),

    min24hTradePrice: num('MIN_24H_TRADE_PRICE', 300000000),
    minSignedChangePct: num('MIN_SIGNED_CHANGE_PCT', -12),
    maxSignedChangePct: num('MAX_SIGNED_CHANGE_PCT', 25),
    maxVolatilityPct: num('MAX_VOLATILITY_PCT', 8),
    minVolumeRatio: num('MIN_VOLUME_RATIO', 0.05),
  },
};

module.exports = config;
