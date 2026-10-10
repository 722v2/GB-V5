import { getActiveAiClient, XAUUSD_TRADE_SIGNAL_JSON_SCHEMA, parseAndValidateAiResponse } from '../server/geminiTrader.js';
import { validateTradeSignalCandidate } from '../server/tradeQualityEngine.js';
import { generateMultiStrategyCandidates } from '../server/strategyEngine.js';
import { analyzeTechnicals } from '../server/indicators.js';
import { Candle, AssetType, TechnicalIndicators } from '../src/types.js';

export interface BenchmarkScenario {
  id: number;
  lang: 'AR' | 'EN';
  category: string;
  price: number;
  expectedBias: 'BUY' | 'SELL' | 'NO TRADE';
  generateData: () => {
    candles1h: Candle[];
    candles15m: Candle[];
    candles5m: Candle[];
    candles1m: Candle[];
    indicators1h: TechnicalIndicators;
    indicators15m: TechnicalIndicators;
    indicators5m: TechnicalIndicators;
  };
}

// Helpers to make synthetic candle series
function buildCandles(basePrice: number, count: number, step: number, noise: number = 0.2): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  let p = basePrice;
  for (let i = count; i >= 1; i--) {
    const o = p;
    p += step + (Math.sin(i) * noise);
    const c = p;
    const h = Math.max(o, c) + Math.abs(noise * 1.2);
    const l = Math.min(o, c) - Math.abs(noise * 1.2);
    candles.push({
      timestamp: now - i * 300000,
      open: Number(o.toFixed(2)),
      high: Number(h.toFixed(2)),
      low: Number(l.toFixed(2)),
      close: Number(c.toFixed(2)),
      volume: 1000 + Math.round(Math.abs(Math.sin(i) * 500)),
    });
  }
  return candles;
}

const scenarioTypes = [
  'Bullish Order Block retest',
  'Bearish Order Block retest',
  'Bullish liquidity sweep / SFP',
  'Bearish liquidity sweep / SFP',
  'Bullish FVG + Order Block confluence',
  'Bearish FVG + Order Block confluence',
  'EMA20 bullish pullback',
  'EMA20 bearish pullback',
  'Bullish trend continuation',
  'Bearish trend continuation',
  'Double bottom',
  'Double top',
  'Bull trap / false bullish breakout',
  'Bear trap / false bearish breakout',
  'Multi-timeframe bullish structure',
  'Multi-timeframe bearish structure',
  'Conflicting H1/M15/M5 structure',
  'Sideways equilibrium',
  'Low-volatility condition',
  'No-liquidity / no-confirmation condition',
];

