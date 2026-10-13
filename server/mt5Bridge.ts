import fs from 'fs';
import path from 'path';
import { Candle, AccountExecutionMode, TradeLedgerItem } from '../src/types.js';
import { storage, PersistentStorage } from './storage.js';
import { BrokerContractSpecs, DEFAULT_BROKER_SPECS, evaluateTradeRisk } from './riskManager.js';
import { telegramService } from './telegram.js';

export interface MT5SymbolSpecs {
  symbol: string;
  contractSize: number;
  point: number;
  digits: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  tickSize: number;
  tickValue: number;
  stopsLevel: number;
  marginInitial?: number;
  spread?: number;
  isValid: boolean;
  validationError?: string;
}

export interface MT5DealRecord {
  ticket: number;
  order: number;
  positionId: number;
  time: number;
  timeMsc?: number;
  type: number; // 0 = BUY, 1 = SELL
  entry: number; // 0 = IN, 1 = OUT, 2 = INOUT, 3 = OUT_BY
  magic: number;
  volume: number;
  price: number;
  profit: number;
  commission: number;
  swap: number;
  symbol: string;
  comment?: string;
}

export interface MT5AccountStatus {
  connected: boolean;
  status: 'CONNECTED' | 'DISCONNECTED' | 'REFUSED_REAL_ACCOUNT' | 'ERROR';
  balance: number | null;
  equity: number | null;
  freeMargin: number | null;
  currency: string;
  server?: string;
  accountNumber?: string;
  accountMode: 'DEMO' | 'REAL' | 'ANALYSIS' | 'UNVERIFIED';
  tradeMode?: number; // 0 = DEMO in MetaTrader5
  leverage?: number;
  lastUpdated: number | null;
  statusMessage: string;
  brokerSymbol?: string;
  terminalConnected?: boolean;
  brokerSpecs?: MT5SymbolSpecs | null;
  brokerSpecsValid?: boolean;
}

export type { AccountExecutionMode };

export type MT5CommandAction = 'BUY' | 'SELL' | 'BUY_LIMIT' | 'SELL_LIMIT' | 'CLOSE' | 'MODIFY' | 'CANCEL';

export type MT5CommandStatus = 
  | 'PENDING'
  | 'DISPATCHED'
  | 'FILLED'
  | 'REJECTED'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNRESOLVED';

export interface MT5ExecutionCommand {
  commandId: string;
  createdAt: number;
  updatedAt: number;
  action: MT5CommandAction;
  symbol: string;
  volume: number;
  price?: number;
  sl: number;
  tp: number;
  tp2?: number;
  ticket?: number; // For CLOSE or MODIFY
  magic: number;
  comment: string;
  accountMode?: string;
  status: MT5CommandStatus;
  retryCount: number;
  maxRetries: number;
  // Execution results
  orderTicket?: number;
  dealTicket?: number;
  positionTicket?: number;
  executionPrice?: number;
  executionTime?: number;
  retcode?: number;
  retcodeDescription?: string;
  failureReason?: string;
}

export interface MT5PositionInfo {
  ticket: number;
  symbol: string;
  type: 'BUY' | 'SELL';
  volume: number;
  priceOpen: number;
  priceCurrent: number;
  sl: number;
  tp: number;
  profit: number;
  magic: number;
  comment: string;
  time: number;
  isBotManaged: boolean;
}

export interface MT5DemoSafetyConfig {
  maxRiskPerTradePercent: number; // default 2.0%
  maxOpenPositions: number; // default 2
  maxDailyRealizedLossUsd: number; // default $15.00
  maxOrderVolume: number; // default 0.10 lots
  maxQuoteAgeSeconds: number; // default 10s
  maxConsecutiveFailures: number; // default 3
  magicNumber: number; // default 240726
  symbolAllowlist: string[];
}

export interface MT5BridgeHeartbeatPayload {
  connected: boolean;
  terminalConnected: boolean;
  login?: number;
  server?: string;
  currency?: string;
  balance?: number;
  equity?: number;
  freeMargin?: number;
  leverage?: number;
  tradeMode?: number; // 0 = DEMO
  accountMode?: string;
  symbols?: string[];
  brokerGoldSymbol?: string;
  symbolSpecs?: any;
  positions?: any[];
  timestamp?: number;
}

export class MT5BridgeService {
  // Centralized Live Execution Authorization Policy
  // LIVE/REAL trading is fully supported when explicitly configured and authorized, but fails closed by default.
  public isLiveExecutionConfigured(): boolean {
    return String(process.env.MT5_LIVE_EXECUTION_ENABLED || '').trim().toLowerCase() === 'true';
  }

  public evaluateLiveExecutionPolicy(): { allowed: boolean; reason?: string } {
    // 1. Central Environment Configuration Gate
    if (!this.isLiveExecutionConfigured()) {
      return {
        allowed: false,
        reason: 'التداول الحقيقي (LIVE/REAL) غير مفعّل في إعدادات الخادم (MT5_LIVE_EXECUTION_ENABLED يجب أن تكون true).',
      };
    }

    // 2. Kill switch gate
    if (this.killSwitchActivated) {
      return {
        allowed: false,
        reason: 'زر الطوارئ (Kill Switch) مفعّل. يجب إعادة الضبط أولاً.',
      };
    }

    // 3. Connectivity gate
    if (!this.lastStatus.connected || !this.lastStatus.terminalConnected) {
      return {
        allowed: false,
        reason: 'جسر MT5 غير متصل بمنصة التداول. يرجى تشغيل Windows Bridge والتحقق من اتصال المنصة.',
      };
    }

    // 4. Strict Verified REAL Account Gate (Numeric tradeMode === 2 AND accountMode === 'REAL')
    if (!this.isVerifiedRealAccount()) {
      return {
        allowed: false,
        reason: 'الحساب المتصل ليس حساباً حقيقياً (REAL Account) موثقاً من MT5 برقم نمط التداول 2.',
      };
    }

    // 5. Consecutive failures gate
    if (this.consecutiveFailures >= this.safetyConfig.maxConsecutiveFailures) {
      return {
        allowed: false,
        reason: `تم حظر التداول لتجاوز حد أخطاء التنفيذ المتتالية (${this.consecutiveFailures}).`,
      };
    }

    return { allowed: true };
  }

  // Active execution mode selection: ANALYSIS | DEMO | LIVE (defaults to ANALYSIS or DEMO, stored server-side)
  private activeExecutionMode: AccountExecutionMode = 'DEMO';
  private liveTradingAuthorized: boolean = false;

  // Active status
  private lastStatus: MT5AccountStatus = {
    connected: false,
    status: 'DISCONNECTED',
    balance: null,
    equity: null,
    freeMargin: null,
    currency: 'USD',
    accountMode: 'DEMO',
    lastUpdated: null,
    statusMessage: 'MT5 Bridge Disconnected (Windows Agent pending heartbeat)',
    brokerSpecs: null,
    brokerSpecsValid: false,
  };

  // Broker Symbol Specifications from MT5
  private symbolSpecs: MT5SymbolSpecs | null = null;
  private brokerSpecsValidationStatus: { valid: boolean; error?: string } = {
    valid: false,
    error: 'لم يتم استلام مواصفات الرمز بعد من منصة MT5',
  };

  // Processed deals tracking for restart-safe idempotency
  private processedDealTickets: Set<number> = new Set();

  // Explicit safety flags: ALWAYS disabled on startup, deploy, restart or reconnect
  private demoAutoTradingEnabled: boolean = false;
  private killSwitchActivated: boolean = false;
  private killSwitchReason: string = '';
  private consecutiveFailures: number = 0;

  // Configurable Safety Limits
  private safetyConfig: MT5DemoSafetyConfig = {
    maxRiskPerTradePercent: 2.0,
    maxOpenPositions: 2,
    maxDailyRealizedLossUsd: 15.0,
    maxOrderVolume: 0.10,
    maxQuoteAgeSeconds: 10,
    maxConsecutiveFailures: 3,
    magicNumber: 240726,
    symbolAllowlist: ['XAUUSD', 'GOLD', 'XAUUSDm', 'XAUUSD.m', 'XAUUSD.a', 'XAUUSD.raw', 'XAUUSDb'],
  };

  private commands: Map<string, MT5ExecutionCommand> = new Map();
  private readonly isIsolatedTest: boolean;
  private readonly enableCommandPersistence: boolean;
  private readonly commandsFilePath: string;
  private readonly dispatchTimeoutMs: number = 60 * 1000; // 60 seconds dispatch timeout

  // Positions tracking
  private openPositions: Map<number, MT5PositionInfo> = new Map();

  // Historical Candles Cache (keyed by timeframe M1, M5, M15, H1)
  private candleCache: Map<string, Candle[]> = new Map();
  private lastCandleSyncTime: number = 0;
  private readonly candleCacheFilePath: string = path.join(process.cwd(), 'server', 'data', 'mt5_candles.json');

