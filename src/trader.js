const config = require('./config');
const {
  writeLog,
  getOpenPosition,
  openPosition,
  updatePositionMeta,
  closePosition,
} = require('./db');
const {
  getMinuteCandles,
  getAccounts,
  getOrder,
  getSymbolRules,
  marketBuy,
  marketSell,
  findBalance,
  getBaseCurrency,
  floorToStep,
} = require('./binance');
const { buildFeaturesFromCandles } = require('./indicators');
const { getEntryDecision, getExitDecision } = require('./aiAdvisor');

function nowSeoul() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

function plusMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function toMySqlDate(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function getPnlPercent(buyPrice, currentPrice) {
  return ((currentPrice - buyPrice) / buyPrice) * 100;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function buildMarketFeature(market) {
  const candles = await getMinuteCandles(market, 1, 200);
  const f = buildFeaturesFromCandles(candles, config.bot.rsiPeriod);
  return {
    market,
    ...f,
  };
}

async function getOrderExecutedAverage(symbol, orderId, fallbackPrice, fallbackVolume) {
  if (!orderId || config.bot.dryRun) {
    return {
      avgPrice: fallbackPrice,
      volume: fallbackVolume,
    };
  }

  try {
    const order = await getOrder(symbol, orderId);

    if (Array.isArray(order.fills) && order.fills.length) {
      let totalFunds = 0;
      let totalVolume = 0;
      let paidFee = 0;

      for (const fill of order.fills) {
        const price = Number(fill.price || 0);
        const qty = Number(fill.qty || 0);
        const commission = Number(fill.commission || 0);

        totalFunds += price * qty;
        totalVolume += qty;
        paidFee += commission;
      }

      if (totalVolume > 0) {
        return {
          avgPrice: totalFunds / totalVolume,
          volume: totalVolume,
          paidFee,
        };
      }
    }

    const executedQty = Number(order.executedQty || 0);
    const cummulativeQuoteQty = Number(order.cummulativeQuoteQty || 0);

    if (executedQty > 0) {
      return {
        avgPrice: cummulativeQuoteQty > 0
          ? cummulativeQuoteQty / executedQty
          : fallbackPrice,
        volume: executedQty,
        paidFee: 0,
      };
    }

    return {
      avgPrice: fallbackPrice,
      volume: fallbackVolume,
    };
  } catch (err) {
    return {
      avgPrice: fallbackPrice,
      volume: fallbackVolume,
    };
  }
}

async function scanMarketsForEntry(accounts) {
  const quoteBalance = findBalance(accounts, config.bot.quoteAsset);
  const analyses = [];

  for (const market of config.bot.markets) {
    try {
      const feature = await buildMarketFeature(market);
      const ai = await getEntryDecision(feature);

      analyses.push({ feature, ai });

      await writeLog({
        market,
        actionType: 'SCAN',
        price: feature.latestPrice,
        rsiValue: feature.rsi,
        krwBalance: quoteBalance,
        message: `action=${ai.action}, score=${ai.score}, risk=${ai.risk_level}`,
        rawJson: { feature, ai },
      });
    } catch (err) {
      await writeLog({
        market,
        actionType: 'SCAN_ERROR',
        krwBalance: quoteBalance,
        message: err.message,
      });
    }
  }

  const candidates = analyses
    .filter(({ feature, ai }) =>
      ai.action === 'BUY' &&
      ai.score >= config.bot.aiBuyScoreMin &&
      ai.risk_level !== 'high' &&
      feature.rsi <= config.bot.buyRsiMax
    )
    .sort((a, b) => {
      if (b.ai.score !== a.ai.score) return b.ai.score - a.ai.score;
      return a.feature.rsi - b.feature.rsi;
    });

  return candidates;
}

async function tryOpenPosition() {
  const position = await getOpenPosition();
  if (position) return;

  const accounts = await getAccounts();
  const quoteBalance = findBalance(accounts, config.bot.quoteAsset);

  if (quoteBalance <= config.bot.quoteReserve) {
    await writeLog({
      market: 'SYSTEM',
      actionType: 'SKIP_BUY',
      krwBalance: quoteBalance,
      message: `${config.bot.quoteAsset} 잔고 부족`,
    });
    return;
  }

  const candidates = await scanMarketsForEntry(accounts);
  if (!candidates.length) return;

  const target = candidates[0];
  const { feature, ai } = target;

  const rules = await getSymbolRules(feature.market);
  if (rules.status !== 'TRADING') {
    await writeLog({
      market: feature.market,
      actionType: 'SKIP_BUY',
      price: feature.latestPrice,
      rsiValue: feature.rsi,
      krwBalance: quoteBalance,
      message: `거래 가능 상태 아님: ${rules.status}`,
    });
    return;
  }

  const orderQuoteAmount = Math.floor(
    (quoteBalance - config.bot.quoteReserve) * 100000000
  ) / 100000000;

  const minQuoteNeeded = Number(rules.minNotional || 0) + config.bot.minNotionalBuffer;

  if (orderQuoteAmount < minQuoteNeeded) {
    await writeLog({
      market: feature.market,
      actionType: 'SKIP_BUY',
      price: feature.latestPrice,
      rsiValue: feature.rsi,
      krwBalance: quoteBalance,
      message: `최소 매수 금액 미만: ${orderQuoteAmount} < ${minQuoteNeeded}`,
      rawJson: { rules },
    });
    return;
  }

  const orderResult = await marketBuy(feature.market, orderQuoteAmount);
  const estimatedVolume = orderQuoteAmount / feature.latestPrice;

  const orderId = orderResult.orderId || null;

  const executed = await getOrderExecutedAverage(
    feature.market,
    orderId,
    feature.latestPrice,
    estimatedVolume
  );

  const buyPrice = Number(executed.avgPrice || feature.latestPrice);
  const buyVolume = Number(executed.volume || estimatedVolume);

  const softStopPrice = buyPrice * (1 - config.bot.softStopPercent / 100);
  const softTakePrice = buyPrice * (1 + config.bot.softTakePercent / 100);
  const hardStopPrice = buyPrice * (1 - config.bot.hardStopPercent / 100);
  const hardTakePrice = buyPrice * (1 + config.bot.hardTakePercent / 100);

  await openPosition({
    market: feature.market,
    buyPrice,
    buyVolume,
    buyKrw: orderQuoteAmount,
    buyOrderUuid: orderId ? String(orderId) : null,
    softStopPrice,
    softTakePrice,
    hardStopPrice,
    hardTakePrice,
    trailingMode: 'N',
    trailingStopPercent: null,
    highestPrice: buyPrice,
    extendCount: 0,
    aiHoldUntil: null,
    aiBuyScore: ai.score,
    aiBuyRisk: ai.risk_level,
    aiBuyRegime: ai.market_regime,
    aiBuySummary: [...ai.reasons, ...ai.warnings].join(' | '),
  });

  await writeLog({
    market: feature.market,
    actionType: 'BUY',
    price: buyPrice,
    rsiValue: feature.rsi,
    krwBalance: quoteBalance,
    message: config.bot.dryRun
      ? `[DRY_RUN] score=${ai.score}, risk=${ai.risk_level}, softStop=${softStopPrice}, softTake=${softTakePrice}`
      : `score=${ai.score}, risk=${ai.risk_level}, softStop=${softStopPrice}, softTake=${softTakePrice}`,
    rawJson: { feature, ai, orderResult, executed, rules },
  });
}

async function forceClosePosition(position, currentPrice, coinBalance, reason, meta = {}) {
  const rules = await getSymbolRules(position.market);
  const sellableVolume = floorToStep(Number(coinBalance), rules.quantityStep);

  if (sellableVolume <= 0) {
    await writeLog({
      market: position.market,
      actionType: 'SELL_SKIP',
      price: currentPrice,
      coinBalance,
      pnlPercent: getPnlPercent(Number(position.buy_price), currentPrice),
      message: `매도 가능 수량 없음. balance=${coinBalance}, step=${rules.quantityStep}`,
      rawJson: { rules },
    });
    return;
  }

  const estimatedAskTotal = currentPrice * sellableVolume;
  if (rules.minNotional > 0 && estimatedAskTotal < rules.minNotional) {
    await writeLog({
      market: position.market,
      actionType: 'SELL_SKIP',
      price: currentPrice,
      coinBalance: sellableVolume,
      pnlPercent: getPnlPercent(Number(position.buy_price), currentPrice),
      message: `최소 매도 금액 미만: ${estimatedAskTotal} < ${rules.minNotional}`,
      rawJson: { rules },
    });
    return;
  }

  const sellResult = await marketSell(position.market, sellableVolume);
  const orderId = sellResult.orderId || null;

  const executed = await getOrderExecutedAverage(
    position.market,
    orderId,
    currentPrice,
    sellableVolume
  );

  const sellPrice = Number(executed.avgPrice || currentPrice);
  const sellVolume = Number(executed.volume || sellableVolume);
  const sellKrw = sellPrice * sellVolume;
  const pnlPercent = getPnlPercent(Number(position.buy_price), sellPrice);

  await closePosition({
    positionId: position.id,
    sellPrice,
    sellVolume,
    sellKrw,
    sellOrderUuid: orderId ? String(orderId) : null,
    pnlPercent,
    closeReason: reason,
  });

  await writeLog({
    market: position.market,
    actionType: 'SELL',
    price: sellPrice,
    coinBalance: sellVolume,
    pnlPercent,
    message: `${reason}`,
    rawJson: { sellResult, executed, meta, rules },
  });
}

async function handleTrailing(position, feature, coinBalance) {
  const currentPrice = feature.latestPrice;
  const highestPrice = Math.max(Number(position.highest_price || 0), currentPrice);
  const trailingPct = Number(position.trailing_stop_percent || 0);

  if (highestPrice > Number(position.highest_price || 0)) {
    await updatePositionMeta(position.id, {
      highest_price: highestPrice,
    });
  }

  const triggerPrice = highestPrice * (1 - trailingPct / 100);

  if (currentPrice <= triggerPrice) {
    await forceClosePosition(
      position,
      currentPrice,
      coinBalance,
      'TRAILING_STOP_HIT',
      { highestPrice, triggerPrice, trailingPct }
    );
    return true;
  }

  await writeLog({
    market: position.market,
    actionType: 'TRAILING_HOLD',
    price: currentPrice,
    rsiValue: feature.rsi,
    coinBalance,
    pnlPercent: getPnlPercent(Number(position.buy_price), currentPrice),
    message: `highest=${highestPrice}, trigger=${triggerPrice}, trailingPct=${trailingPct}`,
  });

  return false;
}

async function shouldRespectAiHoldUntil(position) {
  if (!position.ai_hold_until) return false;
  const now = nowSeoul();
  return now < new Date(position.ai_hold_until);
}

async function tryManageOpenPosition() {
  const position = await getOpenPosition();
  if (!position) return;

  const accounts = await getAccounts();
  const baseCurrency = getBaseCurrency(position.market);
  const coinBalance = findBalance(accounts, baseCurrency);

  if (coinBalance <= 0) {
    await writeLog({
      market: position.market,
      actionType: 'WARN',
      coinBalance,
      message: 'OPEN 포지션은 있는데 실제 잔고가 0 이하',
    });
    return;
  }

  const feature = await buildMarketFeature(position.market);
  const currentPrice = feature.latestPrice;
  const pnlPercent = getPnlPercent(Number(position.buy_price), currentPrice);

  if (String(position.trailing_mode) === 'Y') {
    const closed = await handleTrailing(position, feature, coinBalance);
    if (closed) return;
  }

  if (currentPrice <= Number(position.hard_stop_price)) {
    await forceClosePosition(position, currentPrice, coinBalance, 'HARD_STOP');
    return;
  }

  if (currentPrice >= Number(position.hard_take_price)) {
    await forceClosePosition(position, currentPrice, coinBalance, 'HARD_TAKE');
    return;
  }

  const holdUntilActive = await shouldRespectAiHoldUntil(position);

  if (holdUntilActive) {
    await writeLog({
      market: position.market,
      actionType: 'AI_HOLD',
      price: currentPrice,
      rsiValue: feature.rsi,
      coinBalance,
      pnlPercent,
      message: `ai_hold_until=${position.ai_hold_until}`,
    });
    return;
  }

  const softStopHit = currentPrice <= Number(position.soft_stop_price);
  const softTakeHit = currentPrice >= Number(position.soft_take_price);

  if (!softStopHit && !softTakeHit && String(position.trailing_mode) !== 'Y') {
    await writeLog({
      market: position.market,
      actionType: 'HOLD',
      price: currentPrice,
      rsiValue: feature.rsi,
      coinBalance,
      pnlPercent,
      message: `보유중 softStop=${position.soft_stop_price}, softTake=${position.soft_take_price}`,
    });
    return;
  }

  const zoneType = softStopHit ? 'STOP_ZONE' : 'TAKE_ZONE';

  const exitAi = await getExitDecision({
    type: zoneType,
    market: position.market,
    currentPrice,
    buyPrice: Number(position.buy_price),
    pnlPercent,
    currentRsi: feature.rsi,
    regime: feature.regime,
    volumeRatio: feature.volumeRatio,
    volatilityPct: feature.volatilityPct,
    price1mChange: feature.price1mChange,
    price5mChange: feature.price5mChange,
    price15mChange: feature.price15mChange,
    highestPrice: Number(position.highest_price || position.buy_price),
    trailingMode: String(position.trailing_mode) === 'Y',
  });

  if (zoneType === 'STOP_ZONE') {
    const canExtend =
      exitAi.action === 'HOLD' &&
      exitAi.confidence >= 75 &&
      exitAi.risk_level !== 'high' &&
      Number(position.extend_count) < config.bot.maxStopExtendCount &&
      pnlPercent > -config.bot.hardStopPercent;

    if (canExtend) {
      const holdMinutes = Math.min(
        config.bot.maxStopExtendMinutes,
        Number(exitAi.max_hold_minutes || 0)
      );
      const holdUntil = plusMinutes(nowSeoul(), holdMinutes);

      await updatePositionMeta(position.id, {
        extend_count: Number(position.extend_count) + 1,
        ai_hold_until: toMySqlDate(holdUntil),
      });

      await writeLog({
        market: position.market,
        actionType: 'STOP_EXTEND',
        price: currentPrice,
        rsiValue: feature.rsi,
        coinBalance,
        pnlPercent,
        message: `AI 연장보유 ${holdMinutes}분 / ${exitAi.reason}`,
        rawJson: exitAi,
      });
      return;
    }

    await forceClosePosition(
      position,
      currentPrice,
      coinBalance,
      'SOFT_STOP',
      { exitAi }
    );
    return;
  }

  if (zoneType === 'TAKE_ZONE') {
    const canTrail =
      exitAi.action === 'HOLD' &&
      exitAi.confidence >= 75 &&
      exitAi.risk_level === 'low';

    if (canTrail) {
      const trailingPct = clamp(
        Number(exitAi.trail_stop_percent || config.bot.trailingStopMin),
        config.bot.trailingStopMin,
        config.bot.trailingStopMax
      );

      const holdMinutes = Math.min(
        config.bot.maxTakeExtendMinutes,
        Number(exitAi.max_hold_minutes || 0)
      );
      const holdUntil = plusMinutes(nowSeoul(), holdMinutes);

      await updatePositionMeta(position.id, {
        trailing_mode: 'Y',
        trailing_stop_percent: trailingPct,
        highest_price: Math.max(Number(position.highest_price || 0), currentPrice),
        ai_hold_until: toMySqlDate(holdUntil),
      });

      await writeLog({
        market: position.market,
        actionType: 'TAKE_EXTEND',
        price: currentPrice,
        rsiValue: feature.rsi,
        coinBalance,
        pnlPercent,
        message: `AI 연장보유 / trailing=${trailingPct}% / ${exitAi.reason}`,
        rawJson: exitAi,
      });
      return;
    }

    await forceClosePosition(
      position,
      currentPrice,
      coinBalance,
      'SOFT_TAKE',
      { exitAi }
    );
  }
}

module.exports = {
  tryOpenPosition,
  tryManageOpenPosition,
};