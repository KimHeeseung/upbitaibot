function calculateRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) {
    throw new Error(`RSI 계산용 데이터 부족. 최소 ${period + 1}개 필요`);
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function sma(values, period) {
  if (values.length < period) {
    throw new Error(`SMA 계산용 데이터 부족: ${period}`);
  }
  const sliced = values.slice(values.length - period);
  return sliced.reduce((sum, v) => sum + v, 0) / period;
}

function calculateATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) {
    throw new Error(`ATR 계산용 데이터 부족. 최소 ${period + 1}개 필요`);
  }

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const prev = candles[i - 1];

    const high = Number(current.high_price);
    const low = Number(current.low_price);
    const prevClose = Number(prev.trade_price);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    trs.push(tr);
  }

  const atrValues = trs.slice(-period);
  return atrValues.reduce((sum, v) => sum + v, 0) / period;
}

function percentChange(from, to) {
  if (!from) return 0;
  return ((to - from) / from) * 100;
}

function sum(values) {
  return values.reduce((acc, cur) => acc + cur, 0);
}

function average(values) {
  if (!values.length) return 0;
  return sum(values) / values.length;
}

function buildFeaturesFromCandles(candles, rsiPeriod = 14) {
  if (!candles || candles.length < Math.max(rsiPeriod + 1, 30)) {
    throw new Error('특성 계산용 캔들 수 부족');
  }

  const ordered = candles.slice().reverse();
  const closes = ordered.map((v) => Number(v.trade_price));
  const highs = ordered.map((v) => Number(v.high_price));
  const lows = ordered.map((v) => Number(v.low_price));
  const volumes = ordered.map((v) => Number(v.candle_acc_trade_volume));

  const latestPrice = closes[closes.length - 1];
  const prevPrice = closes[closes.length - 2];
  const price1mChange = percentChange(prevPrice, latestPrice);
  const price5mChange = percentChange(closes[closes.length - 6], latestPrice);
  const price15mChange = percentChange(closes[closes.length - 16], latestPrice);

  const rsi = calculateRSI(closes, rsiPeriod);
  const sma7 = sma(closes, 7);
  const sma20 = sma(closes, 20);
  const atr14 = calculateATR(ordered, 14);

  const vol5 = average(volumes.slice(-5));
  const vol20 = average(volumes.slice(-20));
  const volumeRatio = vol20 === 0 ? 0 : vol5 / vol20;

  const volatilityPct = latestPrice === 0 ? 0 : (atr14 / latestPrice) * 100;

  const regime =
    sma7 > sma20 ? 'trend_up' :
    sma7 < sma20 ? 'trend_down' :
    'sideways';

  return {
    latestPrice,
    highestRecent: Math.max(...highs.slice(-20)),
    lowestRecent: Math.min(...lows.slice(-20)),
    rsi,
    sma7,
    sma20,
    atr14,
    volatilityPct,
    volumeRatio,
    price1mChange,
    price5mChange,
    price15mChange,
    regime,
    closesTail: closes.slice(-20),
    volumesTail: volumes.slice(-20),
  };
}

module.exports = {
  calculateRSI,
  calculateATR,
  sma,
  percentChange,
  buildFeaturesFromCandles,
};