export function generate100Scenarios(): BenchmarkScenario[] {
  const scenarios: BenchmarkScenario[] = [];
  let id = 1;

  for (let catIdx = 0; catIdx < 20; catIdx++) {
    const catName = scenarioTypes[catIdx];
    // 5 scenarios per category = 100 scenarios total
    for (let sub = 0; sub < 5; sub++) {
      const isArabic = (id <= 60); // 60 Arabic, 40 English
      const basePrice = 2500 + (catIdx * 12) + (sub * 4);
      
      let expectedBias: 'BUY' | 'SELL' | 'NO TRADE' = 'NO TRADE';
      let trendDir: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';

      switch (catIdx) {
        case 0: // Bullish OB
        case 2: // Bullish sweep / SFP
        case 4: // Bullish FVG+OB
        case 6: // EMA20 bull pullback
        case 8: // Bull trend continuation
        case 10: // Double bottom
        case 14: // MTF Bullish
          expectedBias = 'BUY';
          trendDir = 'BULLISH';
          break;
        case 1: // Bearish OB
        case 3: // Bearish sweep / SFP
        case 5: // Bearish FVG+OB
        case 7: // EMA20 bear pullback
        case 9: // Bear trend continuation
        case 11: // Double top
        case 15: // MTF Bearish
          expectedBias = 'SELL';
          trendDir = 'BEARISH';
          break;
        default:
          expectedBias = 'NO TRADE';
          trendDir = 'NEUTRAL';
          break;
      }

      const scenPrice = basePrice;
      const scenCat = catName;
      const scenId = id;
      const currentCatIdx = catIdx;
      const currentExpectedBias = expectedBias;

      scenarios.push({
        id: scenId,
        lang: isArabic ? 'AR' : 'EN',
        category: scenCat,
        price: scenPrice,
        expectedBias: currentExpectedBias,
        generateData: () => {
          const now = Date.now();
          const p = scenPrice;
          
          let candles1h: Candle[];
          let candles15m: Candle[];
          let candles5m: Candle[];
          let candles1m: Candle[];

          let ind1h: TechnicalIndicators;
          let ind15m: TechnicalIndicators;
          let ind5m: TechnicalIndicators;

          if (currentExpectedBias === 'BUY') {
            // Price is currently at the retest / POI level (p)
            candles1h = buildCandles(p - 5, 35, 0.15, 0.25);
            candles15m = buildCandles(p - 2, 40, 0.05, 0.15);
            candles5m = buildCandles(p - 0.2, 45, 0.0, 0.08);
            candles1m = buildCandles(p - 0.05, 50, 0.0, 0.04);

            ind1h = {
              rsi14: 55,
              macd: { macd: 0.6, signal: 0.2, histogram: 0.4 },
              ema20: p - 0.8,
              ema50: p - 2.5,
              ema200: p - 6.0,
              vwap: p - 0.3,
              atr14: 1.8,
              bollingerBands: { upper: p + 6.0, middle: p, lower: p - 6.0 },
              swingHigh: p + 8.0,
              swingLow: p - 4.5,
              support: p - 4.2,
              resistance: p + 8.0,
              marketRegime: 'STRONG_UPTREND',
              structure: 'BULLISH',
              liquidityLevels: { buySideLiquidity: p + 9.0, sellSideLiquidity: p - 5.0 },
            };

            ind15m = {
              rsi14: 53,
              macd: { macd: 0.4, signal: 0.15, histogram: 0.25 },
              ema20: p - 0.5,
              ema50: p - 1.8,
              ema200: p - 4.0,
              vwap: p - 0.1,
              atr14: 1.5,
              bollingerBands: { upper: p + 5.0, middle: p, lower: p - 5.0 },
              swingHigh: p + 6.0,
              swingLow: p - 4.2,
              support: p - 4.0,
              resistance: p + 6.5,
              marketRegime: 'STRONG_UPTREND',
              structure: 'BULLISH',
              structureShift: currentCatIdx === 2 ? 'BULLISH_MSS' : 'None',
              orderBlock: { type: 'BULLISH', low: p - 4.5, high: p + 0.2 },
              fvg: { type: 'BULLISH', bottom: p - 3.8, top: p + 0.1 },
              liquidityLevels: { buySideLiquidity: p + 6.5, sellSideLiquidity: p - 4.5 },
              liquiditySweepDetected: currentCatIdx === 2,
            };

            ind5m = {
              rsi14: 52,
              macd: { macd: 0.2, signal: 0.1, histogram: 0.1 },
              ema20: p - 0.3,
              ema50: p - 1.0,
              ema200: p - 2.5,
              vwap: p,
              atr14: 1.2,
              bollingerBands: { upper: p + 3.0, middle: p, lower: p - 3.0 },
              swingHigh: p + 4.0,
              swingLow: p - 4.2,
              support: p - 4.0,
              resistance: p + 4.5,
              marketRegime: 'STRONG_UPTREND',
              structure: 'BULLISH',
              liquidityLevels: { buySideLiquidity: p + 4.5, sellSideLiquidity: p - 4.2 },
            };
          } else if (currentExpectedBias === 'SELL') {
            // Price is currently at the retest / POI level (p)
            candles1h = buildCandles(p + 5, 35, -0.15, 0.25);
            candles15m = buildCandles(p + 2, 40, -0.05, 0.15);
            candles5m = buildCandles(p + 0.2, 45, 0.0, 0.08);
            candles1m = buildCandles(p + 0.05, 50, 0.0, 0.04);

            ind1h = {
              rsi14: 45,
              macd: { macd: -0.6, signal: -0.2, histogram: -0.4 },
              ema20: p + 0.8,
              ema50: p + 2.5,
              ema200: p + 6.0,
              vwap: p + 0.3,
              atr14: 1.8,
              bollingerBands: { upper: p + 6.0, middle: p, lower: p - 6.0 },
              swingHigh: p + 4.5,
              swingLow: p - 8.0,
              support: p - 8.0,
              resistance: p + 4.2,
              marketRegime: 'STRONG_DOWNTREND',
              structure: 'BEARISH',
              liquidityLevels: { buySideLiquidity: p + 5.0, sellSideLiquidity: p - 9.0 },
            };

            ind15m = {
              rsi14: 47,
              macd: { macd: -0.4, signal: -0.15, histogram: -0.25 },
              ema20: p + 0.5,
              ema50: p + 1.8,
              ema200: p + 4.0,
              vwap: p + 0.1,
              atr14: 1.5,
              bollingerBands: { upper: p + 5.0, middle: p, lower: p - 5.0 },
              swingHigh: p + 4.2,
              swingLow: p - 6.0,
              support: p - 6.5,
              resistance: p + 4.0,
              marketRegime: 'STRONG_DOWNTREND',
              structure: 'BEARISH',
              structureShift: currentCatIdx === 3 ? 'BEARISH_MSS' : 'None',
              orderBlock: { type: 'BEARISH', low: p - 0.2, high: p + 4.5 },
              fvg: { type: 'BEARISH', bottom: p - 0.1, top: p + 3.8 },
              liquidityLevels: { buySideLiquidity: p + 4.5, sellSideLiquidity: p - 6.5 },
              liquiditySweepDetected: currentCatIdx === 3,
            };

            ind5m = {
              rsi14: 48,
              macd: { macd: -0.2, signal: -0.1, histogram: -0.1 },
              ema20: p + 0.3,
              ema50: p + 1.0,
              ema200: p + 2.5,
              vwap: p,
              atr14: 1.2,
              bollingerBands: { upper: p + 3.0, middle: p, lower: p - 3.0 },
              swingHigh: p + 4.2,
              swingLow: p - 4.0,
              support: p - 4.5,
              resistance: p + 4.0,
              marketRegime: 'STRONG_DOWNTREND',
              structure: 'BEARISH',
              liquidityLevels: { buySideLiquidity: p + 4.2, sellSideLiquidity: p - 4.5 },
            };
          } else {
            // NO TRADE categories
            const isConflicting = (currentCatIdx === 16);
            const isLowVol = (currentCatIdx === 18);
            const isTrap = (currentCatIdx === 12 || currentCatIdx === 13);

            candles1h = buildCandles(p, 35, 0.02, 0.2);
            candles15m = buildCandles(p, 40, -0.01, 0.15);
            candles5m = buildCandles(p, 45, 0.01, 0.1);
            candles1m = buildCandles(p, 50, 0.0, 0.05);

            ind1h = {
              rsi14: isTrap ? 72 : 50,
              macd: { macd: 0.1, signal: 0.1, histogram: 0.0 },
              ema20: p,
              ema50: p,
              ema200: p,
              vwap: p,
              atr14: isLowVol ? 0.4 : 1.5,
              bollingerBands: { upper: p + 3.0, middle: p, lower: p - 3.0 },
              swingHigh: p + 4.0,
              swingLow: p - 4.0,
              support: p - 4.0,
              resistance: p + 4.0,
              marketRegime: isConflicting ? 'STRONG_UPTREND' : (isTrap ? 'VOLATILE_RANGE' : 'NORMAL_RANGE'),
              structure: isConflicting ? 'BULLISH' : 'RANGING',
              liquidityLevels: { buySideLiquidity: p + 4.0, sellSideLiquidity: p - 4.0 },
            };

            ind15m = {
              rsi14: isTrap ? 75 : 50,
              macd: { macd: 0.05, signal: 0.05, histogram: 0.0 },
              ema20: p,
              ema50: p,
              ema200: p,
              vwap: p,
              atr14: isLowVol ? 0.3 : 1.2,
              bollingerBands: { upper: p + 2.0, middle: p, lower: p - 2.0 },
              swingHigh: p + 3.0,
              swingLow: p - 3.0,
              support: p - 3.0,
              resistance: p + 3.0,
              marketRegime: isConflicting ? 'STRONG_DOWNTREND' : (isTrap ? 'TRANSITION' : 'NORMAL_RANGE'),
              structure: isConflicting ? 'BEARISH' : 'RANGING',
              liquidityLevels: { buySideLiquidity: p + 3.0, sellSideLiquidity: p - 3.0 },
            };

            ind5m = {
              rsi14: 50,
              macd: { macd: 0.0, signal: 0.0, histogram: 0.0 },
              ema20: p,
              ema50: p,
              ema200: p,
              vwap: p,
              atr14: isLowVol ? 0.2 : 0.8,
              bollingerBands: { upper: p + 1.5, middle: p, lower: p - 1.5 },
              swingHigh: p + 2.0,
              swingLow: p - 2.0,
              support: p - 2.0,
              resistance: p + 2.0,
              marketRegime: 'NORMAL_RANGE',
              structure: 'RANGING',
              liquidityLevels: { buySideLiquidity: p + 2.0, sellSideLiquidity: p - 2.0 },
            };
          }

          return {
            candles1h,
            candles15m,
            candles5m,
            candles1m,
            indicators1h: ind1h,
            indicators15m: ind15m,
            indicators5m: ind5m,
          };
        }
      });

      id++;
    }
  }

  return scenarios;
}

