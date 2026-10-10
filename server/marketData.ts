import { AssetType, Candle, HistoricalDataValidationReport } from '../src/types.js';
import { mt5Bridge } from './mt5Bridge.js';

export interface BiquoteQuote {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  last: number;
  spread: number;
  high: number;
  low: number;
  direction?: string;
  dayDiffPercent?: number;
  marketState?: string;
  source?: string;
  timestamp: string;
}

export interface MultiTimeframeMarketData {
  asset: AssetType;
  currentPrice: number;
  quote?: BiquoteQuote;
  candles1h: Candle[];
  candles15m: Candle[];
  candles5m: Candle[];
  candles1m: Candle[];
  lastUpdate: number;
}

// In-memory cache to maintain high performance and prevent unnecessary repetitive requests
interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

export const priceCache: Record<string, CacheEntry<BiquoteQuote>> = {};
export const candleCache: Record<string, CacheEntry<Candle[]>> = {};

const QUOTE_CACHE_TTL_MS = 3_000; // 3 seconds cache for live quotes
const CANDLE_CACHE_TTL_MS = 8_000; // 8 seconds cache for multi-timeframe candles

/**
 * Maps asset type to Biquote symbol
 * XAU/USD -> XAUUSD
 * BTC/USD -> BTCUSD
 */
function getBiquoteSymbol(asset: AssetType | string): string {
  if (typeof asset === 'string' && asset.toUpperCase().includes('BTC')) return 'BTCUSD';
  return 'XAUUSD';
}

/**
 * Validates timeframe interval
 */
function normalizeInterval(tf: string): '1m' | '5m' | '15m' | '1h' {
  switch (tf.toLowerCase()) {
    case '1m':
      return '1m';
    case '5m':
      return '5m';
    case '15m':
      return '15m';
    case '1h':
    default:
      return '1h';
  }
}

/**
 * Helper utility to perform fetch with retries and timeout
 */
async function fetchWithRetry(url: string, options: RequestInit & { timeout?: number }, retries = 3, delay = 1000): Promise<Response> {
  const timeout = options.timeout ?? 10000;
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);
      const fetchOpts = { ...options, signal: controller.signal };
      // Delete timeout property so standard fetch doesn't receive custom config options
      delete (fetchOpts as any).timeout;
      const res = await fetch(url, fetchOpts);
      clearTimeout(id);
      return res;
    } catch (err: any) {
      const isLast = i === retries - 1;
      const isTimeout = err.name === 'AbortError' || err.message?.includes('aborted') || err.message?.includes('timeout');
      console.warn(`[fetchWithRetry] Attempt ${i + 1} failed for ${url}. Error: ${err.message || err}. Timeout: ${isTimeout}. ${isLast ? 'Out of retries.' : 'Retrying...'}`);
      if (isLast) {
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
    }
  }
  throw new Error(`fetchWithRetry failed for ${url}`);
}

/**
 * Fetch live quote from Biquote (symbol: XAUUSD)
 * Endpoint: https://biquote.io/api/XAUUSD
 * No API key, No signup, No subscription required
 */
