import { AssetType, ScannerConfig, SignalDecision, TradeSignal, TradeOpportunity } from '../src/types.js';
import { analyzeTechnicals } from './indicators.js';
import { partition1hCandles, partition15mCandles, partition5mCandles, partition1mCandles } from './candleUtils.js';
import { fetchCandles, fetchLiveQuote } from './marketData.js';
import { runAIAnalysis } from './geminiTrader.js';
import { BrokerContractSpecs } from './riskManager.js';
import { storage } from './storage.js';
import { mt5Bridge } from './mt5Bridge.js';
import { tradeMonitor } from './tradeMonitor.js';
import { tradeManagementEngine } from './tradeManagementEngine.js';
import { checkStructuralSameSetupIdentity, generateOpportunityId } from './tradeQualityEngine.js';
import { telegramService } from './telegram.js';
import { experienceMemoryEngine } from './experienceMemory.js';

/**
 * Minimum cooldown duration between consecutive market scans (in milliseconds).
 * 45 seconds ensures that standard once-per-minute cron triggers (every 60s) pass seamlessly,
 * while preventing duplicate automatic scans within the same 45-second window.
 */
export const SCAN_MIN_COOLDOWN_MS = 45000;

/**
 * Terminal opportunity statuses representing historical/closed trade lifecycles.
 * A terminal opportunity must NEVER block a new independent signal.
 */
export const TERMINAL_OPPORTUNITY_STATUSES = new Set<string>([
  'FAILED',
  'COMPLETED',
  'CANCELLED',
  'NOT_ENTERED',
]);

export function isTerminalOpportunityStatus(status?: string): boolean {
  if (!status) return false;
  return TERMINAL_OPPORTUNITY_STATUSES.has(status);
}

/**
 * Determines whether the internal Node.js setInterval() scanner loop is enabled.
 * In production (e.g. Render), the external cron scheduler is authoritative, so
 * internal timer can be disabled via ENABLE_INTERNAL_SCANNER=false or SCANNER_TRIGGER_MODE=cron.
 */
export function isInternalTimerEnabled(): boolean {
  if (process.env.ENABLE_INTERNAL_SCANNER === 'false' || process.env.ENABLE_INTERNAL_SCANNER === '0') {
    return false;
  }
  if (process.env.SCANNER_TRIGGER_MODE === 'cron' || process.env.SCANNER_TRIGGER_MODE === 'external') {
    return false;
  }
  if (process.env.ENABLE_INTERNAL_SCANNER === 'true' || process.env.ENABLE_INTERNAL_SCANNER === '1') {
    return true;
  }
  // Default to true for standard autonomous background scanning if not specified
  return true;
}

class LiveMarketScanner {
  private config: ScannerConfig = {
    enabled: true,
    intervalSeconds: 60,
    intervalMinutes: 1,
    minConfidence: 75,
    lastScanTime: null,
    nextScanTime: null,
    lastScanStatus: 'جاهز - المسح المباشر التلقائي نشط كل 60 ثانية (Background Worker)',
    dataStatus: 'Biquote XAUUSD MT5 Feed (Connecting...)',
    lastDecision: null,
    lastSignal: null,
    isScanning: false,
    duplicatePrevented: false,
    activeSetupName: null,
    scanCount: 0,
  };

  private timer: NodeJS.Timeout | null = null;
  private currentBalance: number = 10;
  private losingStreak: number = 0;
  private brokerSpecs: Partial<BrokerContractSpecs> = {};
  private onSignalFoundCallback?: (signal: TradeSignal) => void;

  // Server-side worker telemetry
  private workerStartTime: number = Date.now();
  private lastMarketDataTimestamp: number | null = null;
  private biquoteConnectionStatus: string = 'INITIALIZING';
  private isPaused: boolean = false;

  // Active setup tracking for strict duplicate prevention
  private activeSignal: TradeSignal | null = null;
  private isScanRunning: boolean = false;
  private scanStartTime: number = 0;
  private lastScanCompletedTime: number = 0;
  private lastKnownPrice: number = 0;

  constructor() {
    const internalEnabled = isInternalTimerEnabled();
    console.log(`[SCANNER] Trigger mode: ${internalEnabled ? 'AUTONOMOUS_TIMER' : 'CRON_ONLY'}`);
    console.log(`[SCANNER] Internal timer: ${internalEnabled ? 'ACTIVE' : 'DISABLED'}`);

    // Only start the internal timer loop if internal autonomous timer is enabled
    if (internalEnabled) {
      setTimeout(() => {
        this.start();
      }, 1500);
    }
  }

  public isInternalTimerActive(): boolean {
    return this.timer !== null;
  }

  public getTriggerMode(): 'CRON_ONLY' | 'AUTONOMOUS_TIMER' {
    return isInternalTimerEnabled() ? 'AUTONOMOUS_TIMER' : 'CRON_ONLY';
  }

  public getLastScanCompletedTime(): number {
    return this.lastScanCompletedTime;
  }

  public setLastScanCompletedTimeForTesting(timeMs: number): void {
    this.lastScanCompletedTime = timeMs;
  }

  public isScannerPaused(): boolean {
    return this.isPaused;
  }

  public pause(): boolean {
    this.isPaused = true;
    this.config.isPaused = true;
    this.config.lastScanStatus = 'المسح الآلي متوقف مؤقتًا (PAUSED)';
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.config.nextScanTime = null;
    console.log('[SCANNER] paused');
    return true;
  }

  public resume(): boolean {
    this.isPaused = false;
    this.config.isPaused = false;
    if (this.config.enabled) {
      this.start();
    } else {
      this.config.lastScanStatus = 'المسح الآلي جاهز للاستئناف';
    }
    console.log('[SCANNER] resumed');
    return true;
  }

  public getStatus() {
    const health = this.getHealthReport();
    return {
      ...this.config,
      isPaused: this.isPaused,
      status: this.isPaused ? 'PAUSED' : (this.config.enabled ? 'ONLINE' : 'OFFLINE'),
      health,
    };
  }

  public getConfig(): ScannerConfig {
    return { ...this.config };
  }

  public updateConfig(newConfig: Partial<ScannerConfig>): ScannerConfig {
    const wasEnabled = this.config.enabled;
    const oldInterval = this.config.intervalSeconds;

    this.config = { ...this.config, ...newConfig };

    // Ensure intervalSeconds is 60 by default or as configured
    if (newConfig.intervalSeconds) {
      this.config.intervalMinutes = Number((newConfig.intervalSeconds / 60).toFixed(1));
    } else if (newConfig.intervalMinutes) {
      this.config.intervalSeconds = Math.round(newConfig.intervalMinutes * 60);
    }

    if (!wasEnabled && this.config.enabled) {
      this.start();
    } else if (wasEnabled && !this.config.enabled) {
      this.stop();
    } else if (this.config.enabled && oldInterval !== this.config.intervalSeconds) {
      // Restart interval with new duration
      this.start();
    }

    return { ...this.config };
  }

  public setAccountContext(balance: number, losingStreak: number, brokerSpecs?: Partial<BrokerContractSpecs>) {
    this.currentBalance = balance;
    this.losingStreak = losingStreak;
    if (brokerSpecs) {
      this.brokerSpecs = brokerSpecs;
    }
  }

  public cancelActiveSignal(oppId: string): boolean {
    // 1. Locate opportunity by signal ID, direct opportunity ID, restored ID fallback, or active/dispatched status fallback
    let opp = storage.getOpportunity(oppId) || 
              storage.getOpportunities().find(o => o.signalId === oppId || o.id === oppId);

    if (!opp && oppId.startsWith('restored_')) {
      const cleanId = oppId.replace('restored_', '');
      opp = storage.getOpportunity(cleanId) || storage.getOpportunities().find(o => o.signalId === cleanId || o.id === cleanId);
    }

    if (!opp) {
      // Find any opportunity with active or dispatched status as a final robust fallback
      opp = storage.getOpportunities().find(o => o.status === 'ACTIVE' || o.status === 'DISPATCHED');
    }

    if (!opp) {
      console.warn(`[LiveMarketScanner] Cannot cancel: opportunity ${oppId} not found.`);
      return false;
    }

    // Idempotency check: if already cancelled, update config view states and return true
    if (opp.status === 'CANCELLED') {
      console.log(`[LiveMarketScanner] Opportunity ${opp.id} is already CANCELLED. Making operation idempotent.`);
      this.config.lastSignal = null;
      this.config.lastDecision = 'NO TRADE';
      this.config.activeSetupName = null;
      return true;
    }

    console.log(`[LiveMarketScanner] Manually cancelling active/dispatched opportunity ${opp.id}.`);
    
    // 2. Set status to CANCELLED in storage/memory
    opp.status = 'CANCELLED';
    opp.lastUpdatedTime = Date.now();
    storage.saveOpportunity(opp);

    // Update signal state to CANCELLED/NOT_ENTERED to stop periodic updates
    if (opp.signalId) {
      const signal = storage.getSignalById(opp.signalId);
      if (signal) {
        signal.lifecycleState = 'NOT_ENTERED'; // Stop periodic updates
        storage.saveSignal(signal);
      }
    }

    // 3. Remove it from active signal tracking in memory
    if (this.activeSignal && (this.activeSignal.id === opp.signalId || generateOpportunityId(this.activeSignal) === opp.id || oppId.includes(this.activeSignal.id))) {
      this.activeSignal = null;
      this.config.activeSetupName = null;
    }

    // 4. Ensure the frontend's view configuration is updated instantly to stop displaying it as active
    this.config.lastSignal = null;
    this.config.lastDecision = 'NO TRADE';
    this.config.activeSetupName = null;
    this.config.lastScanStatus = `تم إلغاء الإشارة بنجاح ومنع تكرارها لنموذج: (${opp.setupName})`;

    return true;
  }