export interface ScenarioResultRow {
  scenarioNum: number;
  lang: 'AR' | 'EN';
  category: string;
  aiSignal: string;
  entry: number;
  rawSl: number;
  slPoints: number;
  slValid: boolean;
  tp1: number;
  tp2: number;
  tp1Rr: string;
  confidence: number;
  setup: string;
  validatorResult: 'VALID' | 'REJECTED' | 'N/A (NO TRADE)';
  fallback: boolean;
  rejectionReason: string;
  latencyMs: number;
  isOversizedSl: boolean;
  isUndersizedSl: boolean;
  isSpecificOversizedSlPattern: boolean;
}

export async function runScenario(scenario: BenchmarkScenario, ai: any): Promise<ScenarioResultRow> {
  const { candles1h, candles15m, candles5m, candles1m, indicators1h, indicators15m, indicators5m } = scenario.generateData();
  const currentPrice = candles5m[candles5m.length - 1].close;

  const brokerSpecs = {
    minSlPoints: 35,
    maxSlPoints: 65,
    minRr: 1.0,
    contractSizeOz: 100,
    minimumLot: 0.01,
    maxLoss: 5.0,
  };

  const candidatesContext = generateMultiStrategyCandidates({
    asset: 'XAU/USD',
    balance: 50,
    currentPrice,
    indicators1h,
    indicators15m,
    indicators5m,
    candles1h,
    candles15m,
    candles5m,
    candles1m,
    losingStreak: 0,
    brokerSpecs,
  });

  const technicalContext = {
    asset: 'XAUUSD',
    balance: 50,
    currentPrice,
    detectedCandidatesCount: candidatesContext.allCandidates.length,
    topCandidates: candidatesContext.allCandidates.slice(0, 3).map((c) => ({
      family: c.strategyFamily,
      name: c.setupName,
      direction: c.direction,
      orderType: c.orderType,
      entry: c.entry,
      stopLoss: c.stopLoss,
      slPoints: c.slPoints,
      tp1: c.tp1,
      tp1Rr: c.tp1Rr,
      confidence: c.confidence,
      score: c.score,
    })),
    h1: {
      trend: indicators1h.structure,
      ema20: indicators1h.ema20,
      ema50: indicators1h.ema50,
      range: `${indicators1h.swingLow} - ${indicators1h.swingHigh}`,
      bsl: indicators1h.liquidityLevels?.buySideLiquidity || indicators1h.swingHigh,
      ssl: indicators1h.liquidityLevels?.sellSideLiquidity || indicators1h.swingLow,
    },
    m15: {
      marketRegime: indicators15m.marketRegime,
      regimeContext: indicators15m.regimeContext,
      structure: indicators15m.structure,
      orderBlock: indicators15m.orderBlock ? `${indicators15m.orderBlock.type} [${indicators15m.orderBlock.low} - ${indicators15m.orderBlock.high}]` : 'None',
      fvg: indicators15m.fvg ? `${indicators15m.fvg.type} [${indicators15m.fvg.bottom} - ${indicators15m.fvg.top}]` : 'None',
      support: indicators15m.support,
      resistance: indicators15m.resistance,
      bsl: indicators15m.liquidityLevels?.buySideLiquidity || indicators15m.swingHigh,
      ssl: indicators15m.liquidityLevels?.sellSideLiquidity || indicators15m.swingLow,
      sessionHigh: indicators15m.swingHigh,
      sessionLow: indicators15m.swingLow,
    },
    m5: {
      ema20: indicators5m.ema20,
      ema50: indicators5m.ema50,
      vwap: indicators5m.vwap,
      rsi: indicators5m.rsi14,
      atr: indicators5m.atr14,
    },
    recent5mCandlesSummary: candles5m.slice(-5).map(c => ({
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
    }))
  };

  const systemInstruction = scenario.lang === 'AR'
    ? `أنت AI Trading Agent فائق الذكاء ومحترف للغاية متخصص في تداول الذهب XAU/USD بنظام Scalping على حساب صغير (يبدأ من $10).
القواعد الصارمة لمحرك التداول والأهداف الربحية:
1. الهدف الأساسي: حماية رأس المال واختيار صفقات نوعية عالية الجودة بناءً على حالة السوق (Market Regime)، واستراتيجيات الهيكل (Structure)، والسيولة (Liquidity Sweeps)، وOrder Blocks، وFVG، وFibonacci OTE، واستمرار الترند (Trend Continuation)، واستراتيجيات النطاق (Range SFP Reversal & Breakout Expansion).
2. تقييم بيئة السوق (Market Regime Awareness):
   - STRONG_UPTREND / STRONG_DOWNTREND: ابحث عن فرص استمرار الترند مع التصحيح (Pullbacks).
   - إذا كان السعر ممتداً بشكل مفرط (isOverextended=true)، لا تطارد السعر بالدخول المباشر؛ بل اختر انتظار التصحيح السطحي أو اعطِ قرار NO TRADE مؤقت لحين انتهاء التمدد.
   - NORMAL_RANGE / VOLATILE_RANGE: النطاق العرضي لا يعني تلقائياً NO TRADE؛ ابحث عن سحب السيولة عند أطراف الرينج (Range High/Low sweeps & SFP) أو الكسر التوسعي الحقيقي (Breakout Expansion)، وتجنب الدخول العشوائي في منتصف النطاق (Equilibrium).
   - TRANSITION: يتطلب تأكيد كسر الهيكل واستقراره قبل اتخاذ اتجاه جديد.
   - UNCLEAR: لا توجد ميزة إحصائية واضحة؛ اختر NO TRADE لحماية رأس المال.
3. القرارات المسموحة فقط: "BUY NOW" أو "SELL NOW" أو "BUY LIMIT" أو "SELL LIMIT" أو "NO TRADE". قرار واحد حصرياً.
4. حساب وقف الخسارة الصارم لصفقات السكالبينج (Scalping Stop Loss Rules):
   - للذهب: 1 point = 0.10$ حركة سعر (حساب النقاط: abs(Entry - SL) / 0.10).
   - نطاق الـStop Loss الفني المسموح به لصفقات السكالبينج هو من 35 إلى 65 نقطة (أي ما يعادل 3.5$ إلى 6.5$ من سعر الدخول).
   - وضع وقف الخسارة الفني (Structural Local Invalidation): يجب وضع وقف الخسارة بدقة عند مستوى إبطال فني محلي ذي مغزى على فريم M5/M15 (مثل قاع/قمة الـOrder Block المحلي، أو قاع/قمة شمعة الابتلاع والتأكيد، أو أطراف الـFVG، أو السوينغ المحلي الأقرب).
   - حظر وقف الخسارة الماكرو (Macro Swing Prohibition): القمم والقيعان الكبرى على فريم H1 وH4 هي سياق اتجاهي فقط، ويُحظر تماماً وضع وقف الخسارة عند سوينغات H1 البعيدة (مثل 350 أو 566 أو 570 أو 580 أو 602 نقطة).
   - إذا كانت الصفقة تتطلب وقف خسارة أكبر من 65 نقطة ولا توجد نقطة إبطال فنية محلية صالحة ضمن نطاق [35, 65] نقطة، يجب اتخاذ قرار "NO TRADE" فوراً بدلاً من اقتراح صفقة بوقف خسارة واسع سيفشل في محرك المخاطر.
5. سياسة الأهداف الهيكلية الصارمة (Market Structure Target Policy):
   - الهدف الأول (TP1) هو أقرب هدف هيكلي حقيقي وملموس في السوق (Nearest genuine market-structure objective مثل Swings / S/R / Liquidity Pools / Order Blocks / FVG).
   - نسبة العائد إلى المخاطرة (R:R) هي مقياس ناتج (Output metric) وليست معياراً تعسفياً لتوليد الأهداف (يجب أن تكون R:R إلى TP1 على الأقل 1.0R أي abs(TP1 - Entry) >= abs(Entry - SL)).
   - الهدف الهيكلي الحقيقي الذي يحقق نسبة عائد طبيعية حول 1.0R–1.4R يُعتبر صالحاً تماماً ومقبولاً إذا كانت جودة النموذج، والدخول، ووقف الخسارة، وهيكل السوق، وشروط التنفيذ قوية ومكتملة.
   - يُحظر تماماً على الذكاء الاصطناعي مدّ أو إبعاد الهدف الأول (TP1) بعيداً عن الهيكل الحقيقي لمجرد تحسين نسبة R:R حسابياً بشكل مصطنع.
   - الهدف الثاني (TP2): هو الهدف الهيكلي الحقيقي التالي بعد TP1 (Next genuine structural objective). إذا لم يوجد هدف هيكلي ثانٍ صالح وواضح في السوق، لا تخترع هدفاً رياضياً ضخماً ولا تضع TP2 مساوياً لـ TP1، بل اتركه غير محدد أو 0.
   - إذا تم توفير مرشحات استراتيجية صالحة في "topCandidates"، قم بتقييمها واختيار الأقوى أو تأكيدها.
6. الثقة (Confidence): من 70 إلى 96 للصفقات الصالحة.
7. في حال عدم وجود فرصة حقيقية أو تذبذب في منتصف الرينج، اختر "NO TRADE" واذكر السبب بالتفصيل.`
    : `You are an expert XAU/USD scalping AI trading agent for small accounts ($10+).
Strict Scalping & Risk Rules:
1. Capital preservation is priority #1. Pick high-quality setups based on Market Regime, Structure, Liquidity Sweeps, Order Blocks, FVG, Fibonacci OTE, Trend Continuation, or Range SFP.
2. Market Regime:
   - STRONG_UPTREND / STRONG_DOWNTREND: Look for pullback continuations. If overextended, do not chase; return NO TRADE or wait for pullback.
   - NORMAL_RANGE: Look for range edge sweeps / SFP or genuine expansion breakouts. Avoid entries at equilibrium.
   - UNCLEAR / TRANSITION: Capital preservation first -> return NO TRADE.
3. Allowed decisions: "BUY NOW", "SELL NOW", "BUY LIMIT", "SELL LIMIT", "NO TRADE".
4. Strict Scalping Stop Loss Rules:
   - For XAU/USD: 1 point = $0.10 price movement (Points = abs(Entry - SL) / 0.10).
   - Allowed technical scalping Stop Loss range is strictly 35 to 65 points ($3.50 to $6.50).
   - Structural Local Invalidation: Place SL at a genuine local M5/M15 invalidation level (local OB edge, confirmation candle extreme, FVG boundary, or nearest local swing).
   - Macro Swing Prohibition: Macro H1/H4 swings are directional context only. NEVER place execution scalping SL at distant H1 macro swings (e.g. 350, 566, 570, 580, or 602 points).
   - If a setup requires >65 points SL and no valid [35, 65] pt local invalidation exists, return "NO TRADE" immediately.
5. Structural Target Policy:
   - TP1 is the nearest genuine market-structure objective (Swings / S/R / Liquidity Pools / OB / FVG).
   - Minimum R:R to TP1 must be >= 1.0R (abs(TP1 - Entry) >= abs(Entry - SL)).
   - Do NOT artificially inflate TP1.
   - TP2 is the next genuine structural target, or 0 / omitted if none.
6. Confidence: 70-96% for actionable trades.
7. If no high-probability setup exists, return "NO TRADE" with detailed explanation.`;

  const prompt = scenario.lang === 'AR'
    ? `حلل بيانات السوق والمرشحات الاستراتيجية المرفقة للذهب وقدم قرارك النهائي بصيغة JSON:\n${JSON.stringify(technicalContext, null, 2)}`
    : `Analyze the provided market data and strategic candidates for XAU/USD and output your decision in JSON:\n${JSON.stringify(technicalContext, null, 2)}`;

  const model = 'google/gemini-2.5-flash-lite';
  const startT = Date.now();
  
  let completion: any;
  let parsed: any;
  let fallback = false;

  let attempts = 0;
  const maxAttempts = 4;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      completion = await ai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: prompt },
        ],
        temperature: 0.15,
        max_tokens: 1024,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'xauusd_trade_signal',
            strict: true,
            schema: XAUUSD_TRADE_SIGNAL_JSON_SCHEMA,
          },
        },
      }, {
        timeout: 15000,
      });

      const content = completion.choices[0]?.message?.content;
      parsed = parseAndValidateAiResponse(content);
      fallback = false;
      break;
    } catch (err: any) {
      if (attempts < maxAttempts && (err.status === 429 || err.message?.includes('429') || err.message?.includes('rate') || err.message?.includes('exhausted'))) {
        const backoffMs = attempts * 2500;
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }

      if (attempts >= maxAttempts) {
        fallback = true;
        parsed = {
          signal: 'NO TRADE',
          entry: currentPrice,
          stopLoss: currentPrice,
          tp1: currentPrice,
          tp2: currentPrice,
          confidence: 50,
          setup: 'Fallback',
          noTradeReason: `Error after ${attempts} attempts: ${err.message}`,
        };
      }
    }
  }

  const latencyMs = Date.now() - startT;

  const aiSignal = String(parsed.signal || 'NO TRADE').toUpperCase();
  const rawEntry = Number(parsed.entry ?? currentPrice);
  const rawSl = Number(parsed.stopLoss ?? currentPrice);
  const rawTp1 = Number(parsed.tp1 ?? currentPrice);
  const rawTp2 = Number(parsed.tp2 ?? 0);
  const confidence = Number(parsed.confidence ?? 75);
  const setup = String(parsed.setup || 'None');

  const slDistancePrice = Math.abs(rawEntry - rawSl);
  const slPoints = Math.round(slDistancePrice / 0.1);
  const slValid = (aiSignal === 'NO TRADE') || (slPoints >= 35 && slPoints <= 65);

  const tp1Distance = Math.abs(rawTp1 - rawEntry);
  const rr = slDistancePrice > 0 ? (tp1Distance / slDistancePrice) : 0;
  const tp1Rr = slDistancePrice > 0 ? `1:${rr.toFixed(2)}` : '1:0';

  const isOversizedSl = (aiSignal !== 'NO TRADE') && (slPoints > 65);
  const isUndersizedSl = (aiSignal !== 'NO TRADE') && (slPoints < 35);
  const isSpecificOversizedSlPattern = (slPoints >= 300 && slPoints <= 650);

  let validatorResult: 'VALID' | 'REJECTED' | 'N/A (NO TRADE)' = 'N/A (NO TRADE)';
  let rejectionReason = '';

  if (aiSignal === 'BUY NOW' || aiSignal === 'SELL NOW' || aiSignal === 'BUY LIMIT' || aiSignal === 'SELL LIMIT') {
    const valResult = validateTradeSignalCandidate(
      {
        direction: (aiSignal.includes('BUY') ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
        entry: rawEntry,
        stopLoss: rawSl,
        tp1: rawTp1,
        tp2: rawTp2 > 0 ? rawTp2 : undefined,
        confidence,
        setupName: setup,
        strategyFamily: 'ORDER_BLOCK',
      },
      {
        currentPrice,
        candles5m,
        candles15m,
        candles1h,
        indicators5m,
        indicators15m,
        indicators1h,
        brokerSpecs,
      }
    );

    if (valResult.isValid) {
      validatorResult = 'VALID';
    } else {
      validatorResult = 'REJECTED';
      rejectionReason = valResult.rejectionReason || 'Rejected';
    }
  }

  return {
    scenarioNum: scenario.id,
    lang: scenario.lang,
    category: scenario.category,
    aiSignal,
    entry: rawEntry,
    rawSl,
    slPoints,
    slValid,
    tp1: rawTp1,
    tp2: rawTp2,
    tp1Rr,
    confidence,
    setup,
    validatorResult,
    fallback,
    rejectionReason,
    latencyMs,
    isOversizedSl,
    isUndersizedSl,
    isSpecificOversizedSlPattern,
  };
}
