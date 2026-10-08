import OpenAI from 'openai';
import { AssetType, Candle, SignalDecision, TechnicalIndicators, TradeSignal } from '../src/types.js';
import { BrokerContractSpecs, evaluateTradeRisk } from './riskManager.js';
import { calculateDynamicTakeProfits } from './tpEngine.js';
import { generateMultiStrategyCandidates, SetupCandidate } from './strategyEngine.js';
import { experienceMemoryEngine } from './experienceMemory.js';
import { validateTradeSignalCandidate, inferStrategyFamily } from './tradeQualityEngine.js';
import { partition1hCandles, partition15mCandles, partition5mCandles, partition1mCandles } from './candleUtils.js';

export const XAUUSD_TRADE_SIGNAL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    signal: {
      type: 'string',
      enum: ['BUY NOW', 'SELL NOW', 'BUY LIMIT', 'SELL LIMIT', 'NO TRADE'],
      description: 'القرار النهائي للصفقة'
    },
    entry: {
      type: 'number',
      description: 'سعر الدخول المقترح'
    },
    stopLoss: {
      type: 'number',
      description: 'مستوى وقف الخسارة الفني'
    },
    tp1: {
      type: 'number',
      description: 'الهدف الربحي الهيكلي الأول'
    },
    tp2: {
      type: 'number',
      description: 'الهدف الربحي الهيكلي الثاني إن وجد أو 0'
    },
    confidence: {
      type: 'number',
      description: 'نسبة الثقة الفنية من 0 إلى 100'
    },
    timeframe: {
      type: 'string',
      description: 'الفريم الزمني المعتمد للنموذج'
    },
    setup: {
      type: 'string',
      description: 'اسم النموذج أو الاستراتيجية المكتشفة'
    },
    mainReasons: {
      type: 'array',
      items: { type: 'string' },
      description: 'قائمة الأسباب الفنية للقرار'
    },
    invalidation: {
      type: 'string',
      description: 'شروط إلغاء الصفقة فنياً'
    },
    noTradeReason: {
      type: 'string',
      description: 'سبب عدم التداول في حال اختيار NO TRADE'
    }
  },
  required: ['signal', 'confidence', 'setup'],
  additionalProperties: false
} as const;

export function parseAndValidateAiResponse(rawContent: any): {
  signal: SignalDecision;
  entry?: number;
  stopLoss?: number;
  tp1?: number;
  tp2?: number;
  confidence: number;
  timeframe?: string;
  setup: string;
  mainReasons?: string[];
  invalidation?: string;
  noTradeReason?: string;
} {
  let parsed: any = null;
  if (typeof rawContent === 'object' && rawContent !== null) {
    parsed = rawContent;
  } else if (typeof rawContent === 'string') {
    const trimmed = rawContent.trim();
    const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } else {
    throw new Error('Non-parseable response content received from AI');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI response is not a valid JSON object');
  }

  if (!parsed.signal || typeof parsed.signal !== 'string') {
    throw new Error('Missing or invalid "signal" field in AI response');
  }

  const upperSignal = parsed.signal.toUpperCase().trim();
  const validSignals: SignalDecision[] = ['BUY NOW', 'SELL NOW', 'BUY LIMIT', 'SELL LIMIT', 'NO TRADE'];
  if (!validSignals.includes(upperSignal as SignalDecision)) {
    throw new Error(`Invalid signal value "${parsed.signal}" in AI response`);
  }

  const normalizedConfidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
    ? Math.min(100, Math.max(0, parsed.confidence))
    : 75;

  return {
    signal: upperSignal as SignalDecision,
    entry: typeof parsed.entry === 'number' && Number.isFinite(parsed.entry) ? parsed.entry : undefined,
    stopLoss: typeof parsed.stopLoss === 'number' && Number.isFinite(parsed.stopLoss) ? parsed.stopLoss : undefined,
    tp1: typeof parsed.tp1 === 'number' && Number.isFinite(parsed.tp1) ? parsed.tp1 : undefined,
    tp2: typeof parsed.tp2 === 'number' && Number.isFinite(parsed.tp2) ? parsed.tp2 : undefined,
    confidence: normalizedConfidence,
    timeframe: typeof parsed.timeframe === 'string' ? parsed.timeframe : '15M / 5M',
    setup: typeof parsed.setup === 'string' && parsed.setup.trim().length > 0 ? parsed.setup : 'GB-V5 Market Structure Setup',
    mainReasons: Array.isArray(parsed.mainReasons) ? parsed.mainReasons.map((r: any) => String(r)) : undefined,
    invalidation: typeof parsed.invalidation === 'string' ? parsed.invalidation : undefined,
    noTradeReason: typeof parsed.noTradeReason === 'string' ? parsed.noTradeReason : undefined,
  };
}