  public onSignal(callback: (signal: TradeSignal) => void) {
    this.onSignalFoundCallback = callback;
  }

  public start(forceStartTimer = false) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.config.enabled = true;
    const internalEnabled = forceStartTimer || isInternalTimerEnabled();

    if (!internalEnabled) {
      this.config.lastScanStatus = 'المسح المباشر يعمل بنظام المشغّل الخارجي (CRON_ONLY)';
      this.config.nextScanTime = null;
      console.log('[SCANNER] Trigger mode: CRON_ONLY');
      console.log('[SCANNER] Internal timer: DISABLED (external Cron is authoritative trigger)');
      return;
    }

    const intervalSec = this.config.intervalSeconds || 60;
    this.config.nextScanTime = Date.now() + intervalSec * 1000;
    this.config.lastScanStatus = `المسح المباشر نشط في الخلفية (فحص تلقائي مستقل كل ${intervalSec} ثانية)`;
    console.log('[SCANNER] Trigger mode: AUTONOMOUS_TIMER');
    console.log(`[SCANNER] started (interval: ${intervalSec}s for XAU/USD via Biquote)`);

    // Immediate initial scan
    this.runScan('XAU/USD', { source: 'timer' });

    // Recurring scan every interval seconds (default: 60s)
    this.timer = setInterval(() => {
      console.log('[SCANNER] tick');
      this.runScan('XAU/USD', { source: 'timer' });
    }, intervalSec * 1000);
  }

  public stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.config.enabled = false;
    this.config.nextScanTime = null;
    this.config.lastScanStatus = 'المسح الآلي متوقف مؤقتًا';
    console.log('[SCANNER] stopped');
  }

  /**
   * Core Live Scan Execution
   * Strictly uses Biquote XAUUSD as the ONLY market-data source
   * 1. Fetch current price
   * 2. Fetch 1H, 15M, and 5M OHLCV / tick-volume
   * 3. Calculate technical and market-structure indicators
   * 4. Analyze market via trading strategy
   * 5. Return exactly one decision: BUY NOW, SELL NOW, BUY LIMIT, SELL LIMIT, NO TRADE
   * 6. Prevent duplicate signals if same setup is still active
   * 7. Store every scan and every generated signal in persistent storage
   */
  public async runScan(
    asset: AssetType = 'XAU/USD',
    options?: { source?: 'cron' | 'manual' | 'timer' | 'startup'; force?: boolean }
  ): Promise<TradeSignal | null> {
    const source = options?.source || 'cron';
    const force = options?.force || false;

    if (this.isPaused && !force) {
      if (source === 'cron') {
        console.log('[SCANNER] Cron tick: SKIPPED_PAUSED (Scanner is paused)');
      } else if (source === 'manual') {
        console.log('[SCANNER] Manual scan: SKIPPED (Scanner is paused)');
      } else {
        console.log(`[SCANNER] ${source}: SKIPPED_PAUSED (Scanner is paused)`);
      }
      return this.config.lastSignal || null;
    }

    if (this.isScanRunning) {
      const runningDuration = Date.now() - (this.scanStartTime || 0);
      if (runningDuration > 35000) {
        console.warn(`[SCANNER] Warning: Previous scan hung for ${runningDuration}ms. Resetting running lock.`);
        this.isScanRunning = false;
        this.config.isScanning = false;
      } else {
        if (source === 'cron') {
          console.log('[SCANNER] Cron tick: SKIPPED_IN_FLIGHT (Scan already in progress)');
        } else if (source === 'manual') {
          console.log('[SCANNER] Manual scan: SKIPPED (Scan already in progress)');
        } else {
          console.log(`[SCANNER] ${source}: SKIPPED_IN_FLIGHT (Scan already in progress)`);
        }
        return this.config.lastSignal || null;
      }
    }

    const now = Date.now();
    const elapsedSinceLastScan = now - this.lastScanCompletedTime;
    if (!force && this.lastScanCompletedTime > 0 && elapsedSinceLastScan < SCAN_MIN_COOLDOWN_MS) {
      const remainingSec = Math.ceil((SCAN_MIN_COOLDOWN_MS - elapsedSinceLastScan) / 1000);
      if (source === 'cron') {
        console.log(`[SCANNER] Cron tick: SKIPPED_COOLDOWN (${elapsedSinceLastScan}ms elapsed < 45s cooldown, ${remainingSec}s remaining)`);
      } else if (source === 'manual') {
        console.log(`[SCANNER] Manual scan: SKIPPED (Cooldown active: ${remainingSec}s remaining)`);
      } else {
        console.log(`[SCANNER] ${source}: SKIPPED_COOLDOWN (${remainingSec}s remaining)`);
      }
      return this.config.lastSignal || null;
    }

    if (source === 'cron') {
      console.log('[SCANNER] Cron tick: EXECUTING');
    } else if (source === 'manual') {
      console.log('[SCANNER] Manual scan: EXECUTING');
    }

    this.isScanRunning = true;
    this.scanStartTime = Date.now();
    this.config.isScanning = true;
    this.config.lastScanTime = Date.now();
    const intervalSec = this.config.intervalSeconds || 60;
    this.config.nextScanTime = Date.now() + intervalSec * 1000;
    console.log(`[SCANNER] scan started for ${asset} (source: ${source})`);

    try {
      this.config.lastScanStatus = `جارٍ فحص الذهب XAU/USD مباشرة عبر Biquote MT5...`;

      // Step 1: Fetch live quote & current price from Biquote only
      const quote = await fetchLiveQuote(asset);
      const currentPrice = Number(quote.mid.toFixed(2));
      const liveSpread = typeof quote.spread === 'number' ? quote.spread : Number(quote.spread);
      const spreadPoints = Number((liveSpread / 0.1).toFixed(1));

      this.lastKnownPrice = currentPrice;
      this.lastMarketDataTimestamp = Date.now();
      this.biquoteConnectionStatus = `CONNECTED (Bid: ${quote.bid} / Ask: ${quote.ask} / Spread: ${spreadPoints} pts)`;
      this.config.dataStatus = `Connected (Biquote MT5 Feed - Bid: ${quote.bid} / Ask: ${quote.ask} / Spread: ${spreadPoints} pts)`;

      // Task 1: Fail closed if spread is invalid, non-numeric, negative, or excessive (> 12.0 pts / $1.20)
      if (isNaN(liveSpread) || liveSpread <= 0 || spreadPoints > 12.0) {
        const spreadErrorReason = isNaN(liveSpread) || liveSpread <= 0
          ? `SPREAD_INVALID: السبريد غير صالح أو غير متوفر في الأسعار الحية (Spread: ${quote.spread})`
          : `SPREAD_EXCESSIVE: السبريد الحالي (${spreadPoints} نقطة / $${liveSpread.toFixed(2)}) يتجاوز الحد الأقصى الآمن للتداول (12.0 نقطة)`;
        
        console.warn(`[LiveMarketScanner] ${spreadErrorReason}. Blocking trade scan.`);
        this.config.scanCount += 1;
        this.config.lastScanStatus = spreadErrorReason;
        const noTradeSignal: TradeSignal = {
          id: `scan_spread_block_${Date.now()}`,
          timestamp: Date.now(),
          asset,
          signal: 'NO TRADE',
          currentPrice,
          entry: currentPrice,
          stopLoss: currentPrice,
          slPoints: 0,
          tp1: currentPrice,
          tp1Points: 0,
          tp1Rr: 0,
          tp1RrString: '1:0',
          tp2: currentPrice,
          tp2Points: 0,
          tp2Rr: 0,
          tp2RrString: '1:0',
          primaryTarget: 'TP1',
          rr: '1:0',
          rrRatio: 0,
          riskPercent: 0,
          riskAmount: 0,
          potentialProfit: 0,
          potentialLoss: 0,
          recommendedLotSize: 0,
          confidence: 0,
          timeframe: '5M',
          setup: 'SPREAD_GUARD_BLOCK',
          mainReasons: [spreadErrorReason],
          invalidation: 'Spread outside acceptable execution boundaries',
          noTradeReason: spreadErrorReason,
        };

        storage.saveScan({
          id: `scan_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          timestamp: Date.now(),
          asset,
          price: currentPrice,
          signal: 'NO TRADE',
          decision: 'NO TRADE',
          strategy: 'Spread Execution Quality Gate',
          confidence: 0,
          status: 'SPREAD_GUARD_BLOCK',
          rejectionReason: spreadErrorReason,
          details: {
            reason: spreadErrorReason,
            liveSpread,
            spreadPoints,
          },
        });

        return noTradeSignal;
      }

      // Evaluate active open trades lifecycle against live quote
      tradeMonitor.evaluatePrice(currentPrice).catch((err) => {
        console.error('[LiveMarketScanner] Trade monitor evaluation error:', err);
      });

      // Step 2: Fetch 1H, 15M, and 5M (and 1M) OHLCV / tick-volume from Biquote only
      const [candles1h, candles15m, candles5m, candles1m] = await Promise.all([
        fetchCandles(asset, '1h', 500),
        fetchCandles(asset, '15m', 500),
        fetchCandles(asset, '5m', 500),
        fetchCandles(asset, '1m', 100),
      ]);

      console.log(`[SCANNER] market data loaded: price=${currentPrice}, 1h=${candles1h.length}, 15m=${candles15m.length}, 5m=${candles5m.length}`);

      // Step 3: Calculate required technical/market-structure data
      // Partition candles across all timeframes so technical analysis and AI receive ONLY closed candles
      const quoteTime = typeof quote.timestamp === 'number' ? quote.timestamp : (Number(quote.timestamp) || Date.now());
      const partition1h = partition1hCandles(candles1h, quoteTime);
      const closedCandles1h = partition1h.isValid && partition1h.closedCandles.length > 0
        ? partition1h.closedCandles
        : candles1h;

      const partition15m = partition15mCandles(candles15m, quoteTime);
      const closedCandles15m = partition15m.isValid && partition15m.closedCandles.length > 0
        ? partition15m.closedCandles
        : candles15m;

      const partition5m = partition5mCandles(candles5m, quoteTime);
      const closedCandles5m = partition5m.isValid && partition5m.closedCandles.length > 0
        ? partition5m.closedCandles
        : candles5m;

      const partition1m = partition1mCandles(candles1m, quoteTime);
      const closedCandles1m = partition1m.isValid && partition1m.closedCandles.length > 0
        ? partition1m.closedCandles
        : candles1m;

      const ind1h = analyzeTechnicals(closedCandles1h);
      const ind15m = analyzeTechnicals(closedCandles15m);
      const ind5m = analyzeTechnicals(closedCandles5m);

      // Synchronize in-flight trade state with TradeLedger & TradeMonitor
      const allTrades = storage.getTrades(300);
      const openTrades = allTrades.filter((t) => t.result === 'OPEN' && t.isActive !== false);
      const outcomes = storage.getTradeOutcomes();

      // Reconcile stale/orphan opportunities against authoritative trade ledger & trade outcomes
      {
        const activeOrDispatchedOpps = storage.getOpportunities().filter(
          (o) => o.status === 'ACTIVE' || o.status === 'DISPATCHED'
        );

        for (const opp of activeOrDispatchedOpps) {
          // Check if there is an authoritative trade resolution in trade_ledger or trade_outcomes
          const matchingTrade = allTrades.find(
            (t) =>
              t.id === opp.id ||
              t.id === opp.signalId ||
              (t as any).signalId === opp.id ||
              (t as any).signalId === opp.signalId
          );
          const matchingOutcome = outcomes.find(
            (out) =>
              out.signalId === opp.signalId ||
              out.signalId === opp.id ||
              out.tradeId === opp.signalId ||
              out.tradeId === opp.id
          );

          const isResolvedInLedger = matchingTrade && matchingTrade.result !== 'OPEN';
          const isResolvedInOutcomes = matchingOutcome && !!matchingOutcome.outcome;

          if (isResolvedInLedger || isResolvedInOutcomes) {
            const isNotEntered =
              (matchingOutcome && matchingOutcome.outcome === 'NOT_ENTERED') ||
              (matchingTrade && (matchingTrade.result as any) === 'NOT_ENTERED');

            if (isNotEntered) {
              opp.status = 'NOT_ENTERED';
              opp.lastUpdatedTime = Date.now();
              storage.saveOpportunity(opp);
              console.log(
                `[LiveMarketScanner] Reconciled unentered opportunity ${opp.id} (signal: ${opp.signalId}) as NOT_ENTERED.`
              );
              continue;
            }

            const isWin =
              (matchingTrade && matchingTrade.result === 'WIN') ||
              (matchingOutcome && matchingOutcome.outcome === 'WIN');
            const isCancelled =
              (matchingTrade && (matchingTrade.result === 'CANCELLED' || matchingTrade.result === 'VOID')) ||
              (matchingOutcome && ((matchingOutcome.outcome as string) === 'VOID' || (matchingOutcome.outcome as string) === 'CANCELLED'));

            opp.status = isWin ? 'COMPLETED' : (isCancelled ? 'CANCELLED' : 'FAILED');
            if (isWin) opp.completedAt = opp.completedAt || Date.now();
            else opp.failedAt = opp.failedAt || Date.now();
            opp.lastUpdatedTime = Date.now();
            storage.saveOpportunity(opp);
            console.log(
              `[LiveMarketScanner] Reconciled stale opportunity ${opp.id} (signal: ${opp.signalId}) with authoritative closed trade -> ${opp.status}`
            );
            continue;
          }

          // Check if there is an authoritative active open trade in openTrades
          const hasOpenTrade = openTrades.some(
            (t) =>
              t.id === opp.id ||
              t.id === opp.signalId ||
              (t as any).signalId === opp.id ||
              (t as any).signalId === opp.signalId
          );

          if (!hasOpenTrade) {
            // A recently dispatched or active opportunity must NOT be demoted to NOT_ENTERED immediately,
            // because it may be awaiting the user's manual trade entry or Telegram action (WIN / LOSS / NOT ENTERED).
            // Only genuinely stale opportunities (e.g. older than 4 hours without an open trade or resolution)
            // should be automatically cleaned up as NOT_ENTERED.
            const oppAgeMs = Date.now() - (opp.dispatchedAt || opp.firstObservedTime || opp.lastUpdatedTime || 0);
            const STALE_UNENTERED_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

            if (oppAgeMs > STALE_UNENTERED_THRESHOLD_MS) {
              // Truly stale unentered opportunity from a prior session or hours ago without execution.
              // Mark it NOT_ENTERED to clean up stale state.
              opp.status = 'NOT_ENTERED';
              opp.lastUpdatedTime = Date.now();
              storage.saveOpportunity(opp);
              console.log(
                `[LiveMarketScanner] Stale unentered opportunity ${opp.id} (signal: ${opp.signalId}, age: ${Math.round(oppAgeMs / 60000)}m) marked NOT_ENTERED (exceeded stale threshold with no open trade).`
              );
            } else {
              // Keep recent ACTIVE / DISPATCHED opportunity protected while awaiting trade action.
              console.log(
                `[LiveMarketScanner] Preserving active/dispatched opportunity ${opp.id} (signal: ${opp.signalId}, age: ${Math.round(oppAgeMs / 60000)}m) awaiting execution/user action.`
              );
            }
          }
        }
      }

      // Restore activeSignal ONLY if there is a legitimate corresponding open trade in openTrades
      if (!this.activeSignal && openTrades.length > 0) {
        // Find if any legitimate ACTIVE/DISPATCHED opportunity matches an open trade
        const legitimateOpp = storage.getOpportunities().find(
          (o) =>
            (o.status === 'ACTIVE' || o.status === 'DISPATCHED') &&
            openTrades.some(
              (t) =>
                t.id === o.id ||
                t.id === o.signalId ||
                (t as any).signalId === o.id ||
                (t as any).signalId === o.signalId
            )
        );

        if (legitimateOpp) {
          const originalSignal = legitimateOpp.signalId ? storage.getSignal(legitimateOpp.signalId) : undefined;
          if (originalSignal) {
            this.activeSignal = {
              ...originalSignal,
              currentPrice,
            };
          } else {
            const dir = legitimateOpp.direction === 'BUY' ? 'BUY NOW' : 'SELL NOW';
            this.activeSignal = {
              id: legitimateOpp.signalId || `restored_${legitimateOpp.id}`,
              timestamp: legitimateOpp.firstObservedTime,
              asset,
              signal: dir,
              currentPrice,
              entry: legitimateOpp.entry,
              stopLoss: legitimateOpp.stopLoss,
              slPoints: Math.round(Math.abs(legitimateOpp.entry - legitimateOpp.stopLoss) / 0.1),
              tp1: legitimateOpp.tp1,
              tp1Points: Math.round(Math.abs(legitimateOpp.tp1 - legitimateOpp.entry) / 0.1),
              tp1Rr: typeof (legitimateOpp as any).tp1Rr === 'number'
                ? (legitimateOpp as any).tp1Rr
                : (Math.abs(legitimateOpp.entry - legitimateOpp.stopLoss) > 0 ? Number((Math.abs(legitimateOpp.tp1 - legitimateOpp.entry) / Math.abs(legitimateOpp.entry - legitimateOpp.stopLoss)).toFixed(2)) : 0),
              tp1RrString: (legitimateOpp as any).tp1RrString || (Math.abs(legitimateOpp.entry - legitimateOpp.stopLoss) > 0 ? `1:${(Math.abs(legitimateOpp.tp1 - legitimateOpp.entry) / Math.abs(legitimateOpp.entry - legitimateOpp.stopLoss)).toFixed(2)}` : 'N/A'),
              tp2: (legitimateOpp.tp2 && legitimateOpp.tp2 > 0 && Math.abs(legitimateOpp.tp2 - legitimateOpp.entry) > 0.01) ? legitimateOpp.tp2 : 0,
              tp2Points: (legitimateOpp.tp2 && legitimateOpp.tp2 > 0 && Math.abs(legitimateOpp.tp2 - legitimateOpp.entry) > 0.01) ? Math.round(Math.abs(legitimateOpp.tp2 - legitimateOpp.entry) / 0.1) : 0,
              tp2Rr: (legitimateOpp.tp2 && legitimateOpp.tp2 > 0)
                ? (typeof (legitimateOpp as any).tp2Rr === 'number' ? (legitimateOpp as any).tp2Rr : (Math.abs(legitimateOpp.entry - legitimateOpp.stopLoss) > 0 ? Number((Math.abs(legitimateOpp.tp2 - legitimateOpp.entry) / Math.abs(legitimateOpp.entry - legitimateOpp.stopLoss)).toFixed(2)) : 0))
                : 0,
              tp2RrString: (legitimateOpp.tp2 && legitimateOpp.tp2 > 0)
                ? ((legitimateOpp as any).tp2RrString || (Math.abs(legitimateOpp.entry - legitimateOpp.stopLoss) > 0 ? `1:${(Math.abs(legitimateOpp.tp2 - legitimateOpp.entry) / Math.abs(legitimateOpp.entry - legitimateOpp.stopLoss)).toFixed(2)}` : 'N/A'))
                : 'N/A',
              primaryTarget: 'TP1',
              rr: (legitimateOpp.tp2 && legitimateOpp.tp2 > 0 && Math.abs(legitimateOpp.entry - legitimateOpp.stopLoss) > 0)
                ? `TP1: 1:${(Math.abs(legitimateOpp.tp1 - legitimateOpp.entry) / Math.abs(legitimateOpp.entry - legitimateOpp.stopLoss)).toFixed(2)} | TP2: 1:${(Math.abs(legitimateOpp.tp2 - legitimateOpp.entry) / Math.abs(legitimateOpp.entry - legitimateOpp.stopLoss)).toFixed(2)}`
                : `1:${Math.abs(legitimateOpp.entry - legitimateOpp.stopLoss) > 0 ? (Math.abs(legitimateOpp.tp1 - legitimateOpp.entry) / Math.abs(legitimateOpp.entry - legitimateOpp.stopLoss)).toFixed(2) : '1.00'}`,
              rrRatio: Math.abs(legitimateOpp.entry - legitimateOpp.stopLoss) > 0 ? Number((Math.abs(legitimateOpp.tp1 - legitimateOpp.entry) / Math.abs(legitimateOpp.entry - legitimateOpp.stopLoss)).toFixed(2)) : 1.0,
              riskPercent: 15,
              riskAmount: 0,
              potentialProfit: 0,
              potentialLoss: 0,
              recommendedLotSize: 0.01,
              confidence: legitimateOpp.confidence,
              timeframe: legitimateOpp.timeframe,
              setup: legitimateOpp.setupName,
              mainReasons: ['Restored from persistent storage with active open trade'],
              invalidation: legitimateOpp.direction === 'BUY'
                ? `Close candle below ${legitimateOpp.stopLoss}`
                : `Close candle above ${legitimateOpp.stopLoss}`,
            };
          }
          this.config.activeSetupName = this.activeSignal.setup;
          this.config.lastSignal = this.activeSignal;
          console.log(
            `[LiveMarketScanner] Restored activeSignal for legitimate open trade from opportunity ${legitimateOpp.id} (signal: ${this.activeSignal.id})`
          );
        } else {
          // If open trade exists in ledger but no opportunity was matched, build activeSignal from the open trade
          const primaryOpenTrade = openTrades[0];
          const restoredDir = primaryOpenTrade.direction
            ? (String(primaryOpenTrade.direction).toUpperCase().includes('BUY') ? 'BUY NOW' : 'SELL NOW')
            : (Number(primaryOpenTrade.entry) > Number(primaryOpenTrade.sl) ? 'BUY NOW' : 'SELL NOW');

          this.activeSignal = {
            id: primaryOpenTrade.id,
            timestamp: primaryOpenTrade.isoTime ? new Date(primaryOpenTrade.isoTime).getTime() : Date.now(),
            asset: (primaryOpenTrade.asset as any) || asset,
            signal: restoredDir as any,
            currentPrice,
            entry: Number(primaryOpenTrade.entry),
            stopLoss: Number(primaryOpenTrade.sl),
            slPoints: primaryOpenTrade.slPoints || Math.round(Math.abs(Number(primaryOpenTrade.entry) - Number(primaryOpenTrade.sl)) / 0.1),
            tp1: Number(primaryOpenTrade.tp1),
            tp1Points: primaryOpenTrade.tp1Points || Math.round(Math.abs(Number(primaryOpenTrade.tp1) - Number(primaryOpenTrade.entry)) / 0.1),
            tp1Rr: typeof (primaryOpenTrade as any).tp1Rr === 'number'
              ? (primaryOpenTrade as any).tp1Rr
              : (Math.abs(Number(primaryOpenTrade.entry) - Number(primaryOpenTrade.sl)) > 0
                ? Number((Math.abs(Number(primaryOpenTrade.tp1) - Number(primaryOpenTrade.entry)) / Math.abs(Number(primaryOpenTrade.entry) - Number(primaryOpenTrade.sl))).toFixed(2))
                : 0),
            tp1RrString: (primaryOpenTrade as any).tp1RrString || (Math.abs(Number(primaryOpenTrade.entry) - Number(primaryOpenTrade.sl)) > 0
              ? `1:${(Math.abs(Number(primaryOpenTrade.tp1) - Number(primaryOpenTrade.entry)) / Math.abs(Number(primaryOpenTrade.entry) - Number(primaryOpenTrade.sl))).toFixed(2)}`
              : 'N/A'),
            tp2: (primaryOpenTrade.tp2 && Number(primaryOpenTrade.tp2) > 0 && Math.abs(Number(primaryOpenTrade.tp2) - Number(primaryOpenTrade.entry)) > 0.01) ? Number(primaryOpenTrade.tp2) : 0,
            tp2Points: (primaryOpenTrade.tp2 && Number(primaryOpenTrade.tp2) > 0 && Math.abs(Number(primaryOpenTrade.tp2) - Number(primaryOpenTrade.entry)) > 0.01) ? Math.round(Math.abs(Number(primaryOpenTrade.tp2) - Number(primaryOpenTrade.entry)) / 0.1) : 0,
            tp2Rr: (primaryOpenTrade.tp2 && Number(primaryOpenTrade.tp2) > 0)
              ? (typeof (primaryOpenTrade as any).tp2Rr === 'number' ? (primaryOpenTrade as any).tp2Rr : (Math.abs(Number(primaryOpenTrade.entry) - Number(primaryOpenTrade.sl)) > 0
                ? Number((Math.abs(Number(primaryOpenTrade.tp2) - Number(primaryOpenTrade.entry)) / Math.abs(Number(primaryOpenTrade.entry) - Number(primaryOpenTrade.sl))).toFixed(2))
                : 0))
              : 0,
            tp2RrString: (primaryOpenTrade.tp2 && Number(primaryOpenTrade.tp2) > 0)
              ? ((primaryOpenTrade as any).tp2RrString || (Math.abs(Number(primaryOpenTrade.entry) - Number(primaryOpenTrade.sl)) > 0
                ? `1:${(Math.abs(Number(primaryOpenTrade.tp2) - Number(primaryOpenTrade.entry)) / Math.abs(Number(primaryOpenTrade.entry) - Number(primaryOpenTrade.sl))).toFixed(2)}`
                : 'N/A'))
              : 'N/A',
            primaryTarget: 'TP1',
            rr: primaryOpenTrade.rr || ((primaryOpenTrade.tp2 && Number(primaryOpenTrade.tp2) > 0 && Math.abs(Number(primaryOpenTrade.entry) - Number(primaryOpenTrade.sl)) > 0)
              ? `TP1: 1:${(Math.abs(Number(primaryOpenTrade.tp1) - Number(primaryOpenTrade.entry)) / Math.abs(Number(primaryOpenTrade.entry) - Number(primaryOpenTrade.sl))).toFixed(2)} | TP2: 1:${(Math.abs(Number(primaryOpenTrade.tp2) - Number(primaryOpenTrade.entry)) / Math.abs(Number(primaryOpenTrade.entry) - Number(primaryOpenTrade.sl))).toFixed(2)}`
              : `1:${Math.abs(Number(primaryOpenTrade.entry) - Number(primaryOpenTrade.sl)) > 0 ? (Math.abs(Number(primaryOpenTrade.tp1) - Number(primaryOpenTrade.entry)) / Math.abs(Number(primaryOpenTrade.entry) - Number(primaryOpenTrade.sl))).toFixed(2) : '1.00'}`),
            rrRatio: Math.abs(Number(primaryOpenTrade.entry) - Number(primaryOpenTrade.sl)) > 0
              ? Number((Math.abs(Number(primaryOpenTrade.tp1) - Number(primaryOpenTrade.entry)) / Math.abs(Number(primaryOpenTrade.entry) - Number(primaryOpenTrade.sl))).toFixed(2))
              : 1.0,
            riskPercent: primaryOpenTrade.riskPercent || 15,
            riskAmount: primaryOpenTrade.riskAmount || 0,
            potentialProfit: 0,
            potentialLoss: 0,
            recommendedLotSize: primaryOpenTrade.lotSize || 0.01,
            confidence: primaryOpenTrade.confidence || 80,
            timeframe: '15M / 5M',
            setup: primaryOpenTrade.setup || 'Active Trade',
            mainReasons: ['Restored from authoritative open trade in ledger'],
            invalidation: (restoredDir === 'BUY NOW'
              ? `Close candle below ${primaryOpenTrade.sl}`
              : `Close candle above ${primaryOpenTrade.sl}`),
          };
          this.config.activeSetupName = this.activeSignal.setup;
          this.config.lastSignal = this.activeSignal;
          console.log(
            `[LiveMarketScanner] Restored activeSignal directly from open ledger trade ${primaryOpenTrade.id} (${primaryOpenTrade.setup})`
          );
        }
      }

      // Check if our activeSignal was marked NOT_ENTERED or closed in the trade ledger
      if (this.activeSignal) {
        const sigState = storage.getSignal(this.activeSignal.id)?.lifecycleState;
        const outcomeState = storage.getTradeOutcome(this.activeSignal.id)?.outcome;

        if (sigState === 'NOT_ENTERED' || outcomeState === 'NOT_ENTERED') {
          console.log(`[LiveMarketScanner] Signal ${this.activeSignal.id} marked NOT_ENTERED. Clearing activeSignal.`);
          this.activeSignal = null;
          this.config.activeSetupName = null;
        } else {
          const matchingTrade = allTrades.find(
            (t) =>
              t.id === this.activeSignal?.id ||
              (t as any).signalId === this.activeSignal?.id
          );
          if (matchingTrade && matchingTrade.result !== 'OPEN') {
            console.log(`[LiveMarketScanner] Active trade ${this.activeSignal.id} is closed in ledger (${matchingTrade.result}). Clearing activeSignal.`);
            const oppId = generateOpportunityId(this.activeSignal);
            const opp =
              storage.getOpportunity(oppId) ||
              storage.getOpportunity(this.activeSignal.id) ||
              storage.getOpportunities().find(o => o.signalId === this.activeSignal?.id);
            if (opp) {
              const isNotEnteredTrade = (matchingTrade.result as any) === 'NOT_ENTERED';
              opp.status = isNotEnteredTrade ? 'NOT_ENTERED' : (matchingTrade.result === 'WIN' ? 'COMPLETED' : 'FAILED');
              if (opp.status === 'FAILED') opp.failedAt = Date.now();
              else if (opp.status === 'COMPLETED') opp.completedAt = Date.now();
              opp.lastUpdatedTime = Date.now();
              storage.saveOpportunity(opp);
            }
            this.activeSignal = null;
            this.config.activeSetupName = null;
          }
        }
      }

      // Check active signal status against live price (TP / SL reached)
      if (this.activeSignal && this.activeSignal.signal !== 'NO TRADE') {
        const isBuy = this.activeSignal.signal.includes('BUY');
        const hasTp2 = Boolean(this.activeSignal.tp2 && Number(this.activeSignal.tp2) > 0);
        const slHit = isBuy
          ? currentPrice <= this.activeSignal.stopLoss
          : currentPrice >= this.activeSignal.stopLoss;
        const tp2Hit = hasTp2
          ? (isBuy ? currentPrice >= Number(this.activeSignal.tp2) : currentPrice <= Number(this.activeSignal.tp2))
          : false;
        const tp1Hit = !hasTp2 && Boolean(this.activeSignal.tp1 && Number(this.activeSignal.tp1) > 0)
          ? (isBuy ? currentPrice >= Number(this.activeSignal.tp1) : currentPrice <= Number(this.activeSignal.tp1))
          : false;

        if (slHit) {
          console.log(`[LiveMarketScanner] Active setup ${this.activeSignal.setup} hit Stop Loss. Resetting active setup.`);
          const oppId = generateOpportunityId(this.activeSignal);
          const opp =
            storage.getOpportunity(oppId) ||
            storage.getOpportunity(this.activeSignal.id) ||
            storage.getOpportunities().find(o => o.signalId === this.activeSignal?.id);
          if (opp) {
            opp.status = 'FAILED';
            opp.failedAt = Date.now();
            opp.lastUpdatedTime = Date.now();
            storage.saveOpportunity(opp);
          }
          this.activeSignal = null;
          this.config.activeSetupName = null;
        } else if (tp2Hit || tp1Hit) {
          console.log(`[LiveMarketScanner] Active setup ${this.activeSignal.setup} reached target. Resetting active setup.`);
          const oppId = generateOpportunityId(this.activeSignal);
          const opp =
            storage.getOpportunity(oppId) ||
            storage.getOpportunity(this.activeSignal.id) ||
            storage.getOpportunities().find(o => o.signalId === this.activeSignal?.id);
          if (opp) {
            // Only mark as COMPLETED if there is authoritative evidence that the trade was entered in ledger
            const hasEnteredTrade = allTrades.some(
              (t) =>
                t.id === this.activeSignal?.id ||
                (t as any).signalId === this.activeSignal?.id ||
                t.id === opp.id ||
                t.id === opp.signalId
            );
            if (hasEnteredTrade) {
              opp.status = 'COMPLETED';
              opp.completedAt = Date.now();
            } else {
              opp.status = 'NOT_ENTERED';
            }
            opp.lastUpdatedTime = Date.now();
            storage.saveOpportunity(opp);
          }
          this.activeSignal = null;
          this.config.activeSetupName = null;
        }
      }

      // Determine active trade direction for opposition guard
      let activeTradeDirection: 'BUY' | 'SELL' | null = null;
      if (openTrades.length > 0) {
        activeTradeDirection = openTrades[0].direction.toUpperCase().includes('BUY') ? 'BUY' : 'SELL';
      } else if (this.activeSignal && this.activeSignal.signal !== 'NO TRADE') {
        activeTradeDirection = this.activeSignal.signal.toUpperCase().includes('BUY') ? 'BUY' : 'SELL';
      }

      // Step 4: Sync with global settings and evaluate activeCapital
      const settings = storage.getSettings();
      let activeCapital = settings.manualCapital;
      let isExecutionBlocked = false;
      let blockReason = '';

      // Phase 4: Continuous Trade Lifecycle & Health Management for active open trades
      if (openTrades.length > 0 && settings.enableTradeManagement !== false) {
        tradeManagementEngine
          .evaluateActiveTrades(
            currentPrice,
            closedCandles1h,
            closedCandles15m,
            closedCandles5m,
            closedCandles1m,
            ind1h,
            ind15m,
            ind5m,
            activeCapital,
            settings
          )
          .catch((err) => {
            console.error('[LiveMarketScanner] Trade management engine evaluation error:', err);
          });
      }

      if (settings.capitalSource === 'MT5') {
        const mt5Status = await mt5Bridge.getAccountStatus();
        if (mt5Status.connected && typeof mt5Status.balance === 'number' && mt5Status.balance > 0) {
          activeCapital = mt5Status.balance;
        } else {
          isExecutionBlocked = true;
          blockReason = 'MT5 / Broker is DISCONNECTED. Execution blocked (حساب MT5 غير متصل - تم حظر فتح صفقات جديدة).';
          activeCapital = 0;
        }
      } else if (activeCapital <= 0) {
        isExecutionBlocked = true;
        blockReason = 'Manual capital must be greater than $0.00. Execution blocked.';
      }

      this.currentBalance = activeCapital;
      this.brokerSpecs = {
        accountBalance: activeCapital,
        riskPercent: settings.riskPerTrade,
        contractSizeOz: settings.contractSizeOz,
        minimumLot: settings.minimumLot,
        maximumLot: settings.maximumLot,
        lotStep: settings.lotStep,
        minGoldSlPoints: settings.minGoldSlPoints ?? 35,
        maxGoldSlPoints: settings.maxGoldSlPoints ?? 85,
        minRr: settings.minTp1RR,
        maxLoss: settings.maxLoss,
      };
      this.config.minConfidence = settings.minimumConfidence;

      if (isExecutionBlocked) {
        this.config.scanCount += 1;
        const noTradeSignal: TradeSignal = {
          id: `scan_${Date.now()}`,
          timestamp: Date.now(),
          asset,
          signal: 'NO TRADE',
          currentPrice,
          entry: currentPrice,
          stopLoss: currentPrice,
          slPoints: 0,
          tp1: currentPrice,
          tp1Points: 0,
          tp1Rr: 0,
          tp1RrString: '1:0',
          tp2: currentPrice,
          tp2Points: 0,
          tp2Rr: 0,
          tp2RrString: '1:0',
          primaryTarget: 'TP1',
          rr: '1:0',
          rrRatio: 0,
          riskPercent: 0,
          riskAmount: 0,
          potentialProfit: 0,
          potentialLoss: 0,
          recommendedLotSize: 0,
          confidence: 0,
          timeframe: '5M',
          setup: 'CAPITAL_GUARD_BLOCK',
          mainReasons: [blockReason],
          invalidation: 'N/A',
          noTradeReason: blockReason,
        };

        storage.saveScan({
          id: noTradeSignal.id,
          timestamp: Date.now(),
          isoTime: new Date().toISOString(),
          currentPrice,
          signal: 'NO TRADE',
          entry: currentPrice,
          stopLoss: currentPrice,
          slPoints: 0,
          tp1: currentPrice,
          tp1Points: 0,
          tp1Rr: '1:0',
          tp2: currentPrice,
          tp2Points: 0,
          tp2Rr: '1:0',
          rr: '1:0',
          confidence: 0,
          riskPercent: 0,
          riskAmount: 0,
          lotSize: 0,
          setup: 'CAPITAL_GUARD_BLOCK',
          reasons: [blockReason],
          status: 'NO TRADE',
          invalidation: 'N/A',
          noTradeReason: blockReason,
        });

        return noTradeSignal;
      }

      // Step 5: Analyze market using existing trading strategy
      console.log('[SCANNER] AI analysis started');
      const signal = await runAIAnalysis({
        asset,
        balance: this.currentBalance,
        currentPrice,
        indicators1h: ind1h,
        indicators15m: ind15m,
        indicators5m: ind5m,
        candles1h: closedCandles1h,
        candles15m: closedCandles15m,
        recent5mCandles: closedCandles5m,
        recent1mCandles: closedCandles1m,
        losingStreak: this.losingStreak,
        brokerSpecs: this.brokerSpecs,
        activeTradeDirection,
        currentSpread: liveSpread,
      });
      console.log('[SCANNER] AI analysis completed');
      console.log(`[SCANNER] result: ${signal.signal}`);

      this.config.scanCount += 1;

      // Check if candidate signal opposes an active in-flight trade
      const isOpposingActiveTrade =
        activeTradeDirection !== null &&
        signal.signal !== 'NO TRADE' &&
        ((activeTradeDirection === 'BUY' && signal.signal.toUpperCase().includes('SELL')) ||
          (activeTradeDirection === 'SELL' && signal.signal.toUpperCase().includes('BUY')));

      // Check structural same-setup identity against active in-flight trade
      const structuralIdentity = checkStructuralSameSetupIdentity(signal, this.activeSignal);
      const isSameSetupActive = structuralIdentity.isDuplicate;

      // Status text for storage
      let scanResultStatus = 'NO TRADE';
      if (signal.signal !== 'NO TRADE') {
        if (isOpposingActiveTrade) {
          scanResultStatus = 'OPPOSING_ACTIVE_BLOCKED';
        } else if (isSameSetupActive) {
          scanResultStatus = structuralIdentity.status;
        } else {
          scanResultStatus = 'QUALIFIED_SIGNAL';
        }
      }

      const scanId = `scan_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

      // Resolve dynamic rejection / descriptive reason for this scan record
      let dynamicRejectionReason = signal.noTradeReason;
      if (signal.signal !== 'NO TRADE' && signal.confidence < this.config.minConfidence) {
        dynamicRejectionReason = `نسبة الثقة في الإشارة (${signal.confidence}%) أقل من الحد الأدنى المطلوب (${this.config.minConfidence}%).`;
      } else if (isOpposingActiveTrade) {
        dynamicRejectionReason = `صفقة ${activeTradeDirection} جارية حالياً | تم حظر إشارة ${signal.signal} المعارضة لمنع التضارب`;
      } else if (isSameSetupActive) {
        dynamicRejectionReason = `الصفقة لا تزال جارية (${structuralIdentity.status})`;
      } else if (!dynamicRejectionReason && signal.mainReasons && signal.mainReasons.length > 0) {
        dynamicRejectionReason = signal.mainReasons[0];
      } else if (!dynamicRejectionReason && signal.signal === 'NO TRADE') {
        dynamicRejectionReason = 'لا توجد فرصة تداول حالياً: عدم اكتمال شروط الهيكل والسيولة وإدارة المخاطر.';
      }

      // Save scan record exactly once for this completed scan
      storage.saveScan({
        id: scanId,
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
        currentPrice,
        signal: signal.signal,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        slPoints: signal.slPoints,
        tp1: signal.tp1,
        tp1Points: signal.tp1Points || 0,
        tp1Rr: signal.tp1RrString || (signal.tp1Rr ? `1:${signal.tp1Rr.toFixed(2)}` : 'N/A'),
        tp2: signal.tp2,
        tp2Points: signal.tp2Points || 0,
        tp2Rr: signal.tp2RrString || ((signal.tp2 && signal.tp2 > 0 && signal.tp2Rr) ? `1:${signal.tp2Rr.toFixed(2)}` : 'N/A'),
        rr: signal.rr,
        confidence: signal.confidence,
        riskPercent: signal.riskPercent,
        riskAmount: signal.riskAmount,
        lotSize: signal.standardLot ?? signal.recommendedLotSize,
        setup: signal.setup,
        reasons: signal.mainReasons,
        status: scanResultStatus,
        invalidation: signal.invalidation,
        duplicateReason: isSameSetupActive ? structuralIdentity.status : undefined,
        duplicateDetails: isSameSetupActive ? structuralIdentity.details : undefined,
        noTradeReason: dynamicRejectionReason,
      });

      // Active Trade Opposition Guard: Block emission of opposing signals
      if (isOpposingActiveTrade) {
        console.log(`[LiveMarketScanner] Active Trade Opposition Guard: Blocked ${signal.signal} because active ${activeTradeDirection} is in-flight.`);
        if (this.activeSignal) {
          this.activeSignal.currentPrice = currentPrice;
          this.config.lastSignal = this.activeSignal;
          this.config.lastDecision = this.activeSignal.signal;
          this.config.lastScanStatus = `صفقة ${activeTradeDirection} جارية حالياً | تم حظر إشارة ${signal.signal} المعارضة لمنع التضارب`;
          return this.activeSignal;
        }
        return signal;
      }

      // Step 5 & 6: Prevent duplicate signals if same setup is still active
      if (signal.signal !== 'NO TRADE' && signal.confidence >= this.config.minConfidence) {
        let oppId = generateOpportunityId(signal);
        
        // Match canonical opportunity by structural same-setup check to prevent dynamic candidates from shifting identity keys
        if (isSameSetupActive && structuralIdentity.details?.activeSignalId && structuralIdentity.details.activeSignalId !== 'TERMINAL_BLOCK') {
          oppId = structuralIdentity.details.activeSignalId;
        }

        let opp = storage.getOpportunity(oppId);
        const meta = (signal as any).patternMetadata;
        const isTerminalOpp = opp && isTerminalOpportunityStatus(opp.status);

        if (!opp || isTerminalOpp) {
          if (opp && isTerminalOpp) {
            // Preserve historical opportunity record under an immutable historical snapshot ID
            const historicalArchivedId = `${opp.id}_hist_${opp.failedAt || opp.completedAt || opp.lastUpdatedTime || Date.now()}`;
            storage.saveOpportunity({
              ...opp,
              id: historicalArchivedId,
            });
            console.log(`[LiveMarketScanner] Preserved historical terminal opportunity ${opp.id} (status: ${opp.status}) as ${historicalArchivedId}. Initializing fresh opportunity cycle for new signal.`);
          }

          // Initialize fresh active opportunity cycle for the new signal
          opp = {
            id: oppId,
            setupName: signal.setup,
            strategyFamily: signal.strategyFamily || 'UNKNOWN',
            direction: signal.signal.toUpperCase().includes('BUY') ? 'BUY' : 'SELL',
            timeframe: signal.timeframe,
            status: 'ACTIVE',
            firstObservedTime: Date.now(),
            lastUpdatedTime: Date.now(),
            entry: signal.entry,
            stopLoss: signal.stopLoss,
            tp1: signal.tp1,
            tp2: signal.tp2,
            confidence: signal.confidence,
            extremeLevel: meta?.extremeLevel,
            neckline: meta?.neckline,
            patternAnchorKey: meta?.patternAnchorKey || (signal as any).structuralAnchorKey,
            pivot1Time: meta?.pivot1Time,
            pivot2Time: meta?.pivot2Time,
            poiId: signal.poiId,
            signalId: signal.id,
          };
          storage.saveOpportunity(opp);
        } else if (!opp.signalId) {
          // If the opportunity exists but was saved without a canonical signal ID, anchor it to this one
          opp.signalId = signal.id;
          storage.saveOpportunity(opp);
        }

        if (isSameSetupActive) {
          // DUPLICATE PREVENTED: Update status without generating a new signal or spamming alerts
          this.config.duplicatePrevented = true;
          this.config.lastDecision = this.activeSignal?.signal || signal.signal;
          this.config.lastScanStatus = `الصفقة لا تزال جارية: ${this.activeSignal?.signal || signal.signal} (${this.activeSignal?.setup || signal.setup}) | السعر: $${currentPrice.toFixed(2)} [تم منع ${structuralIdentity.status === 'DUPLICATE_ACTIVE_REENTRY' ? 'إعادة الدخول المكرر' : 'تكرار الإشارة'}]`;
          console.log(`[LiveMarketScanner] Blocked ${structuralIdentity.status}: ${signal.setup} @ ${signal.entry}. Active trade ${this.activeSignal?.setup || opp.setupName} @ ${this.activeSignal?.entry || opp.entry} is still OPEN. Telemetry:`, structuralIdentity.details);

          // Freeze original levels! Do not overwrite with candidate signal.
          opp.confidence = signal.confidence;
          opp.lastUpdatedTime = Date.now();
          storage.saveOpportunity(opp);

          // Keep current price updated on active signal
          if (this.activeSignal) {
            this.activeSignal.currentPrice = currentPrice;
            this.config.lastSignal = this.activeSignal;
            return this.activeSignal;
          } else {
            // Rebuild activeSignal from the stored original opportunity snapshot
            const originalSignal = opp.signalId ? storage.getSignal(opp.signalId) : undefined;
            if (originalSignal) {
              this.activeSignal = {
                ...originalSignal,
                currentPrice,
              };
            } else {
              // Fallback to rebuilding from signal using frozen opportunity prices
              this.activeSignal = {
                ...signal,
                id: opp.signalId || signal.id,
                entry: opp.entry,
                stopLoss: opp.stopLoss,
                tp1: opp.tp1,
                tp2: opp.tp2,
                slPoints: Math.round(Math.abs(opp.entry - opp.stopLoss) / 0.1),
                tp1Points: Math.round(Math.abs(opp.tp1 - opp.entry) / 0.1),
                tp2Points: Math.round(Math.abs(opp.tp2 - opp.entry) / 0.1),
                currentPrice,
              };
            }
            this.config.lastSignal = this.activeSignal;
            return this.activeSignal;
          }
        }

        // Only suppress if this opportunity is currently in-flight/DISPATCHED (not terminal)
        if (opp.status === 'DISPATCHED') {
          console.log(`[LiveMarketScanner] Opportunity ${oppId} is currently dispatched (Status: DISPATCHED, DispatchedAt: ${opp.dispatchedAt}). Suppressing duplicate evolving alert.`);
          this.config.duplicatePrevented = true;
          this.config.lastDecision = signal.signal;
          this.config.lastScanStatus = `تم منع إعادة إصدار الإشعار للفرصة الجارية: ${signal.signal} (${signal.setup})`;

          // Freeze original levels! Do not overwrite with candidate signal.
          opp.confidence = signal.confidence;
          opp.lastUpdatedTime = Date.now();
          storage.saveOpportunity(opp);

          if (this.activeSignal) {
            this.activeSignal.currentPrice = currentPrice;
            this.config.lastSignal = this.activeSignal;
            return this.activeSignal;
          } else {
            const originalSignal = opp.signalId ? storage.getSignal(opp.signalId) : undefined;
            if (originalSignal) {
              this.activeSignal = {
                ...originalSignal,
                currentPrice,
              };
            } else {
              this.activeSignal = {
                ...signal,
                id: opp.signalId || signal.id,
                entry: opp.entry,
                stopLoss: opp.stopLoss,
                tp1: opp.tp1,
                tp2: opp.tp2,
                slPoints: Math.round(Math.abs(opp.entry - opp.stopLoss) / 0.1),
                tp1Points: Math.round(Math.abs(opp.tp1 - opp.entry) / 0.1),
                tp2Points: Math.round(Math.abs(opp.tp2 - opp.entry) / 0.1),
                currentPrice,
              };
            }
            this.config.lastSignal = this.activeSignal;
            return this.activeSignal;
          }
        }

        // New genuine setup qualified!
        this.activeSignal = signal;
        this.config.activeSetupName = signal.setup;
        this.config.duplicatePrevented = false;
        this.config.lastDecision = signal.signal;
        this.config.lastSignal = signal;
        this.config.lastScanStatus = `تم رصد صفقة مؤكدة: ${signal.signal} (${signal.setup}) بنسبة ثقة ${signal.confidence}%`;
        console.log(`[LiveMarketScanner] New qualified signal detected: ${signal.signal} @ ${signal.entry}`);

        // Capture decision-time factor snapshot for experience memory
        try {
          const factorSnapshot = experienceMemoryEngine.captureDecisionSnapshot(signal, ind1h, ind15m, ind5m);
          if (factorSnapshot) {
            signal.factorSnapshot = factorSnapshot;
            if (opp) {
              opp.factorSnapshot = factorSnapshot;
              storage.saveOpportunity(opp);
            }
          }
        } catch (fErr) {
          console.warn('[LiveMarketScanner] Decision snapshot capture error (non-blocking):', fErr);
        }

        // Persist new qualified signal to disk
        storage.saveSignal(signal);

        // Dispatch signal alert to the registered private Telegram chat and await result
        console.log('[LiveMarketScanner] Dispatching signal notification to Telegram...');
        const telegramDelivered = await telegramService.sendSignalNotification(signal).catch((err) => {
          console.error('[LiveMarketScanner] Telegram signal dispatch error:', err);
          return false;
        });

        // Auto-Trading execution bridge if enabled in settings
        const currentSettings = storage.getSettings();
        if (currentSettings.autoTradingEnabled) {
          console.log(`[LiveMarketScanner] Auto-trading is ENABLED. Routing order to MT5 Bridge (Mode: ${currentSettings.accountMode || 'DEMO'})...`);
          try {
            const todayStats = storage.getTodayStats();
            const orderRiskPct = signal.riskPercent || 15;
            if (todayStats.tradesCount < 3 && (todayStats.totalRiskPercentUsed + orderRiskPct) <= 30.0) {
              const lot = signal.standardLot ?? signal.recommendedLotSize ?? 0.01;
              let resolvedAction: 'BUY' | 'SELL' | 'BUY_LIMIT' | 'SELL_LIMIT';
              const sUpper = signal.signal.toUpperCase();
              if (sUpper.includes('BUY LIMIT')) resolvedAction = 'BUY_LIMIT';
              else if (sUpper.includes('SELL LIMIT')) resolvedAction = 'SELL_LIMIT';
              else if (sUpper.includes('BUY')) resolvedAction = 'BUY';
              else if (sUpper.includes('SELL')) resolvedAction = 'SELL';
              else resolvedAction = signal.entry > signal.stopLoss ? 'BUY' : 'SELL';

              mt5Bridge.executeOrder({
                symbol: (signal.asset || 'XAUUSD').replace('/', ''),
                action: resolvedAction,
                lot: lot,
                price: signal.entry,
                stopLoss: signal.stopLoss,
                takeProfit: signal.tp1,
                takeProfit2: signal.tp2,
                comment: `AutoTrade ${currentSettings.accountMode || 'DEMO'}`,
                accountMode: currentSettings.accountMode || 'DEMO',
              }).then((bridgeRes) => {
                if (bridgeRes.success) {
                  const autoTradeId = bridgeRes.orderId || `autotrade_${Date.now()}`;
                  storage.saveTrade({
                    id: signal.id,
                    tradeNumber: (storage.getTrades(1)[0]?.tradeNumber || 0) + 1,
                    date: new Date().toLocaleDateString('ar-EG', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                    isoTime: new Date().toISOString(),
                    asset: 'XAU/USD',
                    direction: signal.signal as any,
                    entry: bridgeRes.executionPrice || signal.entry,
                    sl: signal.stopLoss,
                    slPoints: signal.slPoints,
                    tp1: signal.tp1,
                    tp1Points: signal.tp1Points || 0,
                    tp2: signal.tp2,
                    tp2Points: signal.tp2Points || 0,
                    rr: signal.rr,
                    riskPercent: orderRiskPct,
                    riskAmount: signal.riskAmount,
                    lotSize: lot,
                    confidence: signal.confidence,
                    setup: signal.setup,
                    result: 'OPEN',
                    pl: 0,
                    balanceAfterTrade: currentSettings.manualCapital,
                    notes: `Auto-Executed via MT5 Bridge [Mode: ${currentSettings.accountMode || 'DEMO'}] - Status: ${bridgeRes.status}`,
                  });
                  console.log(`[LiveMarketScanner] Auto-trade executed successfully: ${autoTradeId}`);
                } else {
                  console.warn(`[LiveMarketScanner] Auto-trade execution failed: ${bridgeRes.message}`);
                }
              }).catch((e) => console.error('[LiveMarketScanner] Auto-trade execution error:', e));
            } else {
              console.warn('[LiveMarketScanner] Auto-trade blocked by daily trade limit or risk limit.');
            }
          } catch (autoErr) {
            console.error('[LiveMarketScanner] Error in auto-trading dispatch:', autoErr);
          }
        }

        if (this.onSignalFoundCallback) {
          this.onSignalFoundCallback(signal);
        }

        signal.currentPrice = currentPrice;
        if (telegramDelivered) {
          opp.status = 'DISPATCHED';
          opp.dispatchedAt = Date.now();
          console.log(`[LiveMarketScanner] Telegram delivery succeeded. Marking opportunity ${opp.id} as DISPATCHED.`);
        } else {
          opp.status = 'ACTIVE';
          console.warn(`[LiveMarketScanner] Telegram delivery failed. Keeping opportunity ${opp.id} as ACTIVE.`);
        }
        storage.saveOpportunity(opp);

        // Persist signal
        storage.saveSignal(signal);

        console.log('[SCANNER] scan completed');
        return signal;
      } else {
        // Returned NO TRADE (or confidence < minConfidence)
        // If an active trade was previously running and is still between SL and TP, maintain it
        if (this.activeSignal && this.activeSignal.signal !== 'NO TRADE') {
          this.config.duplicatePrevented = true;
          this.config.lastDecision = this.activeSignal.signal;
          this.config.lastScanStatus = `الصفقة لا تزال جارية: ${this.activeSignal.signal} (${this.activeSignal.setup}) | السعر: $${currentPrice.toFixed(2)}`;
          this.activeSignal.currentPrice = currentPrice;
          this.config.lastSignal = this.activeSignal;
          console.log('[SCANNER] scan completed (active signal preserved)');
          return this.activeSignal;
        }

        this.config.duplicatePrevented = false;
        this.config.lastDecision = 'NO TRADE';
        this.config.lastSignal = signal;
        this.config.lastScanStatus = `آخر فحص: ${new Date().toLocaleTimeString()} - القرار: NO TRADE (حماية رأس المال - عدم اكتمال الشروط الصارمة)`;

        signal.currentPrice = currentPrice;

        console.log('[SCANNER] scan completed');
        return signal;
      }
    } catch (error: any) {
      console.error('[SCANNER] Scan execution error:', error?.message || error);
      this.biquoteConnectionStatus = `ERROR: ${error?.message || 'Connection failed'}`;
      this.config.dataStatus = `Error: ${error?.message || 'Biquote connection issue'}`;
      this.config.lastScanStatus = `فشل في الاتصال بمصدر بيانات Biquote: ${error?.message || 'خطأ غير معروف'}`;

      // PART 2: EVERY REAL SCAN MUST BE RECORDED
      // If market data or AI fails, record the scan attempt with an ERROR/FAILED status and the actual error reason
      this.config.scanCount += 1;
      const fallbackPrice = this.lastKnownPrice || 0;
      const errorSignal: TradeSignal = {
        id: `scan_err_${Date.now()}`,
        timestamp: Date.now(),
        asset,
        signal: 'NO TRADE',
        currentPrice: fallbackPrice,
        entry: fallbackPrice,
        stopLoss: fallbackPrice,
        slPoints: 0,
        tp1: fallbackPrice,
        tp1Points: 0,
        tp1Rr: 0,
        tp1RrString: '1:0',
        tp2: fallbackPrice,
        tp2Points: 0,
        tp2Rr: 0,
        tp2RrString: '1:0',
        primaryTarget: 'TP1',
        rr: '1:0',
        rrRatio: 0,
        riskPercent: 0,
        riskAmount: 0,
        potentialProfit: 0,
        potentialLoss: 0,
        recommendedLotSize: 0,
        confidence: 0,
        timeframe: '5M',
        setup: 'SCAN_FAILED',
        mainReasons: [error?.message || 'Scan execution failure'],
        invalidation: 'N/A',
        noTradeReason: `فشل الفحص: ${error?.message || 'Unknown error'}`,
      };

      storage.saveScan({
        id: errorSignal.id,
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
        currentPrice: fallbackPrice,
        signal: 'NO TRADE',
        entry: fallbackPrice,
        stopLoss: fallbackPrice,
        slPoints: 0,
        tp1: fallbackPrice,
        tp1Points: 0,
        tp1Rr: '1:0',
        tp2: fallbackPrice,
        tp2Points: 0,
        tp2Rr: '1:0',
        rr: '1:0',
        confidence: 0,
        riskPercent: 0,
        riskAmount: 0,
        lotSize: 0,
        setup: 'SCAN_FAILED',
        reasons: [error?.message || 'Scan execution failure'],
        status: 'FAILED',
        invalidation: 'N/A',
        noTradeReason: error?.message || 'Scan execution failure',
      });
      console.log('[SCANNER] history saved (FAILED scan recorded)');
      console.log('[SCANNER] scan completed (with error)');

      this.config.lastDecision = 'NO TRADE';
      this.config.lastSignal = errorSignal;
      return errorSignal;
    } finally {
      this.isScanRunning = false;
      this.config.isScanning = false;
      this.lastScanCompletedTime = Date.now();
    }
  }

  /**
   * Triggers an immediate scan and resets the 60-second timer
   */
  public async triggerManualScan(force = false): Promise<TradeSignal | null> {
    if (this.isScanRunning) {
      console.log('[SCANNER] Manual scan: SKIPPED (Scan already in progress)');
      return this.config.lastSignal || null;
    }

    const now = Date.now();
    const elapsed = now - this.lastScanCompletedTime;
    if (!force && this.lastScanCompletedTime > 0 && elapsed < SCAN_MIN_COOLDOWN_MS) {
      const remainingSec = Math.ceil((SCAN_MIN_COOLDOWN_MS - elapsed) / 1000);
      console.log(`[SCANNER] Manual scan: SKIPPED (Cooldown active: ${remainingSec}s remaining)`);
      return this.config.lastSignal || null;
    }

    console.log('[SCANNER] Manual scan: EXECUTING');
    const res = await this.runScan('XAU/USD', { source: 'manual', force });
    // Reset next scan time countdown to full interval
    const intervalSec = this.config.intervalSeconds || 60;
    this.config.nextScanTime = Date.now() + intervalSec * 1000;
    return res;
  }

  /**
   * External Cron Tick Trigger
   * Used by cloud schedulers, external cron services (cron-job.org / Cloud Scheduler)
   * to guarantee 24/7 scanning even when the browser is offline or the container sleeps.
   */
  public async triggerCronTick(): Promise<{
    signal: TradeSignal | null;
    health: any;
    status: 'EXECUTED' | 'SKIPPED_COOLDOWN' | 'SKIPPED_IN_FLIGHT' | 'SKIPPED_PAUSED';
    skipped: boolean;
    reason?: string;
  }> {
    const now = Date.now();

    if (this.isPaused) {
      console.log('[SCANNER] Cron tick: SKIPPED_PAUSED (Scanner is paused)');
      return {
        signal: this.config.lastSignal || null,
        health: this.getHealthReport(),
        status: 'SKIPPED_PAUSED',
        skipped: true,
        reason: 'Scanner is currently paused',
      };
    }

    if (this.isScanRunning) {
      console.log('[SCANNER] Cron tick: SKIPPED_IN_FLIGHT');
      return {
        signal: this.config.lastSignal || null,
        health: this.getHealthReport(),
        status: 'SKIPPED_IN_FLIGHT',
        skipped: true,
        reason: 'Previous scan still running',
      };
    }

    const elapsed = now - this.lastScanCompletedTime;
    if (this.lastScanCompletedTime > 0 && elapsed < SCAN_MIN_COOLDOWN_MS) {
      const remainingSec = Math.ceil((SCAN_MIN_COOLDOWN_MS - elapsed) / 1000);
      console.log(`[SCANNER] Cron tick: SKIPPED_COOLDOWN (${elapsed}ms elapsed < 45s cooldown, ${remainingSec}s remaining)`);
      return {
        signal: this.config.lastSignal || null,
        health: this.getHealthReport(),
        status: 'SKIPPED_COOLDOWN',
        skipped: true,
        reason: `Cooldown active (${remainingSec}s remaining)`,
      };
    }

    console.log('[SCANNER] Cron tick: EXECUTING');
    const signal = await this.runScan('XAU/USD', { source: 'cron' });
    const health = this.getHealthReport();

    return {
      signal,
      health,
      status: 'EXECUTED',
      skipped: false,
    };
  }

  /**
   * Server Health & Worker Status Report
   * Exactly fulfills Requirement 9:
   * - scanner status
   * - last scan time
   * - next scan time
   * - Biquote connection
   * - last successful market-data timestamp
   * - worker uptime
   */
  public getHealthReport() {
    const now = Date.now();
    const uptimeSec = Math.floor((now - this.workerStartTime) / 1000);
    const nextScanMs = this.config.nextScanTime;
    const secondsToNext = nextScanMs ? Math.max(0, Math.ceil((nextScanMs - now) / 1000)) : null;

    return {
      scannerStatus: this.isPaused ? 'PAUSED' : (this.config.enabled ? 'ONLINE' : 'OFFLINE'),
      isPaused: this.isPaused,
      triggerMode: this.getTriggerMode(),
      internalTimerActive: this.isInternalTimerActive(),
      lastScanTime: this.config.lastScanTime,
      lastScanTimeIso: this.config.lastScanTime ? new Date(this.config.lastScanTime).toISOString() : null,
      lastScanTimeFormatted: this.config.lastScanTime ? new Date(this.config.lastScanTime).toLocaleTimeString() : 'N/A',
      lastScanCompletedTime: this.lastScanCompletedTime,
      lastScanCompletedTimeIso: this.lastScanCompletedTime ? new Date(this.lastScanCompletedTime).toISOString() : null,
      nextScanTime: this.config.nextScanTime,
      nextScanTimeIso: this.config.nextScanTime ? new Date(this.config.nextScanTime).toISOString() : null,
      nextScanTimeFormatted: this.config.nextScanTime ? new Date(this.config.nextScanTime).toLocaleTimeString() : 'N/A',
      secondsToNextScan: secondsToNext,
      biquoteConnection: this.biquoteConnectionStatus,
      lastSuccessfulMarketDataTimestamp: this.lastMarketDataTimestamp,
      lastSuccessfulMarketDataTimeIso: this.lastMarketDataTimestamp ? new Date(this.lastMarketDataTimestamp).toISOString() : null,
      workerUptimeSeconds: uptimeSec,
      workerUptimeFormatted: this.formatUptime(uptimeSec),
      scanCount: this.config.scanCount,
      lastDecision: this.config.lastDecision,
      duplicatePrevented: this.config.duplicatePrevented,
      activeSetupName: this.config.activeSetupName,
      isScanning: this.config.isScanning,
      intervalSeconds: this.config.intervalSeconds,
    };
  }

  private formatUptime(totalSeconds: number): string {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || days > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);

    return parts.join(' ');
  }
}

export const scanner = new LiveMarketScanner();
