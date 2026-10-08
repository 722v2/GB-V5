import OpenAI from 'openai';
import { AssetType, Candle, SignalDecision, TechnicalIndicators, TradeSignal, AppSettings } from '../src/types.js';
import { Gbv5EvidenceBundle } from './evidenceEngine.js';
import { Gbv5Candidate } from './gbv5Brain.js';

export interface AiDecisionRequest {
  asset: AssetType;
  currentPrice: number;
  balance: number;
  candles1m?: Candle[];
  candles5m: Candle[];
  candles15m: Candle[];
  candles1h: Candle[];
  indicators5m: TechnicalIndicators;
  indicators15m: TechnicalIndicators;
  indicators1h: TechnicalIndicators;
  candidates: Gbv5Candidate[];
  evidenceBundle: Gbv5EvidenceBundle;
  settings?: Partial<AppSettings>;
}

export interface AiDecisionResponse {
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
  providerUsed: string;
  modelUsed: string;
}

export class AiAdapter {
  /**
   * Executes AI analysis using user-configured provider and model at runtime.
   */
  public async analyze(request: AiDecisionRequest): Promise<AiDecisionResponse> {
    const provider = request.settings?.aiProvider || process.env.AI_PROVIDER || '';
    const model = request.settings?.aiModel || process.env.AI_MODEL || '';

    // API Key is read from environment secrets
    const apiKey = process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || process.env.AI_API_KEY;

    // If Provider, Model, or API Key is not configured, execute intentional autonomous GB-V5 engine path
    if (!provider || !model || !apiKey) {
      // Clean autonomous fallback using GB-V5 candidate arbitration
      const best = request.candidates.length > 0 ? request.candidates[0] : null;
      if (best) {
        return {
          signal: best.direction === 'BUY' ? 'BUY NOW' : 'SELL NOW',
          entry: best.entry,
          stopLoss: best.stopLoss,
          tp1: best.tp1,
          tp2: best.tp2,
          confidence: best.confidence,
          timeframe: best.timeframe,
          setup: best.setupName,
          mainReasons: best.mainReasons,
          invalidation: best.invalidation,
          providerUsed: provider || 'AUTONOMOUS_GBV5_ENGINE',
          modelUsed: model || 'DETERMINISTIC_EVIDENCE_MODEL',
        };
      }
      return {
        signal: 'NO TRADE',
        confidence: 0,
        setup: 'No Setup',
        noTradeReason: !provider || !model
          ? 'AI Provider or Model not configured; deterministic GB-V5 found no viable setup'
          : 'No viable GB-V5 candidate discovered',
        providerUsed: provider || 'AUTONOMOUS_GBV5_ENGINE',
        modelUsed: model || 'DETERMINISTIC_EVIDENCE_MODEL',
      };
    }

    try {
      const client = new OpenAI({
        apiKey,
        baseURL: process.env.AI_BASE_URL || undefined,
      });

      const prompt = `You are the GB-V5 Gold Trading Intelligence.
Evaluate the current market state and candidates for XAU/USD.
Current Price: ${request.currentPrice}
Candidates: ${JSON.stringify(request.candidates.map(c => ({ family: c.family, name: c.setupName, dir: c.direction, entry: c.entry, sl: c.stopLoss, tp1: c.tp1, conf: c.confidence })))}
Return a JSON object with: { "signal": "BUY NOW" | "SELL NOW" | "NO TRADE", "entry": number, "stopLoss": number, "tp1": number, "tp2": number, "confidence": number, "setup": string, "mainReasons": string[], "invalidation": string }`;

      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(content);

      return {
        signal: parsed.signal || 'NO TRADE',
        entry: parsed.entry || request.currentPrice,
        stopLoss: parsed.stopLoss || (parsed.signal?.includes('BUY') ? request.currentPrice - 4 : request.currentPrice + 4),
        tp1: parsed.tp1 || (parsed.signal?.includes('BUY') ? request.currentPrice + 6 : request.currentPrice - 6),
        tp2: parsed.tp2 || 0,
        confidence: parsed.confidence || 75,
        timeframe: 'M1 / M5',
        setup: parsed.setup || 'GB-V5 AI Setup',
        mainReasons: parsed.mainReasons || ['AI Analysis Concurrence'],
        invalidation: parsed.invalidation || 'Break of structural boundary',
        providerUsed: provider,
        modelUsed: model,
      };
    } catch {
      // Resilient fallback to deterministic candidate selection
      const best = request.candidates.length > 0 ? request.candidates[0] : null;
      if (best) {
        return {
          signal: best.direction === 'BUY' ? 'BUY NOW' : 'SELL NOW',
          entry: best.entry,
          stopLoss: best.stopLoss,
          tp1: best.tp1,
          tp2: best.tp2,
          confidence: best.confidence,
          timeframe: best.timeframe,
          setup: best.setupName,
          mainReasons: best.mainReasons,
          invalidation: best.invalidation,
          providerUsed: provider,
          modelUsed: model,
        };
      }
      return {
        signal: 'NO TRADE',
        confidence: 0,
        setup: 'No Setup',
        noTradeReason: 'No viable trade setup',
        providerUsed: provider,
        modelUsed: model,
      };
    }
  }
}

export const globalAiAdapter = new AiAdapter();
