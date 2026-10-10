import { Candle } from '../src/types.js';
import { storage } from './storage.js';
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
  accountMode: 'DEMO';
  tradeMode?: number; // 0 = DEMO in MetaTrader5
  leverage?: number;
  lastUpdated: number | null;
  statusMessage: string;
  brokerSymbol?: string;
  terminalConnected?: boolean;
  brokerSpecs?: MT5SymbolSpecs | null;
  brokerSpecsValid?: boolean;
}

export type MT5CommandAction = 'BUY' | 'SELL' | 'BUY_LIMIT' | 'SELL_LIMIT' | 'CLOSE' | 'MODIFY';

export type MT5CommandStatus = 
  | 'PENDING'
  | 'DISPATCHED'
  | 'FILLED'
  | 'REJECTED'
  | 'FAILED'
  | 'CANCELLED';

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

class MT5BridgeService {
  // Safety Boundary: Live trading is permanently disabled in this integration
  public readonly IS_LIVE_ALLOWED: boolean = false;

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
    symbolAllowlist: ['XAUUSD', 'GOLD', 'XAUUSDm', 'XAUUSD.a', 'XAUUSD.raw', 'XAUUSDb'],
  };

  // Commands Queue (Outbound Windows Agent polling)
  private commands: Map<string, MT5ExecutionCommand> = new Map();

  // Positions tracking
  private openPositions: Map<number, MT5PositionInfo> = new Map();

  // Historical Candles Cache (keyed by timeframe M1, M5, M15, H1)
  private candleCache: Map<string, Candle[]> = new Map();
  private lastCandleSyncTime: number = 0;

  constructor() {
    this.loadSafetyConfigFromEnv();
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
  public isVerifiedDemoAccount(): boolean {
    if (!this.lastStatus.connected) return false;
    if (this.lastStatus.status === 'REFUSED_REAL_ACCOUNT') return false;
    // If tradeMode is reported, it MUST be 0 (DEMO)
    if (typeof this.lastStatus.tradeMode === 'number') {
      return this.lastStatus.tradeMode === 0;
    }
    return this.lastStatus.accountMode === 'DEMO';
  }

  /**
   * Check whether automated demo trading is currently active and eligible
   */
  public isDemoAutoTradingActive(): boolean {
    if (this.killSwitchActivated) return false;
    if (!this.demoAutoTradingEnabled) return false;
    if (!this.isVerifiedDemoAccount()) return false;
    if (this.consecutiveFailures >= this.safetyConfig.maxConsecutiveFailures) return false;
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
    if (!this.isVerifiedDemoAccount()) {
      return { success: false, reason: 'الحساب ليس حساب DEMO معتمد أو نمط التداول غير تجريبي. التداول الحقيقي محظور نهائياً.' };
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
    console.log('[MT5Bridge] Demo Auto-Trading DISABLED by user.');
    return { success: true };
  }

  /**
   * Emergency Kill-Switch: Immediately halts new orders
   */
  public activateKillSwitch(reason: string = 'Emergency Kill-Switch Triggered'): { success: boolean } {
    this.killSwitchActivated = true;
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

    // Hard Safety Boundary: Check trade_mode
    // tradeMode === 2 is ACCOUNT_TRADE_MODE_REAL
    if (tradeMode === 2 || payload.accountMode?.toUpperCase() === 'REAL') {
      this.lastStatus = {
        connected: false,
        status: 'REFUSED_REAL_ACCOUNT',
        balance: null,
        equity: null,
        freeMargin: null,
        currency: payload.currency || 'USD',
        server: payload.server,
        accountNumber: payload.login ? String(payload.login) : undefined,
        accountMode: 'DEMO',
        tradeMode: tradeMode,
        lastUpdated: Date.now(),
        statusMessage: '❌ تم رفض الاتصال: الحساب حساب حقيقي (REAL). هذا النظام مخصص فقط للتداول التجريبي (DEMO ONLY).',
      };
      // Trip safety switch
      this.activateKillSwitch('محاولة ربط حساب حقيقي (REAL ACCOUNT ATTEMPT) - تم الحظر التلقائي.');
      return { success: false, message: 'Refused: Real accounts are strictly forbidden.' };
    }

    const isDemo = tradeMode === 0 || payload.accountMode?.toUpperCase() === 'DEMO';
    if (!isDemo && isTerminalConnected) {
      this.lastStatus = {
        connected: false,
        status: 'REFUSED_REAL_ACCOUNT',
        balance: null,
        equity: null,
        freeMargin: null,
        currency: payload.currency || 'USD',
        accountMode: 'DEMO',
        lastUpdated: Date.now(),
        statusMessage: '❌ لا يمكن التحقق من أن الحساب تجريبي (DEMO). تم رفض التنفيذ.',
      };
      return { success: false, message: 'Refused: Unverified account mode.' };
    }

    const wasDisconnected = !this.lastStatus.connected;

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
      server: payload.server,
      accountNumber: payload.login ? String(payload.login) : undefined,
      accountMode: 'DEMO',
      tradeMode: tradeMode ?? 0,
      leverage: payload.leverage,
      lastUpdated: Date.now(),
      statusMessage: isTerminalConnected ? 'MT5 Demo Terminal Connected' : 'Terminal Disconnected',
      brokerSymbol: payload.brokerGoldSymbol || (payload.symbols && payload.symbols[0]) || 'XAUUSD',
      terminalConnected: isTerminalConnected,
      brokerSpecs: this.symbolSpecs,
      brokerSpecsValid: this.isBrokerSpecsValid(),
    };

    // If bridge reconnected after disconnection, ensure auto-trading stays disabled until verified
    if (wasDisconnected && isTerminalConnected) {
      console.log('[MT5Bridge] Windows MT5 Bridge connected. Auto-trading is disabled by default for safety.');
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
    // 1. Check Safety Boundary
    if (!this.isVerifiedDemoAccount()) {
      return { success: false, reason: 'حساب MT5 غير متصل أو ليس حساب DEMO موثق.' };
    }
    if (this.killSwitchActivated) {
      return { success: false, reason: 'زر الطوارئ مفعّل - تم حظر فتح صفقات جديدة.' };
    }
    if (!this.demoAutoTradingEnabled) {
      return { success: false, reason: 'التداول التجريبي التلقائي معطل حالياً (Auto-trading disabled).' };
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
      status: 'PENDING',
      retryCount: 0,
      maxRetries: 2,
    };

    this.commands.set(commandId, cmd);
    console.log(`[MT5Bridge] Demo order queued: ${commandId} (${params.action} ${volume} ${rawSymbol} @ ${entry})`);

    return { success: true, commandId };
  }

  /**
   * Called by Windows Bridge via GET /api/mt5/bridge/commands/poll
   * Returns commands with status 'PENDING'
   */
  public pollPendingCommands(): MT5ExecutionCommand[] {
    const pending: MT5ExecutionCommand[] = [];
    const now = Date.now();

    for (const cmd of this.commands.values()) {
      if (cmd.status === 'PENDING') {
        // Check if command is still within fresh quote window
        if (now - cmd.createdAt > this.safetyConfig.maxQuoteAgeSeconds * 1000) {
          cmd.status = 'CANCELLED';
          cmd.failureReason = `انتهت صلاحية الأمر لتجاوز وقت الاقتباس (${this.safetyConfig.maxQuoteAgeSeconds} ثانية).`;
          cmd.updatedAt = now;
          continue;
        }

        cmd.status = 'DISPATCHED';
        cmd.updatedAt = now;
        pending.push(cmd);
      }
    }

    return pending;
  }

  /**
   * Called by Windows Bridge via POST /api/mt5/bridge/commands/:commandId/result
   */
  public handleCommandResult(commandId: string, result: {
    success: boolean;
    status: 'FILLED' | 'REJECTED' | 'FAILED';
    orderTicket?: number;
    dealTicket?: number;
    positionTicket?: number;
    executionPrice?: number;
    retcode?: number;
    retcodeDescription?: string;
    message?: string;
  }): { success: boolean } {
    const cmd = this.commands.get(commandId);
    if (!cmd) {
      console.warn(`[MT5Bridge] Received result for unknown command: ${commandId}`);
      return { success: false };
    }

    cmd.updatedAt = Date.now();
    cmd.status = result.status;
    cmd.orderTicket = result.orderTicket;
    cmd.dealTicket = result.dealTicket;
    cmd.positionTicket = result.positionTicket || result.orderTicket;
    cmd.executionPrice = result.executionPrice;
    cmd.retcode = result.retcode;
    cmd.retcodeDescription = result.retcodeDescription;
    cmd.failureReason = result.message;

    if (result.status === 'FILLED') {
      this.consecutiveFailures = 0; // Reset consecutive failures
      console.log(`[MT5Bridge] Command ${commandId} successfully FILLED on broker. Ticket: #${cmd.positionTicket}`);

      // Notify Telegram
      telegramService.sendSystemAlert(
        `✅ <b>تنفيذ صفقة DEMO على منصة MT5</b>\n\n` +
        `• <b>التذكرة:</b> #${cmd.positionTicket}\n` +
        `• <b>النوع:</b> ${cmd.action} (${cmd.symbol})\n` +
        `• <b>الحجم:</b> ${cmd.volume} لوت\n` +
        `• <b>سعر التنفيذ:</b> $${result.executionPrice?.toFixed(2) || cmd.price?.toFixed(2)}\n` +
        `• <b>وقف الخسارة (SL):</b> $${cmd.sl.toFixed(2)}\n` +
        `• <b>الهدف (TP):</b> $${cmd.tp.toFixed(2)}\n` +
        `• <b>الماجيك:</b> ${cmd.magic}\n` +
        `⏱ <i>${new Date().toLocaleTimeString('ar-EG')}</i>`
      );
    } else {
      this.consecutiveFailures += 1;
      console.warn(`[MT5Bridge] Command ${commandId} ${result.status}: ${result.message} (Failures: ${this.consecutiveFailures})`);

      if (this.consecutiveFailures >= this.safetyConfig.maxConsecutiveFailures) {
        this.activateKillSwitch(`تجاوز عدد أخطاء التنفيذ المتتالية (${this.consecutiveFailures} أخطاء).`);
      }

      // Notify Telegram of rejection
      telegramService.sendSystemAlert(
        `⚠️ <b>فشل تنفيذ أمر MT5 DEMO</b>\n\n` +
        `• <b>الأمر:</b> ${cmd.action} ${cmd.symbol}\n` +
        `• <b>السبب:</b> ${result.message || result.retcodeDescription || 'Broker Rejected'}\n` +
        `• <b>كود الوسيط:</b> ${result.retcode || 'N/A'}\n` +
        `⏱ <i>${new Date().toLocaleTimeString('ar-EG')}</i>`
      );
    }

    return { success: true };
  }

  // =========================================================================
  // MT5 Deal History & Closed Trade Reconciliation
  // =========================================================================

  /**
   * Called by Windows Bridge via POST /api/mt5/bridge/deals
   * Reconciles closed deals from MT5 with trade ledger and realized PnL
   */
  public handleDealsReport(deals: MT5DealRecord[]): {
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
      const res = storage.reconcileMt5Trade({
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

    return { success: true, processedCount, duplicateCount };
  }

  // =========================================================================
  // Historical Candles for Backtesting
  // =========================================================================

  public storeHistoricalCandles(timeframe: string, candles: Candle[]) {
    if (!Array.isArray(candles) || candles.length === 0) return;
    const tf = timeframe.toUpperCase();
    this.candleCache.set(tf, candles);
    this.lastCandleSyncTime = Date.now();
    console.log(`[MT5Bridge] Stored ${candles.length} historical candles for ${tf} from MT5.`);
  }

  public getHistoricalCandles(timeframe: string): Candle[] | null {
    const tf = timeframe.toUpperCase();
    return this.candleCache.get(tf) || null;
  }

  public hasHistoricalCandles(timeframe: string): boolean {
    const candles = this.getHistoricalCandles(timeframe);
    return Boolean(candles && candles.length >= 30);
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
    return this.lastStatus.connected && this.isVerifiedDemoAccount();
  }
}

export const mt5Bridge = new MT5BridgeService();
