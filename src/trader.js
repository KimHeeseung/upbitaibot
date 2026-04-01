const config = require('./config');
const {
  writeLog,
  getOpenPosition,
  openPosition,
  updatePositionMeta,
  closePosition,
} = require('./db');
const { buildFeaturesFromCandles } = require('./indicators');
const { getEntryDecision, getExitDecision } = require('./aiAdvisor');

const exchange = require(
  config.exchange === 'bithumb' ? './bithumb' : './upbit'
);

const {
  getAllMarkets,
  getWarningMarkets,
  getTickers,
  getMinuteCandles,
  getAccounts,
  getOrderChance,
  getOrder,
  marketBuy,
  marketSell,
  findBalance,
  getBaseCurrency,
} = exchange;

function nowSeoul() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })
  );
}

function plusMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function toMySqlDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function getPnlPercent(buyPrice, currentPrice) {
  return ((currentPrice - buyPrice) / buyPrice) * 100;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function minutesBetween(date1, date2) {
  return Math.floor((date2.getTime() - date1.getTime()) / 60000);
}

function getPositionOpenedAt(position) {
  return (
    position.buy_datetime ||
    position.created_at ||
    position.reg_date ||
    position.opened_at ||
    position.buy_at ||
    null
  );
}

function getHoldMinutes(position) {
  const openedAtRaw = getPositionOpenedAt(position);
  if (!openedAtRaw) return 0;

  const openedAt = new Date(openedAtRaw);
  if (Number.isNaN(openedAt.getTime())) return 0;

  return minutesBetween(openedAt, nowSeoul());
}

function getPreCandidateScore(feature) {
  return (
    (Number(feature.volumeRatio || 0) * 35) +
    (Number(feature.price5mChange || 0) * 4) +
    (Number(feature.price15mChange || 0) * 2) -
    (Math.abs(Number(feature.rsi || 50) - 52) * 0.8)
  );
}

function getTickerScore(ticker) {
  const accTradePrice = Number(
    ticker.acc_trade_price_24h ||
    ticker.acc_trade_price ||
    0
  );

  const signedChangePct = Number(
    (ticker.signed_change_rate || 0) * 100
  );

  const tradePrice = Number(ticker.trade_price || 0);

  return (
    (Math.log10(Math.max(accTradePrice, 1)) * 20) +
    (signedChangePct * 1.5) +
    (tradePrice > 0 ? 5 : 0)
  );
}

function normalizeMarketRows(rows = []) {
  return rows.map((row) => {
    if (typeof row === 'string') {
      return { market: row, warning: false };
    }

    const ev = row.market_event || {};
    return {
      market: row.market,
      warning: ev.warning === true || ev.caution === true,
      raw: row,
    };
  });
}

function normalizeTickerRow(row) {
  return {
    market: row.market,
    trade_price: Number(row.trade_price || 0),
    signed_change_rate: Number(row.signed_change_rate || 0),
    acc_trade_price_24h: Number(
      row.acc_trade_price_24h ||
      row.acc_trade_price ||
      0
    ),
  };
}

function isSidewaysMarket(feature) {
  return (
    Math.abs(Number(feature.price5mChange || 0)) <= 0.2 &&
    Math.abs(Number(feature.price15mChange || 0)) <= 0.5 &&
    Number(feature.volatilityPct || 0) <= 0.25
  );
}

function getSidewaysExitMinutes(pnlPercent) {
  if (pnlPercent >= 1.5) return 30;
  if (pnlPercent >= 0.7) return 35;
  return 45;
}

async function buildMarketFeature(market) {
  const candles = await getMinuteCandles(market, 1, 120);
  const feature = buildFeaturesFromCandles(candles, config.bot.rsiPeriod);

  return {
    market,
    ...feature,
  };
}

async function getOrderExecutedAverage(uuid, fallbackPrice, fallbackVolume) {
  if (!uuid || config.bot.dryRun) {
    return {
      avgPrice: fallbackPrice,
      volume: fallbackVolume,
    };
  }

  try {
    const order = await getOrder(uuid);

    const executedVolume =
      Number(order.executed_volume || 0) ||
      Number(order.volume || 0) ||
      fallbackVolume;

    const executedFunds =
      Number(order.executed_funds || 0) ||
      (Number(order.price || 0) * Number(order.executed_volume || 0));

    if (Array.isArray(order.trades) && order.trades.length) {
      let totalFunds = 0;
      let totalVolume = 0;

      for (const trade of order.trades) {
        totalFunds += Number(trade.funds || 0);
        totalVolume += Number(trade.volume || 0);
      }

      if (totalVolume > 0) {
        return {
          avgPrice: totalFunds / totalVolume,
          volume: totalVolume,
        };
      }
    }

    if (executedVolume > 0 && executedFunds > 0) {
      return {
        avgPrice: executedFunds / executedVolume,
        volume: executedVolume,
      };
    }

    return {
      avgPrice: fallbackPrice,
      volume: executedVolume || fallbackVolume,
    };
  } catch (err) {
    return {
      avgPrice: fallbackPrice,
      volume: fallbackVolume,
    };
  }
}

async function resolveScanMarkets() {
  if (!config.bot.useAllKrwMarkets) {
    return config.bot.markets;
  }

  const allRows = await getAllMarkets(true);
  const normalized = normalizeMarketRows(allRows);

  let markets = normalized
    .filter((item) => typeof item.market === 'string' && item.market.startsWith('KRW-'));

  if (config.bot.excludeWarningMarkets) {
    markets = markets.filter((item) => !item.warning);

    try {
      const warningMarkets = new Set(await getWarningMarkets());
      markets = markets.filter((item) => !warningMarkets.has(item.market));
    } catch (err) {
      // ignore
    }
  }

  return markets.map((item) => item.market);
}

async function scanMarketsForEntry(accounts) {
  const krwBalance = findBalance(accounts, 'KRW');

  const scanMarkets = await resolveScanMarkets();

  if (!scanMarkets.length) {
    await writeLog({
      market: 'SYSTEM',
      actionType: 'NO_MARKET',
      krwBalance,
      message: '검색 대상 마켓 없음',
    });
    return [];
  }

  let firstPassMarkets = scanMarkets;

  try {
    const tickerRows = await getTickers(scanMarkets);
    const normalizedTickers = tickerRows
      .map(normalizeTickerRow)
      .filter((row) => row.market && row.market.startsWith('KRW-'));

    const filteredTickers = normalizedTickers
      .filter((row) => {
        const accTradePrice = Number(row.acc_trade_price_24h || 0);
        const signedChangePct = Number(row.signed_change_rate || 0) * 100;

        return (
          accTradePrice >= config.bot.min24hTradePrice &&
          signedChangePct >= config.bot.minSignedChangePct &&
          signedChangePct <= config.bot.maxSignedChangePct
        );
      })
      .sort((a, b) => getTickerScore(b) - getTickerScore(a))
      .slice(0, config.bot.preTickerTopCount);

    if (filteredTickers.length) {
      firstPassMarkets = filteredTickers.map((row) => row.market);

      const topTicker = filteredTickers[0];
      await writeLog({
        market: topTicker.market,
        actionType: 'PRE_TICKER_TOP',
        price: topTicker.trade_price,
        krwBalance,
        message:
          `24h=${topTicker.acc_trade_price_24h}` +
          ` / signedChangePct=${(topTicker.signed_change_rate * 100).toFixed(2)}`,
        rawJson: topTicker,
      });
    } else {
      await writeLog({
        market: 'SYSTEM',
        actionType: 'NO_PRE_TICKER',
        krwBalance,
        message: '1차 티커 필터 통과 종목 없음',
      });
      return [];
    }
  } catch (err) {
    await writeLog({
      market: 'SYSTEM',
      actionType: 'TICKER_FALLBACK',
      krwBalance,
      message: `ticker 1차 필터 실패 -> 직접 분봉 스캔 사용 / ${err.message}`,
    });

    firstPassMarkets = scanMarkets.slice(0, config.bot.preTickerTopCount);
  }

  const featureResults = await Promise.all(
    firstPassMarkets.map(async (market) => {
      try {
        const feature = await buildMarketFeature(market);
        return { market, feature, error: null };
      } catch (err) {
        return { market, feature: null, error: err };
      }
    })
  );

  for (const item of featureResults) {
    if (item.error) {
      await writeLog({
        market: item.market,
        actionType: 'SCAN_ERROR',
        krwBalance,
        message: item.error.message,
      });
    }
  }

  const preCandidates = featureResults
    .filter((item) => item.feature)
    .map((item) => item.feature)
    .filter((feature) => {
      return (
        feature.rsi <= 78 &&
        feature.volumeRatio >= config.bot.minVolumeRatio &&
        feature.price15mChange >= -4 &&
        feature.price15mChange <= 25 &&
        feature.volatilityPct <= config.bot.maxVolatilityPct
      );
    })
    .sort((a, b) => getPreCandidateScore(b) - getPreCandidateScore(a))
    .slice(0, config.bot.topCandidateCount);

  if (!preCandidates.length) {
    await writeLog({
      market: 'SYSTEM',
      actionType: 'NO_PRE_CANDIDATE',
      krwBalance,
      message: '분봉 1차 필터 통과 종목 없음',
    });
    return [];
  }

  const topPre = preCandidates[0];
  await writeLog({
    market: topPre.market,
    actionType: 'PRECHECK_TOP',
    price: topPre.latestPrice,
    rsiValue: topPre.rsi,
    krwBalance,
    message:
      `volumeRatio=${Number(topPre.volumeRatio || 0).toFixed(2)}` +
      `, price5mChange=${Number(topPre.price5mChange || 0).toFixed(2)}` +
      `, price15mChange=${Number(topPre.price15mChange || 0).toFixed(2)}` +
      `, regime=${topPre.regime}`,
    rawJson: topPre,
  });

  const aiTargets = preCandidates.slice(0, config.bot.aiTargetCount);

  const aiResults = await Promise.all(
    aiTargets.map(async (feature) => {
      try {
        const ai = await getEntryDecision(feature);

        await writeLog({
          market: feature.market,
          actionType: 'AI_SCAN',
          price: feature.latestPrice,
          rsiValue: feature.rsi,
          krwBalance,
          message: `action=${ai.action}, score=${ai.score}, risk=${ai.risk_level}`,
          rawJson: { feature, ai },
        });

        return { feature, ai, error: null };
      } catch (err) {
        await writeLog({
          market: feature.market,
          actionType: 'SCAN_ERROR',
          krwBalance,
          message: err.message,
        });

        return { feature, ai: null, error: err };
      }
    })
  );

  const candidates = [];

  for (const item of aiResults) {
    if (item.error || !item.ai) continue;

    const { feature, ai } = item;
    let rejectedReason = null;

    const dynamicScoreMin = Math.max(
      40,
      Number(config.bot.aiBuyScoreMin || 55) - 10
    );

    if (!(ai.action === 'BUY' || ai.action === 'HOLD')) {
      rejectedReason = `action_reject:${ai.action}`;
    } else if (ai.score < dynamicScoreMin) {
      rejectedReason = `score_reject:${ai.score}<${dynamicScoreMin}`;
    } else if (
      feature.rsi > Math.max(62, Number(config.bot.buyRsiMax || 55) + 7)
    ) {
      rejectedReason = `rsi_reject:${feature.rsi}`;
    } else if (
      ai.risk_level === 'high' &&
      feature.rsi > 62 &&
      Number(feature.price5mChange || 0) < 0
    ) {
      rejectedReason = `risk_reject:${ai.risk_level}`;
    }

    if (rejectedReason) {
      await writeLog({
        market: feature.market,
        actionType: 'REJECTED',
        price: feature.latestPrice,
        rsiValue: feature.rsi,
        krwBalance,
        message: rejectedReason,
        rawJson: { feature, ai },
      });
      continue;
    }

    candidates.push({ feature, ai });
  }

  candidates.sort((a, b) => {
    const aScore = (a.ai.score * 0.7) + (getPreCandidateScore(a.feature) * 0.3);
    const bScore = (b.ai.score * 0.7) + (getPreCandidateScore(b.feature) * 0.3);
    return bScore - aScore;
  });

  if (!candidates.length) {
    await writeLog({
      market: 'SYSTEM',
      actionType: 'NO_CANDIDATE',
      krwBalance,
      message: '최종 진입 후보 없음',
    });
  } else {
    await writeLog({
      market: candidates[0].feature.market,
      actionType: 'TOP_CANDIDATE',
      price: candidates[0].feature.latestPrice,
      rsiValue: candidates[0].feature.rsi,
      krwBalance,
      message:
        `top score=${candidates[0].ai.score}` +
        `, action=${candidates[0].ai.action}` +
        `, risk=${candidates[0].ai.risk_level}`,
      rawJson: candidates[0],
    });
  }

  return candidates;
}

async function tryOpenPosition() {
  const position = await getOpenPosition();
  if (position) return;

  const accounts = await getAccounts();
  const krwBalance = findBalance(accounts, 'KRW');

  const candidates = await scanMarketsForEntry(accounts);

  if (!candidates.length) {
    return;
  }

  const target = candidates[0];
  const { feature, ai } = target;

  if (krwBalance <= config.bot.krwReserve) {
    await writeLog({
      market: feature.market,
      actionType: 'SKIP_BUY',
      price: feature.latestPrice,
      rsiValue: feature.rsi,
      krwBalance,
      message: 'KRW 잔고 부족 - 후보는 있으나 매수 불가',
      rawJson: { feature, ai },
    });
    return;
  }

  const chance = await getOrderChance(feature.market);
  const minBidTotal = Number(chance?.market?.bid?.min_total || 5000);

  const availableKrw = Math.floor(krwBalance - config.bot.krwReserve);
  const orderKrw = config.bot.maxBuyKrw > 0
    ? Math.min(availableKrw, config.bot.maxBuyKrw)
    : availableKrw;

  if (orderKrw < minBidTotal) {
    await writeLog({
      market: feature.market,
      actionType: 'SKIP_BUY',
      price: feature.latestPrice,
      rsiValue: feature.rsi,
      krwBalance,
      message: `최소 매수 금액 미만: ${orderKrw} < ${minBidTotal}`,
      rawJson: { chance, feature, ai },
    });
    return;
  }

  const orderResult = await marketBuy(feature.market, orderKrw);
  const estimatedVolume = orderKrw / feature.latestPrice;

  const executed = await getOrderExecutedAverage(
    orderResult.uuid,
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
    buyKrw: orderKrw,
    buyOrderUuid: orderResult.uuid || null,
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
    aiBuySummary: [...(ai.reasons || []), ...(ai.warnings || [])].join(' | '),
  });

  await writeLog({
    market: feature.market,
    actionType: 'BUY',
    price: buyPrice,
    rsiValue: feature.rsi,
    krwBalance,
    message:
      `${config.bot.dryRun ? '[DRY_RUN] ' : ''}` +
      `score=${ai.score}, risk=${ai.risk_level}, orderKrw=${orderKrw}` +
      `, softStop=${softStopPrice}, softTake=${softTakePrice}` +
      `, hardStop=${hardStopPrice}, hardTake=${hardTakePrice}`,
    rawJson: { feature, ai, orderResult, executed },
  });
}