export interface AiProviderConfig {
  provider: 'openrouter' | 'nvidia' | 'none';
  apiKey: string;
  baseURL: string;
  model: string;
}

export function resolveAiProviderConfig(): AiProviderConfig {
  const isKeyValid = (key?: string | null): boolean => {
    if (!key) return false;
    const trimmed = key.trim();
    return (
      trimmed.length >= 10 &&
      trimmed !== 'MY_OPENROUTER_API_KEY' &&
      trimmed !== 'MY_NVIDIA_API_KEY' &&
      !trimmed.includes('YOUR_API_KEY')
    );
  };

  const openRouterKey = (process.env.OPENROUTER_API_KEY || '').trim();
  const nvidiaKey = (process.env.NVIDIA_API_KEY || '').trim();

  if (isKeyValid(openRouterKey)) {
    return {
      provider: 'openrouter',
      apiKey: openRouterKey,
      baseURL: 'https://openrouter.ai/api/v1',
      model: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite',
    };
  }

  if (isKeyValid(nvidiaKey)) {
    return {
      provider: 'nvidia',
      apiKey: nvidiaKey,
      baseURL: 'https://integrate.api.nvidia.com/v1',
      model: process.env.NVIDIA_MODEL || 'deepseek-ai/deepseek-v4-flash-0731',
    };
  }

  return {
    provider: 'none',
    apiKey: '',
    baseURL: '',
    model: '',
  };
}

let activeAiClientInstance: OpenAI | null = null;

export function getActiveAiClient(): { client: OpenAI; config: AiProviderConfig } | null {
  const config = resolveAiProviderConfig();
  if (config.provider === 'none' || !config.apiKey) {
    return null;
  }

  if (!activeAiClientInstance) {
    try {
      activeAiClientInstance = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        timeout: 10000,
        maxRetries: 0,
      });
    } catch {
      return null;
    }
  }

  return { client: activeAiClientInstance, config };
}

export function getOpenRouterClient(): OpenAI | null {
  const active = getActiveAiClient();
  return active ? active.client : null;
}

export interface MarketAnalysisInput {
  asset: AssetType;
  balance: number;
  currentPrice: number;
  indicators1h: TechnicalIndicators;
  indicators15m: TechnicalIndicators;
  indicators5m: TechnicalIndicators;
  recent5mCandles: Candle[];
  recent1mCandles: Candle[];
  candles1h?: Candle[];
  candles15m?: Candle[];
  losingStreak: number;
  brokerSpecs?: Partial<BrokerContractSpecs>;
  activeTradeDirection?: 'BUY' | 'SELL' | null;
  currentSpread?: number;
}

/**
 * GB-V5 Algorithmic Technical Engine
 */