export async function fetchLiveQuote(asset: AssetType = 'XAU/USD'): Promise<BiquoteQuote> {
  const symbol = getBiquoteSymbol(asset);
  const now = Date.now();

  const cached = priceCache[symbol];
  if (cached && now - cached.cachedAt < QUOTE_CACHE_TTL_MS) {
    return cached.data;
  }

  const url = `https://biquote.io/api/${symbol}`;
  let res: Response;
  try {
    res = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'BiquoteGoldScanner/1.0',
        'Accept': 'application/json',
      },
      timeout: 12000,
    }, 3, 1000);
  } catch (netErr: any) {
    console.error(`[Biquote Live Quote Error] Network fetch failed for ${url}:`, netErr.message || netErr);
    // Never fall back to stale cached quote or synthetic prices for live trade signals
    throw new Error(`Biquote live quote unavailable or timed out: ${netErr.message || 'Fetch error'}`);
  }

  if (!res.ok) {
    console.error(`[Biquote Live Quote Error] HTTP ${res.status} ${res.statusText} for URL ${url}`);
    throw new Error(`Biquote market data error (${res.status}): ${res.statusText}`);
  }

  let raw: any;
  try {
    raw = await res.json();
  } catch (parseErr: any) {
    console.error(`[Biquote Live Quote Error] Failed to parse JSON response from ${url} (HTTP ${res.status}):`, parseErr.message);
    throw new Error(`Invalid JSON response from Biquote (${res.status})`);
  }

  // Handle array wrapping or nested data containers
  const data = Array.isArray(raw) ? raw[0] : (raw?.data || raw?.quote || raw?.result || raw);

  if (!data || typeof data !== 'object') {
    console.error(`[Biquote Live Quote Error] Unexpected payload shape from ${url} (HTTP ${res.status}). Type: ${typeof raw}, Payload:`, raw);
    throw new Error(`Unexpected Biquote quote payload shape (${res.status})`);
  }

  // Helper to parse numerical values safely from numbers or numeric strings
  const parseNum = (val: any): number => {
    if (typeof val === 'number') return isNaN(val) ? 0 : val;
    if (typeof val === 'string') {
      const parsed = parseFloat(val);
      return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  };

  const rawBid = parseNum(data.bid ?? data.bidPrice ?? data.buy);
  const rawAsk = parseNum(data.ask ?? data.askPrice ?? data.sell);
  const rawPrice = parseNum(data.price ?? data.last ?? data.close ?? data.mid);

  // STRICT VALIDATION: Real, positive bid and ask are mandatory from Biquote MT5 feed
  // No synthetic bid/ask/spread allowed
  if (rawBid <= 0 || rawAsk <= 0 || rawBid > rawAsk) {
    console.error(`[Biquote Live Quote Error] Missing or invalid bid/ask from Biquote for ${symbol}: Bid=${rawBid}, Ask=${rawAsk}`);
    throw new Error(`Missing or invalid bid/ask in Biquote live quote (Bid: ${rawBid}, Ask: ${rawAsk})`);
  }

  const spread = Number((rawAsk - rawBid).toFixed(3));
  const mid = parseNum(data.mid) > 0 ? parseNum(data.mid) : Number(((rawBid + rawAsk) / 2).toFixed(3));
  const last = rawPrice > 0 ? rawPrice : mid;

  if (mid <= 0 || last <= 0) {
    console.error(`[Biquote Live Quote Error] Unable to extract positive price for ${symbol} from Biquote. HTTP ${res.status}, Payload keys: [${Object.keys(data).join(', ')}], Payload:`, data);
    throw new Error(`Invalid or non-positive price extracted from Biquote response (${res.status})`);
  }

  const bid = Number(rawBid.toFixed(3));
  const ask = Number(rawAsk.toFixed(3));
  const high = parseNum(data.high) || Math.max(ask, mid);
  const low = parseNum(data.low) || Math.min(bid, mid);

  const quote: BiquoteQuote = {
    symbol: data.symbol || symbol,
    bid,
    ask,
    mid: Number(mid.toFixed(3)),
    last: Number(last.toFixed(3)),
    spread,
    high: Number(high.toFixed(3)),
    low: Number(low.toFixed(3)),
    direction: data.direction || 'FLAT',
    dayDiffPercent: parseNum(data.dayDiffPercent),
    marketState: data.marketState || 'open',
    source: data.source || 'Biquote MT5 Feed',
    timestamp: data.timestamp || new Date().toISOString(),
  };

  priceCache[symbol] = { data: quote, cachedAt: now };
  return quote;
}

/**
 * Fetch real current price for asset via Biquote
 */
export async function fetchCurrentPrice(asset: AssetType = 'XAU/USD'): Promise<number> {
  const quote = await fetchLiveQuote(asset);
  // Return mid price (or bid/ask fallback) rounded to 2 decimal places for standard display
  return Number(quote.mid.toFixed(2));
}

/**
 * Fetch real OHLC candles from Biquote
 * Endpoints:
 * https://biquote.io/api/XAUUSD/ohlc?interval=1m&limit=1000
 * https://biquote.io/api/XAUUSD/ohlc?interval=5m&limit=1000
 * https://biquote.io/api/XAUUSD/ohlc?interval=15m&limit=1000
 * https://biquote.io/api/XAUUSD/ohlc?interval=1h&limit=1000
 *
 * Rules:
 * - Symbol: XAUUSD
 * - Up to 1000 bars
 * - No API key
 * - Use tickVolume instead of real volume where volume is unavailable
 * - Reverses/sorts to chronological order (oldest to newest) for indicators
 */
