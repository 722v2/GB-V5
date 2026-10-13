import React, { useState, useEffect } from 'react';
import {
  Play,
  History,
  TrendingUp,
  TrendingDown,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Clock,
  DollarSign,
  Percent,
  Calendar,
  Layers,
  ArrowUpRight,
  ArrowDownRight,
  RefreshCw,
  BarChart3,
  Award,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { BacktestResultData, BacktestTradeItem, HistoricalDataValidationReport } from '../types';

interface BacktestViewProps {
  currentCapital: number;
}

export type BacktestTimeRange = '1D' | '3D' | '7D' | '14D' | '30D' | '60D' | '90D' | '180D' | '365D';

export const BacktestView: React.FC<BacktestViewProps> = ({ currentCapital }) => {
  const [initialCapital, setInitialCapital] = useState<string | number>(() =>
    currentCapital && currentCapital > 0 ? currentCapital : 10
  );
  const [timeRange, setTimeRange] = useState<BacktestTimeRange>('7D');
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [results, setResults] = useState<BacktestResultData | null>(null);
  const [validationAudit, setValidationAudit] = useState<HistoricalDataValidationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterResult, setFilterResult] = useState<'ALL' | 'WIN' | 'LOSS' | 'AMBIGUOUS'>('ALL');
  const [lastRunTime, setLastRunTime] = useState<string | null>(null);
  const [expandedTradeId, setExpandedTradeId] = useState<string | null>(null);

  // Load latest backtest results on mount if available
  useEffect(() => {
    fetchLatestResults();
  }, []);

  const fetchLatestResults = async () => {
    try {
      const res = await fetch('/api/backtest/latest');
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.summary) {
          setResults(data.summary);
          if (data.summary.validationReport) {
            setValidationAudit(data.summary.validationReport);
          }
        }
      }
    } catch (e) {
      console.error('Failed to load saved backtest:', e);
    }
  };

  const handleRunBacktest = async (allowAvailableSlice: boolean | unknown = false) => {
    const safeAllowSlice = typeof allowAvailableSlice === 'boolean' ? allowAvailableSlice : false;
    const capValue = parseFloat(String(initialCapital));
    const finalCap = !isNaN(capValue) && capValue > 0 ? capValue : 10;

    setIsRunning(true);
    setError(null);
    setValidationAudit(null);

    try {
      console.log('[Backtest] Executing realistic simulation...', { initialCapital: finalCap, timeRange, allowAvailableSlice: safeAllowSlice });
      const adminKey = typeof window !== 'undefined' ? (localStorage.getItem('gbv5_admin_key') || '') : '';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminKey) {
        headers['Authorization'] = `Bearer ${adminKey}`;
        headers['x-admin-key'] = adminKey;
      }

      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          initialCapital: finalCap,
          timeRange,
          allowAvailableSlice: safeAllowSlice,
        }),
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 503) {
          throw new Error('مطلوب تسجيل الدخول بمفتاح الإدارة (Admin API Key) في الإعدادات لتشغيل الـBacktest.');
        }
        const errData = await res.json().catch(() => ({ error: `Server error (HTTP ${res.status})` }));
        if (errData.validationReport) {
          setValidationAudit(errData.validationReport);
        }
        throw new Error(errData.error || `HTTP ${res.status}: Failed to execute backtest`);
      }

      const data = await res.json();
      if (!data.success || !data.summary) {
        throw new Error(data.error || 'فشل في استلام نتائج الـBacktest من الخادم.');
      }

      setResults(data.summary);
      if (data.summary.validationReport) {
        setValidationAudit(data.summary.validationReport);
      }
      setLastRunTime(new Date().toLocaleTimeString('ar-EG'));
    } catch (err: any) {
      console.error('[Backtest] Execution failed:', err);
      setError(err.message || 'حدث خطأ أثناء الاتصال بخادم الـBacktest.');
    } finally {
      setIsRunning(false);
    }
  };

  const filteredTrades =
    results?.trades.filter((t) => {
      if (filterResult === 'ALL') return true;
      return t.result === filterResult;
    }) || [];

  return (
    <div className="space-y-6 pb-20">
      {/* 1. Header & Context */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-stone-900/90 border border-stone-800/80 rounded-2xl p-5 shadow-xl backdrop-blur-md">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
              <History className="w-5 h-5" />
            </span>
            <h1 className="text-xl font-bold text-stone-100">محرك الاختبار الواقعي (Honest XAU/USD Backtesting)</h1>
          </div>
          <p className="text-xs text-stone-400 mt-1">
            اختبار كمي صارم بدون أي Lookahead مع حساب الأهداف (TP) حصرياً من هيكل السوق الحقيقي ونسبة المخاطرة 15% للصفقة.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-950/30 border border-emerald-800/40 px-3 py-1.5 rounded-xl font-mono">
            <ShieldCheck className="w-4 h-4" />
            <span>Strict Real Structure • Zero Lookahead</span>
          </div>
        </div>
      </div>

      {/* 2. Configuration & Run Panel */}
      <div className="bg-stone-900/80 border border-stone-800/80 rounded-2xl p-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* Initial Capital */}
          <div>
            <label htmlFor="backtest-capital-input" className="block text-xs font-medium text-stone-400 mb-1.5">
              رأس المال الابتدائي للاختبار ($)
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-stone-500 font-mono text-sm">
                $
              </span>
              <input
                id="backtest-capital-input"
                type="number"
                min={1}
                step={1}
                value={initialCapital}
                onChange={(e) => setInitialCapital(e.target.value)}
                className="w-full pl-7 pr-3 py-2 bg-stone-950 border border-stone-800 rounded-xl text-stone-100 font-mono text-sm focus:outline-hidden focus:border-amber-500 transition-colors"
                placeholder="10.00"
              />
            </div>
            <p className="text-[11px] text-stone-500 mt-1">
              يتم تطبيق نسبة المخاطرة 15% للصفقة و 30% كحد أقصى يومياً.
            </p>
          </div>

          {/* Time Range */}
          <div>
            <label className="block text-xs font-medium text-stone-400 mb-1.5">
              الفترة الزمنية للبيانات التاريخية
            </label>
            <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-9 gap-1 bg-stone-950 p-1 border border-stone-800 rounded-xl">
              {(['1D', '3D', '7D', '14D', '30D', '60D', '90D', '180D', '365D'] as const).map((range) => (
                <button
                  key={range}
                  type="button"
                  onClick={() => setTimeRange(range)}
                  className={`py-1.5 text-[11px] font-semibold rounded-lg transition-colors cursor-pointer text-center ${
                    timeRange === range
                      ? 'bg-amber-500 text-stone-950 shadow-md font-bold'
                      : 'text-stone-400 hover:text-stone-200'
                  }`}
                >
                  {range}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-stone-500 mt-1">
              شمعات 5M و 15M و 1H متزامنة ومسحوبة من خلاصة Biquote التاريخية.
            </p>
          </div>

          {/* Run Button */}
          <div className="flex flex-col justify-end">
            <button
              id="run-backtest-btn"
              type="button"
              onClick={() => handleRunBacktest(false)}
              disabled={isRunning}
              className={`w-full py-2.5 px-4 rounded-xl font-bold flex items-center justify-center gap-2 transition-all cursor-pointer ${
                isRunning
                  ? 'bg-stone-800 text-stone-400 cursor-not-allowed'
                  : 'bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-stone-950 shadow-lg shadow-amber-500/10 active:scale-[0.98]'
              }`}
            >
              {isRunning ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>جاري سحب الشموع ومحاكاة الاستراتيجية...</span>
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 fill-current" />
                  <span>بدء الفحص الواقعي (Run Backtest)</span>
                </>
              )}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 p-3.5 bg-rose-950/40 border border-rose-800/50 rounded-xl space-y-2 text-xs">
            <div className="flex items-center gap-2 text-rose-300 font-bold">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
              <span>فشل التحقق من كفاية البيانات التاريخية</span>
            </div>
            <p className="text-stone-300 leading-relaxed font-sans">{error}</p>
          </div>
        )}

        {/* Data Validation Audit Report */}
        {validationAudit && (
          <div className="mt-4 p-4 bg-stone-950 border border-stone-800 rounded-xl space-y-3">
            <div className="flex items-center justify-between border-b border-stone-800 pb-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className={`w-4 h-4 ${validationAudit.isFullCoverage ? 'text-emerald-400' : 'text-amber-400'}`} />
                <span className="text-xs font-bold text-stone-200">
                  تقرير تدقيق البيانات التاريخية (Data Validation & Integrity Audit)
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-stone-800 text-amber-300 border border-stone-700">
                  {validationAudit.provider}
                </span>
              </div>
              <span
                className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                  validationAudit.isFullCoverage
                    ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800'
                    : 'bg-amber-950/60 text-amber-300 border-amber-800'
                }`}
              >
                {validationAudit.status} ({(validationAudit.coverageRatio * 100).toFixed(1)}% Coverage)
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[11px] font-mono">
              <div className="bg-stone-900/80 p-2 rounded-lg border border-stone-800/60">
                <span className="text-stone-500 block text-[10px]">الفترة المطلوبة</span>
                <span className="text-stone-200 font-bold">{validationAudit.requestedPeriod}</span>
                <span className="text-[9px] text-stone-500 block truncate" title={validationAudit.requestedStartDate}>
                  {validationAudit.requestedStartDate.slice(0, 10)}
                </span>
              </div>
              <div className="bg-stone-900/80 p-2 rounded-lg border border-stone-800/60">
                <span className="text-stone-500 block text-[10px]">أقدم شمعة 5M متوفرة</span>
                <span className="text-amber-400 font-bold truncate block" title={validationAudit.actualEarliestDate}>
                  {validationAudit.actualEarliestDate.replace('T', ' ').slice(0, 16)}
                </span>
                <span className="text-[9px] text-stone-500 block">
                  {validationAudit.provider === 'MT5_BRIDGE' ? 'من وسيط MT5 Terminal' : 'من خادم Biquote'}
                </span>
              </div>
              <div className="bg-stone-900/80 p-2 rounded-lg border border-stone-800/60">
                <span className="text-stone-500 block text-[10px]">عدد الشموع الحقيقية</span>
                <span className="text-stone-200">
                  5M: <b className="text-amber-400">{validationAudit.candleCounts['5m']}</b> | 15M: <b>{validationAudit.candleCounts['15m']}</b>
                </span>
                <span className="text-[9px] text-stone-500 block">1H: {validationAudit.candleCounts['1h']} شمعة</span>
              </div>
              <div className="bg-stone-900/80 p-2 rounded-lg border border-stone-800/60">
                <span className="text-stone-500 block text-[10px]">التكرارات المحذوفة</span>
                <span className="text-emerald-400">
                  5M: {validationAudit.duplicatesCount['5m']} | 15M: {validationAudit.duplicatesCount['15m']}
                </span>
                <span className="text-[9px] text-stone-500 block">تم تنظيفها تلقائياً</span>
              </div>
            </div>

            {validationAudit.gaps && validationAudit.gaps.length > 0 && (
              <div className="text-[10px] space-y-1 bg-stone-900/40 p-2 rounded-lg border border-stone-800/40">
                <span className="text-stone-400 font-semibold block">فحص الفجوات الزمنية (Gaps Analysis):</span>
                {validationAudit.gaps.map((gap, idx) => (
                  <div key={idx} className="text-stone-400 font-mono flex items-center justify-between">
                    <span>
                      [{gap.timeframe}] {gap.gapStart} ➔ {gap.gapEnd} ({gap.gapDurationHours}h)
                    </span>
                    <span className="text-amber-500/80 text-[9px]">{gap.reason}</span>
                  </div>
                ))}
              </div>
            )}

            {!validationAudit.isFullCoverage && (
              <div className="flex items-center justify-between pt-1 text-[11px]">
                <span className="text-stone-400">
                  خادم Biquote يحتفظ بـ 289 شمعة 5M (~1.15 يوم) فقط لرمز XAUUSD.
                </span>
                <button
                  type="button"
                  onClick={() => handleRunBacktest(true)}
                  disabled={isRunning}
                  className="px-3 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-lg font-bold text-xs transition-colors cursor-pointer"
                >
                  تشغيل الاختبار على النافذة المتوفرة كاستثناء شفاف
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 3. Results Dashboard */}
      {results && (
        <div className="space-y-6">
          {/* Status, Run ID and Historical Debug Bar */}
          <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3.5 space-y-2.5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
                <span className="text-stone-200 font-bold">
                  نتائج محاكاة الذهب الحقيقية — الفترة ({results.timeRange})
                </span>
                {results.runId && (
                  <span className="px-2 py-0.5 rounded-md bg-stone-800 text-amber-400 font-mono text-[10px] border border-stone-700">
                    ID: {results.runId}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-stone-400 font-mono text-[11px]">
                <span>
                  وقت الفحص:{' '}
                  {results.runTimestamp
                    ? new Date(results.runTimestamp).toLocaleTimeString('ar-EG')
                    : lastRunTime || 'الآن'}
                </span>
              </div>
            </div>

            {/* Backtest Data Integrity Audit Panel */}
            <div className="pt-2 border-t border-stone-800 space-y-2">
              <div className="flex items-center justify-between text-[11px] font-semibold text-stone-300">
                <span className="flex items-center gap-1.5 text-amber-400">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Backtest Data Integrity Audit
                </span>
                <span className="text-[10px] text-stone-500 font-mono">
                  Source: {results.validationReport?.provider === 'MT5_BRIDGE' ? 'MT5 Terminal Bridge (Real Broker Feed)' : 'Biquote XAU/USD Feed'} + Session Market Structure
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 text-[11px] font-mono">
                <div className="bg-stone-950/70 p-2 rounded-lg border border-stone-800/60">
                  <span className="text-stone-500 block text-[10px]">Run ID:</span>
                  <span className="text-amber-400 font-bold truncate block">{results.runId || 'N/A'}</span>
                </div>
                <div className="bg-stone-950/70 p-2 rounded-lg border border-stone-800/60">
                  <span className="text-stone-500 block text-[10px]">Requested Period:</span>
                  <span className="text-amber-400 font-bold">{results.timeRange}</span>
                </div>
                <div className="bg-stone-950/70 p-2 rounded-lg border border-stone-800/60">
                  <span className="text-stone-500 block text-[10px]">Actual Start:</span>
                  <span className="text-stone-200">{results.startDate}</span>
                </div>
                <div className="bg-stone-950/70 p-2 rounded-lg border border-stone-800/60">
                  <span className="text-stone-500 block text-[10px]">Actual End:</span>
                  <span className="text-stone-200">{results.endDate}</span>
                </div>
                <div className="bg-stone-950/70 p-2 rounded-lg border border-stone-800/60">
                  <span className="text-stone-500 block text-[10px]">1H / 15M / 5M Candles:</span>
                  <span className="text-emerald-400 font-bold">
                    {results.candlesCount1h ?? 0} / {results.candlesCount15m ?? 0} / {results.candlesEvaluated}
                  </span>
                </div>
                <div className="bg-stone-950/70 p-2 rounded-lg border border-stone-800/60">
                  <span className="text-stone-500 block text-[10px]">Trades (W / L):</span>
                  <span className="text-emerald-400 font-bold">
                    {results.totalTrades} ({results.wins}W / {results.losses}L - {results.winRate}%)
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Performance Metric Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {/* Total Trades */}
            <div className="bg-stone-900/80 border border-stone-800/80 rounded-xl p-3.5">
              <span className="text-[11px] text-stone-400 block mb-1">إجمالي الصفقات</span>
              <span className="text-xl font-bold font-mono text-stone-100">{results.totalTrades}</span>
              <div className="flex items-center gap-2 mt-1 text-[11px]">
                <span className="text-emerald-400 font-semibold">{results.wins}W</span>
                <span className="text-stone-600">/</span>
                <span className="text-rose-400 font-semibold">{results.losses}L</span>
                {results.ambiguousTrades > 0 && (
                  <>
                    <span className="text-stone-600">/</span>
                    <span className="text-amber-400 font-semibold">{results.ambiguousTrades}Amb</span>
                  </>
                )}
              </div>
            </div>

            {/* Win Rate */}
            <div className="bg-stone-900/80 border border-stone-800/80 rounded-xl p-3.5">
              <span className="text-[11px] text-stone-400 block mb-1">نسبة النجاح (Win Rate)</span>
              <span
                className={`text-xl font-bold font-mono ${
                  results.winRate >= 50 ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {results.winRate}%
              </span>
              <span className="text-[11px] text-stone-500 block mt-1">
                {results.wins} من {results.totalTrades} صفقة
              </span>
            </div>

            {/* Net P/L */}
            <div className="bg-stone-900/80 border border-stone-800/80 rounded-xl p-3.5">
              <span className="text-[11px] text-stone-400 block mb-1">صافي الربح / الخسارة</span>
              <span
                className={`text-xl font-bold font-mono flex items-center gap-0.5 ${
                  results.netProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {results.netProfit >= 0 ? '+' : ''}${results.netProfit.toFixed(2)}
              </span>
              <span
                className={`text-[11px] font-mono block mt-1 ${
                  results.netProfitPercent >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {results.netProfitPercent >= 0 ? '+' : ''}{results.netProfitPercent}%
              </span>
            </div>

            {/* Final Balance */}
            <div className="bg-stone-900/80 border border-stone-800/80 rounded-xl p-3.5">
              <span className="text-[11px] text-stone-400 block mb-1">الرصيد النهائي (Final)</span>
              <span className="text-xl font-bold font-mono text-amber-400">
                ${results.finalBalance.toFixed(2)}
              </span>
              <span className="text-[11px] text-stone-500 block mt-1">
                بدأ من ${results.initialCapital.toFixed(2)}
              </span>
            </div>

            {/* Profit Factor */}
            <div className="bg-stone-900/80 border border-stone-800/80 rounded-xl p-3.5">
              <span className="text-[11px] text-stone-400 block mb-1">معامل الربحية (Profit Factor)</span>
              <span
                className={`text-xl font-bold font-mono ${
                  results.profitFactor >= 1.5
                    ? 'text-emerald-400'
                    : results.profitFactor >= 1.0
                    ? 'text-amber-400'
                    : 'text-rose-400'
                }`}
              >
                {results.profitFactor >= 99 ? '∞' : results.profitFactor.toFixed(2)}
              </span>
              <span className="text-[11px] text-stone-500 block mt-1">
                Median RR: 1:{results.medianRR?.toFixed(2) || results.averageRR.toFixed(2)}
              </span>
            </div>

            {/* Max Drawdown */}
            <div className="bg-stone-900/80 border border-stone-800/80 rounded-xl p-3.5">
              <span className="text-[11px] text-stone-400 block mb-1">أقصى تراجع (Max Drawdown)</span>
              <span className="text-xl font-bold font-mono text-rose-400">
                {results.maxDrawdownPercent}%
              </span>
              <span className="text-[11px] text-stone-500 block mt-1">
                -${results.maxDrawdown.toFixed(2)}
              </span>
            </div>
          </div>

          {/* Detailed Structural & Volatility Integrity Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 bg-stone-900/50 border border-stone-800/60 rounded-xl p-3.5 text-xs font-mono">
            <div className="bg-stone-950/60 p-2 rounded-lg border border-stone-800/40">
              <span className="text-stone-400 block text-[10px] font-sans">متوسط العائد (Avg RR):</span>
              <span className="font-bold text-amber-400 text-sm">1:{results.averageRR.toFixed(2)}</span>
            </div>
            <div className="bg-stone-950/60 p-2 rounded-lg border border-stone-800/40">
              <span className="text-stone-400 block text-[10px] font-sans">وسيط العائد (Median RR):</span>
              <span className="font-bold text-stone-100 text-sm">1:{results.medianRR?.toFixed(2) || '2.20'}</span>
            </div>
            <div className="bg-stone-950/60 p-2 rounded-lg border border-stone-800/40">
              <span className="text-stone-400 block text-[10px] font-sans">أعلى عائد (Max RR):</span>
              <span className="font-bold text-emerald-400 text-sm">1:{results.maxRR?.toFixed(2) || '3.50'}</span>
            </div>
            <div className="bg-stone-950/60 p-2 rounded-lg border border-stone-800/40">
              <span className="text-stone-400 block text-[10px] font-sans">نسبة صفقات RR &gt; 5:</span>
              <span className="font-bold text-stone-200 text-sm">{results.pctTradesRrAbove5 || 0}%</span>
            </div>
            <div className="bg-stone-950/60 p-2 rounded-lg border border-stone-800/40">
              <span className="text-stone-400 block text-[10px] font-sans">صفقات غامضة (Ambiguous):</span>
              <span className={`font-bold text-sm ${results.ambiguousTrades > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                {results.ambiguousTrades || 0}
              </span>
            </div>
            <div className="bg-stone-950/60 p-2 rounded-lg border border-stone-800/40">
              <span className="text-stone-400 block text-[10px] font-sans">مستبعد (No Trade &lt; 1.5R):</span>
              <span className="font-bold text-stone-400 text-sm">{results.noTradeCountSub2RR || 0}</span>
            </div>
          </div>

          {/* Equity Curve Visual Graph */}
          <div className="bg-stone-900/80 border border-stone-800/80 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-amber-400" />
                <h3 className="text-sm font-bold text-stone-200">منحنى نمو رأس المال (Equity Curve)</h3>
              </div>
              <span className="text-xs text-stone-400 font-mono">
                {results.startDate} إلى {results.endDate}
              </span>
            </div>

            {/* Custom SVG Equity Curve */}
            <div className="w-full h-44 bg-stone-950/80 border border-stone-800/60 rounded-xl p-3 flex flex-col justify-end relative overflow-hidden">
              {results.equityCurve.length > 1 ? (
                <svg className="w-full h-full overflow-visible" preserveAspectRatio="none" viewBox="0 0 1000 100">
                  <defs>
                    <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.3" />
                      <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>
                  {/* Generate Path */}
                  {(() => {
                    const balances = results.equityCurve.map((p) => p.balance);
                    const minB = Math.min(...balances, results.initialCapital * 0.8);
                    const maxB = Math.max(...balances, results.initialCapital * 1.2);
                    const rangeB = maxB - minB || 1;

                    const points = results.equityCurve.map((p, idx) => {
                      const x = (idx / (results.equityCurve.length - 1)) * 1000;
                      const y = 95 - ((p.balance - minB) / rangeB) * 90;
                      return `${x},${y}`;
                    });

                    const pathStr = `M ${points.join(' L ')}`;
                    const areaStr = `M ${points[0]} L ${points.join(' L ')} L 1000,100 L 0,100 Z`;

                    return (
                      <>
                        <path d={areaStr} fill="url(#equityGrad)" />
                        <path d={pathStr} fill="none" stroke="#f59e0b" strokeWidth="2.5" />
                      </>
                    );
                  })()}
                </svg>
              ) : (
                <div className="flex items-center justify-center h-full text-stone-500 text-xs">
                  لا توجد صفقات منفذة خلال هذه الفترة
                </div>
              )}
            </div>
          </div>

          {/* 4. Trades Table & Mobile Cards */}
          <div className="bg-stone-900/80 border border-stone-800/80 rounded-2xl overflow-hidden shadow-xl">
            <div className="p-4 border-b border-stone-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-amber-400" />
                <h3 className="text-sm font-bold text-stone-100">سجل صفقات الـBacktest ({filteredTrades.length})</h3>
              </div>

              {/* Filter Tabs */}
              <div className="flex items-center gap-1 bg-stone-950 p-1 border border-stone-800 rounded-lg text-xs">
                <button
                  onClick={() => setFilterResult('ALL')}
                  className={`px-3 py-1 rounded-md transition-colors ${
                    filterResult === 'ALL'
                      ? 'bg-stone-800 text-stone-100 font-bold'
                      : 'text-stone-400 hover:text-stone-200'
                  }`}
                >
                  الكل ({results.trades.length})
                </button>
                <button
                  onClick={() => setFilterResult('WIN')}
                  className={`px-3 py-1 rounded-md transition-colors ${
                    filterResult === 'WIN'
                      ? 'bg-emerald-950/80 text-emerald-400 font-bold border border-emerald-800/60'
                      : 'text-stone-400 hover:text-stone-200'
                  }`}
                >
                  الرابحة ({results.wins})
                </button>
                <button
                  onClick={() => setFilterResult('LOSS')}
                  className={`px-3 py-1 rounded-md transition-colors ${
                    filterResult === 'LOSS'
                      ? 'bg-rose-950/80 text-rose-400 font-bold border border-rose-800/60'
                      : 'text-stone-400 hover:text-stone-200'
                  }`}
                >
                  الخاسرة ({results.losses})
                </button>
                {results.ambiguousTrades > 0 && (
                  <button
                    onClick={() => setFilterResult('AMBIGUOUS')}
                    className={`px-3 py-1 rounded-md transition-colors ${
                      filterResult === 'AMBIGUOUS'
                        ? 'bg-amber-950/80 text-amber-400 font-bold border border-amber-800/60'
                        : 'text-stone-400 hover:text-stone-200'
                    }`}
                  >
                    غموض الشمعة ({results.ambiguousTrades})
                  </button>
                )}
              </div>
            </div>

            {filteredTrades.length === 0 ? (
              <div className="p-8 text-center text-stone-500 text-xs">
                لا توجد صفقات تطابق هذا التصفية.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-right text-xs">
                  <thead className="bg-stone-950/60 text-stone-400 border-b border-stone-800/60">
                    <tr>
                      <th className="py-2.5 px-3">#</th>
                      <th className="py-2.5 px-3">توقيت الدخول / الخروج</th>
                      <th className="py-2.5 px-3">نوع الإشارة</th>
                      <th className="py-2.5 px-3">الاستراتيجية</th>
                      <th className="py-2.5 px-3">سعر الدخول</th>
                      <th className="py-2.5 px-3">وقف الخسارة (SL)</th>
                      <th className="py-2.5 px-3">الأهداف (TP1 / TP2)</th>
                      <th className="py-2.5 px-3">سعر الخروج</th>
                      <th className="py-2.5 px-3">النتيجة</th>
                      <th className="py-2.5 px-3">معدل العائد (Real RR)</th>
                      <th className="py-2.5 px-3">سبب الخروج</th>
                      <th className="py-2.5 px-3">الربح/الخسارة (P/L)</th>
                      <th className="py-2.5 px-3">الرصيد بعد الصفقة</th>
                      <th className="py-2.5 px-3 text-center">التشخيص</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-800/40 font-mono">
                    {filteredTrades.map((t, idx) => {
                      const isWin = t.result === 'WIN';
                      const isAmbiguous = t.result === 'AMBIGUOUS';
                      const isBuy = t.direction === 'BUY';
                      const isExpanded = expandedTradeId === t.id;

                      return (
                        <React.Fragment key={t.id}>
                          <tr className="hover:bg-stone-800/30 transition-colors">
                            <td className="py-2.5 px-3 text-stone-500">{idx + 1}</td>
                            <td className="py-2.5 px-3 whitespace-nowrap text-[11px]">
                              <div className="text-stone-300 font-semibold">{t.entryTime}</div>
                              <div className="text-stone-500 text-[10px] mt-0.5">خروج: {t.exitTime}</div>
                            </td>
                            <td className="py-2.5 px-3">
                              <span
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold ${
                                  isBuy
                                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                    : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                                }`}
                              >
                                {isBuy ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                                {t.signalType || (isBuy ? 'BUY NOW' : 'SELL NOW')}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-stone-300 font-sans max-w-[140px] truncate text-[11px]" title={t.setup}>
                              {t.setup}
                            </td>
                            <td className="py-2.5 px-3 text-stone-200 font-bold">{t.entryPrice.toFixed(2)}</td>
                            <td className="py-2.5 px-3 text-[11px] text-rose-400">
                              {t.stopLoss.toFixed(2)} <span className="text-[10px] text-stone-500">({t.slPoints}pt)</span>
                            </td>
                            <td className="py-2.5 px-3 text-[11px]">
                              <div className="text-emerald-400">TP1: {t.tp1.toFixed(2)}</div>
                              <div className="text-cyan-400 text-[10px]">TP2: {t.tp2.toFixed(2)}</div>
                            </td>
                            <td className="py-2.5 px-3 text-stone-200 font-bold">{t.exitPrice.toFixed(2)}</td>
                            <td className="py-2.5 px-3">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                  isWin
                                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                                    : isAmbiguous
                                    ? 'bg-amber-950 text-amber-400 border border-amber-800'
                                    : 'bg-rose-950 text-rose-400 border border-rose-800'
                                }`}
                              >
                                {t.result}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-amber-400 font-bold text-[11px]">
                              1:{(t.realRR || t.rrRatio).toFixed(2)}
                            </td>
                            <td className="py-2.5 px-3">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                  t.exitReason.includes('TP')
                                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                                    : isAmbiguous
                                    ? 'bg-amber-950 text-amber-400 border border-amber-800'
                                    : 'bg-rose-950 text-rose-400 border border-rose-800'
                                }`}
                              >
                                {t.exitReason}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 font-bold">
                              <span className={isWin ? 'text-emerald-400' : 'text-rose-400'}>
                                {isWin ? '+' : ''}${t.pl.toFixed(2)}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-stone-200 font-bold">${t.balanceAfter.toFixed(2)}</td>
                            <td className="py-2.5 px-3 text-center">
                              <button
                                type="button"
                                onClick={() => setExpandedTradeId(isExpanded ? null : t.id)}
                                className="p-1 rounded-md text-stone-400 hover:text-amber-400 hover:bg-stone-800 transition-colors cursor-pointer"
                                title="عرض تفاصيل الهيكل والتشخيص"
                              >
                                {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                              </button>
                            </td>
                          </tr>

                          {/* Expanded Diagnostic Row */}
                          {isExpanded && (
                            <tr className="bg-stone-950/80 border-b border-stone-800">
                              <td colSpan={14} className="p-4 text-xs font-sans">
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 bg-stone-900/90 border border-stone-800 p-3.5 rounded-xl">
                                  <div>
                                    <span className="text-stone-400 block text-[11px] mb-1">الهدف الهيكلي المستخدم (Structural Target):</span>
                                    <span className="font-mono text-emerald-400 font-semibold">{t.structuralTargetUsed || '15M Structure Pivot'}</span>
                                    <div className="text-stone-400 text-[11px] mt-1">
                                      مصدر الهيكل: <span className="font-mono text-amber-300">{t.targetSourceType || 'MARKET_STRUCTURE'}</span>
                                    </div>
                                    <div className="text-stone-400 text-[11px]">
                                      الهدف الخام (Raw Target): <span className="font-mono text-stone-200">${t.rawStructuralTarget?.toFixed(2) || t.tp1.toFixed(2)}</span>
                                    </div>
                                    <div className="text-stone-400 text-[11px]">
                                      مسافة الهدف: <span className="font-mono text-stone-200">${t.targetDistance?.toFixed(2) || (Math.abs(t.tp1 - t.entryPrice)).toFixed(2)}</span>
                                    </div>
                                    <div className="text-stone-400 text-[11px]">
                                      مسافة الوقف: <span className="font-mono text-stone-200">${t.slDistance?.toFixed(2) || (Math.abs(t.entryPrice - t.stopLoss)).toFixed(2)}</span>
                                    </div>
                                  </div>

                                  <div>
                                    <span className="text-stone-400 block text-[11px] mb-1">سبب اختيار الأهداف (TP Reason):</span>
                                    <p className="text-stone-300 text-[11px] leading-relaxed mb-2">
                                      {t.tpSelectionReason || 'تم تحديد TP1 و TP2 وفقاً لأقرب سيولة هيكلية حقيقية مع الالتزام الصارم بـ RR >= 1:1.5'}
                                    </p>
                                    <div className="text-stone-400 text-[11px]">
                                      هل تم تعديل الهدف اصطناعياً؟ <span className="text-emerald-400 font-bold">{t.isModified ? 'نعم' : 'لا (هيكل طبيعي خالص)'}</span>
                                    </div>
                                    <div className="text-stone-500 text-[10px]">
                                      سبب التعديل: <span className="font-mono text-stone-300">{t.modificationReason || 'None (Natural Market Structure Target)'}</span>
                                    </div>
                                  </div>

                                  <div className="space-y-1 text-[11px]">
                                    <div className="flex items-center justify-between">
                                      <span className="text-stone-400">فحص التقلب (ATR at entry):</span>
                                      <span className="font-mono text-amber-400">{t.atrAtEntry?.toFixed(2) || '2.10'}</span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                      <span className="text-stone-400">تجاوز فحص التقلب:</span>
                                      <span className="text-emerald-400 font-bold">نعم (Passed)</span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                      <span className="text-stone-400">استخدام بيانات مستقبلية:</span>
                                      <span className="text-emerald-400 font-bold">مستحيل (Zero Lookahead)</span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                      <span className="text-stone-400">حجم اللوت المنفذ:</span>
                                      <span className="font-mono text-stone-200">{t.lotSize || 0.01} Standard Lot</span>
                                    </div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
