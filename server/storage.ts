import * as fs from 'fs';
import * as path from 'path';
import {
  supabase,
  isSupabaseConfigured,
  getSupabaseClient,
  isSupabaseAvailable,
  executeSupabaseQuery,
} from './supabase.js';
import { telegramService } from './telegram.js';

import {
  AppSettings,
  DEFAULT_APP_SETTINGS,
  TradeSignal,
  TradeLedgerItem,
  PoiRecord,
  CandidateLifecycleRecord,
  TradeOpportunity,
} from '../src/types.js';

export type {
  AppSettings,
  TradeSignal,
  TradeLedgerItem,
  PoiRecord,
  CandidateLifecycleRecord,
  TradeOpportunity,
};

export interface ScanRecord {
  id: string;
  timestamp: number;
  time?: string;
  isoTime?: string;
  asset?: string;
  price?: number;
  currentPrice?: number;
  bias?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  signal: 'BUY NOW' | 'SELL NOW' | 'BUY LIMIT' | 'SELL LIMIT' | 'NO TRADE' | string;
  confidence: number;
  sl?: number;
  stopLoss?: number;
  slPoints?: number;
  tp1?: number;
  tp1Points?: number;
  tp1Rr?: any;
  tp2?: number;
  tp2Points?: number;
  tp2Rr?: any;
  rr?: string;
  riskPercent?: number;
  riskAmount?: number;
  lotSize?: number;
  setup?: string;
  setupName?: string;
  orderType?: 'MARKET' | 'LIMIT';
  status: 'PENDING' | 'EXECUTED' | 'EXPIRED' | 'CANCELLED' | 'SUCCESS' | 'NO TRADE' | 'FAILED' | string;
  reason?: string;
  strategy?: string;
  timeframe?: string;
  atr?: number;
  reasons?: string[];
  rawAnalysis?: string;
  entry?: number;
  setupId?: string;
  noTradeReason?: string;
  invalidation?: string;
  [key: string]: any;
}

export interface TradeOutcomeRecord {
  signalId: string;
  tradeId?: string;
  direction?: string;
  orderType?: string;
  entry?: number;
  stopLoss?: number;
  tp1?: number;
  tp2?: number;
  outcome: 'WIN' | 'LOSS' | 'BREAK_EVEN' | 'NOT_ENTERED';
  timestamp: number;
  isoTime?: string;
  chatId?: string;
  userId?: string;
  pl?: number;
  realizedPnl?: number;
  exitPrice?: number;
  source?: string;
  brokerDealId?: string;
  brokerOrderId?: string;
  closedAt?: number;
  closeReason?: string;
  notes?: string;
}

export interface DailyTradeStats {
  date: string;
  tradesCount: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPl: number;
  totalRiskPercentUsed: number;
  maxDailyTradesReached: boolean;
  maxDailyRiskReached: boolean;
}

export interface DashboardStatsResult {
  totalScans: number;
  totalSignals: number;
  buyCount: number;
  sellCount: number;
  limitCount: number;
  noTradeCount: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPl: number;
  startingBalance: number;
  currentBalance: number;
  currentRiskPercent: number;
  recentSignals: TradeSignal[];
  recentScans: ScanRecord[];
  lastScanTime: number;
  lastScanStatus: string;
  scannerHealth: string;
  todayStats: DailyTradeStats;
}