export function algorithmicScreening(input: MarketAnalysisInput): {
  decision: SignalDecision;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  confidence: number;
  timeframe: string;
  setup: string;
  mainReasons: string[];
  invalidation: string;
  noTradeReason?: string;
  candidate?: SetupCandidate;
} {
  const candidateResult = generateMultiStrategyCandidates({
    asset: input.asset,
    balance: input.balance,
    currentPrice: input.currentPrice,
    indicators1h: input.indicators1h,
    indicators15m: input.indicators15m,
    indicators5m: input.indicators5m,
    candles1h: input.candles1h || [],
    candles15m: input.candles15m || [],
    candles5m: input.recent5mCandles || [],
    candles1m: input.recent1mCandles || [],
    losingStreak: input.losingStreak,
    brokerSpecs: input.brokerSpecs,
    activeTradeDirection: input.activeTradeDirection,
    currentSpread: input.currentSpread,
  });

  if (candidateResult.hasValidSignal && candidateResult.selectedCandidate) {
    const cand = candidateResult.selectedCandidate;
    const decision: SignalDecision = cand.direction === 'BUY'
      ? (cand.orderType === 'LIMIT' ? 'BUY LIMIT' : 'BUY NOW')
      : (cand.orderType === 'LIMIT' ? 'SELL LIMIT' : 'SELL NOW');

    return {
      decision,
      entry: cand.entry,
      stopLoss: cand.stopLoss,
      tp1: cand.tp1,
      tp2: cand.tp2,
      confidence: cand.confidence,
      timeframe: cand.timeframe,
      setup: cand.setupName,
      mainReasons: cand.mainReasons,
      invalidation: cand.invalidation,
      candidate: cand,
    };
  }

  return {
    decision: 'NO TRADE',
    entry: input.currentPrice,
    stopLoss: input.currentPrice,
    tp1: input.currentPrice,
    tp2: input.currentPrice,
    confidence: 0,
    timeframe: '15M / 5M',
    setup: 'NO TRADE (Waiting for GB-V5 setup)',
    mainReasons: [
      'السوق في حالة ترقب وتجميع دون اكتمال شروط تأكيد الكسر أو سحب السيولة',
      'نسبة المخاطرة إلى العائد الحالية لا تحقق معيار الأمان الفني المطلوب (R:R >= 1.5)',
    ],
    invalidation: 'تغير اتجاه الزخم وظهور نموذج GB-V5 متكامل',
    noTradeReason: 'لا توجد فرصة عالية الدقة مطابقة لشروط التداول',
  };
}

/**
 * GB-V5 Hybrid Orchestration Engine
 * Returns high-probability TradeSignal from algorithmic brain + AI enhancement.
 */
