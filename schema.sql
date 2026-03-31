CREATE TABLE IF NOT EXISTS trade_position (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    market VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',

    buy_price DECIMAL(20,8) NOT NULL,
    buy_volume DECIMAL(30,16) NOT NULL,
    buy_krw DECIMAL(20,2) NOT NULL,
    buy_order_uuid VARCHAR(100) DEFAULT NULL,

    soft_stop_price DECIMAL(20,8) NOT NULL,
    soft_take_price DECIMAL(20,8) NOT NULL,
    hard_stop_price DECIMAL(20,8) NOT NULL,
    hard_take_price DECIMAL(20,8) NOT NULL,

    trailing_mode CHAR(1) NOT NULL DEFAULT 'N',
    trailing_stop_percent DECIMAL(10,4) DEFAULT NULL,
    highest_price DECIMAL(20,8) DEFAULT NULL,

    extend_count INT NOT NULL DEFAULT 0,
    ai_hold_until DATETIME DEFAULT NULL,

    sell_price DECIMAL(20,8) DEFAULT NULL,
    sell_volume DECIMAL(30,16) DEFAULT NULL,
    sell_krw DECIMAL(20,2) DEFAULT NULL,
    sell_order_uuid VARCHAR(100) DEFAULT NULL,
    pnl_percent DECIMAL(10,4) DEFAULT NULL,
    close_reason VARCHAR(50) DEFAULT NULL,

    ai_buy_score INT DEFAULT NULL,
    ai_buy_risk VARCHAR(20) DEFAULT NULL,
    ai_buy_regime VARCHAR(30) DEFAULT NULL,
    ai_buy_summary TEXT DEFAULT NULL,

    opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME DEFAULT NULL,

    KEY idx_trade_position_status (status),
    KEY idx_trade_position_market (market)
);

CREATE TABLE IF NOT EXISTS trade_log (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    market VARCHAR(20) NOT NULL,
    action_type VARCHAR(30) NOT NULL,
    price DECIMAL(20,8) DEFAULT NULL,
    rsi_value DECIMAL(10,4) DEFAULT NULL,
    krw_balance DECIMAL(20,2) DEFAULT NULL,
    coin_balance DECIMAL(30,16) DEFAULT NULL,
    pnl_percent DECIMAL(10,4) DEFAULT NULL,
    message TEXT,
    raw_json JSON DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_trade_log_market (market),
    KEY idx_trade_log_action (action_type),
    KEY idx_trade_log_created_at (created_at)
);