const DATA_DIR = path.join(process.cwd(), 'data');
const SCANS_FILE = path.join(DATA_DIR, 'scan_history.json');
const SIGNALS_FILE = path.join(DATA_DIR, 'saved_signals.json');
const TRADES_FILE = path.join(DATA_DIR, 'trade_ledger.json');
const TEST_TRADES_FILE = path.join(DATA_DIR, 'test_ledger.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'app_settings.json');
const OUTCOMES_FILE = path.join(DATA_DIR, 'trade_outcomes.json');
const ACCOUNT_FILE = path.join(DATA_DIR, 'account_state.json');
const TERMINAL_FILE = path.join(DATA_DIR, 'terminal_setups.json');
const OPPS_FILE = path.join(DATA_DIR, 'opportunities.json');
const TELEGRAM_CHAT_FILE = path.join(DATA_DIR, 'telegram_private_chat.json');
const BACKTEST_FILE = path.join(DATA_DIR, 'backtest_history.json');
const SNAPSHOTS_FILE = path.join(DATA_DIR, 'factor_snapshots.json');
const TEST_SNAPSHOTS_FILE = path.join(DATA_DIR, 'test_factor_snapshots.json');
const EXPERIENCES_FILE = path.join(DATA_DIR, 'experience_records.json');
const TELEGRAM_DISPATCHES_FILE = path.join(DATA_DIR, 'telegram_dispatches.json');
const POIS_FILE = path.join(DATA_DIR, 'pois.json');

const MAX_SCANS_TO_KEEP = 100;
const MAX_SIGNALS_TO_KEEP = 50;
const MAX_TRADES_TO_KEEP = 300;

export function isSyntheticTestRecord(trade: any): boolean {
  if (!trade) return false;
  if (trade.isTest === true || trade.environment === 'test' || trade.isSynthetic === true) return true;
  const id = String(trade.id || trade.tradeId || trade.signalId || '');
  if (
    id.startsWith('test-') ||
    id.startsWith('test_') ||
    id.startsWith('trade_single_') ||
    id.startsWith('trade_dual_') ||
    id.startsWith('trade_be_') ||
    id.startsWith('trade_trail_') ||
    id.startsWith('mock-') ||
    id.startsWith('phantom-')
  ) {
    return true;
  }
  const setup = String(trade.setup || trade.setupName || '');
  if (
    setup.startsWith('Single Target') ||
    setup.startsWith('Dual Target') ||
    setup.startsWith('BE Path') ||
    setup.startsWith('Cold Restart') ||
    setup.startsWith('Trailing Stop Test') ||
    setup.startsWith('Test Setup') ||
    setup.startsWith('Mock Setup')
  ) {
    return true;
  }
  return false;
}

export class PersistentStorage {
  private inMemoryScans: ScanRecord[] = [];
  private inMemorySignals: TradeSignal[] = [];
  private inMemoryTrades: TradeLedgerItem[] = [];
  private inMemoryTestTrades: TradeLedgerItem[] = [];
  private inMemoryOutcomes: TradeOutcomeRecord[] = [];
  private inMemoryPois: PoiRecord[] = [];
  private inMemoryLifecycles: CandidateLifecycleRecord[] = [];
  private inMemoryOpportunities: Map<string, TradeOpportunity> = new Map();
  private inMemoryTerminalSetups: Set<string> = new Set();
  public inMemoryTelegramDispatches: Set<string> = new Set();
  private inMemoryTelegramChatId: string | null = null;
  private inMemoryFactorSnapshots: Map<string, any> = new Map();
  private inMemoryTestFactorSnapshots: Map<string, any> = new Map();
  private inMemoryExperienceRecords: any[] = [];
  private outcomeListeners: Array<(record: TradeOutcomeRecord, trade?: TradeLedgerItem) => void> = [];

  // CRITICAL REQUIREMENT 4: Starting balance $25.00, preserved current balance $91.00
  private inMemoryStartingBalance = 25.0;
  private inMemoryCurrentBalance = 91.0;

  private inMemorySettings: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
  };


  private lastScannerTimestamp = 0;
  private lastScannerStatus = 'IDLE';
  private isReady = false;
  private isTesting = process.env.IS_TESTING === 'true' || process.env.NODE_ENV === 'test';
  private readyPromise: Promise<void>;

  constructor() {
    this.ensureDataDirectory();
    this.readyPromise = this.init();
  }

  public setTestingMode(val: boolean) {
    this.isTesting = val;
    if (val) {
      this.inMemoryOutcomes = this.inMemoryOutcomes.filter(
        (o) => !String(o.signalId || o.tradeId).startsWith('test-trade-') && !String(o.signalId || o.tradeId).startsWith('phantom-trade-')
      );
      this.inMemoryTrades = this.inMemoryTrades.filter(
        (t) => !String(t.id).startsWith('test-trade-') && !String(t.id).startsWith('phantom-trade-')
      );
      this.inMemoryTelegramDispatches.clear();
      this.inMemoryExperienceRecords = [];
      this.inMemoryFactorSnapshots.clear();
    }
  }

  public isTestingMode(): boolean {
    return this.isTesting;
  }

  public restoreTestSnapshot(
    trades: TradeLedgerItem[],
    outcomes: TradeOutcomeRecord[],
    currentBalance: number,
    startingBalance: number
  ): void {
    this.inMemoryTrades = [...trades];
    this.inMemoryOutcomes = [...outcomes];
    this.inMemoryCurrentBalance = currentBalance;
    this.inMemoryStartingBalance = startingBalance;
  }

  private shouldPersist(): boolean {
    return !this.isTesting;
  }

  public async waitUntilReady(): Promise<void> {
    await this.readyPromise;
  }

  private ensureDataDirectory(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
    } catch (e) {
      console.error('[Storage] Error ensuring data directory exists:', e);
    }
  }

  private async init(): Promise<void> {
    console.log('[Storage] Initializing PersistentStorage persistence layer (Supabase PostgreSQL)...');

    // 1. First immediately load local JSON backups so in-memory is fully populated
    this.initLocalBackups();

    // 2. If Supabase is available, sync and load from Supabase PostgreSQL
    const activeClient = getSupabaseClient();
    if (isSupabaseConfigured() && activeClient && this.shouldPersist()) {
      try {
        await this.initSupabaseData();
      } catch (err: any) {
        console.warn('[Storage] Supabase initialization warning (resilient local cache will be used):', err?.message || err);
      }
    } else {
      console.log('[Storage] Supabase credentials not provided in environment. Running with verified local JSON persistence.');
    }

    this.isReady = true;
    console.log('[Storage] Initialization complete. Current balance: $' + this.inMemoryCurrentBalance);
  }

  private initLocalBackups(): void {
    try {
      if (fs.existsSync(ACCOUNT_FILE)) {
        const raw = fs.readFileSync(ACCOUNT_FILE, 'utf-8');
        const acc = JSON.parse(raw);
        if (typeof acc.currentBalance === 'number' && !isNaN(acc.currentBalance)) {
          this.inMemoryCurrentBalance = acc.currentBalance;
        }
        if (typeof acc.startingBalance === 'number' && !isNaN(acc.startingBalance)) {
          this.inMemoryStartingBalance = acc.startingBalance;
        }
      }

      if (fs.existsSync(SETTINGS_FILE)) {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        this.inMemorySettings = { ...this.inMemorySettings, ...data };
        if (this.inMemorySettings.minGoldSlPoints === 40 && this.inMemorySettings.maxGoldSlPoints === 50) {
          this.inMemorySettings.minGoldSlPoints = 35;
          this.inMemorySettings.maxGoldSlPoints = 85;
        }
      }

      if (fs.existsSync(TEST_TRADES_FILE)) {
        const raw = fs.readFileSync(TEST_TRADES_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.inMemoryTestTrades = list;
        }
      }

      if (fs.existsSync(TRADES_FILE)) {
        const raw = fs.readFileSync(TRADES_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          const realTrades: TradeLedgerItem[] = [];
          for (const item of list) {
            if (isSyntheticTestRecord(item)) {
              if (!this.inMemoryTestTrades.some((t) => t.id === item.id)) {
                this.inMemoryTestTrades.push(item);
              }
            } else {
              realTrades.push(item);
            }
          }
          this.inMemoryTrades = realTrades;
        }
      }

      if (fs.existsSync(OUTCOMES_FILE)) {
        const raw = fs.readFileSync(OUTCOMES_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.inMemoryOutcomes = list;
        }
      }

      if (fs.existsSync(SIGNALS_FILE)) {
        const raw = fs.readFileSync(SIGNALS_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.inMemorySignals = list;
        }
      }

      if (fs.existsSync(SCANS_FILE)) {
        const raw = fs.readFileSync(SCANS_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.inMemoryScans = list;
        }
      }

      if (fs.existsSync(OPPS_FILE)) {
        const raw = fs.readFileSync(OPPS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        this.inMemoryOpportunities.clear();
        if (Array.isArray(data)) {
          for (const o of data) {
            if (o && o.id) {
              if (o.telegramDeliveryInFlight) {
                o.telegramDeliveryInFlight = false;
                o.telegramDeliveryInFlightTime = undefined;
              }
              this.inMemoryOpportunities.set(o.id, o);
            }
          }
        } else if (typeof data === 'object' && data !== null) {
          for (const [k, o] of Object.entries(data)) {
            const opp = o as any;
            if (opp) {
              if (opp.telegramDeliveryInFlight) {
                opp.telegramDeliveryInFlight = false;
                opp.telegramDeliveryInFlightTime = undefined;
              }
              this.inMemoryOpportunities.set(k, opp);
            }
          }
        }
      }

      if (fs.existsSync(TERMINAL_FILE)) {
        const raw = fs.readFileSync(TERMINAL_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.inMemoryTerminalSetups = new Set(list);
        }
      }

      if (fs.existsSync(TELEGRAM_CHAT_FILE)) {
        const raw = fs.readFileSync(TELEGRAM_CHAT_FILE, 'utf-8');
        const chatData = JSON.parse(raw);
        if (chatData?.chatId) {
          this.inMemoryTelegramChatId = String(chatData.chatId);
        }
      }

      if (fs.existsSync(TEST_SNAPSHOTS_FILE)) {
        const raw = fs.readFileSync(TEST_SNAPSHOTS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          for (const [k, v] of Object.entries(data)) {
            this.inMemoryTestFactorSnapshots.set(k, v);
          }
        }
      }

      if (fs.existsSync(SNAPSHOTS_FILE)) {
        const raw = fs.readFileSync(SNAPSHOTS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          for (const [k, v] of Object.entries(data)) {
            if (isSyntheticTestRecord({ id: k, ...(v as any) })) {
              this.inMemoryTestFactorSnapshots.set(k, v);
            } else {
              this.inMemoryFactorSnapshots.set(k, v);
            }
          }
        }
      }

      if (fs.existsSync(EXPERIENCES_FILE)) {
        const raw = fs.readFileSync(EXPERIENCES_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.inMemoryExperienceRecords = list;
        }
      }

      if (fs.existsSync(TELEGRAM_DISPATCHES_FILE)) {
        const raw = fs.readFileSync(TELEGRAM_DISPATCHES_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.inMemoryTelegramDispatches = new Set(list);
          console.log(`[Storage] Loaded ${this.inMemoryTelegramDispatches.size} persisted Telegram dispatch IDs.`);
        }
      }

      if (fs.existsSync(POIS_FILE)) {
        const raw = fs.readFileSync(POIS_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.inMemoryPois = list;
          console.log(`[Storage] Loaded ${this.inMemoryPois.length} persisted POI records.`);
        }
      }
    } catch (e: any) {
      console.error('[Storage] Error during initLocalBackups:', e?.message || e);
    }
  }

  private safeSupabase(fn: (client: any) => any, context?: string): void {
    if (!isSupabaseConfigured() || !this.shouldPersist()) return;
    executeSupabaseQuery(fn, context).catch(() => {});
  }

  private async safeSupabaseAsync(fn: (client: any) => any, context?: string): Promise<any> {
    if (!isSupabaseConfigured() || !this.shouldPersist()) return null;
    return executeSupabaseQuery(fn, context);
  }

  private async initSupabaseData(): Promise<void> {
    if (!isSupabaseAvailable()) return;
    const supabaseClient = getSupabaseClient();
    if (!supabaseClient) return;

    // 1. Account State
    try {
      if (!isSupabaseAvailable()) return;
      const res = await executeSupabaseQuery(
        (c) => c.from('account_state').select('*').eq('id', 'main').maybeSingle(),
        'initSupabaseData:account_state'
      );
      if (res && res.data) {
        const curBal = Number(res.data.current_balance ?? res.data.currentBalance);
        if (!isNaN(curBal)) {
          this.inMemoryCurrentBalance = curBal;
        }
        const startBal = Number(res.data.starting_balance ?? res.data.startingBalance);
        if (!isNaN(startBal) && startBal > 0) {
          this.inMemoryStartingBalance = startBal;
        }
      } else if (res && !res.data && !res.error) {
        // Table exists but record does not: Seed with preserved balance
        await executeSupabaseQuery(
          (c) =>
            c.from('account_state').upsert({
              id: 'main',
              starting_balance: this.inMemoryStartingBalance,
              current_balance: this.inMemoryCurrentBalance,
              updated_at: new Date().toISOString(),
            }),
          'initSupabaseData:seed_account_state'
        );
      }
    } catch (e: any) {
      // Non-blocking
    }

    // 2. App Settings
    try {
      if (!isSupabaseAvailable()) return;
      const res = await executeSupabaseQuery(
        (c) => c.from('app_settings').select('*').eq('id', 'main').maybeSingle(),
        'initSupabaseData:app_settings'
      );
      if (res && res.data?.data) {
        this.inMemorySettings = { ...this.inMemorySettings, ...res.data.data };
      } else if (res && !res.data && this.inMemorySettings) {
        // Seed settings
        await executeSupabaseQuery(
          (c) =>
            c.from('app_settings').upsert({
              id: 'main',
              data: this.inMemorySettings,
              updated_at: new Date().toISOString(),
            }),
          'initSupabaseData:seed_app_settings'
        );
      }
    } catch (e: any) {
      // Non-blocking
    }

    // 3. Trade Ledger
    try {
      if (!isSupabaseAvailable()) return;
      const res = await executeSupabaseQuery(
        (c) =>
          c
            .from('trade_ledger')
            .select('*')
            .order('trade_number', { ascending: false })
            .limit(MAX_TRADES_TO_KEEP),
        'initSupabaseData:trade_ledger'
      );
      if (res && Array.isArray(res.data) && res.data.length > 0) {
        this.inMemoryTrades = res.data.map((r) => this.parseTradeRow(r));
      } else if (res && res.data?.length === 0 && this.inMemoryTrades.length > 0) {
        // Seed remote with existing local trades
        for (const t of this.inMemoryTrades) {
          if (!isSupabaseAvailable()) break;
          await executeSupabaseQuery((c) => c.from('trade_ledger').upsert(this.formatTradeRow(t)), 'initSupabaseData:seed_trade');
        }
      }
    } catch (e: any) {
      // Non-blocking
    }

    // 4. Trade Outcomes
    try {
      if (!isSupabaseAvailable()) return;
      const res = await executeSupabaseQuery(
        (c) =>
          c
            .from('trade_outcomes')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(500),
        'initSupabaseData:trade_outcomes'
      );
      if (res && Array.isArray(res.data) && res.data.length > 0) {
        this.inMemoryOutcomes = res.data.map((r) => this.parseOutcomeRow(r));
      } else if (res && res.data?.length === 0 && this.inMemoryOutcomes.length > 0) {
        for (const out of this.inMemoryOutcomes) {
          if (!isSupabaseAvailable()) break;
          await executeSupabaseQuery((c) => c.from('trade_outcomes').upsert(this.formatOutcomeRow(out)), 'initSupabaseData:seed_outcome');
        }
      }
    } catch (e: any) {
      // Non-blocking
    }

    // 5. Signals
    try {
      if (!isSupabaseAvailable()) return;
      const res = await executeSupabaseQuery(
        (c) =>
          c
            .from('signals')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(MAX_SIGNALS_TO_KEEP),
        'initSupabaseData:signals'
      );
      if (res && Array.isArray(res.data) && res.data.length > 0) {
        this.inMemorySignals = res.data.map((r) => r.raw_data || r);
      } else if (res && res.data?.length === 0 && this.inMemorySignals.length > 0) {
        for (const s of this.inMemorySignals) {
          if (!isSupabaseAvailable()) break;
          await executeSupabaseQuery(
            (c) => c.from('signals').upsert({ id: s.id, timestamp: s.timestamp, raw_data: s }),
            'initSupabaseData:seed_signal'
          );
        }
      }
    } catch (e: any) {
      // Non-blocking
    }

    // 6. Scans
    try {
      if (!isSupabaseAvailable()) return;
      const res = await executeSupabaseQuery(
        (c) =>
          c
            .from('scans')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(MAX_SCANS_TO_KEEP),
        'initSupabaseData:scans'
      );
      if (res && Array.isArray(res.data) && res.data.length > 0) {
        this.inMemoryScans = res.data.map((r) => r.raw_data || r);
      } else if (res && res.data?.length === 0 && this.inMemoryScans.length > 0) {
        for (const sc of this.inMemoryScans) {
          if (!isSupabaseAvailable()) break;
          await executeSupabaseQuery(
            (c) => c.from('scans').upsert({ id: sc.id, timestamp: sc.timestamp, status: sc.status, raw_data: sc }),
            'initSupabaseData:seed_scan'
          );
        }
      }
    } catch (e: any) {
      // Non-blocking
    }

    // 7. Opportunities
    try {
      if (!isSupabaseAvailable()) return;
      const res = await executeSupabaseQuery(
        (c) =>
          c
            .from('opportunities')
            .select('*')
            .order('last_updated_time', { ascending: false })
            .limit(200),
        'initSupabaseData:opportunities'
      );
      if (res && Array.isArray(res.data) && res.data.length > 0) {
        this.inMemoryOpportunities.clear();
        for (const r of res.data) {
          const opp = r.raw_data || r;
          if (opp.id) {
            if (opp.telegramDeliveryInFlight) {
              opp.telegramDeliveryInFlight = false;
              opp.telegramDeliveryInFlightTime = undefined;
            }
            this.inMemoryOpportunities.set(opp.id, opp);
          }
        }
      } else if (res && res.data?.length === 0 && this.inMemoryOpportunities.size > 0) {
        for (const opp of this.inMemoryOpportunities.values()) {
          if (!isSupabaseAvailable()) break;
          await executeSupabaseQuery(
            (c) => c.from('opportunities').upsert({ id: opp.id, last_updated_time: opp.lastUpdatedTime, raw_data: opp }),
            'initSupabaseData:seed_opportunity'
          );
        }
      }
    } catch (e: any) {
      // Non-blocking
    }

    // 8. Telegram Config
    try {
      if (!isSupabaseAvailable()) return;
      const res = await executeSupabaseQuery(
        (c) => c.from('telegram_config').select('*').eq('id', 'main').maybeSingle(),
        'initSupabaseData:telegram_config'
      );
      if (res && res.data?.chat_id) {
        this.inMemoryTelegramChatId = String(res.data.chat_id);
      } else if (res && this.inMemoryTelegramChatId) {
        await executeSupabaseQuery(
          (c) =>
            c.from('telegram_config').upsert({
              id: 'main',
              chat_id: this.inMemoryTelegramChatId,
              registered_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
          'initSupabaseData:seed_telegram'
        );
      }
    } catch (e: any) {
      // Non-blocking
    }

    // 9. Terminal Setups
    try {
      if (!isSupabaseAvailable()) return;
      const res = await executeSupabaseQuery((c) => c.from('terminal_setups').select('*'), 'initSupabaseData:terminal_setups');
      if (res && Array.isArray(res.data) && res.data.length > 0) {
        for (const r of res.data) {
          if (r.setup_key) this.inMemoryTerminalSetups.add(r.setup_key);
        }
      } else if (res && this.inMemoryTerminalSetups.size > 0) {
        for (const key of this.inMemoryTerminalSetups) {
          if (!isSupabaseAvailable()) break;
          await executeSupabaseQuery(
            (c) => c.from('terminal_setups').upsert({ id: key.replace(/\//g, '_'), setup_key: key }),
            'initSupabaseData:seed_terminal'
          );
        }
      }
    } catch (e: any) {
      // Non-blocking
    }

    // 10. Experience Records
    try {
      if (!isSupabaseAvailable()) return;
      const res = await executeSupabaseQuery(
        (c) =>
          c
            .from('experience_records')
            .select('*')
            .order('completed_at', { ascending: false })
            .limit(1000),
        'initSupabaseData:experience_records'
      );
      if (res && Array.isArray(res.data) && res.data.length > 0) {
        // Merge Supabase records with in-memory records (from local disk) avoiding duplicates
        const existingMap = new Map<string, any>();
        // First index local disk records
        for (const localRec of this.inMemoryExperienceRecords) {
          if (localRec && localRec.id) {
            existingMap.set(localRec.id, localRec);
          }
        }
        // Merge/update with Supabase records (authoritative)
        for (const row of res.data) {
          const parsed = row.raw_data || {
            id: row.id,
            signalId: row.signal_id,
            tradeId: row.trade_id || undefined,
            combinationKey: row.combination_key,
            factors: row.factors,
            direction: row.direction,
            setupFamily: row.setup_family,
            outcome: row.outcome,
            realizedPnl: typeof row.realized_pnl === 'number' ? row.realized_pnl : parseFloat(row.realized_pnl) || 0,
            rr: typeof row.rr === 'number' ? row.rr : (row.rr ? parseFloat(row.rr) : undefined),
            completedAt: typeof row.completed_at === 'number' ? row.completed_at : Number(row.completed_at) || 0,
          };
          if (parsed && parsed.id) {
            existingMap.set(parsed.id, parsed);
          }
        }
        // Update in-memory records sorted by completedAt ascending
        this.inMemoryExperienceRecords = Array.from(existingMap.values())
          .sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0))
          .slice(-1000);
      } else if (res && res.data?.length === 0 && this.inMemoryExperienceRecords.length > 0) {
        // Seed Supabase with local records if Supabase table is empty
        for (const rec of this.inMemoryExperienceRecords) {
          if (!isSupabaseAvailable()) break;
          await executeSupabaseQuery(
            (c) =>
              c.from('experience_records').upsert({
                id: rec.id,
                signal_id: rec.signalId,
                trade_id: rec.tradeId || null,
                combination_key: rec.combinationKey,
                factors: rec.factors,
                direction: rec.direction,
                setup_family: rec.setupFamily,
                outcome: rec.outcome,
                realized_pnl: rec.realizedPnl,
                rr: rec.rr || null,
                completed_at: rec.completedAt,
                raw_data: rec,
              }),
            'initSupabaseData:seed_experience_record'
          );
        }
      }
    } catch (e: any) {
      // Non-blocking
    }

    // Sync state to local files to ensure disk parity
    this.syncJsonBackups();
  }

  private formatTradeRow(trade: TradeLedgerItem): any {
    return {
      id: trade.id,
      trade_number: trade.tradeNumber ?? null,
      date: trade.date ?? null,
      iso_time: trade.isoTime ?? null,
      asset: trade.asset ?? 'XAU/USD',
      direction: trade.direction ?? null,
      entry: trade.entry !== undefined ? Number(trade.entry) : null,
      sl: trade.sl !== undefined ? Number(trade.sl) : null,
      sl_points: trade.slPoints !== undefined ? Number(trade.slPoints) : null,
      tp1: trade.tp1 !== undefined ? Number(trade.tp1) : null,
      tp1_points: trade.tp1Points !== undefined ? Number(trade.tp1Points) : null,
      tp2: trade.tp2 !== undefined ? Number(trade.tp2) : null,
      tp2_points: trade.tp2Points !== undefined ? Number(trade.tp2Points) : null,
      rr: trade.rr ?? null,
      risk_percent: trade.riskPercent !== undefined ? Number(trade.riskPercent) : null,
      risk_amount: trade.riskAmount !== undefined ? Number(trade.riskAmount) : null,
      lot_size: trade.lotSize !== undefined ? Number(trade.lotSize) : 0.01,
      confidence: trade.confidence !== undefined ? Number(trade.confidence) : null,
      setup: trade.setup ?? null,
      result: trade.result ?? null,
      is_active: trade.isActive ?? false,
      pl: trade.pl !== undefined ? Number(trade.pl) : 0,
      realized_pnl: trade.realizedPnl !== undefined ? Number(trade.realizedPnl) : (trade.pl !== undefined ? Number(trade.pl) : 0),
      balance_after_trade: trade.balanceAfterTrade !== undefined ? Number(trade.balanceAfterTrade) : null,
      exit_price: trade.exitPrice !== undefined ? Number(trade.exitPrice) : null,
      exit_time: trade.exitTime ?? null,
      closed_at: trade.closedAt ?? null,
      close_reason: trade.closeReason ?? null,
      source: trade.source ?? 'MANUAL',
      broker_deal_id: trade.brokerDealId ?? null,
      broker_order_id: trade.brokerOrderId ?? null,
      theoretical_tp1_profit: trade.theoreticalTp1Profit !== undefined ? Number(trade.theoreticalTp1Profit) : null,
      theoretical_tp2_profit: trade.theoreticalTp2Profit !== undefined ? Number(trade.theoreticalTp2Profit) : null,
      notes: trade.notes ?? null,
      signal_id: trade.signalId ?? null,
      setup_id: trade.setupId ?? null,
      raw_data: trade,
      updated_at: new Date().toISOString(),
    };
  }

  private parseTradeRow(row: any): TradeLedgerItem {
    if (row.raw_data && typeof row.raw_data === 'object') {
      return {
        ...row.raw_data,
        id: row.id,
        tradeNumber: row.trade_number ?? row.raw_data.tradeNumber,
        result: row.result ?? row.raw_data.result,
        isActive: row.is_active !== undefined ? row.is_active : row.raw_data.isActive,
        pl: row.pl !== null && row.pl !== undefined ? Number(row.pl) : row.raw_data.pl,
        realizedPnl: row.realized_pnl !== null && row.realized_pnl !== undefined ? Number(row.realized_pnl) : row.raw_data.realizedPnl,
        balanceAfterTrade: row.balance_after_trade !== null && row.balance_after_trade !== undefined ? Number(row.balance_after_trade) : row.raw_data.balanceAfterTrade,
      };
    }
    return {
      id: row.id,
      tradeNumber: row.trade_number,
      date: row.date || '',
      isoTime: row.iso_time || '',
      asset: row.asset || 'XAU/USD',
      direction: row.direction || (Number(row.entry || 0) > Number(row.sl || 0) && Number(row.sl || 0) > 0 ? 'BUY' : 'SELL'),
      entry: Number(row.entry || 0),
      sl: Number(row.sl || 0),
      slPoints: Number(row.sl_points || 0),
      tp1: Number(row.tp1 || 0),
      tp1Points: Number(row.tp1_points || 0),
      tp2: row.tp2 ? Number(row.tp2) : undefined,
      tp2Points: row.tp2_points ? Number(row.tp2_points) : undefined,
      rr: row.rr || '1:1.5',
      riskPercent: Number(row.risk_percent || 15),
      riskAmount: Number(row.risk_amount || 0),
      lotSize: Number(row.lot_size || 0.01),
      confidence: Number(row.confidence || 75),
      setup: row.setup || 'Manual',
      result: row.result || 'OPEN',
      isActive: Boolean(row.is_active),
      pl: Number(row.pl || 0),
      realizedPnl: Number(row.realized_pnl || 0),
      balanceAfterTrade: Number(row.balance_after_trade || 0),
      exitPrice: row.exit_price ? Number(row.exit_price) : undefined,
      exitTime: row.exit_time,
      closedAt: row.closed_at ? Number(row.closed_at) : undefined,
      closeReason: row.close_reason,
      source: row.source || 'MANUAL',
      brokerDealId: row.broker_deal_id,
      brokerOrderId: row.broker_order_id,
      theoreticalTp1Profit: row.theoretical_tp1_profit ? Number(row.theoretical_tp1_profit) : undefined,
      theoreticalTp2Profit: row.theoretical_tp2_profit ? Number(row.theoretical_tp2_profit) : undefined,
      notes: row.notes,
      signalId: row.signal_id,
      setupId: row.setup_id,
    };
  }

  private formatOutcomeRow(out: TradeOutcomeRecord): any {
    const sigId = out.signalId || out.tradeId;
    return {
      signal_id: sigId,
      trade_id: out.tradeId ?? null,
      direction: out.direction ?? null,
      order_type: out.orderType ?? null,
      entry: out.entry !== undefined ? Number(out.entry) : null,
      stop_loss: out.stopLoss !== undefined ? Number(out.stopLoss) : null,
      tp1: out.tp1 !== undefined ? Number(out.tp1) : null,
      tp2: out.tp2 !== undefined ? Number(out.tp2) : null,
      outcome: out.outcome ?? null,
      timestamp: out.timestamp ?? Date.now(),
      iso_time: out.isoTime ?? new Date().toISOString(),
      chat_id: out.chatId ?? null,
      user_id: out.userId ?? null,
      pl: out.pl !== undefined ? Number(out.pl) : 0,
      realized_pnl: out.realizedPnl !== undefined ? Number(out.realizedPnl) : (out.pl !== undefined ? Number(out.pl) : 0),
      exit_price: out.exitPrice !== undefined ? Number(out.exitPrice) : null,
      source: out.source ?? 'MANUAL',
      broker_deal_id: out.brokerDealId ?? null,
      broker_order_id: out.brokerOrderId ?? null,
      closed_at: out.closedAt ?? null,
      close_reason: out.closeReason ?? null,
      notes: out.notes ?? null,
      raw_data: out,
    };
  }

  private parseOutcomeRow(row: any): TradeOutcomeRecord {
    if (row.raw_data && typeof row.raw_data === 'object') {
      return {
        ...row.raw_data,
        signalId: row.signal_id,
        outcome: row.outcome ?? row.raw_data.outcome,
        realizedPnl: row.realized_pnl !== null && row.realized_pnl !== undefined ? Number(row.realized_pnl) : row.raw_data.realizedPnl,
        pl: row.pl !== null && row.pl !== undefined ? Number(row.pl) : row.raw_data.pl,
      };
    }
    return {
      signalId: row.signal_id,
      tradeId: row.trade_id,
      direction: row.direction,
      orderType: row.order_type,
      entry: Number(row.entry || 0),
      stopLoss: Number(row.stop_loss || 0),
      tp1: Number(row.tp1 || 0),
      tp2: row.tp2 ? Number(row.tp2) : undefined,
      outcome: row.outcome,
      timestamp: Number(row.timestamp || Date.now()),
      isoTime: row.iso_time || new Date().toISOString(),
      chatId: row.chat_id,
      userId: row.user_id,
      pl: Number(row.pl || 0),
      realizedPnl: Number(row.realized_pnl || 0),
      exitPrice: row.exit_price ? Number(row.exit_price) : undefined,
      source: row.source || 'MANUAL',
      brokerDealId: row.broker_deal_id,
      brokerOrderId: row.broker_order_id,
      closedAt: row.closed_at ? Number(row.closed_at) : undefined,
      closeReason: row.close_reason,
      notes: row.notes,
    };
  }

  private syncJsonBackups(): void {
    if (!this.shouldPersist()) return;
    try {
      this.ensureDataDirectory();
      fs.writeFileSync(SCANS_FILE, JSON.stringify(this.inMemoryScans, null, 2), 'utf-8');
      fs.writeFileSync(SIGNALS_FILE, JSON.stringify(this.inMemorySignals, null, 2), 'utf-8');
      fs.writeFileSync(TRADES_FILE, JSON.stringify(this.inMemoryTrades, null, 2), 'utf-8');
      fs.writeFileSync(TEST_TRADES_FILE, JSON.stringify(this.inMemoryTestTrades, null, 2), 'utf-8');
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.inMemorySettings, null, 2), 'utf-8');
      fs.writeFileSync(OUTCOMES_FILE, JSON.stringify(this.inMemoryOutcomes, null, 2), 'utf-8');
      fs.writeFileSync(
        ACCOUNT_FILE,
        JSON.stringify(
          {
            currentBalance: this.inMemoryCurrentBalance,
            startingBalance: this.inMemoryStartingBalance,
          },
          null,
          2
        ),
        'utf-8'
      );
      fs.writeFileSync(TERMINAL_FILE, JSON.stringify(Array.from(this.inMemoryTerminalSetups), null, 2), 'utf-8');
      fs.writeFileSync(OPPS_FILE, JSON.stringify(Object.fromEntries(this.inMemoryOpportunities), null, 2), 'utf-8');
      fs.writeFileSync(SNAPSHOTS_FILE, JSON.stringify(Object.fromEntries(this.inMemoryFactorSnapshots), null, 2), 'utf-8');
      fs.writeFileSync(TEST_SNAPSHOTS_FILE, JSON.stringify(Object.fromEntries(this.inMemoryTestFactorSnapshots), null, 2), 'utf-8');
      fs.writeFileSync(EXPERIENCES_FILE, JSON.stringify(this.inMemoryExperienceRecords, null, 2), 'utf-8');
      fs.writeFileSync(POIS_FILE, JSON.stringify(this.inMemoryPois, null, 2), 'utf-8');
      if (this.inMemoryTelegramChatId) {
        fs.writeFileSync(
          TELEGRAM_CHAT_FILE,
          JSON.stringify(
            {
              chatId: this.inMemoryTelegramChatId,
              registeredAt: new Date().toISOString(),
            },
            null,
            2
          ),
          'utf-8'
        );
      }
    } catch (e) {
      console.error('[Storage] Error during syncJsonBackups:', e);
    }
  }

  // =========================================================================
  // Telegram Chat Persistence
  // =========================================================================
  public getTelegramChatId(): string | null {
    return this.inMemoryTelegramChatId;
  }

  public async saveTelegramChatId(chatId: string): Promise<void> {
    if (!chatId) return;
    this.inMemoryTelegramChatId = String(chatId);
    this.syncJsonBackups();

    this.safeSupabase(
      (c) =>
        c.from('telegram_config').upsert({
          id: 'main',
          chat_id: String(chatId),
          registered_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      'saveTelegramChatId'
    );
  }

  // =========================================================================
  // Scans Persistence
  // =========================================================================
  public saveScan(record: ScanRecord): ScanRecord[] {
    try {
      this.lastScannerTimestamp = record.timestamp || Date.now();
      this.lastScannerStatus = record.status || 'SUCCESS';

      const existingIdx = record.id ? this.inMemoryScans.findIndex((s) => s.id === record.id) : -1;
      if (existingIdx !== -1) {
        this.inMemoryScans[existingIdx] = record;
      } else {
        this.inMemoryScans.unshift(record);
        if (this.inMemoryScans.length > MAX_SCANS_TO_KEEP) {
          this.inMemoryScans = this.inMemoryScans.slice(0, MAX_SCANS_TO_KEEP);
        }
      }

      if (record.id) {
        this.safeSupabase(
          (c) =>
            c.from('scans').upsert({
              id: record.id,
              timestamp: record.timestamp,
              status: record.status,
              raw_data: record,
            }),
          'saveScan'
        );
      }

      this.syncJsonBackups();
      return [...this.inMemoryScans];
    } catch (err) {
      console.error('[Storage] Error saving scan:', err);
      return [...this.inMemoryScans];
    }
  }

  public getScans(limit = 100): ScanRecord[] {
    return this.inMemoryScans.slice(0, limit);
  }

  // =========================================================================
  // Signals Persistence
  // =========================================================================
  public saveSignal(signal: TradeSignal): TradeSignal[] {
    try {
      const existingIdx = this.inMemorySignals.findIndex((s) => s.id === signal.id);
      if (existingIdx >= 0) {
        this.inMemorySignals[existingIdx] = signal;
      } else {
        this.inMemorySignals.unshift(signal);
      }

      if (this.inMemorySignals.length > MAX_SIGNALS_TO_KEEP) {
        this.inMemorySignals = this.inMemorySignals.slice(0, MAX_SIGNALS_TO_KEEP);
      }

      if (signal.id) {
        this.safeSupabase(
          (c) =>
            c.from('signals').upsert({
              id: signal.id,
              timestamp: signal.timestamp,
              raw_data: signal,
            }),
          'saveSignal'
        );
      }

      this.syncJsonBackups();
      return [...this.inMemorySignals];
    } catch (err) {
      console.error('[Storage] Error saving signal:', err);
      return [...this.inMemorySignals];
    }
  }

  public getSignals(limit = 50): TradeSignal[] {
    return this.inMemorySignals.slice(0, limit);
  }

  public getSignal(id: string): TradeSignal | undefined {
    return this.inMemorySignals.find((s) => s.id === id);
  }

  public getSignalById(id: string): TradeSignal | undefined {
    return this.getSignal(id);
  }

  public async getSignalFromStorage(id: string): Promise<TradeSignal | undefined> {
    // 1. Check in-memory first
    const memSignal = this.getSignal(id);
    if (memSignal) return memSignal;

    // 2. Try fetching from Supabase
    const res = await this.safeSupabaseAsync(
      (c) => c.from('signals').select('*').eq('id', id).maybeSingle(),
      'getSignalFromStorage'
    );
    if (res && !res.error && res.data) {
      const signalData: TradeSignal = res.data.raw_data || res.data;
      if (!this.inMemorySignals.some((s) => s.id === signalData.id)) {
        this.inMemorySignals.unshift(signalData);
      }
      return signalData;
    }

    // 3. Try reading local saved_signals.json backup if available
    try {
      if (fs.existsSync(SIGNALS_FILE)) {
        const raw = fs.readFileSync(SIGNALS_FILE, 'utf-8');
        const list: TradeSignal[] = JSON.parse(raw || '[]');
        const fileSignal = list.find((s) => s.id === id);
        if (fileSignal) {
          if (!this.inMemorySignals.some((s) => s.id === fileSignal.id)) {
            this.inMemorySignals.unshift(fileSignal);
          }
          return fileSignal;
        }
      }
    } catch (err) {
      console.error(`[Storage] Error reading saved_signals.json for signal ${id}:`, err);
    }

    // 4. Try loading the corresponding opportunity if signal is not found
    const opp = this.getOpportunity(id) || this.getOpportunities().find((o) => o.signalId === id);
    if (opp) {
      const dir = opp.direction === 'BUY' ? 'BUY NOW' : 'SELL NOW';
      const rebuiltSignal: TradeSignal = {
        id: opp.signalId || opp.id,
        timestamp: opp.firstObservedTime,
        asset: 'XAU/USD',
        signal: dir,
        currentPrice: opp.entry,
        entry: opp.entry,
        stopLoss: opp.stopLoss,
        slPoints: Math.round(Math.abs(opp.entry - opp.stopLoss) / 0.1),
        tp1: opp.tp1,
        tp1Points: Math.round(Math.abs(opp.tp1 - opp.entry) / 0.1),
        tp1Rr: Math.abs(opp.entry - opp.stopLoss) > 0 ? Number((Math.abs(opp.tp1 - opp.entry) / Math.abs(opp.entry - opp.stopLoss)).toFixed(2)) : 1.0,
        tp1RrString: Math.abs(opp.entry - opp.stopLoss) > 0 ? `1:${(Math.abs(opp.tp1 - opp.entry) / Math.abs(opp.entry - opp.stopLoss)).toFixed(2)}` : '1:1.00',
        tp2: (opp.tp2 && opp.tp2 > 0 && Math.abs(opp.tp2 - opp.entry) > 0.01) ? opp.tp2 : 0,
        tp2Points: (opp.tp2 && opp.tp2 > 0 && Math.abs(opp.tp2 - opp.entry) > 0.01) ? Math.round(Math.abs(opp.tp2 - opp.entry) / 0.1) : 0,
        tp2Rr: (opp.tp2 && opp.tp2 > 0 && Math.abs(opp.entry - opp.stopLoss) > 0) ? Number((Math.abs(opp.tp2 - opp.entry) / Math.abs(opp.entry - opp.stopLoss)).toFixed(2)) : 0,
        tp2RrString: (opp.tp2 && opp.tp2 > 0 && Math.abs(opp.entry - opp.stopLoss) > 0) ? `1:${(Math.abs(opp.tp2 - opp.entry) / Math.abs(opp.entry - opp.stopLoss)).toFixed(2)}` : 'N/A',
        primaryTarget: 'TP1',
        rr: (opp.tp2 && opp.tp2 > 0 && Math.abs(opp.entry - opp.stopLoss) > 0)
          ? `TP1: 1:${(Math.abs(opp.tp1 - opp.entry) / Math.abs(opp.entry - opp.stopLoss)).toFixed(2)} | TP2: 1:${(Math.abs(opp.tp2 - opp.entry) / Math.abs(opp.entry - opp.stopLoss)).toFixed(2)}`
          : `1:${Math.abs(opp.entry - opp.stopLoss) > 0 ? (Math.abs(opp.tp1 - opp.entry) / Math.abs(opp.entry - opp.stopLoss)).toFixed(2) : '1.00'}`,
        rrRatio: Math.abs(opp.entry - opp.stopLoss) > 0 ? Number((Math.abs(opp.tp1 - opp.entry) / Math.abs(opp.entry - opp.stopLoss)).toFixed(2)) : 1.0,
        riskPercent: 15,
        riskAmount: 0,
        potentialProfit: 0,
        potentialLoss: 0,
        recommendedLotSize: 0.01,
        confidence: opp.confidence,
        timeframe: opp.timeframe,
        setup: opp.setupName,
        mainReasons: ['Rebuilt from opportunity snapshot'],
        invalidation: opp.direction === 'BUY'
          ? `Close candle below ${opp.stopLoss}`
          : `Close candle above ${opp.stopLoss}`,
      };
      if (!this.inMemorySignals.some((s) => s.id === rebuiltSignal.id)) {
        this.inMemorySignals.unshift(rebuiltSignal);
      }
      return rebuiltSignal;
    }

    return undefined;
  }

  // =========================================================================
  // Trade Ledger Persistence (Partitioned: Production vs Test)
  // =========================================================================
  public saveTrade(trade: TradeLedgerItem): TradeLedgerItem[] {
    try {
      const isTest = isSyntheticTestRecord(trade) || this.isTesting;
      const isResultOpen = trade.result === 'OPEN';
      const targetList = isTest ? this.inMemoryTestTrades : this.inMemoryTrades;
      const highestNum = Math.max(0, ...targetList.map((t) => t.tradeNumber || 0));
      const tradeNumber = trade.tradeNumber || highestNum + 1;
      const isoTime = trade.isoTime || new Date().toISOString();
      const date =
        trade.date ||
        new Date().toLocaleDateString('ar-EG', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });

      const tradeWithActive: TradeLedgerItem = {
        ...trade,
        tradeNumber,
        isoTime,
        date,
        isActive: trade.isActive !== undefined ? trade.isActive : isResultOpen,
        isTest: isTest ? true : undefined,
      };

      const existingIdx = targetList.findIndex((t) => t.id === tradeWithActive.id);
      if (existingIdx >= 0) {
        targetList[existingIdx] = tradeWithActive;
      } else {
        targetList.unshift(tradeWithActive);
      }

      if (targetList.length > MAX_TRADES_TO_KEEP) {
        if (isTest) {
          this.inMemoryTestTrades = targetList.slice(0, MAX_TRADES_TO_KEEP);
        } else {
          this.inMemoryTrades = targetList.slice(0, MAX_TRADES_TO_KEEP);
        }
      }

      // Asynchronous Supabase write only for real production trades
      if (!isTest && tradeWithActive.id) {
        this.safeSupabase(
          (c) => c.from('trade_ledger').upsert(this.formatTradeRow(tradeWithActive)),
          `saveTrade:${tradeWithActive.id}`
        );
      }

      this.syncJsonBackups();
      return isTest ? [...this.inMemoryTestTrades] : [...this.inMemoryTrades];
    } catch (err) {
      console.error('[Storage] Error saving trade:', err);
      return [...this.inMemoryTrades];
    }
  }

  public async saveTradeAsync(trade: TradeLedgerItem): Promise<TradeLedgerItem[]> {
    try {
      const isTest = isSyntheticTestRecord(trade) || this.isTesting;
      const isResultOpen = trade.result === 'OPEN';
      const targetList = isTest ? this.inMemoryTestTrades : this.inMemoryTrades;
      const highestNum = Math.max(0, ...targetList.map((t) => t.tradeNumber || 0));
      const tradeNumber = trade.tradeNumber || highestNum + 1;
      const isoTime = trade.isoTime || new Date().toISOString();
      const date =
        trade.date ||
        new Date().toLocaleDateString('ar-EG', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });

      const tradeWithActive: TradeLedgerItem = {
        ...trade,
        tradeNumber,
        isoTime,
        date,
        isActive: trade.isActive !== undefined ? trade.isActive : isResultOpen,
        isTest: isTest ? true : undefined,
      };

      const existingIdx = targetList.findIndex((t) => t.id === tradeWithActive.id);
      if (existingIdx >= 0) {
        targetList[existingIdx] = tradeWithActive;
      } else {
        targetList.unshift(tradeWithActive);
      }

      if (targetList.length > MAX_TRADES_TO_KEEP) {
        if (isTest) {
          this.inMemoryTestTrades = targetList.slice(0, MAX_TRADES_TO_KEEP);
        } else {
          this.inMemoryTrades = targetList.slice(0, MAX_TRADES_TO_KEEP);
        }
      }

      this.syncJsonBackups();

      if (!isTest && tradeWithActive.id) {
        await this.safeSupabaseAsync(
          (c) => c.from('trade_ledger').upsert(this.formatTradeRow(tradeWithActive)),
          `saveTradeAsync:${tradeWithActive.id}`
        );
      }

      return isTest ? [...this.inMemoryTestTrades] : [...this.inMemoryTrades];
    } catch (err) {
      console.error('[Storage] Error saving trade async:', err);
      return [...this.inMemoryTrades];
    }
  }

  public async updateBalanceFromManualTrade(deltaPnl: number): Promise<number> {
    this.inMemoryCurrentBalance = Number((this.inMemoryCurrentBalance + deltaPnl).toFixed(2));
    this.syncJsonBackups();

    this.safeSupabase(
      (c) =>
        c.from('account_state').upsert({
          id: 'main',
          current_balance: this.inMemoryCurrentBalance,
          starting_balance: this.inMemoryStartingBalance,
          updated_at: new Date().toISOString(),
        }),
      'updateBalanceFromManualTrade'
    );
    return this.inMemoryCurrentBalance;
  }

  public getTradeLedger(limit = 100): TradeLedgerItem[] {
    return this.inMemoryTrades.filter((t) => !isSyntheticTestRecord(t)).slice(0, limit);
  }

  public getTrades(limit = 100): TradeLedgerItem[] {
    return this.getTradeLedger(limit);
  }

  public getTestTrades(limit = 100): TradeLedgerItem[] {
    return this.inMemoryTestTrades.slice(0, limit);
  }

  public clearTestTrades(): void {
    this.inMemoryTestTrades = [];
    this.inMemoryTestFactorSnapshots.clear();
    this.syncJsonBackups();
  }

  public getActiveTrades(): TradeLedgerItem[] {
    const realTrades = this.inMemoryTrades.filter((t) => !isSyntheticTestRecord(t) && (t.isActive === true || t.result === 'OPEN'));
    const testTrades = this.inMemoryTestTrades.filter((t) => t.isActive === true || t.result === 'OPEN');
    return [...realTrades, ...testTrades];
  }

  public getTrade(id: string): TradeLedgerItem | undefined {
    return this.inMemoryTrades.find((t) => t.id === id) || this.inMemoryTestTrades.find((t) => t.id === id);
  }

  public getTradeOutcomes(limit = 200): TradeOutcomeRecord[] {
    return this.inMemoryOutcomes.slice(0, limit);
  }

  public getTradeOutcome(signalOrTradeId: string): TradeOutcomeRecord | undefined {
    return this.inMemoryOutcomes.find((o) => o.signalId === signalOrTradeId || o.tradeId === signalOrTradeId);
  }

  // =========================================================================
  // Trade Outcome Recording (Telegram & Manual Resolution)
  // =========================================================================
  public recordTradeOutcome(
    record: TradeOutcomeRecord,
    signalData?: Partial<TradeSignal>
  ): {
    success: boolean;
    isDuplicate: boolean;
    outcome: TradeOutcomeRecord;
    trade?: TradeLedgerItem;
    message?: string;
  } {
    try {
      const existing = this.getTradeOutcome(record.signalId) || (record.tradeId ? this.getTradeOutcome(record.tradeId) : undefined);
      const existingTrade = this.inMemoryTrades.find(
        (t) => t.id === record.signalId || t.id === record.tradeId || (record.signalId && t.signalId === record.signalId)
      );

      // If outcome is NOT_ENTERED, record outcome and ensure no trade is created in ledger
      if (record.outcome === 'NOT_ENTERED') {
        const outcomeIndex = this.inMemoryOutcomes.findIndex((o) => o.signalId === record.signalId || (record.tradeId && o.tradeId === record.tradeId));
        if (outcomeIndex >= 0) {
          this.inMemoryOutcomes[outcomeIndex] = record;
        } else {
          this.inMemoryOutcomes.unshift(record);
        }
        if (this.inMemoryOutcomes.length > 500) {
          this.inMemoryOutcomes = this.inMemoryOutcomes.slice(0, 500);
        }
        this.safeSupabase(
          (c) => c.from('trade_outcomes').upsert(this.formatOutcomeRow(record)),
          'recordTradeOutcome:not_entered'
        );
        this.syncJsonBackups();
        return {
          success: true,
          isDuplicate: false,
          outcome: record,
          message: 'NOT_ENTERED',
        };
      }

      // If referenced trade does not exist, instantiate it from signalData if available (for executed outcomes only)
      let tradeToUpdate = existingTrade;
      if (!tradeToUpdate) {
        if (signalData) {
          const sig = signalData as any;
          const highestNum = Math.max(0, ...this.inMemoryTrades.map((t) => t.tradeNumber || 0));
          const newTrade: TradeLedgerItem = {
            id: record.tradeId || record.signalId || `trade_${Date.now()}`,
            signalId: record.signalId,
            tradeNumber: highestNum + 1,
            date: new Date(sig.timestamp || Date.now()).toLocaleDateString('ar-EG', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
            isoTime: new Date(sig.timestamp || Date.now()).toISOString(),
            asset: sig.asset || 'XAU/USD',
            direction: (sig.direction || sig.signal || record.direction || (Number(sig.entry || record.entry || 0) > Number(sig.stopLoss || sig.sl || record.stopLoss || 0) && Number(sig.stopLoss || sig.sl || record.stopLoss || 0) > 0 ? 'BUY' : 'SELL')) as any,
            entry: Number(sig.entry || record.entry || 0),
            sl: Number(sig.stopLoss || sig.sl || record.stopLoss || 0),
            slPoints: sig.slPoints || Math.round(Math.abs(Number(sig.entry || 0) - Number(sig.stopLoss || sig.sl || 0)) / 0.1),
            tp1: Number(sig.tp1 || record.tp1 || 0),
            tp1Points: sig.tp1Points || Math.round(Math.abs(Number(sig.tp1 || 0) - Number(sig.entry || 0)) / 0.1),
            tp2: sig.tp2 ? Number(sig.tp2) : undefined,
            tp2Points: sig.tp2Points || (sig.tp2 ? Math.round(Math.abs(Number(sig.tp2) - Number(sig.entry || 0)) / 0.1) : undefined),
            lotSize: sig.standardLot ?? sig.recommendedLotSize ?? sig.lotSize ?? 0.01,
            riskPercent: sig.riskPercent || 15,
            riskAmount: sig.riskAmount || 1.5,
            confidence: sig.confidence || 75,
            setup: sig.setup || 'Manual Trade',
            rr: sig.rr || '1:1.5',
            result: 'OPEN',
            pl: 0,
            balanceAfterTrade: this.inMemoryCurrentBalance || 91,
            isActive: false,
            source: (record.source as any) || 'MANUAL',
            notes: 'تم الدخول يدوياً عبر زر التليجرام',
          };
          this.inMemoryTrades.unshift(newTrade);
          tradeToUpdate = newTrade;
        } else {
          console.warn(`[Storage] recordTradeOutcome rejected: referenced trade "${record.tradeId || record.signalId}" not found in trade ledger.`);
          return {
            success: false,
            isDuplicate: false,
            outcome: record,
            message: 'TRADE_NOT_FOUND',
          };
        }
      }

      // 1. Authoritative Realized P&L Calculation
      let finalRealizedPnl: number;
      if (typeof record.realizedPnl === 'number' && !isNaN(record.realizedPnl)) {
        finalRealizedPnl = Number(record.realizedPnl.toFixed(2));
      } else if (typeof record.pl === 'number' && !isNaN(record.pl)) {
        finalRealizedPnl = Number(record.pl.toFixed(2));
      } else if (record.exitPrice !== undefined && typeof record.exitPrice === 'number' && !isNaN(record.exitPrice)) {
        const isBuy = String(record.direction || signalData?.signal || tradeToUpdate.direction || '').toUpperCase().includes('BUY');
        const entryPrice = Number(record.entry || tradeToUpdate.entry || signalData?.entry || record.exitPrice);
        const priceDiff = isBuy ? record.exitPrice - entryPrice : entryPrice - record.exitPrice;
        const lotSize = tradeToUpdate.lotSize || signalData?.recommendedLotSize || (signalData as any)?.lotSize || 0.01;
        finalRealizedPnl = Number((priceDiff * 100 * lotSize).toFixed(2));
      } else {
        finalRealizedPnl = 0;
      }

      // Enforce directional sign consistency with outcome if non-zero
      if (record.outcome === 'WIN' && finalRealizedPnl < 0) {
        finalRealizedPnl = Math.abs(finalRealizedPnl);
      } else if (record.outcome === 'LOSS' && finalRealizedPnl > 0) {
        finalRealizedPnl = -Math.abs(finalRealizedPnl);
      }

      // Requirement 13: Standardize outcome based on realized PnL
      if ((record.outcome as any) !== 'NOT_ENTERED') {
        if (finalRealizedPnl > 0.001) {
          record.outcome = 'WIN';
        } else if (finalRealizedPnl < -0.001) {
          record.outcome = 'LOSS';
        } else {
          record.outcome = 'BREAK_EVEN';
          finalRealizedPnl = 0;
        }
      }

      record.realizedPnl = finalRealizedPnl;
      record.pl = finalRealizedPnl;
      const source = record.source || 'MANUAL';

      // 2. Idempotency Check: Avoid duplicate balance counting
      if (existing) {
        const existingPnl = typeof existing.realizedPnl === 'number' ? existing.realizedPnl : existing.pl;
        if (existing.outcome === record.outcome && existingPnl === finalRealizedPnl && source !== 'MT5') {
          return {
            success: true,
            isDuplicate: true,
            outcome: existing,
            trade: tradeToUpdate,
            message: `تم توثيق نتيجة هذه الصفقة مسبقاً (${existing.outcome === 'WIN' ? '🟢 رابحة' : existing.outcome === 'BREAK_EVEN' ? '⚪ تعادل' : '🔴 خاسرة'}) بقيمة $${finalRealizedPnl}.`,
          };
        }
      }

      if (tradeToUpdate.result === 'WIN' || tradeToUpdate.result === 'LOSS' || tradeToUpdate.result === 'BREAK_EVEN') {
        const existingTradePnl = typeof tradeToUpdate.realizedPnl === 'number' ? tradeToUpdate.realizedPnl : tradeToUpdate.pl || 0;
        if (tradeToUpdate.result === record.outcome && existingTradePnl === finalRealizedPnl && source !== 'MT5') {
          return {
            success: true,
            isDuplicate: true,
            outcome: { ...record, outcome: tradeToUpdate.result, realizedPnl: existingTradePnl },
            trade: tradeToUpdate,
            message: `تم توثيق نتيجة هذه الصفقة مسبقاً (${tradeToUpdate.result === 'WIN' ? '🟢 رابحة' : tradeToUpdate.result === 'BREAK_EVEN' ? '⚪ تعادل' : '🔴 خاسرة'}) بقيمة $${finalRealizedPnl}.`,
          };
        }
      }

      // 3. Update outcome list
      const outcomeIndex = this.inMemoryOutcomes.findIndex((o) => o.signalId === record.signalId || (record.tradeId && o.tradeId === record.tradeId));
      if (outcomeIndex >= 0) {
        this.inMemoryOutcomes[outcomeIndex] = record;
      } else {
        this.inMemoryOutcomes.unshift(record);
      }
      if (this.inMemoryOutcomes.length > 500) {
        this.inMemoryOutcomes = this.inMemoryOutcomes.slice(0, 500);
      }

      const isWin = record.outcome === 'WIN';
      const isBreakEven = record.outcome === 'BREAK_EVEN';
      const lotSize = tradeToUpdate.lotSize || signalData?.recommendedLotSize || (signalData as any)?.lotSize || 0.01;
      const entryPrice = Number(record.entry || tradeToUpdate.entry || signalData?.entry || 0);
      const tp1Price = Number(record.tp1 || tradeToUpdate.tp1 || signalData?.tp1 || 0);
      const tp2Price = Number(record.tp2 || tradeToUpdate.tp2 || signalData?.tp2 || 0);

      const theoreticalTp1Profit = Number((Math.abs(entryPrice - tp1Price) * 100 * lotSize).toFixed(2));
      const theoreticalTp2Profit = (tp2Price > 0 && Math.abs(entryPrice - tp2Price) > 0.01)
        ? Number((Math.abs(entryPrice - tp2Price) * 100 * lotSize).toFixed(2))
        : undefined;

      const previousPnl =
        typeof tradeToUpdate.realizedPnl === 'number'
          ? tradeToUpdate.realizedPnl
          : tradeToUpdate.result === 'WIN' || tradeToUpdate.result === 'LOSS' || tradeToUpdate.result === 'BREAK_EVEN'
          ? tradeToUpdate.pl || 0
          : 0;

      const delta = Number((finalRealizedPnl - previousPnl).toFixed(2));

      tradeToUpdate.result = record.outcome;
      tradeToUpdate.pl = finalRealizedPnl;
      tradeToUpdate.realizedPnl = finalRealizedPnl;
      tradeToUpdate.source = (source as any);
      if (record.brokerDealId) tradeToUpdate.brokerDealId = record.brokerDealId;
      if (record.brokerOrderId) tradeToUpdate.brokerOrderId = record.brokerOrderId;
      if (record.closedAt) tradeToUpdate.closedAt = record.closedAt;
      if (record.closeReason) tradeToUpdate.closeReason = record.closeReason;
      tradeToUpdate.theoreticalTp1Profit = theoreticalTp1Profit;
      tradeToUpdate.theoreticalTp2Profit = theoreticalTp2Profit;
      tradeToUpdate.exitPrice =
        record.exitPrice !== undefined
          ? record.exitPrice
          : isWin
          ? tradeToUpdate.tp1 || record.tp1
          : isBreakEven
          ? tradeToUpdate.entry || record.entry
          : tradeToUpdate.sl || record.stopLoss;
      tradeToUpdate.exitTime = new Date(record.timestamp || Date.now()).toISOString();
      const outcomeNote = isWin ? '🟢 رابحة' : isBreakEven ? '⚪ تعادل (Break-Even)' : '🔴 خاسرة';
      tradeToUpdate.notes = `${tradeToUpdate.notes ? tradeToUpdate.notes + ' | ' : ''}النتيجة: ${outcomeNote} [P&L: ${
        finalRealizedPnl >= 0 ? '+' : ''
      }$${finalRealizedPnl.toFixed(2)}] (${source})`;
      tradeToUpdate.isActive = false;

      this.inMemoryCurrentBalance = Number((this.inMemoryCurrentBalance + delta).toFixed(2));
      tradeToUpdate.balanceAfterTrade = this.inMemoryCurrentBalance;

      const updatedTrade = tradeToUpdate;

      // Supabase persistence
      this.safeSupabase(
        (c) => c.from('trade_outcomes').upsert(this.formatOutcomeRow(record)),
        'recordTradeOutcome:outcomes'
      );
      this.safeSupabase(
        (c) => c.from('trade_ledger').upsert(this.formatTradeRow(updatedTrade)),
        'recordTradeOutcome:ledger'
      );
      this.safeSupabase(
        (c) =>
          c.from('account_state').upsert({
            id: 'main',
            current_balance: this.inMemoryCurrentBalance,
            starting_balance: this.inMemoryStartingBalance,
            updated_at: new Date().toISOString(),
          }),
        'recordTradeOutcome:account_state'
      );

      this.syncJsonBackups();

      // Dispatch to registered outcome listeners (e.g. feedback memory engine)
      for (const listener of this.outcomeListeners) {
        try {
          listener(record, updatedTrade);
        } catch (lErr) {
          console.warn('[Storage] Outcome listener error (non-blocking):', lErr);
        }
      }

      // Dispatch completed trade outcome notification with canonical ID and explicit event timestamp
      const outcomeNotificationId = `close_${record.tradeId || record.signalId}`;
      telegramService.sendOutcomeNotification(record, updatedTrade, {
        notificationId: outcomeNotificationId,
        eventTimestamp: record.timestamp || Date.now(),
      }).catch((err) => {
        console.error('[Storage] Telegram outcome alert dispatch error:', err);
      });

      return {
        success: true,
        isDuplicate: false,
        outcome: record,
        trade: updatedTrade,
      };
    } catch (err: any) {
      console.error('[Storage] Error recording outcome:', err);
      return {
        success: false,
        isDuplicate: false,
        outcome: record,
        message: err?.message || 'Failed to record trade outcome',
      };
    }
  }

  public async recordTradeOutcomeAsync(
    record: TradeOutcomeRecord,
    signalData?: Partial<TradeSignal>
  ): Promise<{
    success: boolean;
    isDuplicate: boolean;
    outcome: TradeOutcomeRecord;
    trade?: TradeLedgerItem;
    message?: string;
  }> {
    const res = this.recordTradeOutcome(record, signalData);
    if (res.success && res.trade) {
      await Promise.all([
        this.safeSupabaseAsync((c) => c.from('trade_outcomes').upsert(this.formatOutcomeRow(record)), 'recordTradeOutcomeAsync:outcomes'),
        this.safeSupabaseAsync((c) => c.from('trade_ledger').upsert(this.formatTradeRow(res.trade!)), 'recordTradeOutcomeAsync:ledger'),
        this.safeSupabaseAsync(
          (c) =>
            c.from('account_state').upsert({
              id: 'main',
              current_balance: this.inMemoryCurrentBalance,
              starting_balance: this.inMemoryStartingBalance,
              updated_at: new Date().toISOString(),
            }),
          'recordTradeOutcomeAsync:account_state'
        ),
      ]);
    }
    return res;
  }

  public reconcileMt5Trade(params: {
    signalOrTradeId: string;
    brokerDealId: string;
    brokerOrderId?: string;
    positionTicket?: number;
    entryPrice?: number;
    exitPrice: number;
    lotSize?: number;
    realizedPnl: number;
    closedAt?: number;
    closeReason?: string;
    direction?: string;
    commission?: number;
    swap?: number;
  }): { success: boolean; trade?: TradeLedgerItem; message?: string } {
    try {
      // 1. Idempotency Check: Don't process the same deal twice
      if (params.brokerDealId) {
        const alreadyRecorded = this.inMemoryOutcomes.find(
          (o) => o.brokerDealId === params.brokerDealId
        );
        if (alreadyRecorded) {
          const existingTrade = this.inMemoryTrades.find((t) => t.id === alreadyRecorded.tradeId || t.id === params.signalOrTradeId);
          return { success: true, trade: existingTrade, message: 'DEAL_ALREADY_RECONCILED' };
        }
      }

      // 2. Locate referenced trade in ledger
      let tradeToUpdate = this.inMemoryTrades.find((t) =>
        t.id === params.signalOrTradeId ||
        (params.positionTicket && (t.id === `mt5_${params.positionTicket}` || t.notes?.includes(String(params.positionTicket)))) ||
        (params.brokerOrderId && (t.id === `mt5_${params.brokerOrderId}` || t.notes?.includes(String(params.brokerOrderId)))) ||
        (t.notes && t.notes.includes(`Deal #${params.brokerDealId}`))
      );

      const outcome: 'WIN' | 'LOSS' = params.realizedPnl >= 0 ? 'WIN' : 'LOSS';

      if (tradeToUpdate) {
        tradeToUpdate.result = outcome;
        tradeToUpdate.pl = params.realizedPnl;
        tradeToUpdate.exitPrice = params.exitPrice;
        tradeToUpdate.isActive = false;
        tradeToUpdate.closeReason = params.closeReason || 'MT5_CLOSED';
        tradeToUpdate.notes = (tradeToUpdate.notes ? `${tradeToUpdate.notes} | ` : '') + `Closed via Deal #${params.brokerDealId} (PnL: $${params.realizedPnl.toFixed(2)})`;
      } else {
        // Instantiate missing trade in ledger (e.g. executed before restart or directly on MT5 demo)
        const highestNum = Math.max(0, ...this.inMemoryTrades.map((t) => t.tradeNumber || 0));
        const entryPrice = params.entryPrice || params.exitPrice;
        tradeToUpdate = {
          id: params.signalOrTradeId || `mt5_${params.brokerDealId}`,
          signalId: params.signalOrTradeId,
          tradeNumber: highestNum + 1,
          date: new Date(params.closedAt || Date.now()).toLocaleDateString('ar-EG', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
          isoTime: new Date(params.closedAt || Date.now()).toISOString(),
          asset: 'XAU/USD',
          direction: (params.direction as any) || 'BUY',
          entry: entryPrice,
          sl: 0,
          slPoints: 0,
          tp1: 0,
          tp1Points: 0,
          lotSize: params.lotSize || 0.01,
          riskPercent: 1.5,
          riskAmount: 1.5,
          confidence: 85,
          setup: 'MT5 Executed Trade',
          rr: '1:1.5',
          result: outcome,
          pl: params.realizedPnl,
          exitPrice: params.exitPrice,
          balanceAfterTrade: Number(((this.inMemoryCurrentBalance || 25) + params.realizedPnl).toFixed(2)),
          isActive: false,
          source: 'MT5' as any,
          notes: `Reconciled from MT5 Deal #${params.brokerDealId}`,
        };
        this.inMemoryTrades.unshift(tradeToUpdate);
      }

      // 3. Update Balance
      this.inMemoryCurrentBalance = Number(((this.inMemoryCurrentBalance || 25) + params.realizedPnl).toFixed(2));
      tradeToUpdate.balanceAfterTrade = this.inMemoryCurrentBalance;

      // 4. Record Trade Outcome Record
      const record: TradeOutcomeRecord = {
        signalId: tradeToUpdate.signalId || tradeToUpdate.id,
        tradeId: tradeToUpdate.id,
        direction: tradeToUpdate.direction,
        orderType: 'MARKET',
        entry: tradeToUpdate.entry,
        stopLoss: tradeToUpdate.sl,
        tp1: tradeToUpdate.tp1,
        tp2: tradeToUpdate.tp2,
        outcome,
        realizedPnl: params.realizedPnl,
        exitPrice: params.exitPrice,
        source: 'MT5',
        brokerDealId: params.brokerDealId,
        brokerOrderId: params.brokerOrderId,
        closedAt: params.closedAt || Date.now(),
        closeReason: params.closeReason || 'MT5_CLOSED',
        timestamp: params.closedAt || Date.now(),
        isoTime: new Date(params.closedAt || Date.now()).toISOString(),
        notes: `Commission: $${(params.commission || 0).toFixed(2)}, Swap: $${(params.swap || 0).toFixed(2)}`,
      };

      this.inMemoryOutcomes.unshift(record);
      if (this.inMemoryOutcomes.length > 500) {
        this.inMemoryOutcomes = this.inMemoryOutcomes.slice(0, 500);
      }

      // 5. Persist to Supabase and JSON backups
      this.safeSupabase(
        (c) => c.from('trade_outcomes').upsert(this.formatOutcomeRow(record)),
        'reconcileMt5Trade:outcomes'
      );
      this.safeSupabase(
        (c) => c.from('trade_ledger').upsert(this.formatTradeRow(tradeToUpdate!)),
        'reconcileMt5Trade:ledger'
      );
      this.safeSupabase(
        (c) =>
          c.from('account_state').upsert({
            id: 'main',
            current_balance: this.inMemoryCurrentBalance,
            starting_balance: this.inMemoryStartingBalance,
            updated_at: new Date().toISOString(),
          }),
        'reconcileMt5Trade:account_state'
      );
      this.syncJsonBackups();

      // 6. Notify registered outcome listeners
      for (const listener of this.outcomeListeners) {
        try {
          listener(record, tradeToUpdate);
        } catch (lErr) {
          console.warn('[Storage] Outcome listener error (non-blocking):', lErr);
        }
      }

      return {
        success: true,
        trade: tradeToUpdate,
        message: 'RECONCILED',
      };
    } catch (e: any) {
      console.error('[Storage] reconcileMt5Trade error:', e);
      return { success: false, message: e?.message };
    }
  }

  // =========================================================================
  // Stats & Dashboard
  // =========================================================================
  public getDashboardStats(): DashboardStatsResult {
    const closedTrades = this.inMemoryTrades.filter((t) => t.result === 'WIN' || t.result === 'LOSS' || t.result === 'BREAK_EVEN');
    const wins = closedTrades.filter((t) => t.result === 'WIN').length;
    const losses = closedTrades.filter((t) => t.result === 'LOSS').length;
    const totalClosed = wins + losses;
    const winRate = totalClosed > 0 ? Number(((wins / totalClosed) * 100).toFixed(1)) : 0;
    const totalPl = Number(closedTrades.reduce((acc, t) => acc + (t.pl || 0), 0).toFixed(2));

    const todayStats = this.getTodayStats();

    return {
      totalScans: this.inMemoryScans.length,
      totalSignals: this.inMemorySignals.length,
      buyCount: this.inMemoryScans.filter((s) => s.signal === 'BUY NOW' || s.signal === 'BUY LIMIT').length,
      sellCount: this.inMemoryScans.filter((s) => s.signal === 'SELL NOW' || s.signal === 'SELL LIMIT').length,
      limitCount: this.inMemoryScans.filter((s) => s.signal === 'BUY LIMIT' || s.signal === 'SELL LIMIT').length,
      noTradeCount: this.inMemoryScans.filter((s) => s.signal === 'NO TRADE').length,
      wins,
      losses,
      winRate,
      totalPl,
      startingBalance: this.inMemoryStartingBalance,
      currentBalance: this.inMemoryCurrentBalance,
      currentRiskPercent: this.inMemorySettings.riskPerTrade,
      recentSignals: this.inMemorySignals.slice(0, 10),
      recentScans: this.inMemoryScans.slice(0, 10),
      lastScanTime: this.lastScannerTimestamp,
      lastScanStatus: this.lastScannerStatus,
      scannerHealth: 'HEALTHY',
      todayStats,
    };
  }

  public getPerformanceStats() {
    return this.getDashboardStats();
  }

  public getTodayStats(todayDateStr?: string): DailyTradeStats {
    const today = todayDateStr || new Date().toISOString().split('T')[0];
    const todayTrades = this.inMemoryTrades.filter((t) => {
      // Non-executed records (e.g. NOT_ENTERED, CANCELLED, VOID) must never count towards executed trades
      if (t.result === 'NOT_ENTERED' || (t.result as any) === 'CANCELLED' || (t.result as any) === 'VOID') return false;
      if (t.isoTime) return t.isoTime.startsWith(today);
      return true;
    });

    const tradesCount = todayTrades.length;
    const wins = todayTrades.filter((t) => t.result === 'WIN').length;
    const losses = todayTrades.filter((t) => t.result === 'LOSS').length;
    const decidedCount = wins + losses;
    const winRate = decidedCount > 0 ? Number(((wins / decidedCount) * 100).toFixed(1)) : 0;
    const totalPl = Number(todayTrades.reduce((acc, t) => acc + (t.pl || 0), 0).toFixed(2));
    const totalRiskPercentUsed = Number(todayTrades.reduce((acc, t) => acc + (t.riskPercent || 0), 0).toFixed(1));

    return {
      date: today,
      tradesCount,
      wins,
      losses,
      winRate,
      totalPl,
      totalRiskPercentUsed,
      maxDailyTradesReached: tradesCount >= 3,
      maxDailyRiskReached: totalRiskPercentUsed >= 30.0,
    };
  }

  public getDailyStats(dateStr?: string): DailyTradeStats {
    return this.getTodayStats(dateStr);
  }

  // =========================================================================
  // Account Balance Management (Requirement 4: Strict $91.00 Preservation)
  // =========================================================================
  public getBalance(): { currentBalance: number; startingBalance: number } {
    return {
      currentBalance: this.inMemoryCurrentBalance,
      startingBalance: this.inMemoryStartingBalance,
    };
  }

  public getCurrentBalance(): number {
    return this.inMemoryCurrentBalance;
  }

  public getStartingBalance(): number {
    return this.inMemoryStartingBalance;
  }

  public setStartingBalance(val: number): void {
    if (typeof val === 'number' && !isNaN(val) && val > 0) {
      this.inMemoryStartingBalance = Number(val.toFixed(2));
      this.inMemoryCurrentBalance = this.inMemoryStartingBalance;
      this.inMemorySettings.manualCapital = this.inMemoryStartingBalance;
      this.syncJsonBackups();

      this.safeSupabase(
        (c) =>
          c.from('account_state').upsert({
            id: 'main',
            current_balance: this.inMemoryCurrentBalance,
            starting_balance: this.inMemoryStartingBalance,
            updated_at: new Date().toISOString(),
          }),
        'setStartingBalance'
      );
    }
  }

  public setCurrentBalance(val: number): void {
    if (typeof val === 'number' && !isNaN(val)) {
      this.inMemoryCurrentBalance = Number(val.toFixed(2));
      this.syncJsonBackups();

      this.safeSupabase(
        (c) =>
          c.from('account_state').upsert({
            id: 'main',
            current_balance: this.inMemoryCurrentBalance,
            starting_balance: this.inMemoryStartingBalance,
            updated_at: new Date().toISOString(),
          }),
        'setCurrentBalance'
      );
    }
  }

  public updateBalance(current: number, starting?: number): { currentBalance: number; startingBalance: number } {
    this.inMemoryCurrentBalance = Number(current.toFixed(2));
    if (typeof starting === 'number' && !isNaN(starting) && starting > 0) {
      this.inMemoryStartingBalance = Number(starting.toFixed(2));
      this.inMemorySettings.manualCapital = this.inMemoryStartingBalance;

      this.safeSupabase(
        (c) =>
          c.from('app_settings').upsert({
            id: 'main',
            data: this.inMemorySettings,
            updated_at: new Date().toISOString(),
          }),
        'updateBalance:settings'
      );
    }

    this.safeSupabase(
      (c) =>
        c.from('account_state').upsert({
          id: 'main',
          current_balance: this.inMemoryCurrentBalance,
          starting_balance: this.inMemoryStartingBalance,
          updated_at: new Date().toISOString(),
        }),
      'updateBalance:account_state'
    );

    this.syncJsonBackups();
    return this.getBalance();
  }

  // =========================================================================
  // Settings Management
  // =========================================================================
  public getSettings(): AppSettings {
    return { ...this.inMemorySettings };
  }

  public saveSettings(patch: Partial<AppSettings>): {
    success: boolean;
    settings: AppSettings;
    startingBalance: number;
    currentBalance: number;
    error?: string;
  } {
    try {
      this.inMemorySettings = { ...this.inMemorySettings, ...patch };

      if (patch.manualCapital !== undefined) {
        const newCap = Number(patch.manualCapital);
        if (!isNaN(newCap) && newCap >= 0) {
          this.inMemorySettings.manualCapital = Number(newCap.toFixed(2));
        }
      }

      this.safeSupabase(
        (c) =>
          c.from('app_settings').upsert({
            id: 'main',
            data: this.inMemorySettings,
            updated_at: new Date().toISOString(),
          }),
        'saveSettings'
      );

      this.syncJsonBackups();
      return {
        success: true,
        settings: { ...this.inMemorySettings },
        startingBalance: this.inMemoryStartingBalance,
        currentBalance: this.inMemoryCurrentBalance,
      };
    } catch (err: any) {
      return {
        success: false,
        settings: this.inMemorySettings,
        startingBalance: this.inMemoryStartingBalance,
        currentBalance: this.inMemoryCurrentBalance,
        error: err?.message || 'Failed',
      };
    }
  }

  public saveScannerEvent(eventType: string, payload: any): void {
    // Optional scanner event logging
  }

  // =========================================================================
  // Terminal Setups (Cooldown & Invalidation Dedup)
  // =========================================================================
  public getTerminalSetups(): string[] {
    return Array.from(this.inMemoryTerminalSetups);
  }

  public saveTerminalSetup(key: string): void {
    if (!key) return;
    this.inMemoryTerminalSetups.add(key);

    this.safeSupabase(
      (c) =>
        c.from('terminal_setups').upsert({
          id: key.replace(/\//g, '_'),
          setup_key: key,
        }),
      'saveTerminalSetup'
    );

    this.syncJsonBackups();
  }

  public isTerminalSetup(key: string): boolean {
    if (!key) return false;
    return this.inMemoryTerminalSetups.has(key);
  }

  // =========================================================================
  // Telegram Dispatches Dedup
  // =========================================================================
  public saveTelegramDispatch(key: string): void {
    if (!key) return;
    this.inMemoryTelegramDispatches.add(key);
    this.persistTelegramDispatches();
  }

  private persistTelegramDispatches(): void {
    if (!this.shouldPersist()) return;
    try {
      fs.writeFileSync(
        TELEGRAM_DISPATCHES_FILE,
        JSON.stringify(Array.from(this.inMemoryTelegramDispatches), null, 2),
        'utf-8'
      );
    } catch (e) {
      console.error('[Storage] Error persisting telegram dispatches:', e);
    }
  }

  public isTelegramDispatched(key: string): boolean {
    if (!key) return false;
    return this.inMemoryTelegramDispatches.has(key);
  }

  public getTelegramDispatches(): string[] {
    return Array.from(this.inMemoryTelegramDispatches);
  }

  public getScannerStatus() {
    return {
      lastScanTimestamp: this.lastScannerTimestamp,
      lastScanStatus: this.lastScannerStatus,
      totalScans: this.inMemoryScans.length,
      isDbReady: this.isReady,
    };
  }

  // =========================================================================
  // Trade Closure & Ledger Mutation
  // =========================================================================
  public closeTrade(
    id: string,
    result: 'WIN' | 'LOSS' | 'CANCELLED' | 'VOID' | 'EXPIRED',
    pl: number,
    exitPrice?: number,
    notes?: string
  ): TradeLedgerItem[] {
    try {
      let targetList = this.inMemoryTrades;
      let idx = targetList.findIndex((t) => t.id === id);
      if (idx === -1) {
        targetList = this.inMemoryTestTrades;
        idx = targetList.findIndex((t) => t.id === id);
      }
      if (idx >= 0) {
        const trade = targetList[idx];
        if (trade.result !== 'OPEN') {
          return [...targetList];
        }

        const isRealizedTrade = result === 'WIN' || result === 'LOSS';
        const finalPl = isRealizedTrade ? Number(pl.toFixed(2)) : 0;
        const finalExitPrice = exitPrice !== undefined ? exitPrice : trade.exitPrice || trade.entry;
        const exitTime = new Date().toISOString();
        const updatedNotes = notes ? (trade.notes ? `${trade.notes} | ${notes}` : notes) : trade.notes;

        const newBalance = isRealizedTrade
          ? Number(((trade.balanceAfterTrade || this.inMemoryCurrentBalance) + finalPl).toFixed(2))
          : this.inMemoryCurrentBalance;

        targetList[idx] = {
          ...trade,
          result,
          pl: finalPl,
          exitPrice: finalExitPrice,
          exitTime,
          balanceAfterTrade: newBalance,
          notes: updatedNotes,
          isActive: false,
        };

        if (isRealizedTrade) {
          this.inMemoryCurrentBalance = newBalance;

          const outcomeRecord: TradeOutcomeRecord = {
            signalId: trade.signalId || trade.id,
            tradeId: trade.id,
            outcome: result as 'WIN' | 'LOSS',
            realizedPnl: finalPl,
            entry: trade.entry,
            exitPrice: finalExitPrice,
            closeReason: notes || trade.closeReason || 'تصفية يدوية أو نظام الوقف/الهدف',
            timestamp: Date.now(),
            source: 'SYSTEM',
          };

          const closeNotificationId = `close_${trade.id}`;
          telegramService.sendOutcomeNotification(outcomeRecord, targetList[idx], {
            notificationId: closeNotificationId,
            eventTimestamp: outcomeRecord.timestamp,
          }).catch((err) => {
            console.error('[Storage] Telegram outcome alert dispatch error from closeTrade:', err);
          });
        }

        if (targetList === this.inMemoryTrades) {
          this.safeSupabase(
            (c) => c.from('trade_ledger').upsert(this.formatTradeRow(this.inMemoryTrades[idx])),
            `closeTrade:${id}`
          );

          if (isRealizedTrade) {
            this.safeSupabase(
              (c) =>
                c.from('account_state').upsert({
                  id: 'main',
                  current_balance: this.inMemoryCurrentBalance,
                  starting_balance: this.inMemoryStartingBalance,
                  updated_at: new Date().toISOString(),
                }),
              'closeTrade:account_state'
            );
          }

          this.syncJsonBackups();
        }
      }
      return [...this.inMemoryTrades];
    } catch (error) {
      console.error('[Storage] Error closing trade in ledger:', error);
      return [...this.inMemoryTrades];
    }
  }

  public deleteTrade(id: string): TradeLedgerItem[] {
    try {
      this.inMemoryTrades = this.inMemoryTrades.filter((t) => t.id !== id);
      const closedTrades = this.inMemoryTrades.filter((t) => t.result === 'WIN' || t.result === 'LOSS');
      const totalPl = Number(closedTrades.reduce((acc, t) => acc + (t.pl || 0), 0).toFixed(2));
      this.inMemoryCurrentBalance =
        closedTrades.length === 0 ? this.inMemoryStartingBalance : Number((this.inMemoryStartingBalance + totalPl).toFixed(2));

      this.safeSupabase((c) => c.from('trade_ledger').delete().eq('id', id), `deleteTrade:${id}`);
      this.safeSupabase(
        (c) =>
          c.from('account_state').upsert({
            id: 'main',
            current_balance: this.inMemoryCurrentBalance,
            starting_balance: this.inMemoryStartingBalance,
            updated_at: new Date().toISOString(),
          }),
        'deleteTrade:account_state'
      );

      this.syncJsonBackups();
      return [...this.inMemoryTrades];
    } catch (error) {
      console.error('[Storage] Error deleting trade from ledger:', error);
      return [...this.inMemoryTrades];
    }
  }

  public getStats() {
    const supabaseConfigured = isSupabaseConfigured();
    const supabaseAvailable = isSupabaseAvailable();
    return {
      totalScansRecorded: this.inMemoryScans.length,
      totalSignalsRecorded: this.inMemorySignals.length,
      totalTradesRecorded: this.inMemoryTrades.length,
      totalOutcomesRecorded: this.inMemoryOutcomes.length,
      storageEngine: supabaseConfigured ? 'Supabase PostgreSQL (Durable Cloud Storage)' : 'Ephemeral Local Disk Backup',
      durablePersistence: supabaseConfigured && supabaseAvailable,
      supabaseStatus: !supabaseConfigured
        ? 'UNCONFIGURED'
        : supabaseAvailable
        ? 'CONNECTED'
        : 'DEGRADED_BACKOFF',
      persistenceWarning: !supabaseConfigured
        ? 'DEPLOYMENT BLOCKER: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not configured. On Render Free, container disk is ephemeral and state will reset on restart/sleep.'
        : undefined,
      isInitialized: this.isReady,
    };
  }

  public saveBacktestResult(result: any): void {
    try {
      this.ensureDataDirectory();
      fs.writeFileSync(BACKTEST_FILE, JSON.stringify(result, null, 2), 'utf-8');
    } catch (error) {
      console.error('[PersistentStorage] Error saving backtest result:', error);
    }
  }

  public getBacktestResult(): any | null {
    try {
      if (fs.existsSync(BACKTEST_FILE)) {
        return JSON.parse(fs.readFileSync(BACKTEST_FILE, 'utf-8'));
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  // =========================================================================
  // POI Tracking
  // =========================================================================
  public savePoi(poi: PoiRecord): void {
    const idx = this.inMemoryPois.findIndex((p) => p.id === poi.id);
    if (idx >= 0) {
      this.inMemoryPois[idx] = poi;
    } else {
      this.inMemoryPois.push(poi);
      if (this.inMemoryPois.length > 200) {
        this.inMemoryPois.shift();
      }
    }
    this.syncJsonBackups();
    this.safeSupabase((c) => c.from('poi_records').upsert({ id: poi.id, raw_data: poi }), `savePoi:${poi.id}`);
  }

  public savePois(pois: PoiRecord[]): void {
    for (const p of pois) {
      this.savePoi(p);
    }
  }

  public getPois(): PoiRecord[] {
    return [...this.inMemoryPois];
  }

  // =========================================================================
  // Candidate Lifecycle State Persistence
  // =========================================================================
  public saveLifecycle(record: CandidateLifecycleRecord): void {
    const idx = this.inMemoryLifecycles.findIndex((l) => l.id === record.id);
    if (idx >= 0) {
      this.inMemoryLifecycles[idx] = record;
    } else {
      this.inMemoryLifecycles.push(record);
      if (this.inMemoryLifecycles.length > 200) {
        this.inMemoryLifecycles.shift();
      }
    }
    if (record.state === 'FAILED' || record.state === 'COMPLETED' || record.state === 'CANCELLED' || record.state === 'EXPIRED') {
      this.saveTerminalSetup(record.id);
      this.saveTerminalSetup(`cand_${record.id}`);
    }
    this.safeSupabase(
      (c) => c.from('candidate_lifecycles').upsert({ id: record.id, raw_data: record }),
      `saveLifecycle:${record.id}`
    );
  }

  public saveCandidateLifecycle(record: CandidateLifecycleRecord): void {
    this.saveLifecycle(record);
  }

  public saveLifecycles(records: CandidateLifecycleRecord[]): void {
    for (const r of records) {
      this.saveLifecycle(r);
    }
  }

  public getLifecycles(): CandidateLifecycleRecord[] {
    return [...this.inMemoryLifecycles];
  }

  // =========================================================================
  // Trade Opportunity State Persistence
  // =========================================================================
  public saveOpportunity(opp: TradeOpportunity): void {
    if (!opp.id) return;
    this.inMemoryOpportunities.set(opp.id, opp);
    if (opp.status === 'FAILED' || opp.status === 'COMPLETED' || opp.status === 'CANCELLED' || opp.status === 'NOT_ENTERED') {
      this.saveTerminalSetup(opp.id);
      this.saveTerminalSetup(`cand_${opp.id}`);
      if (opp.patternAnchorKey) {
        this.saveTerminalSetup(opp.patternAnchorKey);
        this.saveTerminalSetup(`cand_${opp.patternAnchorKey}`);
      }
    }
    this.safeSupabase(
      (c) =>
        c.from('opportunities').upsert({
          id: opp.id,
          last_updated_time: opp.lastUpdatedTime,
          raw_data: opp,
        }),
      `saveOpportunity:${opp.id}`
    );
    this.syncJsonBackups();
  }

  public getOpportunity(id: string): TradeOpportunity | null {
    if (!id) return null;
    const opp = this.inMemoryOpportunities.get(id);
    if (!opp) return null;
    // 60-second TTL fallback for in-flight locks
    if (opp.telegramDeliveryInFlight && opp.telegramDeliveryInFlightTime && Date.now() - opp.telegramDeliveryInFlightTime > 60000) {
      opp.telegramDeliveryInFlight = false;
      opp.telegramDeliveryInFlightTime = undefined;
    }
    return opp;
  }

  public getOpportunities(): TradeOpportunity[] {
    const list = Array.from(this.inMemoryOpportunities.values());
    const now = Date.now();
    for (const opp of list) {
      if (opp.telegramDeliveryInFlight && opp.telegramDeliveryInFlightTime && now - opp.telegramDeliveryInFlightTime > 60000) {
        opp.telegramDeliveryInFlight = false;
        opp.telegramDeliveryInFlightTime = undefined;
      }
    }
    return list;
  }

  public markSignalOrOpportunityNotEntered(signalOrOppId: string): {
    success: boolean;
    signal?: TradeSignal;
    opportunity?: TradeOpportunity;
  } {
    let updatedSignal: TradeSignal | undefined;
    let updatedOpp: TradeOpportunity | undefined;

    // 1. Update Signal in memory and storage
    const sigIdx = this.inMemorySignals.findIndex((s) => s.id === signalOrOppId || s.setupId === signalOrOppId);
    if (sigIdx >= 0) {
      this.inMemorySignals[sigIdx].lifecycleState = 'NOT_ENTERED';
      updatedSignal = this.inMemorySignals[sigIdx];
      this.safeSupabase(
        (c) =>
          c.from('signals').upsert({
            id: updatedSignal!.id,
            timestamp: updatedSignal!.timestamp,
            raw_data: updatedSignal,
          }),
        `markNotEntered:signal:${updatedSignal.id}`
      );
    }

    // 2. Update Opportunity in memory and storage
    const opp = this.inMemoryOpportunities.get(signalOrOppId) || (updatedSignal?.setupId ? this.inMemoryOpportunities.get(updatedSignal.setupId) : null);
    if (opp) {
      opp.status = 'NOT_ENTERED';
      opp.lastUpdatedTime = Date.now();
      this.inMemoryOpportunities.set(opp.id, opp);
      updatedOpp = opp;
      this.safeSupabase(
        (c) =>
          c.from('opportunities').upsert({
            id: opp.id,
            last_updated_time: opp.lastUpdatedTime,
            raw_data: opp,
          }),
        `markNotEntered:opportunity:${opp.id}`
      );
    }

    // 3. Update candidate lifecycle if found
    const lcIdx = this.inMemoryLifecycles.findIndex((l) => l.id === signalOrOppId || l.poiId === signalOrOppId);
    if (lcIdx >= 0) {
      this.inMemoryLifecycles[lcIdx].state = 'NOT_ENTERED';
      this.inMemoryLifecycles[lcIdx].lastUpdatedTime = Date.now();
      this.safeSupabase(
        (c) => c.from('candidate_lifecycles').upsert({ id: this.inMemoryLifecycles[lcIdx].id, raw_data: this.inMemoryLifecycles[lcIdx] }),
        `markNotEntered:lifecycle:${this.inMemoryLifecycles[lcIdx].id}`
      );
    }

    // 4. Also store outcome record as NOT_ENTERED
    const outcomeRecord: TradeOutcomeRecord = {
      signalId: signalOrOppId,
      tradeId: signalOrOppId,
      direction: updatedSignal?.signal || (updatedSignal && updatedSignal.entry > updatedSignal.stopLoss ? 'BUY NOW' : 'SELL NOW'),
      orderType: 'NOT_ENTERED',
      entry: updatedSignal?.entry || 0,
      stopLoss: updatedSignal?.stopLoss || 0,
      tp1: updatedSignal?.tp1 || 0,
      tp2: updatedSignal?.tp2 || 0,
      outcome: 'NOT_ENTERED' as any,
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
      source: 'MANUAL',
      realizedPnl: 0,
      pl: 0,
      notes: 'لم تُنفذ / لم يتم الدخول (NOT ENTERED)',
    };

    const outIdx = this.inMemoryOutcomes.findIndex((o) => o.signalId === signalOrOppId || o.tradeId === signalOrOppId);
    if (outIdx >= 0) {
      this.inMemoryOutcomes[outIdx] = outcomeRecord;
    } else {
      this.inMemoryOutcomes.unshift(outcomeRecord);
    }
    this.safeSupabase(
      (c) => c.from('trade_outcomes').upsert(this.formatOutcomeRow(outcomeRecord)),
      `markNotEntered:outcome:${signalOrOppId}`
    );

    // 5. Ensure NO executed trade exists in trade ledger for this unentered signal
    const tradeIdx = this.inMemoryTrades.findIndex(
      (t) => t.id === signalOrOppId || t.signalId === signalOrOppId || (updatedSignal && (t.id === updatedSignal.id || t.signalId === updatedSignal.id))
    );
    if (tradeIdx >= 0) {
      const removedTrade = this.inMemoryTrades[tradeIdx];
      this.inMemoryTrades.splice(tradeIdx, 1);
      this.safeSupabase(
        (c) => c.from('trade_ledger').delete().eq('id', removedTrade.id),
        `markNotEntered:delete_trade:${removedTrade.id}`
      );
    }

    this.syncJsonBackups();
    return { success: true, signal: updatedSignal, opportunity: updatedOpp };
  }

  public async clearAllTrades(): Promise<TradeLedgerItem[]> {
    this.inMemoryTrades = [];
    this.inMemoryCurrentBalance = this.inMemoryStartingBalance;
    await this.safeSupabaseAsync((c) => c.from('trade_ledger').delete().neq('id', '___non_existent___'), 'clearAllTrades:ledger');
    await this.safeSupabaseAsync(
      (c) =>
        c.from('account_state').upsert({
          id: 'main',
          current_balance: this.inMemoryCurrentBalance,
          starting_balance: this.inMemoryStartingBalance,
          updated_at: new Date().toISOString(),
        }),
      'clearAllTrades:account_state'
    );
    this.syncJsonBackups();
    return [];
  }

  public clearOpportunities(): void {
    this.inMemoryOpportunities.clear();
    this.syncJsonBackups();
  }

  public async resetTradingState(): Promise<any> {
    try {
      const auditBefore = {
        signalsCount: this.inMemorySignals.length,
        tradesCount: this.inMemoryTrades.length,
        openTradesCount: this.inMemoryTrades.filter((t) => t.result === 'OPEN').length,
        opportunitiesCount: this.inMemoryOpportunities.size,
        terminalSetupsCount: this.inMemoryTerminalSetups.size,
        currentBalance: this.inMemoryCurrentBalance,
        startingBalance: this.inMemoryStartingBalance,
      };

      // 1. Reset signals
      this.inMemorySignals = [];

      // 2. Reset opportunities
      this.inMemoryOpportunities.clear();

      // 3. Reset terminal setups & telegram dispatches
      this.inMemoryTerminalSetups.clear();
      this.inMemoryTelegramDispatches.clear();

      // 4. Reset lifecycles
      this.inMemoryLifecycles = [];

      // 5. Preserving completed/realized trades in ledger (WIN/LOSS/BREAK_EVEN)
      const completedTrades = this.inMemoryTrades.filter((t) => t.result === 'WIN' || t.result === 'LOSS' || t.result === 'BREAK_EVEN');
      this.inMemoryTrades = completedTrades;

      // Recalculate current balance based on preserved completed trades
      const totalPl = Number(completedTrades.reduce((acc, t) => acc + (t.pl || 0), 0).toFixed(2));
      this.inMemoryCurrentBalance = Number((this.inMemoryStartingBalance + totalPl).toFixed(2));

      // 6. Sync JSON backups
      this.syncJsonBackups();

      // 7. Clear Supabase tables if connected
      await Promise.all([
        this.safeSupabaseAsync((c) => c.from('signals').delete().neq('id', '___keep___'), 'resetTradingState:signals'),
        this.safeSupabaseAsync((c) => c.from('opportunities').delete().neq('id', '___keep___'), 'resetTradingState:opportunities'),
        this.safeSupabaseAsync((c) => c.from('candidate_lifecycles').delete().neq('id', '___keep___'), 'resetTradingState:lifecycles'),
        this.safeSupabaseAsync((c) => c.from('terminal_setups').delete().neq('id', '___keep___'), 'resetTradingState:terminal_setups'),
        this.safeSupabaseAsync((c) => c.from('trade_ledger').delete().eq('result', 'OPEN'), 'resetTradingState:open_trades'),
        this.safeSupabaseAsync(
          (c) =>
            c.from('account_state').upsert({
              id: 'main',
              current_balance: this.inMemoryCurrentBalance,
              starting_balance: this.inMemoryStartingBalance,
              updated_at: new Date().toISOString(),
            }),
          'resetTradingState:account_state'
        ),
      ]);

      const auditAfter = {
        signalsCount: this.inMemorySignals.length,
        tradesCount: this.inMemoryTrades.length,
        openTradesCount: this.inMemoryTrades.filter((t) => t.result === 'OPEN').length,
        opportunitiesCount: this.inMemoryOpportunities.size,
        terminalSetupsCount: this.inMemoryTerminalSetups.size,
        currentBalance: this.inMemoryCurrentBalance,
        startingBalance: this.inMemoryStartingBalance,
      };

      console.log('[Storage] Total Trading State Reset Complete.', { auditBefore, auditAfter });

      return {
        success: true,
        before: auditBefore,
        after: auditAfter,
      };
    } catch (error: any) {
      console.error('[Storage] Error during resetTradingState:', error);
      throw error;
    }
  }

  // =========================================================================
  // Experience Memory & Factor Snapshots Persistence
  // =========================================================================
  public onOutcomeRecorded(listener: (record: TradeOutcomeRecord, trade?: TradeLedgerItem) => void): void {
    this.outcomeListeners.push(listener);
  }

  public saveFactorSnapshot(snapshot: any): void {
    if (!snapshot || !snapshot.signalId) return;
    const isTest = this.isTesting || isSyntheticTestRecord({ id: snapshot.signalId, ...snapshot });
    if (isTest) {
      this.inMemoryTestFactorSnapshots.set(snapshot.signalId, snapshot);
    } else {
      this.inMemoryFactorSnapshots.set(snapshot.signalId, snapshot);
    }
    if (this.shouldPersist()) {
      this.syncJsonBackups();
    }
  }

  public getFactorSnapshot(signalId: string): any | null {
    if (!signalId) return null;
    return this.inMemoryFactorSnapshots.get(signalId) || this.inMemoryTestFactorSnapshots.get(signalId) || null;
  }

  public saveExperienceRecord(record: any): void {
    if (!record || !record.id) return;
    const idx = this.inMemoryExperienceRecords.findIndex(
      (r) => r.id === record.id || (r.signalId === record.signalId && r.completedAt === record.completedAt)
    );
    if (idx >= 0) {
      this.inMemoryExperienceRecords[idx] = record;
    } else {
      this.inMemoryExperienceRecords.push(record);
    }
    if (this.inMemoryExperienceRecords.length > 1000) {
      this.inMemoryExperienceRecords = this.inMemoryExperienceRecords.slice(-1000);
    }
    if (this.shouldPersist()) {
      this.safeSupabase(
        (c) =>
          c.from('experience_records').upsert({
            id: record.id,
            signal_id: record.signalId,
            trade_id: record.tradeId || null,
            combination_key: record.combinationKey,
            factors: record.factors,
            direction: record.direction,
            setup_family: record.setupFamily,
            outcome: record.outcome,
            realized_pnl: record.realizedPnl,
            rr: record.rr || null,
            completed_at: record.completedAt,
            raw_data: record,
          }),
        'saveExperienceRecord'
      );
      this.syncJsonBackups();
    }
  }

  public getCompletedExperienceRecords(): any[] {
    return [...this.inMemoryExperienceRecords];
  }
}

export const storage = new PersistentStorage();

export function sanitizeFirestoreData(data: any): any {
  if (data === null || data === undefined) return null;
  if (typeof data === 'number') {
    if (isNaN(data) || !isFinite(data)) return 0;
    return data;
  }
  if (typeof data !== 'object') return data;
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeFirestoreData(item)).filter((item) => item !== undefined);
  }
  const result: any = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (typeof value === 'function') continue;
    result[key] = sanitizeFirestoreData(value);
  }
  return result;
}

export const sanitizeDatabaseData = sanitizeFirestoreData;