/**
 * Validates candle data integrity for live scanner and analysis pipelines.
 * Ensures:
 * - Minimum required candle count
 * - Valid timestamps > 0 and chronological ordering
 * - Valid positive numerical OHLC prices
 * - Consistent candle geometry: high >= max(open, close, low) and low <= min(open, close, high)
 * - Non-negative volume
 * - Deduplication of adjacent identical timestamps
 */
export function validateAndSanitizeCandles(
  candles: Candle[],
  timeframe: string,
  minRequiredBars: number = 15
): { isValid: boolean; error?: string; sanitizedCandles: Candle[] } {
  if (!Array.isArray(candles) || candles.length < minRequiredBars) {
    return {
      isValid: false,
      error: `INSUFFICIENT_CANDLES: Timeframe ${timeframe} has ${candles?.length || 0} bars (minimum required: ${minRequiredBars})`,
      sanitizedCandles: [],
    };
  }

  const timestampMap = new Map<number, Candle>();
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c || typeof c !== 'object') continue;

    const ts = typeof c.timestamp === 'number' ? c.timestamp : Number(c.timestamp);
    const open = typeof c.open === 'number' ? c.open : Number(c.open);
    const high = typeof c.high === 'number' ? c.high : Number(c.high);
    const low = typeof c.low === 'number' ? c.low : Number(c.low);
    const close = typeof c.close === 'number' ? c.close : Number(c.close);
    const volume = typeof c.volume === 'number' ? c.volume : Number(c.volume);

    // Strict positive numeric price validation
    if (
      isNaN(ts) || ts <= 0 ||
      isNaN(open) || open <= 0 ||
      isNaN(high) || high <= 0 ||
      isNaN(low) || low <= 0 ||
      isNaN(close) || close <= 0 ||
      isNaN(volume) || volume < 0
    ) {
      return {
        isValid: false,
        error: `CORRUPT_CANDLE_DATA: Non-positive or NaN values in ${timeframe} candle at index ${i}`,
        sanitizedCandles: [],
      };
    }

    // Geometry validation
    if (high < low || high < open || high < close || low > open || low > close) {
      return {
        isValid: false,
        error: `INVALID_CANDLE_GEOMETRY: Inconsistent OHLC bounds in ${timeframe} candle at timestamp ${ts} (O:${open} H:${high} L:${low} C:${close})`,
        sanitizedCandles: [],
      };
    }

    timestampMap.set(ts, {
      timestamp: ts,
      open,
      high,
      low,
      close,
      volume,
    });
  }

  const sanitized = Array.from(timestampMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  if (sanitized.length < minRequiredBars) {
    return {
      isValid: false,
      error: `INSUFFICIENT_UNIQUE_CANDLES: After deduplication, ${timeframe} has ${sanitized.length} bars (minimum required: ${minRequiredBars})`,
      sanitizedCandles: [],
    };
  }

  return {
    isValid: true,
    sanitizedCandles: sanitized,
  };
}