  constructor(options?: { isIsolatedTest?: boolean; commandsFilePath?: string; candleCacheFilePath?: string }) {
    this.isIsolatedTest = Boolean(options?.isIsolatedTest);
    this.commandsFilePath = options?.commandsFilePath || path.join(process.cwd(), 'data', 'mt5_commands.json');
    this.enableCommandPersistence = options?.commandsFilePath ? true : !this.isIsolatedTest;
    if (options?.candleCacheFilePath) {
      this.candleCacheFilePath = options.candleCacheFilePath;
    }
    this.loadSafetyConfigFromEnv();
    if (!this.isIsolatedTest) {
      this.loadCandleCacheFromDisk();
    }
    this.loadCommandsFromDisk();
  }

  private loadCommandsFromDisk(): void {
    if (!this.enableCommandPersistence) return;
    try {
      if (fs.existsSync(this.commandsFilePath)) {
        const raw = fs.readFileSync(this.commandsFilePath, 'utf-8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          if (Array.isArray(data.commands)) {
            const now = Date.now();
            for (const c of data.commands) {
              if (c && c.commandId) {
                // Restart Recovery: In-flight DISPATCHED command transitions to UNRESOLVED
                // Safe unknown-outcome state; broker might have executed it, so do NOT assume failure and do NOT auto-retry!
                if (c.status === 'DISPATCHED') {
                  c.status = 'UNRESOLVED';
                  c.failureReason = 'Server restarted while command was in flight with broker';
                  c.updatedAt = now;
                } else if (c.status === 'PENDING' && (now - c.createdAt > this.safetyConfig.maxQuoteAgeSeconds * 1000)) {
                  c.status = 'CANCELLED';
                  c.failureReason = 'Command quote expired during server restart';
                  c.updatedAt = now;
                }
                this.commands.set(c.commandId, c);
              }
            }
          }
          if (Array.isArray(data.processedDealTickets)) {
            for (const t of data.processedDealTickets) {
              if (typeof t === 'number') this.processedDealTickets.add(t);
            }
          }
          console.log(`[MT5Bridge] Loaded ${this.commands.size} persisted commands and ${this.processedDealTickets.size} deals from disk.`);
        }
      }
    } catch (err: any) {
      console.error('[MT5Bridge] Error loading persisted commands:', err.message);
    }
  }

  public persistCommandsToDisk(): void {
    if (!this.enableCommandPersistence) return;
    try {
      const dir = path.dirname(this.commandsFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const payload = {
        updatedAt: Date.now(),
        commands: Array.from(this.commands.values()).slice(-200),
        processedDealTickets: Array.from(this.processedDealTickets).slice(-500),
      };
      fs.writeFileSync(this.commandsFilePath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (err: any) {
      console.error('[MT5Bridge] Error persisting commands to disk:', err.message);
    }
  }

  public checkCommandTimeouts(now: number = Date.now()): number {
    let timedOutCount = 0;
    for (const cmd of this.commands.values()) {
      if (cmd.status === 'DISPATCHED' && (now - cmd.updatedAt > this.dispatchTimeoutMs)) {
        cmd.status = 'UNRESOLVED';
        cmd.failureReason = `Command timed out after ${Math.round(this.dispatchTimeoutMs / 1000)}s without broker confirmation; outcome uncertain.`;
        cmd.updatedAt = now;
        timedOutCount++;
        console.warn(`[MT5Bridge] Command ${cmd.commandId} transitioned to UNRESOLVED due to dispatch timeout.`);
      }
    }
    if (timedOutCount > 0) {
      this.persistCommandsToDisk();
    }
    return timedOutCount;
  }

  private loadCandleCacheFromDisk() {
    try {
      if (fs.existsSync(this.candleCacheFilePath)) {
        const raw = fs.readFileSync(this.candleCacheFilePath, 'utf-8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          for (const [tf, candles] of Object.entries(data)) {
            if (Array.isArray(candles) && candles.length > 0) {
              this.candleCache.set(tf.toUpperCase(), candles as Candle[]);
            }
          }
          console.log(`[MT5Bridge] Loaded persisted historical candles from disk: ${Array.from(this.candleCache.keys()).map(k => `${k}(${this.candleCache.get(k)?.length})`).join(', ')}`);
        }
      }
    } catch (err: any) {
      console.error('[MT5Bridge] Error loading persisted candle cache:', err.message);
    }
  }

  private persistCandleCacheToDisk() {
    if (this.isIsolatedTest) return;
    try {
      const dir = path.dirname(this.candleCacheFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const obj = Object.fromEntries(this.candleCache.entries());
      fs.writeFileSync(this.candleCacheFilePath, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err: any) {
      console.error('[MT5Bridge] Error persisting candle cache to disk:', err.message);
    }
  }

  private loadSafetyConfigFromEnv() {
    if (process.env.MT5_MAGIC_NUMBER) {
      const mn = parseInt(process.env.MT5_MAGIC_NUMBER, 10);
      if (!isNaN(mn) && mn > 0) this.safetyConfig.magicNumber = mn;
    }
    if (process.env.MT5_MAX_RISK_PER_TRADE_PERCENT) {
      const mr = parseFloat(process.env.MT5_MAX_RISK_PER_TRADE_PERCENT);
      if (!isNaN(mr) && mr > 0) this.safetyConfig.maxRiskPerTradePercent = mr;
    }
    if (process.env.MT5_MAX_OPEN_POSITIONS) {
      const mop = parseInt(process.env.MT5_MAX_OPEN_POSITIONS, 10);
      if (!isNaN(mop) && mop > 0) this.safetyConfig.maxOpenPositions = mop;
    }
    if (process.env.MT5_MAX_DAILY_LOSS_USD) {
      const mdl = parseFloat(process.env.MT5_MAX_DAILY_LOSS_USD);
      if (!isNaN(mdl) && mdl > 0) this.safetyConfig.maxDailyRealizedLossUsd = mdl;
    }
    if (process.env.MT5_MAX_ORDER_VOLUME) {
      const mov = parseFloat(process.env.MT5_MAX_ORDER_VOLUME);
      if (!isNaN(mov) && mov > 0) this.safetyConfig.maxOrderVolume = mov;
    }
    if (process.env.MT5_ALLOWED_SYMBOLS) {
      const syms = process.env.MT5_ALLOWED_SYMBOLS.split(',').map((s) => s.trim().toUpperCase());
      if (syms.length > 0) this.safetyConfig.symbolAllowlist = syms;
    }
  }

  // =========================================================================
  // Strict Safety Checks & Account Verification
  // =========================================================================

  /**
   * Verify that the connected account is strictly a DEMO account.
   * MetaTrader5 package constants:
   * ACCOUNT_TRADE_MODE_DEMO = 0
   * ACCOUNT_TRADE_MODE_CONTEST = 1
   * ACCOUNT_TRADE_MODE_REAL = 2
   */
  // Set the server-side active execution mode (ANALYSIS | DEMO | LIVE)
  public setExecutionMode(mode: AccountExecutionMode): { success: boolean; message?: string } {
    const rawMode = String(mode || '').trim().toUpperCase();
    let targetMode: AccountExecutionMode = 'DEMO';

    if (rawMode === 'ANALYSIS') {
      targetMode = 'ANALYSIS';
    } else if (rawMode === 'DEMO') {
      targetMode = 'DEMO';
    } else if (rawMode === 'LIVE' || rawMode === 'REAL') {
      targetMode = 'LIVE';
      if (!this.isLiveExecutionConfigured()) {
        return {
          success: false,
          message: 'لا يمكن تفعيل نمط التداول الحقيقي (LIVE): الخاصية معطلة في إعدادات الخادم (MT5_LIVE_EXECUTION_ENABLED غير مفعل).',
        };
      }
    } else {
      return {
        success: false,
        message: `نمط تنفيذ غير مدعوم أو غير معروف (${mode}). الأنماط المدعومة: ANALYSIS, DEMO, LIVE.`,
      };
    }

    this.activeExecutionMode = targetMode;
    // Reset explicit live authorization whenever mode changes or is re-set
    if (targetMode !== 'LIVE') {
      this.liveTradingAuthorized = false;
    }
    console.log(`[MT5Bridge] Execution mode set to: ${targetMode}`);
    return { success: true };
  }

  public getExecutionMode(): AccountExecutionMode {
    return this.activeExecutionMode;
  }

  /**
   * Explicit user authorization action to enable LIVE real account trading.
   * Resets to false on restart, reconnect, mode change, or kill-switch.
   */
  public authorizeLiveTrading(): { success: boolean; reason?: string } {
    const policy = this.evaluateLiveExecutionPolicy();
    if (!policy.allowed) {
      this.liveTradingAuthorized = false;
      return { success: false, reason: policy.reason };
    }
    this.activeExecutionMode = 'LIVE';
    this.liveTradingAuthorized = true;
    this.demoAutoTradingEnabled = true;
    console.log('[MT5Bridge] LIVE real account trading explicitly AUTHORIZED by user.');
    return { success: true };
  }

  public revokeLiveTrading(): { success: boolean } {
    this.liveTradingAuthorized = false;
    if (this.activeExecutionMode === 'LIVE') {
      this.activeExecutionMode = 'DEMO';
    }
    console.log('[MT5Bridge] LIVE real account trading REVOKED.');
    return { success: true };
  }

  public isVerifiedDemoAccount(): boolean {
    if (!this.lastStatus.connected) return false;
    if (typeof this.lastStatus.tradeMode !== 'number') return false;
    if (this.lastStatus.tradeMode !== 0) return false;
    return this.lastStatus.accountMode === 'DEMO';
  }

  public isVerifiedRealAccount(): boolean {
    if (!this.lastStatus.connected) return false;
    if (typeof this.lastStatus.tradeMode !== 'number') return false;
    if (this.lastStatus.tradeMode !== 2) return false;
    return this.lastStatus.accountMode === 'REAL';
  }

  /**
   * Check whether automated trading is currently active for the current mode
   */
  public isDemoAutoTradingActive(): boolean {
    if (this.killSwitchActivated) return false;
    if (this.consecutiveFailures >= this.safetyConfig.maxConsecutiveFailures) return false;

    if (this.activeExecutionMode === 'ANALYSIS') {
      return false; // ANALYSIS mode never executes orders
    }

    if (this.activeExecutionMode === 'LIVE') {
      if (!this.isLiveExecutionConfigured()) return false;
      if (!this.liveTradingAuthorized) return false;
      if (!this.isVerifiedRealAccount()) return false;
      return this.demoAutoTradingEnabled;
    }

    // DEMO mode
    if (!this.demoAutoTradingEnabled) return false;
    if (!this.isVerifiedDemoAccount()) return false;
    return true;
  }

  /**
   * Explicit user action to enable demo auto-trading
   */
  public enableDemoAutoTrading(): { success: boolean; reason?: string } {
    if (this.killSwitchActivated) {
      return { success: false, reason: 'زر الطوارئ (Kill Switch) مفعّل. يجب إعادة ضبط زر الطوارئ أولاً.' };
    }
    if (!this.lastStatus.connected) {
      return { success: false, reason: 'جسر MT5 غير متصل بالمنصة. شغّل Windows Bridge أولاً.' };
    }
    if (this.activeExecutionMode === 'ANALYSIS') {
      return { success: false, reason: 'النظام في وضع التحليل فقط (ANALYSIS ONLY). يمنع التداول التلقائي.' };
    }
    if (this.activeExecutionMode === 'LIVE') {
      return this.authorizeLiveTrading();
    }
    if (!this.isVerifiedDemoAccount()) {
      return { success: false, reason: 'الحساب ليس حساب DEMO معتمد.' };
    }
    if (this.consecutiveFailures >= this.safetyConfig.maxConsecutiveFailures) {
      return { success: false, reason: `تم حظر التداول لتكرار ${this.consecutiveFailures} أخطاء تنفيذ متتالية.` };
    }

    this.demoAutoTradingEnabled = true;
    console.log('[MT5Bridge] Demo Auto-Trading explicitly ENABLED by user.');
    return { success: true };
  }

  /**
   * User action to disable demo auto-trading
   */
  public disableDemoAutoTrading(): { success: boolean } {
    this.demoAutoTradingEnabled = false;
    this.liveTradingAuthorized = false;
    console.log('[MT5Bridge] Auto-Trading DISABLED by user.');
    return { success: true };
  }

  /**
   * Emergency Kill-Switch: Immediately halts new orders
   */
  public activateKillSwitch(reason: string = 'Emergency Kill-Switch Triggered'): { success: boolean } {
    this.killSwitchActivated = true;
    this.killSwitchReason = reason;
    this.demoAutoTradingEnabled = false;
    console.warn(`[MT5Bridge] EMERGENCY KILL-SWITCH ACTIVATED: ${reason}`);

    // Notify via Telegram if configured
    telegramService.sendSystemAlert(
      `🚨 <b>تفعيل زر الطوارئ (MT5 Demo Kill-Switch)</b>\n\n` +
      `تم إيقاف فتح أي صفقات جديدة على منصة MT5 فوراً.\n` +
      `<b>السبب:</b> ${reason}\n` +
      `<b>الوقت:</b> ${new Date().toLocaleTimeString('ar-EG')}`
    );

    return { success: true };
  }

  public resetKillSwitch(): { success: boolean } {
    this.killSwitchActivated = false;
    this.consecutiveFailures = 0;
    console.log('[MT5Bridge] Kill-Switch reset. (Trading remains disabled until explicitly enabled).');
    return { success: true };
  }

  // =========================================================================
  // Broker Symbol Specifications Validation & Mapping
  // =========================================================================

  public validateBrokerSpecs(specs: any): { isValid: boolean; specs?: MT5SymbolSpecs; error?: string } {
    if (!specs || typeof specs !== 'object') {
      return { isValid: false, error: 'مواصفات الرمز غير متوفرة من منصة MT5' };
    }

    const contractSize = Number(specs.contractSize);
    const point = Number(specs.point);
    const digits = Number(specs.digits);
    const volumeMin = Number(specs.volumeMin);
    const volumeMax = Number(specs.volumeMax);
    const volumeStep = Number(specs.volumeStep);
    const tickSize = Number(specs.tickSize);
    const tickValue = Number(specs.tickValue);

    if (!contractSize || contractSize <= 0) {
      return { isValid: false, error: `حجم العقد غير صالح: ${contractSize}` };
    }
    if (!point || point <= 0) {
      return { isValid: false, error: `قيمة النقطة (point) غير صالحة: ${point}` };
    }
    if (isNaN(digits) || digits < 0) {
      return { isValid: false, error: `عدد الخانات العشرية غير صالح: ${digits}` };
    }
    if (!volumeMin || volumeMin <= 0) {
      return { isValid: false, error: `الحد الأدنى للوت غير صالح: ${volumeMin}` };
    }
    if (!volumeMax || volumeMax < volumeMin) {
      return { isValid: false, error: `الحد الأقصى للوت (${volumeMax}) أقل من الحد الأدنى (${volumeMin})` };
    }
    if (!volumeStep || volumeStep <= 0) {
      return { isValid: false, error: `خطوة حجم اللوت (volumeStep) غير صالحة: ${volumeStep}` };
    }
    if (!tickSize || tickSize <= 0) {
      return { isValid: false, error: `حجم التيك (tickSize) غير صالح: ${tickSize}` };
    }
    if (!tickValue || tickValue <= 0) {
      return { isValid: false, error: `قيمة التيك (tickValue) غير صالحة: ${tickValue}` };
    }

    const validSpecs: MT5SymbolSpecs = {
      symbol: String(specs.symbol || 'XAUUSD'),
      contractSize,
      point,
      digits,
      volumeMin,
      volumeMax,
      volumeStep,
      tickSize,
      tickValue,
      stopsLevel: Number(specs.stopsLevel || 0),
      marginInitial: Number(specs.marginInitial || 0),
      spread: Number(specs.spread || 0),
      isValid: true,
    };

    return { isValid: true, specs: validSpecs };
  }

  public getBrokerSpecs(): (BrokerContractSpecs & { isValid: boolean; stopsLevel?: number; marginInitial?: number; spread?: number }) | null {
    if (!this.symbolSpecs || !this.symbolSpecs.isValid) {
      return null;
    }
    const currentBalance = this.lastStatus.balance || 25;
    const settings = storage.getSettings();
    return {
      accountBalance: currentBalance,
      riskPercent: settings.riskPerTrade || 15.0,
      contractSizeOz: this.symbolSpecs.contractSize || 100,
      minimumLot: this.symbolSpecs.volumeMin || 0.01,
      maximumLot: this.symbolSpecs.volumeMax || 100,
      lotStep: this.symbolSpecs.volumeStep || 0.01,
      minGoldSlPoints: settings.minGoldSlPoints ?? 35,
      maxGoldSlPoints: settings.maxGoldSlPoints ?? 85,
      minSlPoints: settings.minGoldSlPoints ?? 35,
      maxSlPoints: settings.maxGoldSlPoints ?? 85,
      minRr: settings.minTp1RR || 1.5,
      maxLoss: settings.maxLoss ?? 5.5,
      isValid: true,
      stopsLevel: this.symbolSpecs.stopsLevel,
      marginInitial: this.symbolSpecs.marginInitial,
      spread: this.symbolSpecs.spread,
    };
  }

  public isBrokerSpecsValid(): boolean {
    return Boolean(this.symbolSpecs && this.symbolSpecs.isValid);
  }

  public setBrokerSpecs(specs: any): { success: boolean; error?: string } {
    const res = this.validateBrokerSpecs(specs);
    if (res.isValid && res.specs) {
      this.symbolSpecs = res.specs;
      this.brokerSpecsValidationStatus = { valid: true };
      this.lastStatus.brokerSpecs = this.symbolSpecs;
      this.lastStatus.brokerSpecsValid = true;
      return { success: true };
    } else {
      this.symbolSpecs = null;
      this.brokerSpecsValidationStatus = { valid: false, error: res.error };
      this.lastStatus.brokerSpecs = null;
      this.lastStatus.brokerSpecsValid = false;
      return { success: false, error: res.error };
    }
  }

  // =========================================================================
  // Inbound Heartbeat from Windows Python Bridge
  // =========================================================================

  public handleBridgeHeartbeat(payload: MT5BridgeHeartbeatPayload): { success: boolean; message: string } {
    const isTerminalConnected = Boolean(payload.terminalConnected && payload.connected);
    const tradeMode = payload.tradeMode;
    const rawAccountMode = payload.accountMode?.toUpperCase();

    // Strict Fail-Closed Account Verification:
    // Rely strictly on verified numeric tradeMode (0 = DEMO, 2 = REAL).
    // Never allow client-supplied accountMode to override or substitute missing tradeMode.
    let verifiedAccountMode: 'DEMO' | 'REAL' | 'UNVERIFIED' = 'UNVERIFIED';

    if (typeof tradeMode === 'number') {
      if (tradeMode === 0) {
        if (!rawAccountMode || rawAccountMode === 'DEMO') {
          verifiedAccountMode = 'DEMO';
        }
      } else if (tradeMode === 2) {
        if (!rawAccountMode || rawAccountMode === 'REAL') {
          verifiedAccountMode = 'REAL';
        }
      }
    }

    const currentAccountNumber = payload.login ? String(payload.login) : undefined;
    const currentServer = payload.server;

    const wasDisconnected = !this.lastStatus.connected;
    const identityChanged =
      (this.lastStatus.accountNumber && currentAccountNumber && this.lastStatus.accountNumber !== currentAccountNumber) ||
      (this.lastStatus.server && currentServer && this.lastStatus.server !== currentServer) ||
      (typeof this.lastStatus.tradeMode === 'number' && typeof tradeMode === 'number' && this.lastStatus.tradeMode !== tradeMode);

    // Reset explicit LIVE authorization if disconnected, account identity changed, or mode is UNVERIFIED
    if (wasDisconnected || identityChanged || verifiedAccountMode !== 'REAL') {
      if (this.liveTradingAuthorized) {
        console.warn(`[MT5Bridge] Account state change or unverified identity detected (wasDisconnected=${wasDisconnected}, identityChanged=${identityChanged}, verifiedMode=${verifiedAccountMode}). Revoking LIVE authorization.`);
      }
      this.liveTradingAuthorized = false;
    }

    // Validate and update Broker Symbol Specifications if provided
    if (payload.symbolSpecs) {
      const validation = this.validateBrokerSpecs(payload.symbolSpecs);
      if (validation.isValid && validation.specs) {
        this.symbolSpecs = validation.specs;
        this.brokerSpecsValidationStatus = { valid: true };
      } else {
        this.symbolSpecs = null;
        this.brokerSpecsValidationStatus = { valid: false, error: validation.error };
        console.warn(`[MT5Bridge] Invalid broker symbol specs in heartbeat: ${validation.error}`);
      }
    }

    this.lastStatus = {
      connected: isTerminalConnected,
      status: isTerminalConnected ? 'CONNECTED' : 'DISCONNECTED',
      balance: typeof payload.balance === 'number' ? payload.balance : null,
      equity: typeof payload.equity === 'number' ? payload.equity : null,
      freeMargin: typeof payload.freeMargin === 'number' ? payload.freeMargin : null,
      currency: payload.currency || 'USD',
      server: currentServer,
      accountNumber: currentAccountNumber,
      accountMode: verifiedAccountMode,
      tradeMode: typeof tradeMode === 'number' ? tradeMode : undefined,
      leverage: payload.leverage,
      lastUpdated: Date.now(),
      statusMessage: isTerminalConnected
        ? (verifiedAccountMode === 'UNVERIFIED'
            ? 'MT5 Terminal Connected (Account Type UNVERIFIED)'
            : `MT5 ${verifiedAccountMode} Terminal Connected`)
        : 'Terminal Disconnected',
      brokerSymbol: payload.brokerGoldSymbol || (payload.symbols && payload.symbols[0]) || 'XAUUSD.m',
      terminalConnected: isTerminalConnected,
      brokerSpecs: this.symbolSpecs,
      brokerSpecsValid: this.isBrokerSpecsValid(),
    };

    if (wasDisconnected && isTerminalConnected) {
      console.log(`[MT5Bridge] Windows MT5 Bridge connected (${verifiedAccountMode}). Auto-trading remains disabled until explicitly authorized.`);
    }

    // Reconcile open positions reported by MT5 terminal
    if (Array.isArray(payload.positions)) {
      this.reconcileTerminalPositions(payload.positions);
    }

    return { success: true, message: 'Heartbeat acknowledged' };
  }

  // =========================================================================
  // Position Reconciliation
  // =========================================================================

  private reconcileTerminalPositions(positions: any[]) {
    const currentTicketSet = new Set<number>();

    for (const p of positions) {
      const ticket = Number(p.ticket);
      if (!ticket) continue;
      currentTicketSet.add(ticket);

      const magic = Number(p.magic || 0);
      const isBot = magic === this.safetyConfig.magicNumber;

      const posInfo: MT5PositionInfo = {
        ticket,
        symbol: String(p.symbol || 'XAUUSD'),
        type: Number(p.type) === 0 ? 'BUY' : 'SELL',
        volume: Number(p.volume || 0.01),
        priceOpen: Number(p.priceOpen || p.price_open || 0),
        priceCurrent: Number(p.priceCurrent || p.price_current || 0),
        sl: Number(p.sl || 0),
        tp: Number(p.tp || 0),
        profit: Number(p.profit || 0),
        magic,
        comment: String(p.comment || ''),
        time: Number(p.time || Date.now()),
        isBotManaged: isBot,
      };

      this.openPositions.set(ticket, posInfo);
    }

    // Remove closed positions from map
    for (const ticket of this.openPositions.keys()) {
      if (!currentTicketSet.has(ticket)) {
        this.openPositions.delete(ticket);
      }
    }
  }

  public getBotManagedPositions(): MT5PositionInfo[] {
    return Array.from(this.openPositions.values()).filter((p) => p.isBotManaged);
  }

  public getAllPositions(): MT5PositionInfo[] {
    return Array.from(this.openPositions.values());
  }

  // =========================================================================
  // Execution Command Queue (Polled by Windows Agent)
  // =========================================================================

  /**
   * Queue a demo order command.
   * Performs all server-side risk and safety validations first.
   */
  public queueDemoOrder(params: {
    commandId?: string;
    action: 'BUY' | 'SELL' | 'BUY_LIMIT' | 'SELL_LIMIT';
    symbol?: string;
    volume?: number;
    price: number;
    sl: number;
    tp: number;
    tp2?: number;
    comment?: string;
    signalId?: string;
  }): { success: boolean; commandId?: string; reason?: string } {
    // 1. Server-Side Execution Mode Authorization & Verification
    if (this.activeExecutionMode === 'ANALYSIS') {
      return { success: false, reason: 'النظام في وضع التحليل فقط (ANALYSIS ONLY). تم حظر جميع أشكال تنفيذ الأوامر.' };
    }

    if (this.killSwitchActivated) {
      return { success: false, reason: 'زر الطوارئ مفعّل - تم حظر فتح صفقات جديدة.' };
    }

    if (this.activeExecutionMode === 'LIVE') {
      const livePolicy = this.evaluateLiveExecutionPolicy();
      if (!livePolicy.allowed) {
        return { success: false, reason: livePolicy.reason };
      }
      if (!this.liveTradingAuthorized) {
        return { success: false, reason: 'التداول الحقيقي (LIVE Trading) يتطلب تفعيلاً وتفويضاً صريحاً من المستخدم.' };
      }
      if (!this.isVerifiedRealAccount()) {
        return { success: false, reason: 'الحساب المتصل ليس حساباً حقيقياً (REAL Account) موثقاً من MT5.' };
      }
    } else if (this.activeExecutionMode === 'DEMO') {
      // DEMO mode
      if (!this.demoAutoTradingEnabled) {
        return { success: false, reason: 'التداول التجريبي التلقائي معطل حالياً (Auto-trading disabled).' };
      }
      if (!this.isVerifiedDemoAccount()) {
        return { success: false, reason: 'حساب MT5 غير متصل أو ليس حساب DEMO موثق.' };
      }
    } else {
      return { success: false, reason: `نمط تنفيذ غير مدعوم (${this.activeExecutionMode}).` };
    }

    // 2. Check Consecutive Failures Limit
    if (this.consecutiveFailures >= this.safetyConfig.maxConsecutiveFailures) {
      return { success: false, reason: `تم تجاوز حد أخطاء التنفيذ المتتالية (${this.consecutiveFailures}).` };
    }

    // 3. Check Max Simultaneous Bot Positions
    const activeBotPos = this.getBotManagedPositions().length;
    if (activeBotPos >= this.safetyConfig.maxOpenPositions) {
      return { success: false, reason: `الحد الأقصى لعدد الصفقات النشطة (${this.safetyConfig.maxOpenPositions}) مكتمل.` };
    }

    // 4. Validate Symbol against Allowlist
    const rawSymbol = (params.symbol || this.lastStatus.brokerSymbol || 'XAUUSD').replace('/', '').toUpperCase();
    const isAllowedSymbol = this.safetyConfig.symbolAllowlist.some(
      (s) => s.toUpperCase() === rawSymbol || rawSymbol.startsWith(s.toUpperCase())
    );
    if (!isAllowedSymbol) {
      return { success: false, reason: `الرمز (${rawSymbol}) غير مدرج في قائمة الرموز المصرح بها للذهب.` };
    }

    // 5. Mandatory Protective Stop Loss Verification
    const entry = Number(params.price);
    const sl = Number(params.sl);
    const tp = Number(params.tp);
    const isBuy = params.action.includes('BUY');

    if (!Number.isFinite(entry) || !Number.isFinite(sl) || sl <= 0) {
      return { success: false, reason: 'وقف الخسارة (Stop Loss) إلزامي وصارم. لا يمكن فتح أي صفقة بدون SL.' };
    }

    if (isBuy && sl >= entry) {
      return { success: false, reason: `وقف الخسارة لصفقة الشراء (${sl}) يجب أن يكون أدنى من سعر الدخول (${entry}).` };
    }
    if (!isBuy && sl <= entry) {
      return { success: false, reason: `وقف الخسارة لصفقة البيع (${sl}) يجب أن يكون أعلى من سعر الدخول (${entry}).` };
    }

    const settings = storage.getSettings();
    const minSlPoints = settings.minGoldSlPoints ?? 35;
    const maxSlPoints = settings.maxGoldSlPoints ?? 85;
    const slPoints = Math.round(Math.abs(entry - sl) / 0.1);

    if (slPoints < minSlPoints || slPoints > maxSlPoints) {
      return { success: false, reason: `مسافة وقف الخسارة (${slPoints} نقطة) خارج النطاق المحدد للذهب (${minSlPoints}-${maxSlPoints} نقطة).` };
    }

    if (this.symbolSpecs && this.symbolSpecs.stopsLevel > 0) {
      const stopsLevelPoints = Math.round(this.symbolSpecs.stopsLevel);
      if (slPoints < stopsLevelPoints) {
        return { success: false, reason: `مسافة وقف الخسارة (${slPoints} نقطة) أقل من الحد الأدنى للوسيط (${stopsLevelPoints} نقطة).` };
      }
    }

    // 6. Volume Constraint Check (Broker Specs & Safety Config)
    const volume = Number(params.volume) || 0.01;
    const volumeMin = this.symbolSpecs?.volumeMin || 0.01;
    const volumeMax = Math.min(this.symbolSpecs?.volumeMax || 100, this.safetyConfig.maxOrderVolume);
    if (volume < volumeMin) {
      return { success: false, reason: `حجم اللوت المطلوب (${volume}) أقل من الحد الأدنى للوسيط (${volumeMin}).` };
    }
    if (volume > volumeMax) {
      return { success: false, reason: `حجم اللوت المطلوب (${volume}) يتجاوز الحد المسموح للأمان (${volumeMax}).` };
    }

    // Fail closed if broker specs are explicitly invalid
    if (this.symbolSpecs && !this.symbolSpecs.isValid) {
      return { success: false, reason: 'مواصفات الرمز غير صالحة لدى وسيط MT5.' };
    }

    // 7. Check Daily Realized Loss Limit
    const todayStats = storage.getTodayStats();
    if (todayStats.totalPl <= -this.safetyConfig.maxDailyRealizedLossUsd) {
      return { success: false, reason: `تم الوصول إلى الحد الأقصى للخسارة اليومية المسموحة ($${this.safetyConfig.maxDailyRealizedLossUsd}).` };
    }

    // 8. Generate Idempotent Unique Command ID
    const commandId = params.commandId || `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // Avoid duplicate commands
    if (this.commands.has(commandId)) {
      const existing = this.commands.get(commandId)!;
      if (existing.status !== 'REJECTED' && existing.status !== 'FAILED') {
        return { success: true, commandId, reason: 'Command already queued or executed' };
      }
    }

    const cmd: MT5ExecutionCommand = {
      commandId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      action: params.action,
      symbol: rawSymbol,
      volume,
      price: entry,
      sl,
      tp,
      tp2: params.tp2,
      magic: this.safetyConfig.magicNumber,
      comment: params.comment ? params.comment.substring(0, 31) : 'GB-V5 Demo Trade',
      accountMode: this.activeExecutionMode,
      status: 'PENDING',
      retryCount: 0,
      maxRetries: 2,
    };

    this.commands.set(commandId, cmd);
    console.log(`[MT5Bridge] Demo order queued: ${commandId} (${params.action} ${volume} ${rawSymbol} @ ${entry})`);

    return { success: true, commandId };
  }

  public async modifyOrder(params: {
    ticket: number;
    stopLoss?: number;
    takeProfit?: number;
    accountMode?: string;
    commandId?: string;
  }): Promise<{ success: boolean; commandId?: string; message?: string; reason?: string }> {
    if (!params.ticket || params.ticket <= 0) {
      return { success: false, reason: 'رقم التذكرة (ticket) غير صالحة.' };
    }

    if (this.killSwitchActivated) {
      return { success: false, reason: `تم إيقاف التداول آلياً عبر مفتاح الأمان (Kill-Switch): ${this.killSwitchReason}` };
    }

    if (!this.isAvailable()) {
      return { success: false, reason: 'جسر MetaTrader 5 غير متصل أو غير جاهز حالياً.' };
    }

    if (params.stopLoss !== undefined && (isNaN(params.stopLoss) || params.stopLoss < 0)) {
      return { success: false, reason: 'قيمة وقف الخسارة (Stop Loss) غير صالحة.' };
    }

    if (params.takeProfit !== undefined && (isNaN(params.takeProfit) || params.takeProfit < 0)) {
      return { success: false, reason: 'قيمة هدف الربح (Take Profit) غير صالحة.' };
    }

    const commandId = params.commandId || `mod_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    if (this.commands.has(commandId)) {
      const existing = this.commands.get(commandId)!;
      if (existing.status !== 'REJECTED' && existing.status !== 'FAILED') {
        return { success: true, commandId, message: 'Command already queued or executed' };
      }
    }

    const cmd: MT5ExecutionCommand = {
      commandId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      action: 'MODIFY',
      symbol: 'XAUUSD',
      volume: 0,
      sl: params.stopLoss ?? 0,
      tp: params.takeProfit ?? 0,
      ticket: params.ticket,
      magic: this.safetyConfig.magicNumber,
      comment: 'GB-V5 Modify Order',
      accountMode: params.accountMode || this.activeExecutionMode,
      status: 'PENDING',
      retryCount: 0,
      maxRetries: 2,
    };
    this.commands.set(commandId, cmd);
    console.log(`[MT5Bridge] Modify command queued: ${commandId} for ticket #${params.ticket}`);
    return { success: true, commandId, message: 'تم إدراج أمر التعديل في قائمة الانتظار.' };
  }

  public async closeOrder(params: {
    ticket: number;
    lot?: number;
    accountMode?: string;
    commandId?: string;
  }): Promise<{ success: boolean; commandId?: string; message?: string; reason?: string }> {
    if (!params.ticket || params.ticket <= 0) {
      return { success: false, reason: 'رقم التذكرة (ticket) غير صالحة.' };
    }

    if (this.killSwitchActivated) {
      return { success: false, reason: `تم إيقاف التداول آلياً عبر مفتاح الأمان (Kill-Switch): ${this.killSwitchReason}` };
    }

    if (!this.isAvailable()) {
      return { success: false, reason: 'جسر MetaTrader 5 غير متصل أو غير جاهز حالياً.' };
    }

    if (params.lot !== undefined && (isNaN(params.lot) || params.lot < 0)) {
      return { success: false, reason: 'حجم اللوت المطلوب للإغلاق غير صالح.' };
    }

    if (params.lot !== undefined && params.lot > 0 && this.symbolSpecs) {
      const minVol = this.symbolSpecs.volumeMin || 0.01;
      const maxVol = Math.min(this.symbolSpecs.volumeMax || 100, this.safetyConfig.maxOrderVolume);
      if (params.lot < minVol) {
        return { success: false, reason: `حجم اللوت المطلوب للإغلاق (${params.lot}) أقل من الحد الأدنى للوسيط (${minVol}).` };
      }
      if (params.lot > maxVol) {
        return { success: false, reason: `حجم اللوت المطلوب للإغلاق (${params.lot}) يتجاوز الحد المسموح للأمان (${maxVol}).` };
      }
    }

    const commandId = params.commandId || `cls_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    if (this.commands.has(commandId)) {
      const existing = this.commands.get(commandId)!;
      if (existing.status !== 'REJECTED' && existing.status !== 'FAILED') {
        return { success: true, commandId, message: 'Command already queued or executed' };
      }
    }

    const cmd: MT5ExecutionCommand = {
      commandId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      action: 'CLOSE',
      symbol: 'XAUUSD',
      volume: params.lot ?? 0,
      sl: 0,
      tp: 0,
      ticket: params.ticket,
      magic: this.safetyConfig.magicNumber,
      comment: 'GB-V5 Close Order',
      accountMode: params.accountMode || this.activeExecutionMode,
      status: 'PENDING',
      retryCount: 0,
      maxRetries: 2,
    };
    this.commands.set(commandId, cmd);
    console.log(`[MT5Bridge] Close command queued: ${commandId} for ticket #${params.ticket}`);
    return { success: true, commandId, message: 'تم إدراج أمر الإغلاق في قائمة الانتظار.' };
  }

  public async getOrderStatus(ticket: number): Promise<{
    success: boolean;
    command?: MT5ExecutionCommand;
    position?: any;
    status?: string;
    message?: string;
  }> {
    if (!ticket || ticket <= 0) {
      return { success: false, message: 'رقم التذكرة (ticket) غير صالحة.' };
    }

    for (const cmd of this.commands.values()) {
      if (cmd.ticket === ticket || cmd.orderTicket === ticket || cmd.positionTicket === ticket) {
        return { success: true, command: cmd, status: cmd.status };
      }
    }

    if (this.openPositions.has(ticket)) {
      const pos = this.openPositions.get(ticket);
      return {
        success: true,
        position: pos,
        status: 'OPEN',
      };
    }

    return { success: false, message: `لم يتم العثور على أمر أو صفقة برقم التذكرة ${ticket}` };
  }

  /**
   * Called by Windows Bridge via GET /api/mt5/bridge/commands/poll
   * Returns commands with status 'PENDING'
   */
  public pollPendingCommands(): MT5ExecutionCommand[] {
    const now = Date.now();
    this.checkCommandTimeouts(now);

    const pending: MT5ExecutionCommand[] = [];

    for (const cmd of this.commands.values()) {
      if (cmd.status === 'PENDING') {
        // Check if command is still within fresh quote window
        if (now - cmd.createdAt > this.safetyConfig.maxQuoteAgeSeconds * 1000) {
          cmd.status = 'CANCELLED';
          cmd.failureReason = `انتهت صلاحية الأمر لتجاوز وقت الاقتباس (${this.safetyConfig.maxQuoteAgeSeconds} ثانية).`;
          cmd.updatedAt = now;
          continue;
        }

        // Live execution policy enforcement at dispatch boundary
        if (cmd.accountMode === 'LIVE') {
          const livePolicy = this.evaluateLiveExecutionPolicy();
          if (!livePolicy.allowed || !this.liveTradingAuthorized) {
            cmd.status = 'CANCELLED';
            cmd.failureReason = `تم إلغاء الأمر لتعليق تفويض التداول الحقيقي: ${livePolicy.reason || 'التفويض غير نشط'}.`;
            cmd.updatedAt = now;
            continue;
          }
        }

        cmd.status = 'DISPATCHED';
        cmd.updatedAt = now;
        pending.push(cmd);
      }
    }

    if (pending.length > 0) {
      this.persistCommandsToDisk();
    }

    return pending;
  }

  /**
   * Called by Windows Bridge via POST /api/mt5/bridge/commands/:commandId/result
   * Validates execution details and idempotently updates command and ledger state.
   */
  public handleCommandResult(
    commandId: string,
    result: {
      success: boolean;
      status: 'FILLED' | 'REJECTED' | 'FAILED' | 'CANCELLED';
      orderTicket?: number;
      dealTicket?: number;
      positionTicket?: number;
      executionPrice?: number;
      retcode?: number;
      retcodeDescription?: string;
      message?: string;
      orderCancelled?: boolean;
    },
    targetStorage: PersistentStorage = storage
  ): { success: boolean; message?: string } {
    const cmd = this.commands.get(commandId);
    if (!cmd) {
      console.warn(`[MT5Bridge] Received result for unknown command: ${commandId}`);
      return { success: false, message: 'UNKNOWN_COMMAND' };
    }

    // 1. Idempotency Check: Don't process already finalized terminal commands
    if (cmd.status === 'FILLED') {
      return { success: true, message: 'ALREADY_FILLED' };
    }
    if (cmd.status === 'REJECTED' || cmd.status === 'FAILED' || cmd.status === 'CANCELLED') {
      return { success: true, message: 'ALREADY_FINALIZED' };
    }
    // Note: If cmd.status === 'UNRESOLVED', allow recovery and resolution when broker confirmation arrives!

    cmd.updatedAt = Date.now();

    // 2. Pending-Order Cancellation Handling
    // Python bridge handles pending order cancellation via TRADE_ACTION_REMOVE
    if (cmd.action === 'CANCEL' || result.status === 'CANCELLED' || result.orderCancelled) {
      const ticket = Number(cmd.ticket || result.orderTicket || result.positionTicket);
      cmd.status = 'CANCELLED';
      cmd.orderTicket = ticket;
      cmd.retcode = result.retcode;
      cmd.retcodeDescription = result.retcodeDescription;
      this.consecutiveFailures = 0;

      if (ticket) {
        const tradeId = `mt5_${ticket}`;
        const existingTrade = targetStorage.getTrade(tradeId) ||
          targetStorage.getTrades().find((t) => t.brokerPositionTicket === ticket || t.brokerOrderId === String(ticket));
        if (existingTrade && existingTrade.result === 'OPEN') {
          targetStorage.closeTrade(
            existingTrade.id,
            'CANCELLED',
            0,
            undefined,
            `Cancelled pending order #${ticket}`
          );
        }
      }

      this.persistCommandsToDisk();
      console.log(`[MT5Bridge] Command ${commandId} cancelled order #${ticket} safely without phantom trades.`);
      return { success: true, message: 'CANCELLED' };
    }

    // 3. Handle Non-FILLED Results (REJECTED or FAILED)
    if (result.status !== 'FILLED') {
      cmd.status = result.status;
      cmd.retcode = result.retcode;
      cmd.retcodeDescription = result.retcodeDescription;
      cmd.failureReason = result.message || result.retcodeDescription || 'Broker Rejected';
      this.consecutiveFailures += 1;

      console.warn(
        `[MT5Bridge] Command ${commandId} ${result.status}: ${cmd.failureReason} (Failures: ${this.consecutiveFailures})`
      );

      if (this.consecutiveFailures >= this.safetyConfig.maxConsecutiveFailures) {
        this.activateKillSwitch(`تجاوز عدد أخطاء التنفيذ المتتالية (${this.consecutiveFailures} أخطاء).`);
      }

      // Safe Telegram dispatch: only for production storage singleton
      if (!targetStorage.isTestingMode() && targetStorage === storage) {
        telegramService.sendSystemAlert(
          `⚠️ <b>فشل تنفيذ أمر MT5 DEMO</b>\n\n` +
          `• <b>الأمر:</b> ${cmd.action} ${cmd.symbol}\n` +
          `• <b>السبب:</b> ${cmd.failureReason}\n` +
          `• <b>كود الوسيط:</b> ${result.retcode || 'N/A'}\n` +
          `⏱ <i>${new Date().toLocaleTimeString('ar-EG')}</i>`
        );
      }

      this.persistCommandsToDisk();
      return { success: true, message: 'COMMAND_REJECTED' };
    }

    // 4. Handle FILLED Results by Action
    if (cmd.action === 'BUY' || cmd.action === 'SELL') {
      const ticket = Number(result.positionTicket || result.orderTicket);
      const execPrice = Number(result.executionPrice !== undefined ? result.executionPrice : cmd.price);
      const volume = Number(cmd.volume);

      // Validation: Strict fail-closed on missing or invalid execution parameters
      if (!Number.isInteger(ticket) || ticket <= 0) {
        cmd.status = 'FAILED';
        cmd.failureReason = 'Missing or invalid ticket for position opening';
        console.warn(`[MT5Bridge] Command ${commandId} failed: missing/invalid ticket (${result.positionTicket || result.orderTicket})`);
        this.persistCommandsToDisk();
        return { success: false, message: 'MISSING_OR_INVALID_TICKET' };
      }

      if (isNaN(execPrice) || !Number.isFinite(execPrice) || execPrice <= 0) {
        cmd.status = 'FAILED';
        cmd.failureReason = 'Missing or invalid execution price';
        console.warn(`[MT5Bridge] Command ${commandId} failed: missing/invalid execution price (${execPrice})`);
        this.persistCommandsToDisk();
        return { success: false, message: 'MISSING_OR_INVALID_PRICE' };
      }

      if (isNaN(volume) || !Number.isFinite(volume) || volume <= 0) {
        cmd.status = 'FAILED';
        cmd.failureReason = 'Invalid volume';
        console.warn(`[MT5Bridge] Command ${commandId} failed: invalid volume (${volume})`);
        this.persistCommandsToDisk();
        return { success: false, message: 'INVALID_VOLUME' };
      }

      // Mark command filled
      cmd.status = 'FILLED';
      cmd.positionTicket = ticket;
      cmd.orderTicket = Number(result.orderTicket) || ticket;
      cmd.dealTicket = Number(result.dealTicket) || undefined;
      cmd.executionPrice = execPrice;
      cmd.retcode = result.retcode;
      cmd.retcodeDescription = result.retcodeDescription;
      this.consecutiveFailures = 0;

      // Idempotently create managed open trade in ledger
      const tradeId = `mt5_${ticket}`;
      const existingTrade = targetStorage.getTrade(tradeId);
      if (!existingTrade) {
        const sl = Number.isFinite(cmd.sl) ? cmd.sl : 0;
        const tp1 = Number.isFinite(cmd.tp) ? cmd.tp : 0;
        const tp2 = (cmd.tp2 && Number.isFinite(cmd.tp2)) ? cmd.tp2 : undefined;
        const slPoints = sl > 0 ? Math.round(Math.abs(execPrice - sl) / 0.1) : 0;
        const tp1Points = tp1 > 0 ? Math.round(Math.abs(tp1 - execPrice) / 0.1) : 0;
        const tp2Points = (tp2 && tp2 > 0) ? Math.round(Math.abs(tp2 - execPrice) / 0.1) : undefined;

        const currentCap = typeof targetStorage.getCurrentBalance === 'function'
          ? targetStorage.getCurrentBalance()
          : targetStorage.getSettings().manualCapital;

        const tradeItem: TradeLedgerItem = {
          id: tradeId,
          signalId: cmd.commandId,
          tradeNumber: (targetStorage.getTrades(1)[0]?.tradeNumber || 0) + 1,
          date: new Date().toLocaleDateString('ar-EG', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
          isoTime: new Date().toISOString(),
          asset: 'XAU/USD',
          direction: cmd.action === 'BUY' ? 'BUY NOW' : 'SELL NOW',
          entry: execPrice,
          sl,
          slPoints,
          tp1,
          tp1Points,
          tp2,
          tp2Points,
          rr: tp1Points > 0 && slPoints > 0 ? `1:${(tp1Points / slPoints).toFixed(1)}` : '1:2.0',
          riskPercent: 1.5,
          riskAmount: 1.5,
          lotSize: volume,
          confidence: 85,
          setup: 'GB-V5 Demo Execution',
          result: 'OPEN',
          pl: 0,
          balanceAfterTrade: currentCap,
          notes: `Executed via Windows MT5 Demo Bridge [Ticket #${ticket}]`,
          isActive: true,
          source: 'MT5' as any,
          brokerPositionTicket: ticket,
          brokerOrderId: String(result.orderTicket || ticket),
        };
        targetStorage.saveTrade(tradeItem);
        console.log(`[MT5Bridge] Open trade ${tradeId} created in ledger for command ${commandId}`);
      }

      if (!targetStorage.isTestingMode() && targetStorage === storage) {
        telegramService.sendSystemAlert(
          `✅ <b>تنفيذ صفقة DEMO على منصة MT5</b>\n\n` +
          `• <b>التذكرة:</b> #${ticket}\n` +
          `• <b>النوع:</b> ${cmd.action} (${cmd.symbol})\n` +
          `• <b>الحجم:</b> ${volume} لوت\n` +
          `• <b>سعر التنفيذ:</b> $${execPrice.toFixed(2)}\n` +
          `• <b>وقف الخسارة (SL):</b> $${cmd.sl.toFixed(2)}\n` +
          `• <b>الهدف (TP):</b> $${cmd.tp.toFixed(2)}\n` +
          `• <b>الماجيك:</b> ${cmd.magic}\n` +
          `⏱ <i>${new Date().toLocaleTimeString('ar-EG')}</i>`
        );
      }

      this.persistCommandsToDisk();
      return { success: true, message: 'FILLED' };
    } else if (cmd.action === 'MODIFY') {
      const ticket = Number(cmd.ticket || result.positionTicket || result.orderTicket);
      if (!Number.isInteger(ticket) || ticket <= 0) {
        cmd.status = 'FAILED';
        cmd.failureReason = 'Missing or invalid ticket for modify';
        console.warn(`[MT5Bridge] Modify command ${commandId} failed: invalid ticket (${ticket})`);
        this.persistCommandsToDisk();
        return { success: false, message: 'MISSING_OR_INVALID_TICKET' };
      }

      cmd.status = 'FILLED';
      cmd.positionTicket = ticket;
      cmd.retcode = result.retcode;
      cmd.retcodeDescription = result.retcodeDescription;
      this.consecutiveFailures = 0;

      // Locate existing trade to update SL/TP in place without creating new ledger entry
      const tradeId = `mt5_${ticket}`;
      const existingTrade = targetStorage.getTrade(tradeId) ||
        targetStorage.getTrades().find((t) =>
          t.brokerPositionTicket === ticket ||
          (t.notes && new RegExp(`\\b(Ticket|Position)\\s*#?\\s*${ticket}\\b`).test(t.notes))
        );

      if (existingTrade && existingTrade.result === 'OPEN') {
        if (Number.isFinite(cmd.sl) && cmd.sl > 0) {
          existingTrade.sl = cmd.sl;
          existingTrade.slPoints = Math.round(Math.abs(existingTrade.entry - cmd.sl) / 0.1);
        }
        if (Number.isFinite(cmd.tp) && cmd.tp > 0) {
          existingTrade.tp1 = cmd.tp;
          existingTrade.tp1Points = Math.round(Math.abs(cmd.tp - existingTrade.entry) / 0.1);
        }
        if (cmd.tp2 && Number.isFinite(cmd.tp2) && cmd.tp2 > 0) {
          existingTrade.tp2 = cmd.tp2;
          existingTrade.tp2Points = Math.round(Math.abs(cmd.tp2 - existingTrade.entry) / 0.1);
        }
        const modNote = `Modified SL: $${cmd.sl}, TP: $${cmd.tp}`;
        existingTrade.notes = existingTrade.notes ? `${existingTrade.notes} | ${modNote}` : modNote;
        targetStorage.saveTrade(existingTrade);
        console.log(`[MT5Bridge] Trade ${existingTrade.id} SL/TP updated for modify command ${commandId}`);
      } else {
        console.warn(`[MT5Bridge] Modify command filled for ticket #${ticket}, but no matching open trade found in ledger. Zero phantom trade created.`);
      }

      this.persistCommandsToDisk();
      return { success: true, message: 'FILLED' };
    } else if (cmd.action === 'CLOSE') {
      const ticket = Number(cmd.ticket || result.positionTicket || result.orderTicket);
      const exitPrice = Number(result.executionPrice);

      if (!Number.isInteger(ticket) || ticket <= 0) {
        cmd.status = 'FAILED';
        cmd.failureReason = 'Missing or invalid ticket for close';
        console.warn(`[MT5Bridge] Close command ${commandId} failed: invalid ticket (${ticket})`);
        this.persistCommandsToDisk();
        return { success: false, message: 'MISSING_OR_INVALID_TICKET' };
      }

      if (isNaN(exitPrice) || !Number.isFinite(exitPrice) || exitPrice <= 0) {
        cmd.status = 'FAILED';
        cmd.failureReason = 'Missing or invalid exit price for close';
        console.warn(`[MT5Bridge] Close command ${commandId} failed: invalid exit price (${exitPrice})`);
        this.persistCommandsToDisk();
        return { success: false, message: 'MISSING_OR_INVALID_PRICE' };
      }

      cmd.status = 'FILLED';
      cmd.positionTicket = ticket;
      cmd.executionPrice = exitPrice;
      cmd.retcode = result.retcode;
      cmd.retcodeDescription = result.retcodeDescription;
      this.consecutiveFailures = 0;

      // Locate existing open trade to settle without creating new opening trade entry
      const tradeId = `mt5_${ticket}`;
      const existingTrade = targetStorage.getTrade(tradeId) ||
        targetStorage.getTrades().find((t) =>
          t.brokerPositionTicket === ticket ||
          (t.notes && new RegExp(`\\b(Ticket|Position)\\s*#?\\s*${ticket}\\b`).test(t.notes))
        );

      if (existingTrade) {
        // If trade is already authoritatively settled by deal report, preserve authoritative settlement
        if (existingTrade.isAuthoritative || existingTrade.result !== 'OPEN') {
          console.log(`[MT5Bridge] Trade ${existingTrade.id} already authoritatively settled via MT5 Deal. Preserving authoritative PnL: $${existingTrade.pl}`);
        } else {
          const lotSize = Number(cmd.volume || existingTrade.lotSize || 0.01);
          const isBuy = existingTrade.direction.toUpperCase().includes('BUY');
          const diff = isBuy
            ? (exitPrice - existingTrade.entry)
            : (existingTrade.entry - exitPrice);
          const realizedPnl = Number((diff * lotSize * 100).toFixed(2));
          const outcome: 'WIN' | 'LOSS' = realizedPnl >= 0 ? 'WIN' : 'LOSS';

          existingTrade.isInterimClose = true;
          targetStorage.closeTrade(
            existingTrade.id,
            outcome,
            realizedPnl,
            exitPrice,
            `Closed via MT5 Bridge CLOSE command [Ticket #${ticket}]`
          );
          console.log(`[MT5Bridge] Trade ${existingTrade.id} settled via close command ${commandId} with interim PnL: $${realizedPnl}`);
        }
      } else {
        console.warn(`[MT5Bridge] Close command filled for ticket #${ticket}, but no matching open trade found in ledger. Zero phantom trade created.`);
      }

      this.persistCommandsToDisk();
      return { success: true, message: 'FILLED' };
    }

    this.persistCommandsToDisk();
    return { success: true, message: 'FILLED' };
  }

  public getCommand(commandId: string): MT5ExecutionCommand | undefined {
    return this.commands.get(commandId);
  }

  public cancelOrder(ticket: number, comment: string = 'GB-V5 Cancel Order'): { success: boolean; commandId?: string; reason?: string } {
    if (!Number.isInteger(ticket) || ticket <= 0) {
      return { success: false, reason: 'رقم التذكرة غير صالح' };
    }
    const commandId = `cmd_cancel_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const cmd: MT5ExecutionCommand = {
      commandId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      action: 'CANCEL',
      symbol: 'XAUUSD',
      volume: 0,
      sl: 0,
      tp: 0,
      ticket,
      magic: this.safetyConfig.magicNumber,
      comment,
      accountMode: this.activeExecutionMode,
      status: 'PENDING',
      retryCount: 0,
      maxRetries: 2,
    };
    this.commands.set(commandId, cmd);
    this.persistCommandsToDisk();
    console.log(`[MT5Bridge] Cancel order queued for ticket #${ticket} [Command: ${commandId}]`);
    return { success: true, commandId };
  }

  // =========================================================================
  // MT5 Deal History & Closed Trade Reconciliation
  // =========================================================================

  /**
   * Called by Windows Bridge via POST /api/mt5/bridge/deals
   * Reconciles closed deals from MT5 with trade ledger and realized PnL
   */
  public handleDealsReport(
    deals: MT5DealRecord[],
    targetStorage: PersistentStorage = storage
  ): {
    success: boolean;
    processedCount: number;
    duplicateCount: number;
  } {
    if (!Array.isArray(deals)) {
      return { success: false, processedCount: 0, duplicateCount: 0 };
    }

    let processedCount = 0;
    let duplicateCount = 0;

    for (const deal of deals) {
      const ticket = Number(deal.ticket);
      if (!ticket) continue;

      if (this.processedDealTickets.has(ticket)) {
        duplicateCount++;
        continue;
      }

      // Reconcile exit deals that finalize a trade outcome
      const isExit = deal.entry === 1 || deal.entry === 2 || deal.entry === 3 || (deal.entry !== 0 && deal.profit !== 0);
      if (!isExit) {
        continue;
      }

      this.processedDealTickets.add(ticket);

      const netPnl = Number(((deal.profit || 0) + (deal.commission || 0) + (deal.swap || 0)).toFixed(2));
      const res = targetStorage.reconcileMt5Trade({
        signalOrTradeId: `mt5_${deal.positionId || deal.order || ticket}`,
        brokerDealId: String(ticket),
        brokerOrderId: String(deal.order),
        positionTicket: deal.positionId,
        entryPrice: undefined,
        exitPrice: Number(deal.price || 0),
        lotSize: Number(deal.volume || 0.01),
        realizedPnl: netPnl,
        closedAt: Number(deal.time ? deal.time * 1000 : Date.now()),
        closeReason: deal.comment || 'MT5_CLOSED_DEAL',
        direction: deal.type === 0 ? 'BUY' : 'SELL',
        commission: Number(deal.commission || 0),
        swap: Number(deal.swap || 0),
      });

      if (res.success) {
        processedCount++;
        if (!targetStorage.isTestingMode() && targetStorage === storage) {
          const emoji = netPnl >= 0 ? '🎉 ربح' : '⚠️ خسارة';
          telegramService.sendSystemAlert(
            `📊 <b>تسوية صفقة MT5 DEMO مغلقة</b>\n\n` +
            `• <b>التذكرة:</b> #${deal.positionId || ticket}\n` +
            `• <b>تذكرة الصفقة:</b> #${ticket}\n` +
            `• <b>النوع:</b> ${deal.type === 0 ? 'BUY' : 'SELL'} (${deal.volume} لوت)\n` +
            `• <b>النتيجة:</b> ${emoji} ($${netPnl.toFixed(2)})\n` +
            `• <b>سعر الإغلاق:</b> $${deal.price?.toFixed(2)}\n` +
            `• <b>العمولة/السواب:</b> $${((deal.commission || 0) + (deal.swap || 0)).toFixed(2)}\n` +
            `⏱ <i>${new Date().toLocaleTimeString('ar-EG')}</i>`
          );
        }
      }
    }

    if (processedCount > 0) {
      this.persistCommandsToDisk();
    }

    return { success: true, processedCount, duplicateCount };
  }

  // =========================================================================
  // Historical Candles for Backtesting
  // =========================================================================

  public storeHistoricalCandles(timeframe: string, candles: Candle[]) {
    if (!Array.isArray(candles) || candles.length === 0) return;
    const tf = timeframe.toUpperCase();
    const existing = this.candleCache.get(tf) || [];

    const candleMap = new Map<number, Candle>();
    for (const c of existing) {
      if (c && typeof c.timestamp === 'number') {
        candleMap.set(c.timestamp, c);
      }
    }
    for (const c of candles) {
      if (c && typeof c.timestamp === 'number') {
        candleMap.set(c.timestamp, c);
      }
    }

    const merged = Array.from(candleMap.values()).sort((a, b) => a.timestamp - b.timestamp);
    this.candleCache.set(tf, merged);
    this.lastCandleSyncTime = Date.now();
    this.persistCandleCacheToDisk();
    console.log(`[MT5Bridge] Stored ${merged.length} historical candles for ${tf} from MT5 (incoming batch: ${candles.length}).`);
  }

  public getHistoricalCandles(timeframe: string): Candle[] | null {
    const tf = timeframe.toUpperCase();
    return this.candleCache.get(tf) || null;
  }

  public hasHistoricalCandles(timeframe: string): boolean {
    const candles = this.getHistoricalCandles(timeframe);
    return Boolean(candles && candles.length >= 30);
  }

  public clearCandleCache(): void {
    this.candleCache.clear();
    this.lastCandleSyncTime = 0;
  }

  // =========================================================================
  // Status and Telemetry
  // =========================================================================

  public getStatus() {
    return {
      account: { ...this.lastStatus },
      brokerSpecs: this.symbolSpecs,
      brokerSpecsValid: this.isBrokerSpecsValid(),
      safety: {
        demoAutoTradingEnabled: this.demoAutoTradingEnabled,
        killSwitchActivated: this.killSwitchActivated,
        isVerifiedDemo: this.isVerifiedDemoAccount(),
        isVerifiedReal: this.isVerifiedRealAccount(),
        isLiveConfigured: this.isLiveExecutionConfigured(),
        liveTradingAuthorized: this.liveTradingAuthorized,
        isAutoTradingActive: this.isDemoAutoTradingActive(),
        consecutiveFailures: this.consecutiveFailures,
        safetyConfig: { ...this.safetyConfig },
      },
      positions: {
        totalOpen: this.openPositions.size,
        botManagedCount: this.getBotManagedPositions().length,
        openBotPositions: this.getBotManagedPositions(),
      },
      candles: {
        hasM1: this.hasHistoricalCandles('M1'),
        hasM5: this.hasHistoricalCandles('M5'),
        hasM15: this.hasHistoricalCandles('M15'),
        hasH1: this.hasHistoricalCandles('H1'),
        lastSync: this.lastCandleSyncTime,
      },
      commands: {
        total: this.commands.size,
        recent: Array.from(this.commands.values()).slice(-10),
      },
    };
  }

  public getAccountStatus(): Promise<MT5AccountStatus> {
    return Promise.resolve({ ...this.lastStatus });
  }

  public isAvailable(): boolean {
    if (!this.lastStatus.connected) return false;
    if (this.activeExecutionMode === 'LIVE') {
      return this.isVerifiedRealAccount() && this.liveTradingAuthorized;
    }
    return this.isVerifiedDemoAccount();
  }
}

export const mt5Bridge = new MT5BridgeService();
