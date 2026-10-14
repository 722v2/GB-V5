import React, { useState } from 'react';
import {
  ShieldAlert,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  XCircle,
  Clock,
  DollarSign,
  Layers,
  PlusCircle,
  Trash2,
  AlertCircle,
  Lock,
  Flame,
  ShieldCheck,
} from 'lucide-react';
import { TradeLedgerItem, AccountExecutionMode, MT5AccountInfo } from '../types';

interface TradesViewProps {
  ledger: TradeLedgerItem[];
  currentBalance: number;
  currentPrice: number;
  accountMode?: AccountExecutionMode;
  mt5Account?: MT5AccountInfo;
  onAddTrade?: (trade: Partial<TradeLedgerItem>) => Promise<boolean> | void;
  onUpdateTrade: (trade: TradeLedgerItem) => void;
  onDeleteTrade: (id: string) => void;
}

export const TradesView: React.FC<TradesViewProps> = ({
  ledger,
  currentBalance,
  currentPrice,
  accountMode = 'DEMO',
  mt5Account,
  onAddTrade,
  onUpdateTrade,
  onDeleteTrade,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<'OPEN' | 'CLOSED'>('OPEN');

  // Manual trade entry dialog state
  const [showAddModal, setShowAddModal] = useState(false);
  const [manualDirection, setManualDirection] = useState<'BUY' | 'SELL'>('BUY');
  const [manualEntry, setManualEntry] = useState<string>('');
  const [manualSl, setManualSl] = useState<string>('');
  const [manualTp1, setManualTp1] = useState<string>('');
  const [manualTp2, setManualTp2] = useState<string>('');
  const [manualLot, setManualLot] = useState<string>('0.01');
  const [manualRiskPercent, setManualRiskPercent] = useState<string>('15');
  const [manualStatus, setManualStatus] = useState<'OPEN' | 'WIN' | 'LOSS'>('OPEN');
  const [manualPnl, setManualPnl] = useState<string>('');
  const [isSubmittingManual, setIsSubmittingManual] = useState(false);

  // Close trade confirmation with authoritative USD P&L dialog state
  const [closingTrade, setClosingTrade] = useState<{
    trade: TradeLedgerItem;
    outcome: 'WIN' | 'LOSS';
    pnlInput: string;
  } | null>(null);

  const openTrades = ledger.filter((t) => {
    if (t.result !== 'OPEN') return false;
    if (t.isActive === false) return false;
    // Guard against anomalous test/mock records (e.g. >25% entry deviation from live market)
    if (currentPrice > 0 && t.entry > 0) {
      const deviation = Math.abs(currentPrice - t.entry) / currentPrice;
      if (deviation > 0.25) return false;
    }
    return true;
  });
  const closedTrades = ledger.filter(
    (t) => (t.result === 'WIN' || t.result === 'LOSS' || t.result === 'BREAK_EVEN') && t.result !== 'NOT_ENTERED'
  );

  // Compute live floating P/L for open trades
  const computeFloatingPl = (trade: TradeLedgerItem) => {
    const isBuy = trade.direction.includes('BUY');
    const diff = isBuy ? currentPrice - trade.entry : trade.entry - currentPrice;
    // For Gold: 1 lot = 100 oz. contractSizeOz = 100.
    const lots = trade.lotSize || 0.01;
    return diff * 100 * lots;
  };

  const totalFloatingPl = openTrades.reduce((acc, t) => acc + computeFloatingPl(t), 0);
  const effectiveBal = accountMode === 'REAL' && mt5Account?.connected && typeof mt5Account.balance === 'number'
    ? mt5Account.balance
    : currentBalance;
  const equity = accountMode === 'REAL' && mt5Account?.connected && typeof mt5Account.equity === 'number'
    ? mt5Account.equity
    : effectiveBal + totalFloatingPl;
  const marginUsed = openTrades.length * 1.5; // estimated margin
  const freeMargin = accountMode === 'REAL' && mt5Account?.connected && typeof mt5Account.freeMargin === 'number'
    ? mt5Account.freeMargin
    : Math.max(0, equity - marginUsed);

  // Today stats
  const todayStr = new Date().toISOString().split('T')[0];
  const todayTrades = ledger.filter((t) => (t.isoTime || '').startsWith(todayStr));
  const todayPl = todayTrades.reduce((acc, t) => acc + (t.pl || 0), 0);
  const todayRiskUsed = todayTrades.reduce((acc, t) => acc + (t.riskPercent || 0), 0);

  // Initiate close open trade (opens dialog for authoritative USD P&L)
  const handleInitiateCloseTrade = (trade: TradeLedgerItem, outcome: 'WIN' | 'LOSS') => {
    const parts = (trade.rr || '1:1.5').split(':');
    const rrMultiplier = parts.length === 2 ? parseFloat(parts[1]) || 1.5 : 1.5;
    const estVal = outcome === 'WIN' ? (trade.riskAmount * rrMultiplier) : trade.riskAmount;
    setClosingTrade({
      trade,
      outcome,
      pnlInput: estVal.toFixed(2),
    });
  };

  // Confirm close with authoritative P&L (Integrated with Phase 5B close-user-trade endpoint)
  const handleConfirmCloseTrade = async () => {
    if (!closingTrade) return;
    const parsed = parseFloat(closingTrade.pnlInput);
    const validAmount = isNaN(parsed) ? (closingTrade.outcome === 'WIN' ? 2.25 : 1.5) : Math.abs(parsed);
    const finalPl = closingTrade.outcome === 'WIN' ? validAmount : -validAmount;

    try {
      const res = await fetch(`/api/trades/${closingTrade.trade.id}/close-user-trade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outcome: closingTrade.outcome,
          exitPrice: currentPrice,
          realizedPnl: finalPl,
          closeReason: 'MANUAL_USER_CLOSE',
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.trade) {
          onUpdateTrade(data.trade);
          setClosingTrade(null);
          return;
        }
      }
    } catch (e) {
      console.warn('API close-user-trade failed, falling back to local update:', e);
    }

    const updated: TradeLedgerItem = {
      ...closingTrade.trade,
      result: closingTrade.outcome,
      pl: finalPl,
      realizedPnl: finalPl,
      exitPrice: currentPrice,
      exitTime: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
      balanceAfterTrade: Number((effectiveBal + finalPl).toFixed(2)),
      isActive: false,
    };
    onUpdateTrade(updated);
    setClosingTrade(null);
  };

  // Phase 5B: Apply trade management recommendation (e.g. SL Trailing or TP Extension)
  const handleApplyRecommendation = async (trade: TradeLedgerItem) => {
    try {
      const res = await fetch(`/api/trades/${trade.id}/apply-recommendation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType: trade.lastManagementAction }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.trade) {
          onUpdateTrade(data.trade);
          return;
        }
      }
    } catch (e) {
      console.warn('Failed to apply recommendation via API:', e);
    }

    // Local fallback update
    const updated: TradeLedgerItem = {
      ...trade,
      sl: trade.suggestedSL !== undefined && trade.suggestedSL > 0 ? trade.suggestedSL : trade.sl,
      tp2: trade.suggestedTP2 !== undefined && trade.suggestedTP2 > 0 ? trade.suggestedTP2 : trade.tp2,
      isRecommendationApplied: true,
    };
    onUpdateTrade(updated);
  };

  // Submit manual trade
  const handleCreateManualTrade = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingManual) return;
    setIsSubmittingManual(true);

    try {
      const entry = parseFloat(manualEntry) || (currentPrice > 0 ? currentPrice : 2750);
      const sl = parseFloat(manualSl) || (manualDirection === 'BUY' ? entry - 1.5 : entry + 1.5);
      const tp1 = parseFloat(manualTp1) || (manualDirection === 'BUY' ? entry + 2.5 : entry - 2.5);
      const tp2 = manualTp2 ? parseFloat(manualTp2) : undefined;
      const lot = parseFloat(manualLot) || 0.01;
      const riskPct = parseFloat(manualRiskPercent) || 15;
      const riskAmt = Number(((effectiveBal * riskPct) / 100).toFixed(2));
      const slPoints = Math.round(Math.abs(entry - sl) / 0.1);
      const tp1Points = Math.round(Math.abs(tp1 - entry) / 0.1);
      const tp2Points = tp2 ? Math.round(Math.abs(tp2 - entry) / 0.1) : undefined;

      let pl = 0;
      if (manualStatus !== 'OPEN') {
        const userPnl = parseFloat(manualPnl);
        if (!isNaN(userPnl)) {
          pl = manualStatus === 'WIN' ? Math.abs(userPnl) : -Math.abs(userPnl);
        } else {
          pl = manualStatus === 'WIN' ? riskAmt * 1.5 : -riskAmt;
        }
      }

      const newTradeItem: Partial<TradeLedgerItem> = {
        id: `manual_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        asset: 'XAU/USD',
        direction: manualDirection as any,
        entry,
        sl,
        slPoints,
        tp1,
        tp1Points,
        tp2,
        tp2Points,
        lotSize: lot,
        riskPercent: riskPct,
        riskAmount: riskAmt,
        result: manualStatus,
        pl,
        realizedPnl: manualStatus !== 'OPEN' ? pl : undefined,
        isActive: manualStatus === 'OPEN',
        source: 'MANUAL',
        setup: 'Manual Trade Entry',
        notes: 'صفقة يدوية مسجلة',
        date: new Date().toLocaleDateString('ar-EG', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        isoTime: new Date().toISOString(),
      };

      if (onAddTrade) {
        await onAddTrade(newTradeItem);
      }
      setShowAddModal(false);
      setManualPnl('');
      setManualSl('');
      setManualTp1('');
      setManualTp2('');
    } finally {
      setIsSubmittingManual(false);
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6 animate-in fade-in duration-250">
      {/* ================================================== */}
      {/* 1. EXECUTION MODE BANNER (DEMO / REAL)            */}
      {/* ================================================== */}
      <div className={`border-2 rounded-2xl p-4 sm:p-5 shadow-lg ${
        accountMode === 'REAL'
          ? 'bg-gradient-to-r from-rose-950/90 via-stone-900 to-stone-900 border-rose-500/60'
          : 'bg-gradient-to-r from-cyan-950/90 via-stone-900 to-stone-900 border-cyan-500/50'
      }`}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center border ${
              accountMode === 'REAL'
                ? 'bg-rose-500/20 border-rose-500/40 text-rose-400'
                : 'bg-cyan-500/20 border-cyan-500/40 text-cyan-400'
            }`}>
              {accountMode === 'REAL' ? <Flame className="w-6 h-6" /> : <ShieldCheck className="w-6 h-6" />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-bold uppercase tracking-widest text-stone-300">
                  EXECUTION MODE
                </span>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-black font-mono ${
                  accountMode === 'REAL'
                    ? 'bg-rose-600 text-white animate-pulse'
                    : 'bg-cyan-500 text-stone-950'
                }`}>
                  {accountMode === 'REAL' ? 'REAL ACCOUNT (MT5)' : 'DEMO ONLY (PROTECTED)'}
                </span>
              </div>
              <h3 className="text-base sm:text-lg font-black text-stone-100 mt-0.5">
                {accountMode === 'REAL' ? 'بيئة التنفيذ الحي على الحساب الحقيقي' : 'بيئة التداول الافتراضية التجريبية'}
              </h3>
              <p className="text-xs text-stone-400 mt-0.5">
                {accountMode === 'REAL'
                  ? 'يتم إرسال الصفقات مباشرة إلى وسيطك عبر MT5 Execution Bridge مع تطبيق كامل لقيود المخاطرة وLot Protection.'
                  : 'النظام يعمل في وضع المحاكاة الصارم (Demo Simulation). لا يتم إرسال أي أوامر حقيقية إلى الوسطاء.'}
              </p>
            </div>
          </div>

          <div className="bg-stone-950/80 border border-stone-800 rounded-xl px-4 py-2.5 text-right font-mono">
            <span className="text-[10px] text-stone-400 uppercase block font-bold">حالة الاتصال بالوسيط</span>
            <span className={`text-xs font-bold ${mt5Account?.connected ? 'text-emerald-400' : 'text-stone-300'}`}>
              {mt5Account?.connected ? 'MT5 Bridge Connected' : 'Demo Virtual Terminal'}
            </span>
          </div>
        </div>
      </div>

      {/* ================================================== */}
      {/* 2. ACCOUNT FINANCIAL METRICS STRIP                 */}
      {/* ================================================== */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5 font-mono text-xs">
        {/* Broker */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-stone-400 block uppercase">الوسيط (Broker)</span>
          <span className="text-xs font-bold text-stone-200 mt-0.5 block truncate">
            {mt5Account?.connected ? mt5Account.server || 'MT5 Bridge' : 'Biquote MT5'}
          </span>
          <span className="text-[10px] text-stone-400">Gateway</span>
        </div>

        {/* Account */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-stone-400 block uppercase">الحساب (Account)</span>
          <span className="text-xs font-bold text-stone-200 mt-0.5 block truncate">
            {mt5Account?.accountNumber ? `#${mt5Account.accountNumber}` : 'Demo #10'}
          </span>
          <span className={`text-[10px] font-bold ${accountMode === 'REAL' ? 'text-rose-400' : 'text-cyan-400'}`}>
            {accountMode}
          </span>
        </div>

        {/* Balance */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-stone-400 block uppercase">الرصيد (Balance)</span>
          <span className="text-sm font-black text-stone-100 mt-0.5 block">
            ${(Number(effectiveBal) || 0).toFixed(2)}
          </span>
          <span className="text-[10px] text-stone-400">الرصيد النشط</span>
        </div>

        {/* Equity */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-stone-400 block uppercase">السيولة (Equity)</span>
          <span
            className={`text-sm font-black mt-0.5 block ${
              equity >= (effectiveBal || 0) ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            ${(Number(equity) || 0).toFixed(2)}
          </span>
          <span className="text-[10px] text-stone-400">مع الأرباح العائمة</span>
        </div>

        {/* Free Margin */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-stone-400 block uppercase">الهامش المتاح</span>
          <span className="text-sm font-black text-stone-200 mt-0.5 block">
            ${(Number(freeMargin) || 0).toFixed(2)}
          </span>
          <span className="text-[10px] text-stone-400">Free Margin</span>
        </div>

        {/* Open Trades */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-stone-400 block uppercase">الصفقات المفتوحة</span>
          <span className="text-sm font-black text-cyan-400 mt-0.5 block">
            {openTrades.length}
          </span>
          <span className="text-[10px] text-stone-400">صفقة قيد المتابعة</span>
        </div>

        {/* Closed Trades */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3 col-span-2 sm:col-span-1">
          <span className="text-[10px] text-stone-400 block uppercase">المغلقة (Closed)</span>
          <span className="text-sm font-black text-stone-300 mt-0.5 block">
            {closedTrades.length}
          </span>
          <span className="text-[10px] text-stone-400">منجزة بالكامل</span>
        </div>
      </div>

      {/* ================================================== */}
      {/* 3. SUB-TABS: OPEN TRADES vs CLOSED TRADES          */}
      {/* ================================================== */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-800 pb-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveSubTab('OPEN')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              activeSubTab === 'OPEN'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                : 'text-stone-400 hover:text-stone-200'
            }`}
          >
            <span>الصفقات المفتوحة (Open Trades)</span>
            <span className="px-1.5 py-0.2 rounded-full bg-stone-800 text-stone-300 font-mono text-[10px]">
              {openTrades.length}
            </span>
          </button>

          <button
            onClick={() => setActiveSubTab('CLOSED')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              activeSubTab === 'CLOSED'
                ? 'bg-stone-800 text-stone-200 border border-stone-700'
                : 'text-stone-400 hover:text-stone-200'
            }`}
          >
            <span>الصفقات المغلقة (Closed Trades)</span>
            <span className="px-1.5 py-0.2 rounded-full bg-stone-800 text-stone-300 font-mono text-[10px]">
              {closedTrades.length}
            </span>
          </button>
        </div>

        <button
          onClick={() => {
            setManualEntry(currentPrice > 0 ? currentPrice.toFixed(2) : '2750.00');
            setShowAddModal(true);
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 rounded-xl text-xs font-bold font-mono transition-all"
        >
          <PlusCircle className="w-3.5 h-3.5" />
          <span>تسجيل صفقة يدوية (Add Manual Trade)</span>
        </button>
      </div>

      {/* ================================================== */}
      {/* 4. OPEN TRADES LIST                                */}
      {/* ================================================== */}
      {activeSubTab === 'OPEN' && (
        <div className="space-y-3">
          {openTrades.length === 0 ? (
            <div className="bg-stone-900/60 border border-dashed border-stone-800 rounded-2xl p-8 text-center space-y-2">
              <Layers className="w-8 h-8 text-stone-600 mx-auto" />
              <h4 className="text-sm font-bold text-stone-300 font-mono">لا توجد صفقات مفتوحة حالياً</h4>
              <p className="text-xs text-stone-400 max-w-sm mx-auto">
                عندما يعتمد الماسح إشارة مؤكدة يمكنك الضغط على "Execute Demo" لتسجيلها ومتابعتها لحظياً هنا.
              </p>
            </div>
          ) : (
            openTrades.map((t) => {
              const floating = computeFloatingPl(t);
              const isProfit = floating >= 0;

              return (
                <div
                  key={t.id}
                  className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 transition-all"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-stone-800">
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-9 h-9 rounded-xl flex items-center justify-center font-bold ${
                          t.direction.includes('BUY')
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : 'bg-rose-500/20 text-rose-400'
                        }`}
                      >
                        {t.direction.includes('BUY') ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
                      </div>

                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-black font-mono text-stone-100">{t.asset}</span>
                          <span
                            className={`text-xs font-black font-mono px-2 py-0.5 rounded ${
                              t.direction.includes('BUY')
                                ? 'bg-emerald-950 text-emerald-300'
                                : 'bg-rose-950 text-rose-300'
                            }`}
                          >
                            {t.direction}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-stone-800 text-stone-300 font-mono">
                            {(t.lotSize || 0.01).toFixed(2)} Lot (RR {t.rr || '1:1.5'})
                          </span>
                        </div>
                        <span className="text-[11px] text-stone-400 font-mono block mt-0.5">
                          دخول: ${(Number(t.entry) || 0).toFixed(2)} • {t.date}
                        </span>
                      </div>
                    </div>

                    {/* Live Floating P/L */}
                    <div className="text-left font-mono">
                      <span className="text-[10px] text-stone-400 block uppercase">Floating P/L</span>
                      <span
                        className={`text-base sm:text-lg font-black ${
                          isProfit ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {isProfit ? `+$${(Number(floating) || 0).toFixed(2)}` : `-$${Math.abs(Number(floating) || 0).toFixed(2)}`}
                      </span>
                    </div>
                  </div>

                  {/* Pricing Details */}
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-3 font-mono text-xs">
                    <div className="bg-stone-950/70 p-2 rounded-lg border border-stone-800">
                      <span className="text-[10px] text-stone-400 block">السعر الحالي</span>
                      <span className="font-bold text-stone-200">${(Number(currentPrice) || 0).toFixed(2)}</span>
                    </div>
                    <div className="bg-stone-950/70 p-2 rounded-lg border border-rose-950/50">
                      <span className="text-[10px] text-rose-400 block">Stop Loss</span>
                      <span className="font-bold text-rose-400">${(Number(t.sl) || 0).toFixed(2)}</span>
                    </div>
                    <div className="bg-stone-950/70 p-2 rounded-lg border border-emerald-950/50">
                      <span className="text-[10px] text-emerald-400 block">TP1</span>
                      <span className="font-bold text-emerald-400">${(Number(t.tp1) || 0).toFixed(2)}</span>
                    </div>
                    <div className="bg-stone-950/70 p-2 rounded-lg border border-emerald-950/50">
                      <span className="text-[10px] text-emerald-300 block">TP2</span>
                      <span className="font-bold text-emerald-300">{t.tp2 && Number(t.tp2) > 0 ? `$${(Number(t.tp2) || 0).toFixed(2)}` : 'N/A'}</span>
                    </div>
                    <div className="bg-stone-950/70 p-2 rounded-lg border border-stone-800">
                      <span className="text-[10px] text-stone-400 block">المخاطرة المحجوزة</span>
                      <span className="font-bold text-amber-300">
                        {t.riskPercent}% (${(Number(t.riskAmount) || 0).toFixed(2)})
                      </span>
                    </div>
                  </div>

                  {/* Phase 5B Management Recommendation Banner */}
                  {t.managementState && t.managementState !== 'HOLD' && t.managementState !== 'DATA_INCOMPLETE' && (
                    <div className={`mt-3 p-3 rounded-xl border flex flex-wrap items-center justify-between gap-2 text-xs font-mono ${
                      t.managementState === 'EARLY_EXIT'
                        ? 'bg-rose-950/60 border-rose-500/50 text-rose-200'
                        : t.managementState === 'REVERSAL_WATCH'
                        ? 'bg-amber-950/60 border-amber-500/50 text-amber-200'
                        : t.managementState === 'TARGET_EXTENSION'
                        ? 'bg-purple-950/60 border-purple-500/50 text-purple-200'
                        : 'bg-cyan-950/60 border-cyan-500/50 text-cyan-200'
                    }`}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold">
                          {t.managementState === 'TP1_HIT' && '🎯 هدف TP1 تحقق — حجز أرباح'}
                          {t.managementState === 'TARGET_EXTENSION' && '🚀 تمديد الهدف (Target Extension)'}
                          {t.managementState === 'TRAIL_STOP' && '🛡️ تأمين الأرباح (Trailing Stop)'}
                          {t.managementState === 'REVERSAL_WATCH' && '⚠️ مراقبة انعكاس الهيكل'}
                          {t.managementState === 'EARLY_EXIT' && '🚨 خروج مبكر موصى به'}
                          {!['TP1_HIT', 'TARGET_EXTENSION', 'TRAIL_STOP', 'REVERSAL_WATCH', 'EARLY_EXIT'].includes(t.managementState) && `📌 حالة الإدارة: ${t.managementState}`}
                        </span>
                        {t.suggestedSL && <span>• SL مقترح: ${t.suggestedSL.toFixed(2)}</span>}
                        {t.suggestedTP2 && <span>• TP2 مقترح: ${t.suggestedTP2.toFixed(2)}</span>}
                      </div>
                      {(t.suggestedSL || t.suggestedTP2) && !t.isRecommendationApplied && (
                        <button
                          onClick={() => handleApplyRecommendation(t)}
                          className="px-2.5 py-1 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-100 font-bold text-[11px] border border-stone-600 transition-colors cursor-pointer"
                        >
                          تطبيق التوصية
                        </button>
                      )}
                      {t.isRecommendationApplied && (
                        <span className="text-[10px] text-emerald-400 font-bold">✅ تم تطبيق التوصية</span>
                      )}
                    </div>
                  )}

                  {/* Trade Action Controls */}
                  <div className="mt-3 pt-2.5 border-t border-stone-800/80 flex items-center justify-between">
                    <button
                      onClick={() => onDeleteTrade(t.id)}
                      className="text-stone-400 hover:text-rose-400 text-xs flex items-center gap-1 font-mono transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>إلغاء الأمر التجريبي</span>
                    </button>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleInitiateCloseTrade(t, 'WIN')}
                        className="px-3 py-1 rounded-lg bg-emerald-950 hover:bg-emerald-900 border border-emerald-800 text-emerald-300 text-xs font-bold transition-all"
                      >
                        إغلاق بربح (Target Hit)
                      </button>
                      <button
                        onClick={() => handleInitiateCloseTrade(t, 'LOSS')}
                        className="px-3 py-1 rounded-lg bg-rose-950 hover:bg-rose-900 border border-rose-800 text-rose-300 text-xs font-bold transition-all"
                      >
                        إغلاق بوقف (Stop Hit)
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ================================================== */}
      {/* 5. CLOSED TRADES LIST                              */}
      {/* ================================================== */}
      {activeSubTab === 'CLOSED' && (
        <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-5">
          <h4 className="text-xs sm:text-sm font-bold text-stone-100 mb-3 border-b border-stone-800 pb-2">
            سجل الصفقات المغلقة (Closed Trades Log)
          </h4>

          {closedTrades.length === 0 ? (
            <div className="py-8 text-center text-xs text-stone-400 font-mono">
              لا توجد صفقات مغلقة بعد في سجل المحاكاة.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs font-mono">
                <thead>
                  <tr className="border-b border-stone-800 text-stone-400 text-[10px] uppercase">
                    <th className="py-2.5 px-2">#</th>
                    <th className="py-2.5 px-2">الرمز والاتجاه</th>
                    <th className="py-2.5 px-2">سعر الدخول</th>
                    <th className="py-2.5 px-2">الهدف / الوقف</th>
                    <th className="py-2.5 px-2">العقد / المخاطرة</th>
                    <th className="py-2.5 px-2">النتيجة</th>
                    <th className="py-2.5 px-2">الربح / الخسارة</th>
                    <th className="py-2.5 px-2">الرصيد بعد الصفقة</th>
                    <th className="py-2.5 px-2">حذف</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-800/60 text-stone-300">
                  {closedTrades.map((t, idx) => {
                    const isWin = t.result === 'WIN';
                    return (
                      <tr key={t.id} className="hover:bg-stone-950/60 transition-colors">
                        <td className="py-2 px-2 text-stone-400">#{t.tradeNumber || idx + 1}</td>
                        <td className="py-2 px-2">
                          <span className="font-bold text-stone-200">{t.asset}</span>{' '}
                          <span
                            className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${
                              t.direction.includes('BUY')
                                ? 'text-emerald-400 bg-emerald-950/60'
                                : 'text-rose-400 bg-rose-950/60'
                            }`}
                          >
                            {t.direction}
                          </span>
                        </td>
                        <td className="py-2 px-2">${(Number(t.entry) || 0).toFixed(2)}</td>
                        <td className="py-2 px-2 text-stone-400">
                          TP1: ${(Number(t.tp1) || 0).toFixed(2)} | SL: ${(Number(t.sl) || 0).toFixed(2)}
                        </td>
                        <td className="py-2 px-2 text-amber-300">
                          {(t.lotSize || 0.01).toFixed(2)} Lot ({t.riskPercent}%)
                        </td>
                        <td className="py-2 px-2">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              isWin
                                ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                                : 'bg-rose-950 text-rose-300 border border-rose-800'
                            }`}
                          >
                            {t.result} ({t.rr || '1:1.5'})
                          </span>
                        </td>
                        <td
                          className={`py-2 px-2 font-bold ${
                            (Number(t.pl) || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {(Number(t.pl) || 0) >= 0 ? `+$${(Number(t.pl) || 0).toFixed(2)}` : `-$${Math.abs(Number(t.pl) || 0).toFixed(2)}`}
                        </td>
                        <td className="py-2 px-2 text-stone-200 font-bold">
                          ${(Number(t.balanceAfterTrade) || 0).toFixed(2)}
                        </td>
                        <td className="py-2 px-2">
                          <button
                            onClick={() => onDeleteTrade(t.id)}
                            className="text-stone-500 hover:text-rose-400"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ================================================== */}
      {/* 6. MODAL: CLOSE TRADE WITH AUTHORITATIVE P&L       */}
      {/* ================================================== */}
      {closingTrade && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-stone-900 border border-stone-800 rounded-2xl max-w-md w-full p-5 space-y-4 shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-stone-800 pb-3">
              <div className="flex items-center gap-2">
                <span className={`w-3 h-3 rounded-full ${closingTrade.outcome === 'WIN' ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                <h3 className="text-sm font-bold text-stone-100">
                  {closingTrade.outcome === 'WIN' ? 'توثيق صفقة رابحة (WIN)' : 'توثيق صفقة خاسرة (LOSS)'}
                </h3>
              </div>
              <button
                onClick={() => setClosingTrade(null)}
                className="text-stone-400 hover:text-stone-100 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 font-mono text-xs">
              <div className="bg-stone-950 p-3 rounded-xl border border-stone-800 space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-stone-400">الأصل والاتجاه:</span>
                  <span className="font-bold text-stone-200">{closingTrade.trade.asset} ({closingTrade.trade.direction})</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-stone-400">سعر الدخول:</span>
                  <span className="text-stone-200">${Number(closingTrade.trade.entry).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-stone-400">حجم العقد:</span>
                  <span className="text-stone-200">{(closingTrade.trade.lotSize || 0.01).toFixed(2)} Lot</span>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-stone-200">
                  {closingTrade.outcome === 'WIN' ? 'قيمة الربح الفعلي المحقق بالدولار (USD):' : 'قيمة الخسارة الفعلية بالدولار (USD):'}
                </label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-3 flex items-center text-stone-400 font-bold">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={closingTrade.pnlInput}
                    onChange={(e) => setClosingTrade({ ...closingTrade, pnlInput: e.target.value })}
                    className="w-full bg-stone-950 border border-stone-700 rounded-xl py-2 pl-8 pr-3 text-stone-100 font-bold text-sm focus:outline-none focus:border-amber-500"
                    placeholder="0.00"
                    autoFocus
                  />
                </div>
                <p className="text-[10px] text-stone-400">
                  سيتم اعتماد هذا المبلغ المحدد بدقة في سجل التداول وتحديث رصيد المحفظة به مباشرة.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-stone-800">
              <button
                type="button"
                onClick={() => setClosingTrade(null)}
                className="px-4 py-2 rounded-xl text-xs font-bold text-stone-400 hover:text-stone-200 bg-stone-800"
              >
                إلغاء
              </button>
              <button
                type="button"
                onClick={handleConfirmCloseTrade}
                className={`px-4 py-2 rounded-xl text-xs font-bold text-white transition-all ${
                  closingTrade.outcome === 'WIN'
                    ? 'bg-emerald-600 hover:bg-emerald-500'
                    : 'bg-rose-600 hover:bg-rose-500'
                }`}
              >
                تأكيد الإغلاق والتوثيق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================================================== */}
      {/* 7. MODAL: ADD MANUAL TRADE                         */}
      {/* ================================================== */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateManualTrade}
            className="bg-stone-900 border border-stone-800 rounded-2xl max-w-lg w-full p-5 space-y-4 shadow-2xl animate-in zoom-in-95 duration-150"
          >
            <div className="flex items-center justify-between border-b border-stone-800 pb-3">
              <div className="flex items-center gap-2">
                <PlusCircle className="w-4 h-4 text-amber-400" />
                <h3 className="text-sm font-bold text-stone-100">تسجيل صفقة يدوية جديدة (Manual Trade)</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="text-stone-400 hover:text-stone-100 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 font-mono text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] uppercase text-stone-400 mb-1">الاتجاه (Direction)</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setManualDirection('BUY')}
                      className={`py-2 rounded-xl font-bold text-xs transition-all ${
                        manualDirection === 'BUY'
                          ? 'bg-emerald-600 text-white border border-emerald-500'
                          : 'bg-stone-950 text-stone-400 border border-stone-800'
                      }`}
                    >
                      BUY NOW
                    </button>
                    <button
                      type="button"
                      onClick={() => setManualDirection('SELL')}
                      className={`py-2 rounded-xl font-bold text-xs transition-all ${
                        manualDirection === 'SELL'
                          ? 'bg-rose-600 text-white border border-rose-500'
                          : 'bg-stone-950 text-stone-400 border border-stone-800'
                      }`}
                    >
                      SELL NOW
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] uppercase text-stone-400 mb-1">سعر الدخول (Entry)</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={manualEntry}
                    onChange={(e) => setManualEntry(e.target.value)}
                    placeholder={currentPrice > 0 ? currentPrice.toFixed(2) : '2750.00'}
                    className="w-full bg-stone-950 border border-stone-800 rounded-xl p-2 text-stone-100 focus:outline-none focus:border-amber-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[10px] uppercase text-stone-400 mb-1">وقف الخسارة (SL)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={manualSl}
                    onChange={(e) => setManualSl(e.target.value)}
                    placeholder="اختياري"
                    className="w-full bg-stone-950 border border-stone-800 rounded-xl p-2 text-stone-100 focus:outline-none focus:border-amber-500"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase text-stone-400 mb-1">الهدف الأول (TP1)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={manualTp1}
                    onChange={(e) => setManualTp1(e.target.value)}
                    placeholder="اختياري"
                    className="w-full bg-stone-950 border border-stone-800 rounded-xl p-2 text-stone-100 focus:outline-none focus:border-amber-500"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase text-stone-400 mb-1">الهدف الثاني (TP2)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={manualTp2}
                    onChange={(e) => setManualTp2(e.target.value)}
                    placeholder="اختياري"
                    className="w-full bg-stone-950 border border-stone-800 rounded-xl p-2 text-stone-100 focus:outline-none focus:border-amber-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] uppercase text-stone-400 mb-1">حجم العقد (Lot)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={manualLot}
                    onChange={(e) => setManualLot(e.target.value)}
                    className="w-full bg-stone-950 border border-stone-800 rounded-xl p-2 text-stone-100 focus:outline-none focus:border-amber-500"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase text-stone-400 mb-1">نسبة المخاطرة (%)</label>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    max="30"
                    value={manualRiskPercent}
                    onChange={(e) => setManualRiskPercent(e.target.value)}
                    className="w-full bg-stone-950 border border-stone-800 rounded-xl p-2 text-stone-100 focus:outline-none focus:border-amber-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] uppercase text-stone-400 mb-1">حالة الصفقة (Status)</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setManualStatus('OPEN')}
                    className={`py-2 rounded-xl font-bold text-xs transition-all ${
                      manualStatus === 'OPEN'
                        ? 'bg-cyan-600 text-white border border-cyan-500'
                        : 'bg-stone-950 text-stone-400 border border-stone-800'
                    }`}
                  >
                    مفتوحة (OPEN)
                  </button>
                  <button
                    type="button"
                    onClick={() => setManualStatus('WIN')}
                    className={`py-2 rounded-xl font-bold text-xs transition-all ${
                      manualStatus === 'WIN'
                        ? 'bg-emerald-600 text-white border border-emerald-500'
                        : 'bg-stone-950 text-stone-400 border border-stone-800'
                    }`}
                  >
                    رابحة (WIN)
                  </button>
                  <button
                    type="button"
                    onClick={() => setManualStatus('LOSS')}
                    className={`py-2 rounded-xl font-bold text-xs transition-all ${
                      manualStatus === 'LOSS'
                        ? 'bg-rose-600 text-white border border-rose-500'
                        : 'bg-stone-950 text-stone-400 border border-stone-800'
                    }`}
                  >
                    خاسرة (LOSS)
                  </button>
                </div>
              </div>

              {manualStatus !== 'OPEN' && (
                <div className="p-3 bg-stone-950 rounded-xl border border-stone-800 space-y-1">
                  <label className="block text-xs font-bold text-stone-200">
                    {manualStatus === 'WIN' ? 'الربح المحقق بالدولار (USD):' : 'الخسارة المحققة بالدولار (USD):'}
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-3 flex items-center text-stone-400 font-bold">$</span>
                    <input
                      type="number"
                      step="0.01"
                      value={manualPnl}
                      onChange={(e) => setManualPnl(e.target.value)}
                      placeholder="0.00"
                      className="w-full bg-stone-900 border border-stone-700 rounded-xl py-2 pl-8 pr-3 text-stone-100 font-bold text-sm focus:outline-none focus:border-amber-500"
                    />
                  </div>
                  <p className="text-[10px] text-stone-400">
                    سيتم حفظ هذه الصفقة مباشرة إلى قاعدة بيانات Supabase وتحديث رصيد الحساب بالربح أو الخسارة المحددة.
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-stone-800">
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 rounded-xl text-xs font-bold text-stone-400 hover:text-stone-200 bg-stone-800"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={isSubmittingManual}
                className="px-5 py-2 rounded-xl text-xs font-bold text-white bg-amber-600 hover:bg-amber-500 transition-all disabled:opacity-50"
              >
                {isSubmittingManual ? 'جاري الحفظ...' : 'حفظ الصفقة في السجل'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