export async function fetchCandles(
  asset: AssetType,
  timeframe: '1m' | '5m' | '15m' | '1h',
  limit: number = 1000
): Promise<Candle[]> {
  const symbol = getBiquoteSymbol(asset);
  const interval = normalizeInterval(timeframe);
  const clampedLimit = Math.min(1000, Math.max(10, limit || 1000));
  const cacheKey = `${symbol}_${interval}_${clampedLimit}`;
  const now = Date.now();

  const cached = candleCache[cacheKey];
  if (cached && now - cached.cachedAt < CANDLE_CACHE_TTL_MS) {
    return cached.data;
  }

  const url = `https://biquote.io/api/${symbol}/ohlc?interval=${interval}&limit=${clampedLimit}`;
  let res: Response;
  try {
    res = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'BiquoteGoldScanner/1.0',
        'Accept': 'application/json',
      },
      timeout: 15000,
    }, 3, 1000);
  } catch (netErr: any) {
    console.error(`[Biquote Candles Error] Network fetch failed for ${url}:`, netErr.message || netErr);
    // Task 3: Never silently fall back to stale expired cached candles for live execution / scanning
    throw new Error(`Biquote OHLC fetch failed: ${netErr.message || 'Fetch error'}`);
  }

  if (!res.ok) {
    throw new Error(`Biquote OHLC error (${res.status}) for ${symbol} [${interval}]: ${res.statusText}`);
  }

  const json = await res.json();
  const rawBars = json.bars;

  if (!Array.isArray(rawBars) || rawBars.length === 0) {
    throw new Error(`No candle data returned from Biquote for ${symbol} [${interval}]`);
  }

  // Map bars according to specification:
  // - Use tickVolume instead of real volume where volume is unavailable
  const parsedCandles: Candle[] = rawBars.map((b: any) => {
    const rawVolume = Number(b.volume) || 0;
    const tickVolume = Number(b.tickVolume) || 0;
    const effectiveVolume = rawVolume > 0 ? rawVolume : tickVolume;

    return {
      timestamp: new Date(b.openTime).getTime(),
      open: Number(parseFloat(b.open).toFixed(2)),
      high: Number(parseFloat(b.high).toFixed(2)),
      low: Number(parseFloat(b.low).toFixed(2)),
      close: Number(parseFloat(b.close).toFixed(2)),
      volume: effectiveVolume,
    };
  });

  // Biquote returns bars with newest first (index 0 is current/newest bar).
  // Sort ascending (oldest first, newest last) for charting and technical indicators
  parsedCandles.sort((a, b) => a.timestamp - b.timestamp);

  // Validate and sanitize parsed candles
  const validation = validateAndSanitizeCandles(parsedCandles, interval, 15);
  if (!validation.isValid) {
    throw new Error(`Biquote candle validation failed for ${symbol} [${interval}]: ${validation.error}`);
  }

  const sanitizedCandles = validation.sanitizedCandles;
  candleCache[cacheKey] = { data: sanitizedCandles, cachedAt: now };
  return sanitizedCandles;
}

/**
 * Parses raw Biquote bars into standard Candle objects
 */
export function parseBiquoteBars(rawBars: any[]): Candle[] {
  if (!Array.isArray(rawBars)) return [];
  return rawBars
    .map((b: any) => {
      const rawVolume = Number(b.volume) || 0;
      const tickVolume = Number(b.tickVolume) || 0;
      const effectiveVolume = rawVolume > 0 ? rawVolume : tickVolume;
      const ts = new Date(b.openTime).getTime();
      return {
        timestamp: ts,
        open: Number(parseFloat(b.open).toFixed(2)),
        high: Number(parseFloat(b.high).toFixed(2)),
        low: Number(parseFloat(b.low).toFixed(2)),
        close: Number(parseFloat(b.close).toFixed(2)),
        volume: effectiveVolume,
      };
    })
    .filter((c) => !isNaN(c.timestamp) && c.timestamp > 0);
}

export interface PaginatedFetchResult {
  candles: Candle[];
  duplicatesRemoved: number;
  pagesFetched: number;
  earliestTimestamp: number | null;
  latestTimestamp: number | null;
  earliestDate: string | null;
  latestDate: string | null;
  coversTarget: boolean;
}

/**
 * Fetches historical candles using time-based pagination (chunking) via `to` parameter.
 * Strictly adheres to Zero-Mock, Zero-Synthetic data: pulls 100% genuine Biquote candles.
 * Paginates backwards until targetStartTime is covered OR until Biquote historical buffer is exhausted.
 */
