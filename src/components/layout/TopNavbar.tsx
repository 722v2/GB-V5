import React from 'react';
import { RefreshCw, Play, Radio, Flame, ShieldCheck } from 'lucide-react';
import { AssetType, NavigationTab, AccountExecutionMode, MT5AccountInfo } from '../../types';

interface TopNavbarProps {
  activeTab: NavigationTab;
  asset?: AssetType;
  price?: number;
  currentPrice?: number;
  prevPrice?: number;
  spread?: number;
  bid?: number;
  ask?: number;
  scannerOnline?: boolean;
  scannerActive?: boolean;
  marketOnline?: boolean;
  isLiveConnected?: boolean;
  marketProvider?: string;
  isAnalyzing?: boolean;
  accountMode?: AccountExecutionMode;
  mt5Account?: MT5AccountInfo;
  onRefresh?: () => void;
  onRefreshPrice?: () => void;
  onManualScan?: () => void;
}

const TAB_TITLES: Record<NavigationTab, { title: string; subtitle: string }> = {
  dashboard: { title: 'لوحة التحكم', subtitle: 'نظرة شاملة وسريعة على الصفقات وحالة الذهب' },
  scanner: { title: 'الماسح الآلي', subtitle: 'فحص دوري كل 60 ثانية بالخلفية' },
  signals: { title: 'سجل الإشارات', subtitle: 'جميع الإشارات الصادرة مع تفاصيل الهدف والوقف' },
  trades: { title: 'الصفقات والتنفيذ', subtitle: 'بيئة التنفيذ ومحاكاة المحفظة' },
  backtest: { title: 'الاختبار التاريخي', subtitle: 'اختبار دقيق على بيانات XAU/USD الحقيقية' },
  risk: { title: 'إدارة المخاطر', subtitle: 'حماية رأس المال بنسبة 15% وقواعد XAU/USD' },
  analytics: { title: 'إحصائيات الأداء', subtitle: 'منحنى نمو الرصيد ونسبة النجاح ومعدل العائد' },
  health: { title: 'سلامة النظام', subtitle: 'حالة الخادم والذكاء الاصطناعي' },
  settings: { title: 'الإعدادات', subtitle: 'تخصيص الرصيد، أحجام العقود، والمؤشرات' },
};

