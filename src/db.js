const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.connLimit,
  timezone: '+09:00',
});

async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function execute(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

async function writeLog({
  market,
  actionType,
  price = null,
  rsiValue = null,
  krwBalance = null,
  coinBalance = null,
  pnlPercent = null,
  message = '',
  rawJson = null,
}) {
  const sql = `
    INSERT INTO trade_log
      (market, action_type, price, rsi_value, krw_balance, coin_balance, pnl_percent, message, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  await execute(sql, [
    market,
    actionType,
    price,
    rsiValue,
    krwBalance,
    coinBalance,
    pnlPercent,
    message,
    rawJson ? JSON.stringify(rawJson) : null,
  ]);
}

async function getOpenPosition() {
  const sql = `
    SELECT *
    FROM trade_position
    WHERE status = 'OPEN'
    ORDER BY id DESC
    LIMIT 1
  `;
  const rows = await query(sql);
  return rows.length ? rows[0] : null;
}

async function openPosition(data) {
  const sql = `
    INSERT INTO trade_position
    (
      market, status,
      buy_price, buy_volume, buy_krw, buy_order_uuid,
      soft_stop_price, soft_take_price, hard_stop_price, hard_take_price,
      trailing_mode, trailing_stop_percent, highest_price,
      extend_count, ai_hold_until,
      ai_buy_score, ai_buy_risk, ai_buy_regime, ai_buy_summary
    )
    VALUES
    (
      ?, 'OPEN',
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?
    )
  `;
  return execute(sql, [
    data.market,
    data.buyPrice,
    data.buyVolume,
    data.buyKrw,
    data.buyOrderUuid || null,
    data.softStopPrice,
    data.softTakePrice,
    data.hardStopPrice,
    data.hardTakePrice,
    data.trailingMode || 'N',
    data.trailingStopPercent || null,
    data.highestPrice,
    data.extendCount || 0,
    data.aiHoldUntil || null,
    data.aiBuyScore || null,
    data.aiBuyRisk || null,
    data.aiBuyRegime || null,
    data.aiBuySummary || null,
  ]);
}

async function updatePositionMeta(positionId, patch) {
  const fields = [];
  const values = [];

  const allowed = [
    'trailing_mode',
    'trailing_stop_percent',
    'highest_price',
    'extend_count',
    'ai_hold_until',
    'soft_stop_price',
    'soft_take_price',
    'hard_stop_price',
    'hard_take_price',
  ];

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      fields.push(`${key} = ?`);
      values.push(patch[key]);
    }
  }

  if (!fields.length) return;

  values.push(positionId);

  const sql = `
    UPDATE trade_position
    SET ${fields.join(', ')}
    WHERE id = ?
  `;
  await execute(sql, values);
}

async function closePosition({
  positionId,
  sellPrice,
  sellVolume,
  sellKrw,
  sellOrderUuid = null,
  pnlPercent,
  closeReason,
}) {
  const sql = `
    UPDATE trade_position
    SET
      status = 'CLOSED',
      sell_price = ?,
      sell_volume = ?,
      sell_krw = ?,
      sell_order_uuid = ?,
      pnl_percent = ?,
      close_reason = ?,
      closed_at = NOW()
    WHERE id = ?
  `;
  return execute(sql, [
    sellPrice,
    sellVolume,
    sellKrw,
    sellOrderUuid,
    pnlPercent,
    closeReason,
    positionId,
  ]);
}

module.exports = {
  pool,
  query,
  execute,
  writeLog,
  getOpenPosition,
  openPosition,
  updatePositionMeta,
  closePosition,
};