export async function fetchHistoricalCandlesWithPagination(
  symbol: string = 'XAUUSD',
  interval: '5m' | '15m' | '1h' | '1d',
  targetStartTime: number,
  targetEndTime: number = Date.now(),
  maxPages: number = 25
): Promise<PaginatedFetchResult> {
  const candlesMap = new Map<number, Candle>();
  let duplicatesRemoved = 0;
  let cursorTo: string | null = null;
  let pagesFetched = 0;

  while (pagesFetched < maxPages) {
    pagesFetched++;
    let url = `https://biquote.io/api/${symbol}/ohlc?interval=${interval}&limit=1000`;
    if (cursorTo) {
      url += `&to=${encodeURIComponent(cursorTo)}`;
    }

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'BiquoteGoldBacktest/1.0',
          'Accept': 'application/json',
        },
      });

      if (!res.ok) {
        console.warn(`[HistoricalDataLoader] Page ${pagesFetched} HTTP ${res.status} for ${interval}`);
        break;
      }

      const json = await res.json();
      const rawBars = json.bars || [];
      if (!Array.isArray(rawBars) || rawBars.length === 0) {
        break;
      }

      const parsed = parseBiquoteBars(rawBars);
      for (const candle of parsed) {
        if (candlesMap.has(candle.timestamp)) {
          duplicatesRemoved++;
        } else {
          candlesMap.set(candle.timestamp, candle);
        }
      }

      const earliestBar = rawBars[rawBars.length - 1]?.openTime;
      if (!earliestBar) break;

      const earliestTs = new Date(earliestBar).getTime();
      // If cursor didn't move backwards, we hit the end of available history on Biquote
      if (cursorTo === earliestBar) {
        break;
      }
      cursorTo = earliestBar;

      // If we've reached or passed the target start time, stop paginating
      if (earliestTs <= targetStartTime) {
        break;
      }

      // If Biquote returned very few bars, we've reached the end of history
      if (rawBars.length < 5) {
        break;
      }

      // Small pause to prevent rate limiting
      if (pagesFetched < maxPages) {
        await new Promise((r) => setTimeout(r, 40));
      }
    } catch (err: any) {
      console.error(`[HistoricalDataLoader] Error on page ${pagesFetched} for ${interval}:`, err.message);
      break;
    }
  }

  const candles = Array.from(candlesMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  const earliestTimestamp = candles[0]?.timestamp ?? null;
  const latestTimestamp = candles[candles.length - 1]?.timestamp ?? null;
  const coversTarget = earliestTimestamp !== null && earliestTimestamp <= targetStartTime;

  return {
    candles,
    duplicatesRemoved,
    pagesFetched,
    earliestTimestamp,
    latestTimestamp,
    earliestDate: earliestTimestamp ? new Date(earliestTimestamp).toISOString() : null,
    latestDate: latestTimestamp ? new Date(latestTimestamp).toISOString() : null,
    coversTarget,
  };
}

export interface CandleGapInfo {
  timeframe: string;
  gapStart: string;
  gapEnd: string;
  gapDurationHours: number;
  reason: string;
}

/**
 * Analyzes gaps between consecutive candles.
 * Normal weekend closures are recognized and categorized.
 */
export function detectCandleGaps(candles: Candle[], intervalMinutes: number, tfLabel: string): CandleGapInfo[] {
  const gaps: CandleGapInfo[] = [];
  const expectedStepMs = intervalMinutes * 60 * 1000;
  // Threshold: gap > 3x the normal step
  const gapThresholdMs = expectedStepMs * 3;

  for (let i = 1; i < candles.length; i++) {
    const prevTime = candles[i - 1].timestamp;
    const currTime = candles[i].timestamp;
    const diff = currTime - prevTime;

    if (diff > gapThresholdMs) {
      const prevDate = new Date(prevTime);
      const currDate = new Date(currTime);
      const prevDay = prevDate.getUTCDay(); // 5 = Friday
      const currDay = currDate.getUTCDay(); // 0 = Sunday, 1 = Monday
      const durationHours = Number((diff / (3600 * 1000)).toFixed(1));

      let reason = 'Unexpected Intraday Data Gap';
      if ((prevDay === 5 || prevDay === 6) && (currDay === 0 || currDay === 1) && durationHours >= 40 && durationHours <= 55) {
        reason = 'Weekend Market Closure (Normal Forex/Gold MT5)';
      }

      gaps.push({
        timeframe: tfLabel,
        gapStart: prevDate.toISOString().replace('T', ' ').slice(0, 19),
        gapEnd: currDate.toISOString().replace('T', ' ').slice(0, 19),
        gapDurationHours: durationHours,
        reason,
      });
    }
  }

  return gaps;
}

/**
 * Scans for duplicate candles
 */
export function detectCandleDuplicates(candles: Candle[]): number {
  let dupCount = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].timestamp === candles[i - 1].timestamp) {
      dupCount++;
    }
  }
  return dupCount;
}