export const TopNavbar: React.FC<TopNavbarProps> = ({
  activeTab,
  price,
  currentPrice,
  prevPrice,
  spread,
  scannerOnline,
  scannerActive,
  isLiveConnected = true,
  isAnalyzing = false,
  accountMode = 'DEMO',
  mt5Account,
  onRefresh,
  onRefreshPrice,
  onManualScan,
}) => {
  const displayPrice = typeof price === 'number' ? price : typeof currentPrice === 'number' ? currentPrice : 2718.5;
  const isUp = typeof prevPrice === 'number' ? displayPrice >= prevPrice : true;
  const tabInfo = TAB_TITLES[activeTab] || { title: 'المنصة', subtitle: 'AI Trading Terminal' };
  const isScannerActive = Boolean(scannerOnline ?? scannerActive ?? false);
  const handleRefresh = onRefresh || onRefreshPrice || (() => {});
  const handleScan = onManualScan || (() => {});

  return (
    <header className="sticky top-0 z-30 bg-stone-950/95 backdrop-blur-md border-b border-stone-800/80 px-2.5 sm:px-5 py-2">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-1.5 sm:gap-3">
        {/* 1. Left / Tab Title & Account Badge */}
        <div className="flex items-center gap-2 min-w-0 flex-1 sm:flex-initial">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
              <h2 className="text-xs sm:text-sm font-bold text-stone-100 truncate">
                {tabInfo.title}
              </h2>

              {/* Mode Badge (ANALYSIS / DEMO / LIVE/REAL) */}
              {accountMode === 'ANALYSIS' ? (
                <span className="inline-flex items-center gap-1 text-[9px] sm:text-[10px] px-2 py-0.5 rounded-full bg-amber-950/90 text-amber-300 border border-amber-800/80 font-mono font-bold shrink-0">
                  <Radio className="w-2.5 h-2.5 sm:w-3 sm:h-3 text-amber-400" />
                  ANALYSIS ONLY
                </span>
              ) : accountMode === 'REAL' || accountMode === 'LIVE' ? (
                <span className="inline-flex items-center gap-1 text-[9px] sm:text-[10px] px-2 py-0.5 rounded-full bg-rose-950 text-rose-300 border border-rose-700 font-mono font-black shrink-0 animate-pulse">
                  <Flame className="w-2.5 h-2.5 sm:w-3 sm:h-3 text-rose-400" />
                  REAL / LIVE
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[9px] sm:text-[10px] px-2 py-0.5 rounded-full bg-cyan-950/80 text-cyan-300 border border-cyan-800/60 font-mono font-bold shrink-0">
                  <ShieldCheck className="w-2.5 h-2.5 sm:w-3 sm:h-3 text-cyan-400" />
                  DEMO
                </span>
              )}

              {/* MT5 Connection Pill if REAL */}
              {accountMode === 'REAL' && (
                <span className={`hidden md:inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded font-mono font-bold border ${
                  mt5Account?.connected
                    ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800'
                    : 'bg-rose-950/80 text-rose-300 border-rose-800'
                }`}>
                  <span className={`w-1 h-1 rounded-full ${mt5Account?.connected ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                  {mt5Account?.connected ? 'MT5 CONNECTED' : 'MT5 DISCONNECTED'}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* 2. Center / Compact Live Gold Price Widget */}
        <div className="flex items-center gap-1.5 sm:gap-2.5 bg-stone-900/90 border border-stone-800 px-2 sm:px-3 py-1 rounded-lg shrink-0">
          <div className="flex items-center gap-1">
            <span className="text-[10px] sm:text-[11px] font-mono text-stone-400 font-bold">XAUUSD</span>
            <span
              className={`font-mono text-xs sm:text-sm font-black transition-colors ${
                isUp ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              ${displayPrice.toFixed(2)}
            </span>
          </div>

          {/* Live pulsing badge */}
          <div className="flex items-center gap-1 text-[9px] font-mono text-emerald-400 border-r border-stone-800 pr-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="hidden xs:inline text-[9px] font-bold">LIVE</span>
          </div>

          {/* Spread on desktop */}
          {typeof spread === 'number' && (
            <div className="hidden lg:flex items-center gap-1 text-[10px] font-mono text-stone-400 border-r border-stone-800 pr-2">
              <span className="text-stone-400">سبريد:</span>
              <span className="text-stone-200 font-bold">${spread.toFixed(2)}</span>
            </div>
          )}
        </div>

        {/* 3. Right / Actions (Scan & Refresh) */}
        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          {/* Quick Scanner Status */}
          <div
            className={`hidden sm:flex items-center gap-1 px-2 py-1 rounded-md border text-[10px] font-mono ${
              isScannerActive
                ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/50'
                : 'bg-stone-900 text-stone-400 border-stone-800'
            }`}
            title="حالة الماسح الآلي"
          >
            <Radio className={`w-2.5 h-2.5 ${isScannerActive ? 'text-emerald-400 animate-pulse' : 'text-stone-500'}`} />
            <span className="font-bold">{isScannerActive ? '60s SCAN' : 'OFFLINE'}</span>
          </div>

          {/* Run Scan CTA */}
          <button
            onClick={handleScan}
            disabled={isAnalyzing}
            className="flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-md bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 text-[10px] sm:text-xs font-black transition-transform active:scale-95 shadow-xs"
            title="تنفيذ فحص فوري"
          >
            <Play className={`w-2.5 h-2.5 sm:w-3 sm:h-3 fill-stone-950 ${isAnalyzing ? 'animate-spin' : ''}`} />
            <span className="hidden xs:inline">فحص فوري</span>
            <span className="xs:hidden">فحص</span>
          </button>

          {/* Refresh Button */}
          <button
            onClick={handleRefresh}
            className="p-1 sm:p-1.5 rounded-md bg-stone-900 hover:bg-stone-850 border border-stone-800 text-stone-400 hover:text-stone-200 transition-colors"
            title="تحديث الأسعار"
          >
            <RefreshCw className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
};
