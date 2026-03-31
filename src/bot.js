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
  if (config.exchange === 'bithumb') {
    if (!config.bithumb.accessKey || !config.bithumb.secretKey) {
      throw new Error('BITHUMB_ACCESS_KEY / BITHUMB_SECRET_KEY 확인 필요');
    }
  } else {
    if (!config.upbit.accessKey || !config.upbit.secretKey) {
      throw new Error('UPBIT_ACCESS_KEY / UPBIT_SECRET_KEY 확인 필요');
    }
  }

  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY 확인 필요');
  }

  console.log('=== AI Hybrid Trader Start ===');
  console.log('EXCHANGE:', config.exchange);
  console.log('MARKETS:', config.bot.markets.join(', '));
  console.log('DRY_RUN:', config.bot.dryRun);
  console.log('LOOP_SECONDS:', config.bot.loopSeconds);

  await writeLog({
    market: 'SYSTEM',
    actionType: 'START',
    message: `bot started / exchange=${config.exchange} / dryRun=${config.bot.dryRun}`,
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

start().catch(async (err) => {
  console.error('[FATAL]', err.message);

  try {
    await writeLog({
      market: 'SYSTEM',
      actionType: 'FATAL',
      message: err.message,
    });
  } catch (logErr) {
    console.error('[FATAL LOG ERROR]', logErr.message);
  }

  process.exit(1);
});