/**
 * Comprehensive Data Validation Report Generator & Auditor
 */
export function validateHistoricalBacktestDataset(params: {
  provider?: 'MT5_BRIDGE' | 'BIQUOTE';
  symbol?: string;
  timeRange: string;
  requestedStartTime: number;
  requestedEndTime: number;
  candles5m: Candle[];
  candles15m: Candle[];
  candles1h: Candle[];
  duplicatesRemoved: { '5m': number; '15m': number; '1h': number };
}): HistoricalDataValidationReport {
  const {
    provider = 'BIQUOTE',
    symbol = 'XAUUSD',
    timeRange,
    requestedStartTime,
    requestedEndTime,
    candles5m,
    candles15m,
    candles1h,
    duplicatesRemoved,
  } = params;

  const actualEarliest5m = candles5m[0]?.timestamp || 0;
  const actualLatest5m = candles5m[candles5m.length - 1]?.timestamp || 0;
  const actualEarliestDate = actualEarliest5m ? new Date(actualEarliest5m).toISOString() : 'N/A';
  const actualLatestDate = actualLatest5m ? new Date(actualLatest5m).toISOString() : 'N/A';

  const requestedStartDate = new Date(requestedStartTime).toISOString();
  const requestedEndDate = new Date(requestedEndTime).toISOString();

  // Gap analysis
  const gaps5m = detectCandleGaps(candles5m, 5, '5M');
  const gaps15m = detectCandleGaps(candles15m, 15, '15M');
  const gaps1h = detectCandleGaps(candles1h, 60, '1H');
  const allGaps = [...gaps5m, ...gaps15m, ...gaps1h];

  const internalDuplicates = {
    '5m': duplicatesRemoved['5m'] + detectCandleDuplicates(candles5m),
    '15m': duplicatesRemoved['15m'] + detectCandleDuplicates(candles15m),
    '1h': duplicatesRemoved['1h'] + detectCandleDuplicates(candles1h),
  };

  const requestedSpanHours = Math.max(1, (requestedEndTime - requestedStartTime) / (3600 * 1000));
  const actualSpanHours = actualEarliest5m && actualLatest5m ? (actualLatest5m - actualEarliest5m) / (3600 * 1000) : 0;
  const coverageRatio = Math.min(1.0, Number((actualSpanHours / requestedSpanHours).toFixed(3)));

  // Strict coverage check:
  // Must cover back to target start time (within 15m allowance)
  const isFullCoverage = actualEarliest5m > 0 && actualEarliest5m <= requestedStartTime + 15 * 60 * 1000;
  const status = isFullCoverage ? 'VALID' : 'INSUFFICIENT_DATA';

  const requestedCandles = Math.max(1, Math.floor(requestedSpanHours * 12));
  const returnedCandles = candles5m.length;

  const report: HistoricalDataValidationReport = {
    provider,
    symbol,
    timeframe: '5M',
    requestedPeriod: timeRange,
    requestedStartTime,
    requestedEndTime,
    requestedStartDate,
    requestedEndDate,
    requestedCandles,
    returnedCandles,
    earliestTimestamp: actualEarliest5m,
    latestTimestamp: actualLatest5m,
    actualEarliestCandleTime: actualEarliest5m,
    actualLatestCandleTime: actualLatest5m,
    actualEarliestDate,
    actualLatestDate,
    candleCounts: {
      '5m': candles5m.length,
      '15m': candles15m.length,
      '1h': candles1h.length,
    },
    gaps: allGaps,
    duplicatesCount: internalDuplicates,
    coverageRatio,
    coverage: coverageRatio,
    isFullCoverage,
    status: status as 'VALID' | 'INSUFFICIENT_DATA',
    message: isFullCoverage
      ? `تم التحقق بنجاح من مزود (${provider}): البيانات تغطي 100% من الفترة المطلوبة (${timeRange}).`
      : provider === 'MT5_BRIDGE'
        ? `بيانات MT5 Bridge لشموع 5M المستلمة (${candles5m.length} شمعة) تغطي ${Number((actualSpanHours / 24).toFixed(2))} يوم فقط (من ${actualEarliestDate} إلى ${actualLatestDate}) بينما الفترة المطلوبة ${timeRange} تبدأ من ${requestedStartDate}. نسبة التغطية: ${(coverageRatio * 100).toFixed(1)}%.`
        : `بيانات Biquote لشموع 5M المتوفرة هي ${candles5m.length} شمعة تغطي ${Number((actualSpanHours / 24).toFixed(2))} يوم فقط (من ${actualEarliestDate} إلى ${actualLatestDate}) بينما الفترة المطلوبة ${timeRange} تبدأ من ${requestedStartDate}. نسبة التغطية الفعلية: ${(coverageRatio * 100).toFixed(1)}%.`,
  };

  // Log validation report in exact required format
  console.log(`\n================================================================================`);
  console.log(`       HISTORICAL DATA VALIDATION REPORT [Provider: ${provider}]`);
  console.log(`================================================================================`);
  console.log(`Provider:               ${provider}`);
  console.log(`Symbol:                 ${symbol}`);
  console.log(`Requested Period:       ${timeRange}`);
  console.log(`Requested Start:        ${requestedStartDate}`);
  console.log(`Requested End:          ${requestedEndDate}`);
  console.log(`Requested Candles (5M): ~${requestedCandles}`);
  console.log(`Returned Candles (5M):  ${returnedCandles}`);
  console.log(`Actual Earliest Candle: ${actualEarliestDate} (5M)`);
  console.log(`Actual Latest Candle:   ${actualLatestDate} (5M)`);
  console.log(`Candle Counts:`);
  console.log(`  - 5M:                 ${candles5m.length} candles (${Number((actualSpanHours / 24).toFixed(2))} days)`);
  console.log(`  - 15M:                ${candles15m.length} candles`);
  console.log(`  - 1H:                 ${candles1h.length} candles`);
  console.log(`Coverage Ratio:         ${(coverageRatio * 100).toFixed(1)}%`);
  console.log(`Duplicates Detected & Removed:`);
  console.log(`  - 5M:                 ${internalDuplicates['5m']}`);
  console.log(`  - 15M:                ${internalDuplicates['15m']}`);
  console.log(`  - 1H:                 ${internalDuplicates['1h']}`);
  console.log(`Gaps Analysis:          ${allGaps.length} gap(s) found`);
  allGaps.forEach((g, idx) => {
    console.log(`  [${idx + 1}] TF: ${g.timeframe} | ${g.gapStart} -> ${g.gapEnd} (${g.gapDurationHours}h) - ${g.reason}`);
  });
  console.log(`Validation Status:      ${report.status}`);
  console.log(`Validation Message:     ${report.message}`);
  console.log(`================================================================================\n`);

  return report;
}