async function forceClosePosition(position, currentPrice, coinBalance, reason, meta = {}) {
  const sellResult = await marketSell(position.market, coinBalance);
  const executed = await getOrderExecutedAverage(
    sellResult.uuid,
    currentPrice,
    coinBalance
  );

  const sellPrice = Number(executed.avgPrice || currentPrice);
  const sellVolume = Number(executed.volume || coinBalance);
  const sellKrw = sellPrice * sellVolume;
  const pnlPercent = getPnlPercent(Number(position.buy_price), sellPrice);

  await closePosition({
    positionId: position.id,
    sellPrice,
    sellVolume,
    sellKrw,
    sellOrderUuid: sellResult.uuid || null,
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
    rawJson: { sellResult, executed, meta },
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

function isAiHoldStillActive(position) {
  if (!position.ai_hold_until) return false;

  const now = nowSeoul();
  const until = new Date(position.ai_hold_until);

  if (Number.isNaN(until.getTime())) return false;
  return now < until;
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
  const holdMinutes = getHoldMinutes(position);

  const chance = await getOrderChance(position.market);
  const minAskTotal = Number(chance?.market?.ask?.min_total || 5000);
  const estimatedAskTotal = currentPrice * coinBalance;

  if (estimatedAskTotal < minAskTotal) {
    await writeLog({
      market: position.market,
      actionType: 'SELL_SKIP',
      price: currentPrice,
      rsiValue: feature.rsi,
      coinBalance,
      pnlPercent,
      message: `최소 매도 금액 미만: ${estimatedAskTotal} < ${minAskTotal}`,
    });
    return;
  }

  if (String(position.trailing_mode) === 'Y') {
    const closed = await handleTrailing(position, feature, coinBalance);
    if (closed) return;
  }

  const hardStopPrice = Number(position.hard_stop_price || 0);
  const hardTakePrice = Number(position.hard_take_price || 0);

  if (currentPrice <= hardStopPrice || pnlPercent <= -config.bot.hardStopPercent) {
    await forceClosePosition(
      position,
      currentPrice,
      coinBalance,
      'HARD_STOP',
      { pnlPercent, holdMinutes }
    );
    return;
  }

  if (currentPrice >= hardTakePrice || pnlPercent >= config.bot.hardTakePercent) {
    await forceClosePosition(
      position,
      currentPrice,
      coinBalance,
      'HARD_TAKE',
      { pnlPercent, holdMinutes }
    );
    return;
  }

  if (isAiHoldStillActive(position)) {
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

  const softStopHit =
    currentPrice <= Number(position.soft_stop_price || 0) ||
    pnlPercent <= -config.bot.softStopPercent;

  const softTakeHit =
    currentPrice >= Number(position.soft_take_price || 0) ||
    pnlPercent >= config.bot.softTakePercent;

  if (pnlPercent < config.bot.minHoldProfitPct && !softStopHit) {
    await writeLog({
      market: position.market,
      actionType: 'HOLD',
      price: currentPrice,
      rsiValue: feature.rsi,
      coinBalance,
      pnlPercent,
      message:
        `${config.bot.minHoldProfitPct}% 미만 보유 / holdMinutes=${holdMinutes}` +
        ` / pnl=${pnlPercent.toFixed(4)}`,
      rawJson: { feature },
    });
    return;
  }

  const sideways = isSidewaysMarket(feature);
  const sidewaysExitMinutes = getSidewaysExitMinutes(pnlPercent);

  if (
    pnlPercent >= config.bot.minHoldProfitPct &&
    !softTakeHit &&
    sideways &&
    holdMinutes >= sidewaysExitMinutes
  ) {
    await forceClosePosition(
      position,
      currentPrice,
      coinBalance,
      'SIDEWAYS_PROFIT_EXIT',
      {
        pnlPercent,
        holdMinutes,
        sidewaysExitMinutes,
        price5mChange: feature.price5mChange,
        price15mChange: feature.price15mChange,
        volatilityPct: feature.volatilityPct,
        volumeRatio: feature.volumeRatio,
      }
    );
    return;
  }

  let exitType = 'PROFIT_ZONE';
  if (softStopHit) exitType = 'STOP_ZONE';
  if (softTakeHit) exitType = 'TAKE_ZONE';

  const exitAi = await getExitDecision({
    type: exitType,
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
    highestPrice: Math.max(
      Number(position.highest_price || 0),
      currentPrice,
      Number(position.buy_price || 0)
    ),
    trailingMode: String(position.trailing_mode) === 'Y',
    holdMinutes,
  });

  if (exitType === 'STOP_ZONE') {
    const canExtend =
      exitAi &&
      exitAi.action === 'HOLD' &&
      exitAi.confidence >= 75 &&
      exitAi.risk_level !== 'high' &&
      Number(position.extend_count || 0) < config.bot.maxStopExtendCount;

    if (canExtend) {
      const holdMinutesByAi = Math.min(
        config.bot.maxStopExtendMinutes,
        Number(exitAi.max_hold_minutes || 0)
      );

      const holdUntil = plusMinutes(nowSeoul(), holdMinutesByAi || 1);

      await updatePositionMeta(position.id, {
        extend_count: Number(position.extend_count || 0) + 1,
        ai_hold_until: toMySqlDate(holdUntil),
      });

      await writeLog({
        market: position.market,
        actionType: 'STOP_EXTEND',
        price: currentPrice,
        rsiValue: feature.rsi,
        coinBalance,
        pnlPercent,
        message: `AI 연장보유 ${holdMinutesByAi}분 / ${exitAi.reason || ''}`,
        rawJson: exitAi,
      });
      return;
    }

    await forceClosePosition(
      position,
      currentPrice,
      coinBalance,
      'SOFT_STOP',
      {
        exitAi,
        pnlPercent,
        holdMinutes,
      }
    );
    return;
  }

  if (exitType === 'TAKE_ZONE') {
    const canTrail =
      exitAi &&
      exitAi.action === 'HOLD' &&
      exitAi.confidence >= 75 &&
      exitAi.risk_level === 'low';

    if (canTrail) {
      const trailingPct = clamp(
        Number(exitAi.trail_stop_percent || config.bot.trailingStopMin),
        config.bot.trailingStopMin,
        config.bot.trailingStopMax
      );

      const holdMinutesByAi = Math.min(
        config.bot.maxTakeExtendMinutes,
        Number(exitAi.max_hold_minutes || 0)
      );

      const holdUntil = plusMinutes(nowSeoul(), holdMinutesByAi || 1);

      await updatePositionMeta(position.id, {
        trailing_mode: 'Y',
        trailing_stop_percent: trailingPct,
        highest_price: Math.max(
          Number(position.highest_price || 0),
          currentPrice,
          Number(position.buy_price || 0)
        ),
        ai_hold_until: toMySqlDate(holdUntil),
      });

      await writeLog({
        market: position.market,
        actionType: 'TAKE_EXTEND',
        price: currentPrice,
        rsiValue: feature.rsi,
        coinBalance,
        pnlPercent,
        message: `AI 연장보유 / trailing=${trailingPct}% / ${exitAi.reason || ''}`,
        rawJson: exitAi,
      });
      return;
    }

    await forceClosePosition(
      position,
      currentPrice,
      coinBalance,
      'SOFT_TAKE',
      {
        exitAi,
        pnlPercent,
        holdMinutes,
      }
    );
    return;
  }

  if (exitAi && exitAi.action === 'SELL') {
    await forceClosePosition(
      position,
      currentPrice,
      coinBalance,
      'AI_PROFIT_TAKE',
      {
        exitAi,
        pnlPercent,
        holdMinutes,
      }
    );
    return;
  }

  if (exitAi && exitAi.action === 'HOLD') {
    await writeLog({
      market: position.market,
      actionType: 'AI_HOLD',
      price: currentPrice,
      rsiValue: feature.rsi,
      coinBalance,
      pnlPercent,
      message:
        `AI 보유 / pnl=${pnlPercent.toFixed(4)}` +
        ` / holdMinutes=${holdMinutes}` +
        ` / reason=${exitAi.reason || ''}`,
      rawJson: exitAi,
    });
    return;
  }

  await writeLog({
    market: position.market,
    actionType: 'HOLD',
    price: currentPrice,
    rsiValue: feature.rsi,
    coinBalance,
    pnlPercent,
    message: `중립 보유 / pnl=${pnlPercent.toFixed(4)} / holdMinutes=${holdMinutes}`,
    rawJson: {
      feature,
      exitAi,
    },
  });
}

module.exports = {
  tryOpenPosition,
  tryManageOpenPosition,
};
