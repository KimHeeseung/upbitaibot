const OpenAI = require('openai');
const config = require('./config');

const client = new OpenAI({
  apiKey: config.openai.apiKey,
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

function validateEntryDecision(data) {
  if (!data || typeof data !== 'object') return false;
  const actionOk = ['BUY', 'HOLD', 'AVOID'].includes(data.action);
  const riskOk = ['low', 'medium', 'high'].includes(data.risk_level);
  return actionOk && riskOk && typeof data.score === 'number';
}

function validateExitDecision(data) {
  if (!data || typeof data !== 'object') return false;
  const actionOk = ['SELL', 'HOLD'].includes(data.action);
  const riskOk = ['low', 'medium', 'high'].includes(data.risk_level);
  return actionOk && riskOk && typeof data.confidence === 'number';
}

async function getEntryDecision(feature) {
  const messages = [
    {
      role: 'developer',
      content:
        '너는 암호화폐 단기매매 보조 분석기다. 반드시 JSON만 반환한다. 공격적 추격매수보다 리스크 관리 우선.',
    },
    {
      role: 'user',
      content: `
아래 입력을 보고 신규 진입 판단을 내려라.

규칙:
- BUY / HOLD / AVOID 중 하나를 반환
- score는 0~100
- risk_level은 low / medium / high
- 급등 추격은 감점
- 거래량 증가, 과매도 반등, 단기 추세 회복은 가점
- 애매하면 HOLD 또는 AVOID
- 변동성이 과도하면 보수적으로 판단

입력:
${JSON.stringify(feature)}
      `.trim(),
    },
  ];

  const response = await client.chat.completions.create({
    model: config.openai.model,
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'entry_decision',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            market_regime: { type: 'string' },
            action: { type: 'string', enum: ['BUY', 'HOLD', 'AVOID'] },
            score: { type: 'number' },
            risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
            reasons: {
              type: 'array',
              items: { type: 'string' },
            },
            warnings: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: [
            'market_regime',
            'action',
            'score',
            'risk_level',
            'reasons',
            'warnings',
          ],
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content ?? '{}';
  const parsed = safeJsonParse(content);

  if (!validateEntryDecision(parsed)) {
    return {
      market_regime: feature.regime || 'unknown',
      action: 'AVOID',
      score: 0,
      risk_level: 'high',
      reasons: ['invalid_ai_response'],
      warnings: ['json_validation_failed'],
    };
  }

  parsed.score = clamp(Number(parsed.score), 0, 100);
  return parsed;
}

async function getExitDecision(input) {
  const messages = [
    {
      role: 'developer',
      content:
        '너는 암호화폐 포지션 청산 보조 분석기다. 반드시 JSON만 반환한다. 손절 구간에서는 매우 보수적으로 판단한다.',
    },
    {
      role: 'user',
      content: `
현재 포지션 청산 판단을 내려라.

규칙:
- action은 SELL 또는 HOLD
- confidence는 0~100
- STOP_ZONE에서는 위험하면 빠르게 SELL
- TAKE_ZONE에서는 추세가 강하면 HOLD 허용
- PROFIT_ZONE에서는 무리한 조기매도 지양
- HOLD를 주더라도 max_hold_minutes는 보수적으로
- trail_stop_percent는 0~3 숫자
- reason은 짧고 명확하게

입력:
${JSON.stringify(input)}
      `.trim(),
    },
  ];

  const response = await client.chat.completions.create({
    model: config.openai.model,
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'exit_decision',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['SELL', 'HOLD'] },
            confidence: { type: 'number' },
            risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
            reason: { type: 'string' },
            max_hold_minutes: { type: 'number' },
            trail_stop_percent: { type: 'number' },
          },
          required: [
            'action',
            'confidence',
            'risk_level',
            'reason',
            'max_hold_minutes',
            'trail_stop_percent',
          ],
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content ?? '{}';
  const parsed = safeJsonParse(content);

  if (!validateExitDecision(parsed)) {
    return {
      action: 'SELL',
      confidence: 0,
      risk_level: 'high',
      reason: 'invalid_ai_response',
      max_hold_minutes: 0,
      trail_stop_percent: 0,
    };
  }

  parsed.confidence = clamp(Number(parsed.confidence), 0, 100);
  parsed.max_hold_minutes = clamp(Number(parsed.max_hold_minutes || 0), 0, 60);
  parsed.trail_stop_percent = clamp(Number(parsed.trail_stop_percent || 0), 0, 3);

  return parsed;
}

module.exports = {
  getEntryDecision,
  getExitDecision,
};
