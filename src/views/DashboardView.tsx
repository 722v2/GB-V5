import React, { useState } from 'react';
import {
  Activity,
  Radio,
  Cpu,
  Shield,
  Clock,
  TrendingUp,
  TrendingDown,
  ArrowRightLeft,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertTriangle,
  Play,
  Layers,
  Sparkles,
  Info,
  History,
  DollarSign,
  Percent,
  Scale,
  ShieldCheck,
  Lock,
} from 'lucide-react';
import { Candle, ScannerConfig, TradeSignal, AppSettings, MT5AccountInfo, AccountStats } from '../types';
import { MiniChart } from '../components/MiniChart';

interface DashboardViewProps {
  scannerConfig: ScannerConfig;
  signal?: TradeSignal | null;
  currentSignal?: TradeSignal | null;
  currentPrice?: number;
  prevPrice?: number;
  marketMetrics?: any;
  stats?: AccountStats;
  currentBalance?: number;
  settings?: AppSettings;
  activeCapital?: number;
  mt5Account?: MT5AccountInfo;
  candles?: Candle[];
  atr?: number;
  structure?: string;
  marketRegime?: string;
  isOverextended?: boolean;
  isLiveConnected?: boolean;
  hasGeminiKey?: boolean;
  workerUptimeFormatted?: string;
  onExecuteDemo?: (signal: TradeSignal) => void;
  isSignalLogged?: boolean;
  onRunScanNow?: () => void;
  onRunScan?: () => void;
  onNavigate?: (tab: any) => void;
  isAnalyzing?: boolean;
  multitimeframe?: {
    marketState: 'TREND' | 'RANGE' | 'CONSOLIDATION';
    marketRegime?: string;
    regimeContext?: any;
    h1Trend: string;
    m15Structure: string;
    m5Atr: number;
  };
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  scannerConfig,
  signal,
  currentSignal,
  currentPrice = 2718.5,
  candles = [],
  atr = 2.4,
  structure = 'BULLISH',
  marketRegime,
  isOverextended,
  isLiveConnected = false,
  hasGeminiKey = true,
  workerUptimeFormatted = 'Active',
  onExecuteDemo,
  isSignalLogged = false,
  onRunScanNow,
  onRunScan,
  onNavigate,
  isAnalyzing = false,
  multitimeframe,
  settings,
  activeCapital,
  mt5Account,
  currentBalance,
  stats,
}) => {
  const [showFullAnalysis, setShowFullAnalysis] = useState<boolean>(false);

  const activeSignal = signal || currentSignal || null;
  const displayPrice = typeof currentPrice === 'number' ? currentPrice : 2718.5;
  const displayAtr = typeof atr === 'number' ? atr : typeof multitimeframe?.m5Atr === 'number' ? multitimeframe.m5Atr : 2.4;
  const marketState = multitimeframe?.marketState || (structure === 'RANGING' ? 'RANGE' : 'TREND');
  const resolvedRegime = marketRegime || multitimeframe?.marketRegime || (structure === 'RANGING' ? 'NORMAL_RANGE' : structure === 'BULLISH' ? 'STRONG_UPTREND' : 'STRONG_DOWNTREND');
  const isPriceOverextended = isOverextended || multitimeframe?.regimeContext?.isOverextended || false;
  const h1Trend = multitimeframe?.h1Trend || structure;
  const m15Structure = multitimeframe?.m15Structure || (structure === 'BULLISH' ? 'DISCOUNT' : 'PREMIUM');

  const hasActiveSignal = Boolean(activeSignal && activeSignal.signal && activeSignal.signal !== 'NO TRADE');
  const handleScan = onRunScanNow || onRunScan || (() => {});

  // Resolved Capital & Risk Calculations
  const effectiveCapital = typeof activeCapital === 'number'
    ? activeCapital
    : (settings?.manualCapital ?? Number(currentBalance || 25));

  const riskPercent = typeof settings?.riskPerTrade === 'number' ? settings.riskPerTrade : 18.0;
  const maxRiskPercent = typeof settings?.maxRiskPerTrade === 'number' ? settings.maxRiskPerTrade : 30.0;
  const effectiveRiskPercent = Math.min(riskPercent, maxRiskPercent);
  const liveRiskAmount = Number(((effectiveCapital * effectiveRiskPercent) / 100).toFixed(2));
  const maxAllowedRiskAmount = Number(((effectiveCapital * maxRiskPercent) / 100).toFixed(2));

  // Position Sizing: 40 points SL typical benchmark ($4.00 move in gold)
  const standardPointRisk = (settings?.contractSizeOz ?? 100) * 0.1 * 40; // 400
  const typicalLot = standardPointRisk > 0 ? liveRiskAmount / standardPointRisk : 0;
  const minLotLossAt40pts = (settings?.minimumLot ?? 0.01) * standardPointRisk; // $4.00
  const maxLossLimit = typeof settings?.maxLoss === 'number' && settings.maxLoss > 0 ? settings.maxLoss : 5.5;
  const isMinLotExceedingMaxLoss = minLotLossAt40pts > maxLossLimit + 0.0001;
  const isMinLotExceedingRiskBudget = liveRiskAmount > 0 && minLotLossAt40pts > liveRiskAmount;

  return (
    <div className="space-y-4 sm:space-y-6 animate-in fade-in duration-250">
      {/* ================================================== */}
      {/* 0. RISK & CAPITAL LIVE STRIP (5 Metrics)          */}
      {/* ================================================== */}
      <section className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-3.5 sm:p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 mb-3 border-b border-stone-800/80">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-amber-400" />
            <h3 className="text-xs sm:text-sm font-black text-stone-100 uppercase tracking-wider font-mono">
              إدارة رأس المال والمخاطرة (Risk & Sizing Engine)
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] sm:text-xs font-mono font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
              SOURCE: {settings?.capitalSource || 'MANUAL'}
            </span>
            {onNavigate && (
              <button
                type="button"
                onClick={() => onNavigate('settings')}
                className="text-[11px] text-amber-400 hover:text-amber-300 font-mono underline cursor-pointer"
              >
                تعديل الإعدادات
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 sm:gap-3 font-mono">
          {/* 1. RISK PER TRADE */}
          <div className="bg-stone-950/80 border border-amber-500/40 rounded-xl p-2.5 sm:p-3">
            <div className="flex items-center justify-between text-stone-400 text-[10px] sm:text-xs mb-0.5">
              <span>RISK PER TRADE</span>
              <Percent className="w-3.5 h-3.5 text-amber-400" />
            </div>
            <span className="text-lg sm:text-xl font-black text-amber-400 block">
              {effectiveRiskPercent.toFixed(1)}%
            </span>
            <span className="text-[9px] text-stone-400 block mt-0.5">نسبة المخاطرة المعتمدة</span>
          </div>

          {/* 2. ACTIVE CAPITAL */}
          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-2.5 sm:p-3">
            <div className="flex items-center justify-between text-stone-400 text-[10px] sm:text-xs mb-0.5">
              <span>ACTIVE CAPITAL</span>
              <DollarSign className="w-3.5 h-3.5 text-stone-400" />
            </div>
            <span className="text-lg sm:text-xl font-black text-stone-100 block">
              ${effectiveCapital.toFixed(2)}
            </span>
            <span className="text-[9px] text-stone-400 block mt-0.5">
              {settings?.capitalSource === 'MT5' ? 'MT5 Feed Balance' : 'Manual Capital'}
            </span>
          </div>

          {/* 3. RISK AMOUNT */}
          <div className="bg-stone-950/80 border border-amber-950/80 rounded-xl p-2.5 sm:p-3">
            <div className="flex items-center justify-between text-amber-400 text-[10px] sm:text-xs mb-0.5">
              <span>RISK AMOUNT</span>
              <DollarSign className="w-3.5 h-3.5 text-amber-400" />
            </div>
            <span className="text-lg sm:text-xl font-black text-amber-400 block">
              ${liveRiskAmount.toFixed(2)}
            </span>
            <span className="text-[9px] text-stone-400 block mt-0.5">{effectiveRiskPercent}% ميزانية المخاطرة</span>
          </div>

          {/* 4. MAX LOSS CEILING */}
          <div className="bg-stone-950/80 border border-rose-950/80 rounded-xl p-2.5 sm:p-3">
            <div className="flex items-center justify-between text-rose-400 text-[10px] sm:text-xs mb-0.5">
              <span>MAX LOSS CEILING</span>
              <Lock className="w-3.5 h-3.5 text-rose-400" />
            </div>
            <span className="text-lg sm:text-xl font-black text-rose-300 block">
              ${maxLossLimit.toFixed(2)}
            </span>
            <span className="text-[9px] text-stone-400 block mt-0.5">سقف الخسارة الصارم</span>
          </div>

          {/* 5. POSITION SIZE */}
          <div className="bg-stone-950/80 border border-cyan-950/80 rounded-xl p-2.5 sm:p-3 col-span-2 sm:col-span-1">
            <div className="flex items-center justify-between text-cyan-400 text-[10px] sm:text-xs mb-0.5">
              <span>ESTIMATED LOT</span>
              <Scale className="w-3.5 h-3.5 text-cyan-400" />
            </div>
            <span className="text-lg sm:text-xl font-black text-cyan-300 block">
              {typicalLot > 0 ? typicalLot.toFixed(4) : '0.0100'}
            </span>
            <span className="text-[9px] text-stone-400 block mt-0.5">Standard Lot (40 pts SL)</span>
          </div>
        </div>

        {/* Protection Warning if min lot exceeds max loss or risk */}
        {isMinLotExceedingMaxLoss ? (
          <div className="mt-2.5 p-2.5 bg-rose-950/60 border border-rose-800/80 rounded-xl text-rose-300 text-xs font-mono flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
            <span>
              حظر الصفقات: خسارة أقل لوت ({settings?.minimumLot || 0.01}) عند وقف 40 نقطة (${minLotLossAt40pts.toFixed(2)}) تتجاوز سقف الخسارة النقدي (${maxLossLimit.toFixed(2)}).
            </span>
          </div>
        ) : isMinLotExceedingRiskBudget ? (
          <div className="mt-2.5 p-2.5 bg-amber-950/40 border border-amber-800/60 rounded-xl text-amber-300 text-xs font-mono flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 shrink-0 text-amber-400" />
            <span>
              متاح بنظام Max Loss: خسارة 0.01 لوت (${minLotLossAt40pts.toFixed(2)}) تفوق نسبة الـ {effectiveRiskPercent}% (${liveRiskAmount.toFixed(2)}) ولكنها مقبولة وضمن سقف الخسارة (${maxLossLimit.toFixed(2)}).
            </span>
          </div>
        ) : null}

        {/* MT5 Account Details Strip if MT5 selected */}
        {settings?.capitalSource === 'MT5' && (
          <div className="mt-2.5 pt-2.5 border-t border-stone-800/80 grid grid-cols-3 gap-2 text-xs font-mono">
            <div className="bg-stone-950 p-2 rounded-lg border border-stone-800">
              <span className="text-stone-400 text-[10px] block">MT5 Equity</span>
              <span className="text-stone-100 font-bold">
                {mt5Account?.connected && typeof mt5Account.equity === 'number'
                  ? `$${mt5Account.equity.toFixed(2)}`
                  : '—'}
              </span>
            </div>
            <div className="bg-stone-950 p-2 rounded-lg border border-stone-800">
              <span className="text-stone-400 text-[10px] block">Free Margin</span>
              <span className="text-stone-100 font-bold">
                {mt5Account?.connected && typeof mt5Account.freeMargin === 'number'
                  ? `$${mt5Account.freeMargin.toFixed(2)}`
                  : '—'}
              </span>
            </div>
            <div className="bg-stone-950 p-2 rounded-lg border border-stone-800">
              <span className="text-stone-400 text-[10px] block">MT5 Status</span>
              <span className={mt5Account?.connected ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                {mt5Account?.connected ? 'CONNECTED' : 'DISCONNECTED'}
              </span>
            </div>
          </div>
        )}
      </section>

      {/* ================================================== */}
      {/* 0.5. PHASE 5B: USER TRADE TRACKING & SIGNAL ANALYTICS */}
      {/* ================================================== */}
      <section className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-3.5 sm:p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 mb-3 border-b border-stone-800/80">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-cyan-400" />
            <h3 className="text-xs sm:text-sm font-black text-stone-100 uppercase tracking-wider font-mono">
              تتبع صفقات المستخدم وإحصائيات الإشارات (User Trade Tracking & Signals)
            </h3>
          </div>
          <span className="text-[10px] sm:text-xs font-mono font-bold px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
            SEPARATE ANALYTICS
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 sm:gap-3 font-mono">
          {/* 1. SIGNALS GENERATED */}
          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-2.5 sm:p-3">
            <span className="text-[10px] text-stone-400 uppercase block">إشارات مولدة</span>
            <span className="text-base sm:text-lg font-black text-stone-100 block mt-0.5">
              {stats?.signalsGenerated ?? stats?.totalSignals ?? 0}
            </span>
            <span className="text-[9px] text-stone-400 block mt-0.5">إجمالي الإشارات</span>
          </div>

          {/* 2. SIGNALS NOT ENTERED */}
          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-2.5 sm:p-3">
            <span className="text-[10px] text-stone-400 uppercase block">لم يتم الدخول</span>
            <span className="text-base sm:text-lg font-black text-stone-400 block mt-0.5">
              {stats?.signalsNotEntered ?? 0}
            </span>
            <span className="text-[9px] text-stone-400 block mt-0.5">تجاهلها المستخدم</span>
          </div>

          {/* 3. USER TRADES ENTERED */}
          <div className="bg-stone-950/80 border border-cyan-500/40 rounded-xl p-2.5 sm:p-3">
            <span className="text-[10px] text-cyan-400 uppercase block">صفقات مؤكدة</span>
            <span className="text-base sm:text-lg font-black text-cyan-300 block mt-0.5">
              {stats?.userTradesEntered ?? 0}
            </span>
            <span className="text-[9px] text-stone-400 block mt-0.5">
              فوز: {stats?.userTradesWon ?? 0} | خسارة: {stats?.userTradesLost ?? 0}
            </span>
          </div>

          {/* 4. USER REALIZED P/L */}
          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-2.5 sm:p-3">
            <span className="text-[10px] text-stone-400 uppercase block">أرباح المستخدم الفعلية</span>
            <span className={`text-base sm:text-lg font-black block mt-0.5 ${
              (stats?.userTradesPl ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}>
              {(stats?.userTradesPl ?? 0) >= 0 ? `+$${(stats?.userTradesPl ?? 0).toFixed(2)}` : `-$${Math.abs(stats?.userTradesPl ?? 0).toFixed(2)}`}
            </span>
            <span className="text-[9px] text-stone-400 block mt-0.5">P&L معتمد يدوياً</span>
          </div>

          {/* 5. MT5 AUTOMATED TRADES */}
          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-2.5 sm:p-3 col-span-2 sm:col-span-1">
            <span className="text-[10px] text-stone-400 uppercase block">صفقات MT5 الآلية</span>
            <span className="text-base sm:text-lg font-black text-amber-300 block mt-0.5">
              {stats?.mt5TradesExecuted ?? 0}
            </span>
            <span className="text-[9px] text-stone-400 block mt-0.5">
              P&L: {(stats?.mt5TradesPl ?? 0) >= 0 ? `+$${(stats?.mt5TradesPl ?? 0).toFixed(2)}` : `-$${Math.abs(stats?.mt5TradesPl ?? 0).toFixed(2)}`}
            </span>
          </div>
        </div>
      </section>

      {/* ================================================== */}
      {/* 1. SYSTEM STATUS (Top Strip)                       */}
      {/* ================================================== */}
      <section className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-3 sm:p-4 shadow-xs">
        <div className="flex items-center justify-between mb-3 border-b border-stone-800/80 pb-2">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-amber-400" />
            <h3 className="text-xs sm:text-sm font-black text-stone-100 uppercase tracking-wider font-mono">
              System Status Overview
            </h3>
          </div>
          <span className="text-[11px] text-stone-400 font-mono">
            {new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3">
          {/* Scanner */}
          <div className="bg-stone-950/70 border border-stone-800/80 rounded-xl p-2.5">
            <div className="flex items-center justify-between text-[11px] text-stone-400 mb-1">
              <span>المسح الآلي</span>
              <Radio className="w-3.5 h-3.5 text-amber-400" />
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  scannerConfig.enabled ? 'bg-emerald-400 animate-pulse' : 'bg-stone-600'
                }`}
              />
              <span
                className={`text-xs font-mono font-bold ${
                  scannerConfig.enabled ? 'text-emerald-400' : 'text-stone-400'
                }`}
              >
                {scannerConfig.enabled ? 'ONLINE' : 'OFFLINE'}
              </span>
            </div>
            <span className="text-[10px] text-stone-400 block mt-0.5 font-mono">كل 60 ثانية</span>
          </div>

          {/* Market Data */}
          <div className="bg-stone-950/70 border border-stone-800/80 rounded-xl p-2.5">
            <div className="flex items-center justify-between text-[11px] text-stone-400 mb-1">
              <span>بيانات السوق</span>
              <TrendingUp className="w-3.5 h-3.5 text-cyan-400" />
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  isLiveConnected ? 'bg-emerald-400' : 'bg-amber-400 animate-ping'
                }`}
              />
              <span
                className={`text-xs font-mono font-bold ${
                  isLiveConnected ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {isLiveConnected ? 'ONLINE' : 'RECONNECTING'}
              </span>
            </div>
            <span className="text-[10px] text-stone-400 block mt-0.5 font-mono">Biquote MT5</span>
          </div>

          {/* AI Engine */}
          <div className="bg-stone-950/70 border border-stone-800/80 rounded-xl p-2.5">
            <div className="flex items-center justify-between text-[11px] text-stone-400 mb-1">
              <span>الذكاء الاصطناعي</span>
              <Cpu className="w-3.5 h-3.5 text-purple-400" />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span className="text-xs font-mono font-bold text-emerald-400">
                {hasGeminiKey ? 'ONLINE' : 'ACTIVE (RULES)'}
              </span>
            </div>
            <span className="text-[10px] text-stone-400 block mt-0.5 font-mono">NVIDIA DeepSeek V4 Pro</span>
          </div>

          {/* Execution Mode */}
          <div className="bg-stone-950/70 border border-cyan-800/60 rounded-xl p-2.5">
            <div className="flex items-center justify-between text-[11px] text-cyan-400 mb-1">
              <span>وضع التنفيذ</span>
              <Shield className="w-3.5 h-3.5 text-cyan-400" />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
              <span className="text-xs font-mono font-black text-cyan-300">DEMO ONLY</span>
            </div>
            <span className="text-[10px] text-cyan-400/70 block mt-0.5 font-mono">حماية 100%</span>
          </div>

          {/* Last Scan */}
          <div className="bg-stone-950/70 border border-stone-800/80 rounded-xl p-2.5">
            <div className="flex items-center justify-between text-[11px] text-stone-400 mb-1">
              <span>آخر فحص</span>
              <Clock className="w-3.5 h-3.5 text-stone-400" />
            </div>
            <span className="text-xs font-mono font-bold text-stone-200 block">
              {scannerConfig.lastScanTime
                ? new Date(scannerConfig.lastScanTime).toLocaleTimeString('ar-EG', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })
                : 'جاري البدء'}
            </span>
            <span className="text-[10px] text-stone-400 block mt-0.5 font-mono">
              إجمالي: {scannerConfig.scanCount || 0}
            </span>
          </div>

          {/* Uptime */}
          <div className="bg-stone-950/70 border border-stone-800/80 rounded-xl p-2.5">
            <div className="flex items-center justify-between text-[11px] text-stone-400 mb-1">
              <span>مدة التشغيل</span>
              <Layers className="w-3.5 h-3.5 text-stone-400" />
            </div>
            <span className="text-xs font-mono font-bold text-stone-200 block">
              {workerUptimeFormatted}
            </span>
            <span className="text-[10px] text-emerald-400/80 block mt-0.5 font-mono">
              24/7 Autonomous
            </span>
          </div>
        </div>
      </section>

      {/* ================================================== */}
      {/* 1.5. BACKTEST ENGINE QUICK ACCESS BANNER          */}
      {/* ================================================== */}
      {onNavigate && (
        <section className="bg-gradient-to-r from-purple-950/40 via-stone-900/90 to-stone-900/90 border border-purple-800/40 rounded-2xl p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-300 shrink-0">
              <History className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-xs sm:text-sm font-bold text-stone-100">محرك الاختبار التاريخي (Backtest Engine)</h4>
                <span className="text-[9px] px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 font-mono font-bold">
                  REAL BIQUOTE DATA
                </span>
              </div>
              <p className="text-[11px] text-stone-400 mt-0.5">
                اختبار دقيق للاستراتيجية (1H Bias + 15M Setup + 5M Entry) بدون Lookahead Bias وإدارة مخاطر 15%.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('backtest')}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-stone-100 text-xs font-bold transition-all shadow-md shrink-0 cursor-pointer"
          >
            <History className="w-3.5 h-3.5" />
            <span>تشغيل الاختبار التاريخي</span>
          </button>
        </section>
      )}

      {/* ================================================== */}
      {/* 2. MARKET SECTION (XAUUSD Multi-Timeframe)         */}
      {/* ================================================== */}
      <section className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center text-amber-400 font-mono font-black text-sm">
              AU
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-black text-stone-100 font-mono">XAU/USD (Gold)</h3>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-stone-800 text-stone-300 font-mono font-bold">
                  Biquote MT5
                </span>
              </div>
              <p className="text-[11px] text-stone-400">تحليل الهيكل السعري والسيولة متعدد الأطر الزمنية</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-left font-mono">
              <span className="text-[10px] text-stone-400 block uppercase">السعر المباشر</span>
              <span className="text-xl sm:text-2xl font-black text-amber-400">
                ${displayPrice.toFixed(2)}
              </span>
            </div>
          </div>
        </div>

        {/* Multi-Timeframe Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {/* 1H Trend */}
          <div className="bg-stone-950/80 border border-stone-800/90 rounded-xl p-3">
            <div className="flex items-center justify-between text-[11px] text-stone-400 mb-1">
              <span className="font-mono font-bold">1H Trend</span>
              {h1Trend === 'BULLISH' ? (
                <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
              ) : h1Trend === 'BEARISH' ? (
                <TrendingDown className="w-3.5 h-3.5 text-rose-400" />
              ) : (
                <ArrowRightLeft className="w-3.5 h-3.5 text-amber-400" />
              )}
            </div>
            <span
              className={`text-xs sm:text-sm font-mono font-black ${
                h1Trend === 'BULLISH'
                  ? 'text-emerald-400'
                  : h1Trend === 'BEARISH'
                  ? 'text-rose-400'
                  : 'text-amber-400'
              }`}
            >
              {h1Trend}
            </span>
            <span className="text-[10px] text-stone-400 block mt-1">الاتجاه العام للإطار الأكبر</span>
          </div>

          {/* 15M Structure */}
          <div className="bg-stone-950/80 border border-stone-800/90 rounded-xl p-3">
            <div className="flex items-center justify-between text-[11px] text-stone-400 mb-1">
              <span className="font-mono font-bold">15M Structure</span>
              <Layers className="w-3.5 h-3.5 text-indigo-400" />
            </div>
            <span className="text-xs sm:text-sm font-mono font-black text-stone-200">
              {m15Structure}
            </span>
            <span className="text-[10px] text-stone-400 block mt-1">منطقة التسعير والكتل</span>
          </div>

          {/* 5M Structure */}
          <div className="bg-stone-950/80 border border-stone-800/90 rounded-xl p-3">
            <div className="flex items-center justify-between text-[11px] text-stone-400 mb-1">
              <span className="font-mono font-bold">5M Volatility</span>
              <Activity className="w-3.5 h-3.5 text-amber-400" />
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-xs sm:text-sm font-mono font-black text-amber-400">
                ATR {displayAtr.toFixed(2)}
              </span>
            </div>
            <span className="text-[10px] text-stone-400 block mt-1">متوسط حركة الشمعة</span>
          </div>

          {/* Market Regime */}
          <div className="bg-stone-950/80 border border-stone-800/90 rounded-xl p-3">
            <div className="flex items-center justify-between text-[11px] text-stone-400 mb-1">
              <span className="font-mono font-bold">Regime (البيئة)</span>
              <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span
                className={`text-[11px] sm:text-xs font-mono font-black ${
                  resolvedRegime.includes('UPTREND')
                    ? 'text-emerald-400'
                    : resolvedRegime.includes('DOWNTREND')
                    ? 'text-rose-400'
                    : resolvedRegime.includes('RANGE')
                    ? 'text-amber-400'
                    : 'text-stone-300'
                }`}
              >
                {resolvedRegime}
              </span>
              {isPriceOverextended && (
                <span className="text-[8px] font-bold px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  EXTENDED
                </span>
              )}
            </div>
            <span className="text-[10px] text-stone-400 block mt-1">
              {resolvedRegime.includes('STRONG')
                ? 'زخم قوي للترند'
                : resolvedRegime.includes('WEAK')
                ? 'ترند ضعيف / تصحيحي'
                : resolvedRegime.includes('RANGE')
                ? 'نطاق تداول عرضي'
                : resolvedRegime.includes('TRANSITION')
                ? 'تحول هيكلي محتمل'
                : 'حالة السوق الحالية'}
            </span>
          </div>
        </div>

        {/* Mini Candlestick visualizer */}
        <div className="mt-4 pt-3 border-t border-stone-800/80">
          <MiniChart candles={candles} signal={signal} currentPrice={currentPrice} />
        </div>
      </section>

      {/* ================================================== */}
      {/* 3. CURRENT SIGNAL (3-Second Rule UX)               */}
      {/* ================================================== */}
      <section className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4 pb-2 border-b border-stone-800/80">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" />
            <h3 className="text-sm font-bold text-stone-100 uppercase tracking-wide">
              إشارة التداول الحالية (Current Signal)
            </h3>
          </div>
          <span className="text-[11px] font-mono text-stone-400">
            {hasActiveSignal ? 'إشارة معتمدة' : 'في انتظار اكتمال الشروط'}
          </span>
        </div>

        {!hasActiveSignal || !activeSignal ? (
          /* NO ACTIVE SIGNAL STATE */
          <div className="bg-stone-950/80 border border-dashed border-stone-800 rounded-2xl p-6 sm:p-8 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-stone-900 border border-stone-700/60 mx-auto flex items-center justify-center text-stone-400">
              <Shield className="w-6 h-6" />
            </div>
            <div>
              <h4 className="text-base font-black text-stone-200 tracking-wide font-mono">
                NO ACTIVE SIGNAL
              </h4>
              <p className="text-xs sm:text-sm text-stone-400 max-w-md mx-auto mt-1 leading-relaxed">
                {activeSignal?.noTradeReason ||
                  `الماسح يراقب حركة XAU/USD بشكل مستمر كل 60 ثانية. يلتزم النظام بعدم إجبار أي صفقة (No Forced Trades) حتى يتحقق نموذج واضح يوفر على الأقل ${settings.minTp1RR || 1.5}R بعيداً عن حواجز الهيكل المعاكس.`}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2 pt-2 text-[11px] font-mono text-stone-400">
              <span className="px-2.5 py-1 rounded-lg bg-stone-900 border border-stone-800">
                الفحص القادم: {scannerConfig.nextScanTime ? `${Math.max(0, Math.round((scannerConfig.nextScanTime - Date.now()) / 1000))}s` : 'خلال ثوانٍ'}
              </span>
              <span className="px-2.5 py-1 rounded-lg bg-stone-900 border border-stone-800">
                أقصى وقف: 100 نقطة ($10)
              </span>
              <span className="px-2.5 py-1 rounded-lg bg-stone-900 border border-stone-800">
                الهدف الأدنى: {settings.minTp1RR || 1.5}R
              </span>
            </div>

            <div className="pt-2">
              <button
                onClick={handleScan}
                disabled={isAnalyzing}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-bold transition-all"
              >
                <Play className="w-3.5 h-3.5 text-amber-400" />
                <span>إجراء فحص فوري الآن</span>
              </button>
            </div>
          </div>
        ) : (
          /* ACTIVE QUALIFIED TRADE SIGNAL CARD */
          <div className="space-y-4">
            {/* Header / Direction / Confidence */}
            <div
              className={`p-4 rounded-2xl border flex flex-wrap items-center justify-between gap-3 ${
                (activeSignal.signal || '').includes('BUY')
                  ? 'bg-emerald-950/40 border-emerald-500/50'
                  : 'bg-rose-950/40 border-rose-500/50'
              }`}
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-12 h-12 rounded-xl flex items-center justify-center text-xl font-black ${
                    (activeSignal.signal || '').includes('BUY')
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                  }`}
                >
                  {(activeSignal.signal || '').includes('BUY') ? <TrendingUp className="w-6 h-6" /> : <TrendingDown className="w-6 h-6" />}
                </div>

                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-bold text-stone-300">XAU/USD</span>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-stone-900/80 text-stone-300 font-mono font-bold border border-stone-700">
                      {activeSignal.setup || 'Breakout & Liquidity Sweep'}
                    </span>
                  </div>
                  <h3
                    className={`text-xl sm:text-2xl font-black tracking-tight font-mono mt-0.5 ${
                      (activeSignal.signal || '').includes('BUY') ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {activeSignal.signal}
                  </h3>
                </div>
              </div>

              {/* Confidence & Status */}
              <div className="text-left">
                <div className="text-[11px] text-stone-400 font-mono">CONFIDENCE</div>
                <div className="text-xl font-black font-mono text-amber-400">
                  {activeSignal.confidence ?? 80}%
                </div>
                <span className="inline-block text-[10px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold font-mono mt-0.5">
                  STATUS: {isSignalLogged ? 'EXECUTED (DEMO)' : 'READY'}
                </span>
              </div>
            </div>

            {/* Core Metrics Grid (3-Second Rule: Entry, SL, TP1, TP2, RR, Risk, Lot) */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 font-mono">
              {/* Entry */}
              <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-3">
                <span className="text-[10px] text-stone-400 block uppercase">سعر الدخول (Entry)</span>
                <span className="text-base sm:text-lg font-black text-stone-100">
                  ${(Number(activeSignal.entry) || displayPrice).toFixed(2)}
                </span>
                <span className="text-[10px] text-stone-400 block mt-0.5">سعر السوق المباشر</span>
              </div>

              {/* Stop Loss */}
              <div className="bg-stone-950/80 border border-rose-950/60 rounded-xl p-3">
                <span className="text-[10px] text-rose-400 block uppercase">وقف الخسارة (Stop Loss)</span>
                <span className="text-base sm:text-lg font-black text-rose-400">
                  ${(Number(activeSignal.stopLoss) || 0).toFixed(2)}
                </span>
                <span className="text-[10px] text-stone-400 block mt-0.5">
                  {(Number(activeSignal.slPoints) || 0).toFixed(1)} نقطة (≤ 100p)
                </span>
              </div>

              {/* TP1 */}
              <div className="bg-stone-950/80 border border-emerald-950/60 rounded-xl p-3">
                <span className="text-[10px] text-emerald-400 block uppercase">الهدف الأول TP1</span>
                <span className="text-base sm:text-lg font-black text-emerald-400">
                  ${(Number(activeSignal.tp1) || 0).toFixed(2)}
                </span>
                <span className="text-[10px] text-stone-400 block mt-0.5">
                  {activeSignal.tp1RrString || (activeSignal.tp1Rr ? `1:${Number(activeSignal.tp1Rr).toFixed(2)}` : 'N/A')} • {(Number(activeSignal.tp1Points) || 0).toFixed(1)} نقطة
                </span>
              </div>

              {/* TP2 */}
              <div className="bg-stone-950/80 border border-emerald-950/60 rounded-xl p-3">
                <span className="text-[10px] text-emerald-300 block uppercase">الهدف الثاني TP2</span>
                <span className="text-base sm:text-lg font-black text-emerald-300">
                  {activeSignal.tp2 && Number(activeSignal.tp2) > 0 ? `$${Number(activeSignal.tp2).toFixed(2)}` : 'N/A'}
                </span>
                <span className="text-[10px] text-stone-400 block mt-0.5">
                  {activeSignal.tp2 && Number(activeSignal.tp2) > 0 ? (activeSignal.tp2RrString || (activeSignal.tp2Rr ? `1:${Number(activeSignal.tp2Rr).toFixed(2)}` : 'N/A')) : 'N/A'} • {(Number(activeSignal.tp2Points) || 0).toFixed(1)} نقطة
                </span>
              </div>
            </div>

            {/* Risk & Position Sizing Strip */}
            <div className="bg-stone-950/90 border border-stone-800 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
              <div className="flex items-center gap-4">
                <div>
                  <span className="text-stone-400 text-[11px] block">المخاطرة:</span>
                  <span className="text-amber-400 font-bold">
                    {activeSignal.riskPercent ?? 15}% (${(Number(activeSignal.riskAmount) || 0).toFixed(2)})
                  </span>
                </div>
                <div className="border-r border-stone-800 pr-4">
                  <span className="text-stone-400 text-[11px] block">حجم اللوت المقترح:</span>
                  <span className="text-stone-100 font-bold">
                    {activeSignal.recommendedLotSize ?? 0.01} Standard Lot
                  </span>
                </div>
                <div className="hidden sm:block border-r border-stone-800 pr-4">
                  <span className="text-stone-400 text-[11px] block">توقيت الإشارة:</span>
                  <span className="text-stone-300">
                    {activeSignal.timestamp
                      ? new Date(activeSignal.timestamp).toLocaleTimeString('ar-EG', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : '---'}
                  </span>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowFullAnalysis(!showFullAnalysis)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-bold transition-colors"
                >
                  <span>{showFullAnalysis ? 'إخفاء التحليل' : 'عرض التحليل الكامل'}</span>
                  {showFullAnalysis ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>

                <button
                  onClick={() => onExecuteDemo && activeSignal && onExecuteDemo(activeSignal)}
                  disabled={isSignalLogged}
                  className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-black transition-all ${
                    isSignalLogged
                      ? 'bg-stone-800 text-stone-500 cursor-not-allowed'
                      : settings?.accountMode === 'REAL'
                      ? 'bg-rose-600 hover:bg-rose-500 text-white active:scale-95 shadow-md shadow-rose-950'
                      : 'bg-cyan-500 hover:bg-cyan-400 text-stone-950 active:scale-95'
                  }`}
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>
                    {isSignalLogged
                      ? 'تم التنفيذ'
                      : settings?.accountMode === 'REAL'
                      ? 'EXECUTE REAL (MT5)'
                      : 'EXECUTE DEMO'}
                  </span>
                </button>
              </div>
            </div>

            {/* Brief Rationale */}
            {activeSignal.mainReasons && activeSignal.mainReasons.length > 0 && (
              <div className="bg-stone-950/60 border border-stone-800/80 rounded-xl p-3 text-xs text-stone-300 space-y-1">
                <span className="text-[11px] text-amber-400 font-bold block mb-1">
                  الأسباب الفنية الرئيسية:
                </span>
                <ul className="list-disc list-inside space-y-0.5 text-stone-300 font-sans">
                  {activeSignal.mainReasons.slice(0, 3).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Expandable Full Analysis Accordion */}
            {showFullAnalysis && (
              <div className="bg-stone-950 border border-amber-500/30 rounded-xl p-4 space-y-3 animate-in fade-in duration-200 text-xs">
                <div className="flex items-center justify-between border-b border-stone-800 pb-2">
                  <span className="font-bold text-amber-400 font-mono flex items-center gap-1.5">
                    <Info className="w-4 h-4" />
                    التحليل الهيكلي الشامل (NVIDIA DeepSeek V4 Pro + Market Structure)
                  </span>
                  <span className="text-[10px] text-stone-400 font-mono">
                    Invalidation: ${(Number(activeSignal.stopLoss) || 0).toFixed(2)}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="bg-stone-900/60 p-3 rounded-lg border border-stone-800">
                    <span className="text-[11px] text-stone-400 font-bold block mb-1">
                      منطقة الإبطال الفني (Invalidation Zone):
                    </span>
                    <p className="text-stone-300 leading-relaxed">
                      {activeSignal.invalidation ||
                        `تعتبر الصفقة ملغية تماماً في حال إغلاق شمعة 5 دقائق بعد مستوى $${(Number(activeSignal.stopLoss) || 0).toFixed(
                          2
                        )}، حيث ينهار هيكل الكسر وتفقد السيولة الموجهة زخمها.`}
                    </p>
                  </div>

                  <div className="bg-stone-900/60 p-3 rounded-lg border border-stone-800">
                    <span className="text-[11px] text-stone-400 font-bold block mb-1">
                      هدف السيولة والمضاعف (RR Logic):
                    </span>
                    <p className="text-stone-300 leading-relaxed">
                      الهدف الأول يمثل حجز ربح عند {activeSignal.tp1RrString || (activeSignal.tp1Rr ? `1:${Number(activeSignal.tp1Rr).toFixed(2)}` : 'N/A')} لتأمين رأس المال ونقل الوقف إلى الدخول (Breakeven)، بينما يستهدف الهدف الثاني {activeSignal.tp2 && Number(activeSignal.tp2) > 0 ? (activeSignal.tp2RrString || (activeSignal.tp2Rr ? `1:${Number(activeSignal.tp2Rr).toFixed(2)}` : 'N/A')) : 'N/A'} قاع/قمة السيولة المقابلة.
                    </p>
                  </div>
                </div>

                {activeSignal.aiAnalysisText && (
                  <div className="bg-stone-900/40 p-3 rounded-lg border border-stone-800/80 font-mono text-[11px] text-stone-300 leading-relaxed whitespace-pre-wrap">
                    {activeSignal.aiAnalysisText}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
};
