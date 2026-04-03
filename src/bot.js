const config = require('./config');
const { writeLog, getOpenPosition } = require('./db');
const { tryOpenPosition, tryManageOpenPosition } = require('./trader');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function oneCycle() {
  const openPosition = await getOpenPosition();

  if (openPosition) {
    await tryManageOpenPosition();
  } else {
    await tryOpenPosition();
  }
}

async function start() {
  if (!config.binance.apiKey || !config.binance.secretKey) {
    throw new Error('BINANCE_API_KEY / BINANCE_SECRET_KEY 확인 필요');
  }
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY 확인 필요');
  }

  console.log('=== Binance AI Spot Trader Start ===');
  console.log('MARKETS:', config.bot.markets.join(', '));
  console.log('QUOTE_ASSET:', config.bot.quoteAsset);
  console.log('DRY_RUN:', config.bot.dryRun);
  console.log('LOOP_SECONDS:', config.bot.loopSeconds);

  await writeLog({
    market: 'SYSTEM',
    actionType: 'START',
    message: `bot started / dryRun=${config.bot.dryRun}`,
  });

  while (true) {
    try {
      await oneCycle();
    } catch (err) {
      const message = err.response
        ? JSON.stringify(err.response.data)
        : err.message;

      console.error('[ERROR]', message);

      try {
        await writeLog({
          market: 'SYSTEM',
          actionType: 'ERROR',
          message,
        });
      } catch (logErr) {
        console.error('[LOG ERROR]', logErr.message);
      }
    }

    await sleep(config.bot.loopSeconds * 1000);
  }
}

start();