export interface HistoricalDatasetResult {
  provider: 'MT5_BRIDGE' | 'BIQUOTE';
  candles1m?: Candle[];
  candles5m: Candle[];
  candles15m: Candle[];
  candles1h: Candle[];
  duplicatesRemoved: { '1m'?: number; '5m': number; '15m': number; '1h': number };
  validation: HistoricalDataValidationReport;
}

/**
 * Loads historical data for Backtesting:
 * 1. Checks MT5 Bridge first if available.
 * 2. If MT5 Bridge is connected and returns data, uses MT5 Bridge.
 * 3. Otherwise, falls back to Biquote with strict validation.
 */
export async function fetchHistoricalBacktestDataset(params: {
  symbol?: string;
  timeRange?: string;
  requestedStartTime: number;
  requestedEndTime?: number;
}): Promise<HistoricalDatasetResult> {
  const symbol = (params.symbol || 'XAUUSD').replace('/', '').toUpperCase();
  const timeRange = params.timeRange || '7D';
  const requestedStartTime = params.requestedStartTime;
  const requestedEndTime = params.requestedEndTime || Date.now();

  const spanHours = Math.max(1, (requestedEndTime - requestedStartTime) / (3600 * 1000));
  const count5m = Math.min(50000, Math.ceil(spanHours * 12) + 300);
  const count15m = Math.min(20000, Math.ceil(spanHours * 4) + 150);
  const count1h = Math.min(10000, Math.ceil(spanHours * 1) + 100);

  // 1. Try MT5 Bridge historical candles if available
  if (mt5Bridge.hasHistoricalCandles('M5')) {
    try {
      const mt51m = mt5Bridge.getHistoricalCandles('M1') || [];
      const mt55m = mt5Bridge.getHistoricalCandles('M5') || [];
      const mt515m = mt5Bridge.getHistoricalCandles('M15') || [];
      const mt51h = mt5Bridge.getHistoricalCandles('H1') || [];

      if (mt55m.length >= 30) {
        // Filter candles strictly up to requestedEndTime so no future data is included
        const filtered1m = mt51m.filter((c) => c.timestamp <= requestedEndTime);
        const filtered5m = mt55m.filter((c) => c.timestamp <= requestedEndTime);
        const filtered15m = mt515m.filter((c) => c.timestamp <= requestedEndTime);
        const filtered1h = mt51h.filter((c) => c.timestamp <= requestedEndTime);

        const validation = validateHistoricalBacktestDataset({
          provider: 'MT5_BRIDGE',
          symbol,
          timeRange,
          requestedStartTime,
          requestedEndTime,
          candles5m: filtered5m,
          candles15m: filtered15m,
          candles1h: filtered1h,
          duplicatesRemoved: { '5m': 0, '15m': 0, '1h': 0 },
        });

        console.log(`[HistoricalDataLoader] MT5 Bridge loaded successfully: ${filtered1m.length} 1M and ${filtered5m.length} 5M candles. Provider: MT5_BRIDGE`);
        return {
          provider: 'MT5_BRIDGE',
          candles1m: filtered1m,
          candles5m: filtered5m,
          candles15m: filtered15m,
          candles1h: filtered1h,
          duplicatesRemoved: { '1m': 0, '5m': 0, '15m': 0, '1h': 0 },
          validation,
        };
      }
    } catch (err: any) {
      console.warn(`[HistoricalDataLoader] MT5 Bridge cache fetch error: ${err.message}, falling back.`);
    }
  }

  // 2. Fallback to Biquote
  console.log(`[HistoricalDataLoader] Fetching historical candles from Biquote (fallback)...`);
  const [res1h, res15m, res5m] = await Promise.all([
    fetchHistoricalCandlesWithPagination(symbol, '1h', requestedStartTime, requestedEndTime, 15),
    fetchHistoricalCandlesWithPagination(symbol, '15m', requestedStartTime, requestedEndTime, 20),
    fetchHistoricalCandlesWithPagination(symbol, '5m', requestedStartTime, requestedEndTime, 25),
  ]);

  const validation = validateHistoricalBacktestDataset({
    provider: 'BIQUOTE',
    symbol,
    timeRange,
    requestedStartTime,
    requestedEndTime,
    candles5m: res5m.candles,
    candles15m: res15m.candles,
    candles1h: res1h.candles,
    duplicatesRemoved: {
      '5m': res5m.duplicatesRemoved,
      '15m': res15m.duplicatesRemoved,
      '1h': res1h.duplicatesRemoved,
    },
  });

  return {
    provider: 'BIQUOTE',
    candles5m: res5m.candles,
    candles15m: res15m.candles,
    candles1h: res1h.candles,
    duplicatesRemoved: {
      '5m': res5m.duplicatesRemoved,
      '15m': res15m.duplicatesRemoved,
      '1h': res1h.duplicatesRemoved,
    },
    validation,
  };
}

/**
 * Gather complete multi-timeframe market data (1H, 15M, 5M, 1M) via Biquote
 * Uses up to 1000 bars for comprehensive SMC / Price Action / Trend structure
 */
export async function getMultiTimeframeData(asset: AssetType = 'XAU/USD'): Promise<MultiTimeframeMarketData> {
  const now = Date.now();

  // Parallel fetch from Biquote across all requested timeframes and live quote
  const [quote, candles1h, candles15m, candles5m, candles1m] = await Promise.all([
    fetchLiveQuote(asset),
    fetchCandles(asset, '1h', 1000),
    fetchCandles(asset, '15m', 1000),
    fetchCandles(asset, '5m', 1000),
    fetchCandles(asset, '1m', 1000),
  ]);

  const currentPrice = Number(quote.mid.toFixed(2));

  return {
    asset,
    currentPrice,
    quote,
    candles1h,
    candles15m,
    candles5m,
    candles1m,
    lastUpdate: now,
  };
}