export async function runAIAnalysis(input: MarketAnalysisInput): Promise<TradeSignal> {
  const algoResult = algorithmicScreening(input);
  const brokerSpecs = input.brokerSpecs || {};

  // If algorithmic brain identified a setup, format into high-confidence TradeSignal
  if (algoResult.decision !== 'NO TRADE') {
    const riskEval = evaluateTradeRisk({
      accountBalance: input.balance,
      entryPrice: algoResult.entry,
      stopLossPrice: algoResult.stopLoss,
      brokerSpecs,
      riskPercent: 1.5,
    });

    const slDist = Math.abs(algoResult.entry - algoResult.stopLoss);
    const tp1Dist = Math.abs(algoResult.tp1 - algoResult.entry);
    const tp2Dist = Math.abs(algoResult.tp2 - algoResult.entry);
    const slPts = Math.round((slDist / 0.1) * 10) / 10;
    const tp1Pts = Math.round((tp1Dist / 0.1) * 10) / 10;
    const tp2Pts = Math.round((tp2Dist / 0.1) * 10) / 10;
    const tp1Rr = slDist > 0 ? Math.round((tp1Dist / slDist) * 100) / 100 : 1.5;
    const tp2Rr = slDist > 0 ? Math.round((tp2Dist / slDist) * 100) / 100 : 3.0;

    const signal: TradeSignal = {
      id: `sig_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: Date.now(),
      asset: input.asset,
      signal: algoResult.decision,
      currentPrice: input.currentPrice,
      entry: algoResult.entry,
      stopLoss: algoResult.stopLoss,
      slPoints: slPts,
      tp1: algoResult.tp1,
      tp1Points: tp1Pts,
      tp1Rr,
      tp1RrString: `1:${tp1Rr.toFixed(2)}`,
      tp2: algoResult.tp2,
      tp2Points: tp2Pts,
      tp2Rr,
      tp2RrString: `1:${tp2Rr.toFixed(2)}`,
      primaryTarget: 'TP1',
      rr: `TP1: 1:${tp1Rr.toFixed(2)} | TP2: 1:${tp2Rr.toFixed(2)}`,
      rrRatio: tp1Rr,
      riskPercent: riskEval.riskPercent,
      riskAmount: riskEval.riskDollars,
      potentialProfit: Math.round(riskEval.riskDollars * tp1Rr * 100) / 100,
      potentialLoss: riskEval.riskDollars,
      recommendedLotSize: riskEval.recommendedLotSize,
      confidence: algoResult.confidence,
      strategyConfidence: algoResult.confidence,
      executionQualityScore: algoResult.confidence,
      strategyFamily: inferStrategyFamily(algoResult.setup),
      timeframe: algoResult.timeframe,
      setup: algoResult.setup,
      mainReasons: algoResult.mainReasons,
      invalidation: algoResult.invalidation,
      isExecutable: riskEval.isExecutable,
      nonExecutableReason: riskEval.nonExecutableReason,
      positionSizing: {
        accountBalance: input.balance,
        riskPercent: riskEval.riskPercent,
        riskDollars: riskEval.riskDollars,
        entryPrice: algoResult.entry,
        stopLossPrice: algoResult.stopLoss,
        priceDistance: slDist,
        contractSizeOz: brokerSpecs.contractSizeOz ?? 100,
        riskPerStandardLot: riskEval.riskPerStandardLot,
        standardLotSize: riskEval.recommendedLotSize,
        miniLotSize: Math.round(riskEval.recommendedLotSize * 10 * 100) / 100,
        microLotSize: Math.round(riskEval.recommendedLotSize * 100 * 100) / 100,
        estimatedMaxLoss: riskEval.estimatedMaxLoss,
        isExecutable: riskEval.isExecutable,
        nonExecutableReason: riskEval.nonExecutableReason,
        minimumLot: brokerSpecs.minimumLot ?? 0.01,
        maximumLot: brokerSpecs.maximumLot ?? 100,
        lotStep: brokerSpecs.lotStep ?? 0.01,
      },
    };

    return signal;
  }

  // Otherwise return NO TRADE
  return {
    id: `sig_${Date.now()}_notrade`,
    timestamp: Date.now(),
    asset: input.asset,
    signal: 'NO TRADE',
    currentPrice: input.currentPrice,
    entry: input.currentPrice,
    stopLoss: input.currentPrice,
    slPoints: 0,
    tp1: input.currentPrice,
    tp1Points: 0,
    tp1Rr: 0,
    tp1RrString: '1:0.00',
    tp2: input.currentPrice,
    tp2Points: 0,
    tp2Rr: 0,
    tp2RrString: '1:0.00',
    primaryTarget: 'TP1',
    rr: '1:0.00',
    rrRatio: 0,
    riskPercent: 0,
    riskAmount: 0,
    potentialProfit: 0,
    potentialLoss: 0,
    recommendedLotSize: 0,
    confidence: 0,
    strategyConfidence: 0,
    executionQualityScore: 0,
    strategyFamily: 'MARKET_STRUCTURE',
    timeframe: '15M / 5M',
    setup: 'NO TRADE (Waiting for GB-V5 setup)',
    mainReasons: [
      'السوق في مرحلة تذبذب عرضي، ننتظر اكتمال سحب سيولة أو ارتداد واضح من منطقة قيمة',
      'لم يتم رصد كسر هيكلي مؤكد أو نموذج تداول عالي الاحتمالية',
    ],
    invalidation: 'تغير حركة السعر وظهور نموذج فني متكامل',
    noTradeReason: 'لا توجد فرصة مطابقة لشروط التداول الآمن',
  };
}
