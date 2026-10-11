import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  AssetType,
  BrokerSettings,
  Candle,
  NavigationTab,
  ScannerConfig,
  TradeLedgerItem,
  TradeSignal,
  AppSettings,
  DEFAULT_APP_SETTINGS,
  MT5AccountInfo,
} from './types';
import { Sidebar } from './components/layout/Sidebar';
import { BottomNav } from './components/layout/BottomNav';
import { MobileMoreDrawer } from './components/layout/MobileMoreDrawer';
import { TopNavbar } from './components/layout/TopNavbar';

// Views
import { DashboardView } from './views/DashboardView';
import { ScannerView } from './views/ScannerView';
import { SignalsView } from './views/SignalsView';
import { TradesView } from './views/TradesView';
import { BacktestView } from './views/BacktestView';
import { RiskView } from './views/RiskView';
import { AnalyticsView } from './views/AnalyticsView';
import { SystemHealthView } from './views/SystemHealthView';
import { SettingsView } from './views/SettingsView';

import { calculateAccountStats } from './utils/storage';

export default function App() {
  // Navigation State
  const [activeTab, setActiveTab] = useState<NavigationTab>('dashboard');
  const [isMoreDrawerOpen, setIsMoreDrawerOpen] = useState<boolean>(false);

  // App Unified Settings & Real Capital State
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [activeCapital, setActiveCapital] = useState<number>(10);
  const [mt5Account, setMt5Account] = useState<MT5AccountInfo>({
    connected: false,
    balance: 0,
    equity: 0,
    freeMargin: 0,
    server: '',
    error: 'Disconnected',
  });

  // Account & Persistence State - backend SQLite is the authoritative single source of truth
  const [startingBalance, setStartingBalance] = useState<number>(10);
  const [currentBalance, setCurrentBalance] = useState<number>(10);
  const [ledger, setLedger] = useState<TradeLedgerItem[]>([]);
  const [signal, setSignal] = useState<TradeSignal | null>(null);

  // Broker specifications derived directly from authoritative appSettings and activeCapital
  const brokerSettings: BrokerSettings = useMemo(() => ({
    accountBalance: activeCapital,
    riskPercent: appSettings.riskPerTrade,
    contractSizeOz: appSettings.contractSizeOz,
    minimumLot: appSettings.minimumLot,
    maximumLot: appSettings.maximumLot,
    lotStep: appSettings.lotStep,
    maxGoldSlPoints: appSettings.maxGoldSlPoints,
    minRr: appSettings.minTp1RR,
  }), [activeCapital, appSettings]);

  // Market Data State
  const [asset, setAsset] = useState<AssetType>('XAU/USD');
  const [currentPrice, setCurrentPrice] = useState<number>(2718.5);
  const [prevPrice, setPrevPrice] = useState<number | undefined>(undefined);
  const [marketMetrics, setMarketMetrics] = useState<{
    bid?: number;
    ask?: number;
    spread?: number;
    high?: number;
    low?: number;
    provider?: string;
    lastUpdated?: number;
  }>({});
  const [candles, setCandles] = useState<Candle[]>([]);
  const [atr, setAtr] = useState<number>(2.4);
  const [structure, setStructure] = useState<string>('BULLISH');
  const [marketRegime, setMarketRegime] = useState<string | undefined>(undefined);
  const [isOverextended, setIsOverextended] = useState<boolean>(false);
  const [isLiveConnected, setIsLiveConnected] = useState<boolean>(false);
  const [multitimeframe, setMultitimeframe] = useState<any>(null);

  // Operation States
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [errorToast, setErrorToast] = useState<string | null>(null);

  // Scanner Config State
  const [scannerConfig, setScannerConfig] = useState<ScannerConfig>({
    enabled: true,
    intervalSeconds: 60,
    intervalMinutes: 1,
    minConfidence: 75,
    lastScanTime: null,
    nextScanTime: null,
    lastScanStatus: 'جاهز - المسح المباشر التلقائي نشط كل 60 ثانية',
    dataStatus: 'Biquote XAUUSD MT5 Feed (Connecting...)',
    lastDecision: null,
    lastSignal: null,
    isScanning: false,
    duplicatePrevented: false,
    activeSetupName: null,
    scanCount: 0,
  });

  // Calculate current account statistics
  const stats = calculateAccountStats(startingBalance, currentBalance, ledger);

  const getAuthHeaders = (): Record<string, string> => {
    const key = localStorage.getItem('gbv5_admin_key') || '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) {
      headers['Authorization'] = `Bearer ${key}`;
      headers['x-admin-key'] = key;
    }
    return headers;
  };

  // Verify and sync server admin authorization status on app initialization
  useEffect(() => {
    const verifyAndSyncAuth = async () => {
      try {
        const storedKey = localStorage.getItem('gbv5_admin_key');
        if (storedKey) {
          const verifyRes = await fetch('/api/auth/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: storedKey }),
          });
          if (verifyRes.ok) {
            const data = await verifyRes.json();
            if (data.authenticated) return;
          }
        }

        // If no valid stored key, attempt verification with default bridge token key
        const defaultKey = 'your_secure_random_bridge_token_here';
        const defaultRes = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: defaultKey }),
        });
        if (defaultRes.ok) {
          const defaultData = await defaultRes.json();
          if (defaultData.authenticated) {
            localStorage.setItem('gbv5_admin_key', defaultKey);
          }
        }
      } catch (err) {
        console.warn('Failed to verify admin auth config:', err);
      }
    };
    verifyAndSyncAuth();
  }, []);

  // Fetch live price
  const fetchPrice = useCallback(
    async (selectedAsset = asset) => {
      try {
        const res = await fetch(`/api/market/price?asset=${encodeURIComponent(selectedAsset)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const data = await res.json();
        if (typeof data.price === 'number' && data.price > 0) {
          setPrevPrice((old) => (old !== undefined ? old : data.price));
          setCurrentPrice(data.price);
          setMarketMetrics({
            bid: typeof data.bid === 'number' ? data.bid : undefined,
            ask: typeof data.ask === 'number' ? data.ask : undefined,
            spread: typeof data.spread === 'number' ? data.spread : undefined,
            high: typeof data.high === 'number' ? data.high : undefined,
            low: typeof data.low === 'number' ? data.low : undefined,
            provider: data.provider || 'Biquote',
            lastUpdated: Date.now(),
          });
          setIsLiveConnected(true);
        } else {
          console.warn('[Market Data Warning] Invalid or non-positive price payload:', data);
          setIsLiveConnected(false);
        }
      } catch (e) {
        console.warn('Market price fetch failed:', e);
        setIsLiveConnected(false);
      }
    },
    [asset]
  );

  // Fetch recent candles
  const fetchCandleData = useCallback(
    async (selectedAsset = asset) => {
      try {
        const res = await fetch(
          `/api/market/candles?asset=${encodeURIComponent(selectedAsset)}&timeframe=5m&limit=50`
        );
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data.candles)) {
          setCandles(data.candles);
        }
        if (data.technicals) {
          if (typeof data.technicals.atr14 === 'number') setAtr(data.technicals.atr14);
          if (data.technicals.structure) setStructure(data.technicals.structure);
          if (data.technicals.marketRegime) setMarketRegime(data.technicals.marketRegime);
          if (typeof data.technicals.regimeContext?.isOverextended === 'boolean') {
            setIsOverextended(data.technicals.regimeContext.isOverextended);
          }
        }
      } catch (e) {
        console.warn('Candle fetch error:', e);
      }
    },
    [asset]
  );

  // Fetch multitimeframe overview
  const fetchMultitimeframe = useCallback(async () => {
    try {
      const res = await fetch('/api/market/multitimeframe');
      if (res.ok) {
        const data = await res.json();
        setMultitimeframe(data);
        if (data.marketRegime) setMarketRegime(data.marketRegime);
        if (typeof data.regimeContext?.isOverextended === 'boolean') {
          setIsOverextended(data.regimeContext.isOverextended);
        }
      }
    } catch (e) {
      console.warn('Multitimeframe fetch error:', e);
    }
  }, []);

  // Fetch unified application settings & active capital from authoritative backend
  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        if (data.settings) {
          setAppSettings((prev) => {
            if (JSON.stringify(prev) === JSON.stringify(data.settings)) return prev;
            return data.settings;
          });
        }
        if (typeof data.activeCapital === 'number') setActiveCapital(data.activeCapital);
        if (typeof data.startingBalance === 'number') setStartingBalance(data.startingBalance);
        if (typeof data.currentBalance === 'number') setCurrentBalance(data.currentBalance);
        if (data.mt5Status || data.mt5Account) setMt5Account(data.mt5Status || data.mt5Account);
      }
    } catch (e) {
      console.warn('Settings fetch error:', e);
    }
  }, []);

  // Update unified settings handler
  const handleUpdateSettings = async (patch: Partial<AppSettings>): Promise<boolean> => {
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.settings) setAppSettings(data.settings);
        if (typeof data.activeCapital === 'number') setActiveCapital(data.activeCapital);
        if (typeof data.startingBalance === 'number') setStartingBalance(data.startingBalance);
        if (typeof data.currentBalance === 'number') setCurrentBalance(data.currentBalance);
        if (data.mt5Status || data.mt5Account) setMt5Account(data.mt5Status || data.mt5Account);
        await fetchDashboardAndTrades();
        return true;
      }
      return false;
    } catch (e) {
      console.error('Update settings failed:', e);
      return false;
    }
  };

  // Fetch scanner status
  const fetchScannerStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/scanner/status');
      if (res.ok) {
        const data = await res.json();
        setScannerConfig(data);
        if (data.lastSignal) {
          setSignal((current) => {
            if (!current) return data.lastSignal;
            if (data.lastSignal.id !== current.id) {
              return data.lastSignal;
            }
            if (
              data.duplicatePrevented &&
              Math.abs(current.currentPrice - data.lastSignal.currentPrice) > 0.05
            ) {
              return { ...current, currentPrice: data.lastSignal.currentPrice };
            }
            return current;
          });
        }
      }
    } catch (e) {
      console.warn('Scanner status fetch error:', e);
    }
  }, []);

  // Fetch server-side persisted trades and balance (authoritative single source of truth)
  const fetchDashboardAndTrades = useCallback(async () => {
    try {
      const [tradesRes, balanceRes] = await Promise.all([
        fetch('/api/trades?limit=100'),
        fetch('/api/account/balance'),
      ]);

      if (tradesRes.ok) {
        const data = await tradesRes.json();
        if (Array.isArray(data.trades)) {
          setLedger(data.trades);
        }
      }

      if (balanceRes.ok) {
        const data = await balanceRes.json();
        if (typeof data.currentBalance === 'number') {
          setCurrentBalance(data.currentBalance);
        }
        if (typeof data.startingBalance === 'number') {
          setStartingBalance(data.startingBalance);
        }
      }
    } catch (e) {
      console.warn('Trades/balance fetch error:', e);
    }
  }, []);

  // Periodic polling for live price & candles & scanner status & settings
  useEffect(() => {
    fetchPrice(asset);
    fetchCandleData(asset);
    fetchMultitimeframe();
    fetchScannerStatus();
    fetchSettings();
    fetchDashboardAndTrades();

    const priceInterval = setInterval(() => {
      fetchPrice(asset);
    }, 6000);

    const candleInterval = setInterval(() => {
      fetchCandleData(asset);
      fetchMultitimeframe();
    }, 20000);

    const scannerInterval = setInterval(() => {
      fetchScannerStatus();
    }, 4000);

    const settingsInterval = setInterval(() => {
      fetchSettings();
      fetchDashboardAndTrades();
    }, 8000);

    return () => {
      clearInterval(priceInterval);
      clearInterval(candleInterval);
      clearInterval(scannerInterval);
      clearInterval(settingsInterval);
    };
  }, [asset, fetchPrice, fetchCandleData, fetchMultitimeframe, fetchScannerStatus, fetchSettings, fetchDashboardAndTrades]);

  // Execute Trade via MT5 Bridge (DEMO or REAL)
  const handleExecuteTrade = async (tradeSignal: TradeSignal) => {
    if (tradeSignal.signal === 'NO TRADE') return;

    // Check client-side daily rules
    const todayStr = new Date().toISOString().split('T')[0];
    const todayTrades = ledger.filter((t) => (t.isoTime || '').startsWith(todayStr));
    if (todayTrades.length >= 3) {
      alert('حماية رأس المال: تم الوصول للحد الأقصى اليومي للصفقات (3 صفقات يومياً).');
      return;
    }
    const todayRiskSum = todayTrades.reduce((acc, t) => acc + (t.riskPercent || 0), 0);
    if (todayRiskSum + (tradeSignal.riskPercent || 0) > 30) {
      alert('حماية رأس المال: تجاوز الحد الأقصى للمخاطرة اليومية (30%).');
      return;
    }

    const calculatedLot = tradeSignal.standardLot ?? tradeSignal.recommendedLotSize ?? 0.01;

    try {
      const response = await fetch('/api/mt5/order', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          symbol: tradeSignal.asset || 'XAUUSD',
          signal: tradeSignal.signal,
          lot: calculatedLot,
          entryPrice: tradeSignal.entry,
          stopLoss: tradeSignal.stopLoss,
          takeProfit: tradeSignal.tp1,
          takeProfit2: tradeSignal.tp2,
          confidence: tradeSignal.confidence,
          riskPercent: tradeSignal.riskPercent,
          riskAmount: tradeSignal.riskAmount,
          setup: tradeSignal.setup,
          rr: tradeSignal.rr,
          comment: `Gold AI [${appSettings.accountMode || 'DEMO'}]`,
        }),
      });

      const data = await response.json();
      if (!data.success) {
        alert(`فشل تنفيذ الصفقة: ${data.error || 'خطأ غير معروف'}`);
        return;
      }

      // If backend returned created trade and updated list, sync state
      if (data.trade) {
        const updated = [data.trade, ...ledger.filter((t) => t.id !== data.trade.id)];
        setLedger(updated);
      } else if (Array.isArray(data.trades)) {
        setLedger(data.trades);
      }
      await fetchDashboardAndTrades();

      setActiveTab('trades'); // navigate directly to trades to show open execution
    } catch (err: any) {
      console.error('Failed to execute order through MT5 bridge:', err);
      alert(`خطأ في الاتصال بجسر MT5: ${err.message}`);
    }
  };

  // Add Trade to Ledger (Manual Trade)
  const handleAddTrade = async (newTrade: Partial<TradeLedgerItem>) => {
    try {
      const res = await fetch('/api/trades', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(newTrade),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        if (Array.isArray(data.trades)) {
          setLedger(data.trades);
        }
        await fetchDashboardAndTrades();
        return true;
      } else {
        alert(`فشل تسجيل الصفقة: ${data.error || 'خطأ غير معروف'}`);
        return false;
      }
    } catch (err: any) {
      console.error('Failed to save manual trade to server:', err);
      alert(`خطأ في حفظ الصفقة: ${err.message}`);
      return false;
    }
  };

  // Update Trade in Ledger (e.g. Closed)
  const handleUpdateTrade = async (updatedItem: TradeLedgerItem) => {
    try {
      const res = await fetch(`/api/trades/${updatedItem.id}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(updatedItem),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.trades)) {
          setLedger(data.trades);
        }
      }
      await fetchDashboardAndTrades();
    } catch (err) {
      console.warn('Failed to sync updated trade to server:', err);
    }
  };

  // Delete Trade from Ledger
  const handleDeleteTrade = async (id: string) => {
    try {
      const res = await fetch(`/api/trades/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.trades)) {
          setLedger(data.trades);
        }
      }
      await fetchDashboardAndTrades();
    } catch (err) {
      console.warn('Failed to delete trade from server:', err);
    }
  };

  // Toggle Background Scanner
  const handleToggleScanner = async (
    enabled: boolean,
    intervalMinutes: number,
    minConfidence: number,
    intervalSeconds?: number
  ) => {
    try {
      const res = await fetch('/api/scanner/toggle', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          enabled,
          intervalSeconds: intervalSeconds || intervalMinutes * 60,
          intervalMinutes,
          minConfidence,
          balance: currentBalance,
          losingStreak: stats.losingStreak,
          brokerSpecs: brokerSettings,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setScannerConfig(data.config);
      }
    } catch (e) {
      console.error('Toggle scanner error:', e);
    }
  };

  // Immediate Manual Scan
  const handleManualScan = async () => {
    setIsAnalyzing(true);
    try {
      const res = await fetch('/api/scanner/scan-now', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          balance: currentBalance,
          losingStreak: stats.losingStreak,
          brokerSpecs: brokerSettings,
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.signal) {
          setSignal(data.signal);
        }
        if (data.config) {
          setScannerConfig(data.config);
        }
        fetchCandleData(asset);
        fetchPrice(asset);
        fetchMultitimeframe();
      }
    } catch (err: any) {
      console.error('Manual scan error:', err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Manual Cancellation of Active/Dispatched Signal
  const handleCancelSignal = async (signalId: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/scanner/cancel-signal', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ id: signalId }),
      });
      if (res.ok) {
        setSignal(null);
        await fetchScannerStatus();
        return true;
      }
      return false;
    } catch (e) {
      console.error('Cancel signal error:', e);
      return false;
    }
  };

  // Reset Demo Balance
  const handleResetDemoBalance = async (newBal: number) => {
    setStartingBalance(newBal);
    setCurrentBalance(newBal);
    setActiveCapital(newBal);
    setLedger([]);
    setSignal(null);
    try {
      await fetch('/api/account/balance', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ currentBalance: newBal, startingBalance: newBal }),
      });
      await fetch('/api/settings', {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ manualCapital: newBal }),
      });
      await fetchDashboardAndTrades();
    } catch (e) {
      console.error('Reset demo balance error:', e);
    }
  };

  // Update Broker Settings
  const handleUpdateBrokerSettings = async (newSettings: BrokerSettings) => {
    await handleUpdateSettings({
      manualCapital: newSettings.accountBalance,
      riskPerTrade: newSettings.riskPercent,
      contractSizeOz: newSettings.contractSizeOz,
      minimumLot: newSettings.minimumLot,
      maximumLot: newSettings.maximumLot,
      lotStep: newSettings.lotStep,
      maxGoldSlPoints: newSettings.maxGoldSlPoints,
      minTp1RR: newSettings.minRr,
    });
  };

  return (
    <div
      className="min-h-screen bg-stone-950 text-stone-100 flex antialiased selection:bg-amber-500/30 selection:text-amber-200"
      dir="rtl"
    >
      {/* 1. Desktop Sidebar (hidden on mobile) */}
      <Sidebar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        scannerActive={scannerConfig.enabled}
        openTradesCount={ledger.filter((t) => t.result === 'OPEN').length}
      />

      {/* 2. Main Application Flow */}
      <div className="flex-1 flex flex-col min-w-0 pb-20 md:pb-6">
        {/* Top Sticky Header */}
        <TopNavbar
          activeTab={activeTab}
          asset={asset}
          price={currentPrice}
          currentPrice={currentPrice}
          prevPrice={prevPrice}
          spread={marketMetrics.spread}
          bid={marketMetrics.bid}
          ask={marketMetrics.ask}
          scannerOnline={scannerConfig.enabled}
          scannerActive={scannerConfig.enabled}
          marketOnline={isLiveConnected}
          isLiveConnected={isLiveConnected}
          marketProvider={marketMetrics.provider || 'Biquote MT5'}
          isAnalyzing={isAnalyzing}
          accountMode={appSettings.accountMode || 'DEMO'}
          mt5Account={mt5Account}
          onRefresh={() => fetchPrice(asset)}
          onRefreshPrice={() => fetchPrice(asset)}
          onManualScan={handleManualScan}
        />

        {/* Global Error Toast */}
        {errorToast && (
          <div className="max-w-7xl mx-auto w-full px-3 sm:px-6 pt-3">
            <div className="bg-rose-950/80 border border-rose-800 text-rose-200 text-xs sm:text-sm p-3 rounded-xl flex items-center justify-between">
              <span>{errorToast}</span>
              <button
                onClick={() => setErrorToast(null)}
                className="text-rose-400 hover:text-rose-100 font-bold px-2"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* Dynamic View Body */}
        <main className="flex-1 max-w-7xl w-full mx-auto p-3 sm:p-6">
          {activeTab === 'dashboard' && (
            <DashboardView
              currentPrice={currentPrice}
              prevPrice={prevPrice}
              marketMetrics={marketMetrics}
              scannerConfig={scannerConfig}
              stats={stats}
              currentBalance={currentBalance}
              settings={appSettings}
              activeCapital={activeCapital}
              mt5Account={mt5Account}
              signal={signal}
              currentSignal={signal}
              candles={candles}
              atr={atr}
              structure={structure}
              marketRegime={marketRegime}
              isOverextended={isOverextended}
              isLiveConnected={isLiveConnected}
              isAnalyzing={isAnalyzing}
              multitimeframe={multitimeframe}
              onNavigate={setActiveTab}
              onRunScan={handleManualScan}
              onRunScanNow={handleManualScan}
              onExecuteDemo={handleExecuteTrade}
            />
          )}

          {activeTab === 'scanner' && (
            <ScannerView
              config={scannerConfig}
              currentPrice={currentPrice}
              isAnalyzing={isAnalyzing}
              onToggleScanner={handleToggleScanner}
              onManualScan={handleManualScan}
              onCancelSignal={handleCancelSignal}
              multitimeframe={multitimeframe}
            />
          )}

          {activeTab === 'signals' && (
            <SignalsView
              currentSignal={signal}
              currentPrice={currentPrice}
              accountMode={appSettings.accountMode || 'DEMO'}
              onExecuteDemo={handleExecuteTrade}
            />
          )}

          {activeTab === 'trades' && (
            <TradesView
              ledger={ledger}
              currentBalance={currentBalance}
              currentPrice={currentPrice}
              accountMode={appSettings.accountMode || 'DEMO'}
              mt5Account={mt5Account}
              onAddTrade={handleAddTrade}
              onUpdateTrade={handleUpdateTrade}
              onDeleteTrade={handleDeleteTrade}
            />
          )}

          {activeTab === 'backtest' && (
            <BacktestView currentCapital={activeCapital} />
          )}

          {activeTab === 'risk' && (
            <RiskView
              settings={appSettings}
              activeCapital={activeCapital}
              mt5Account={mt5Account}
              currentBalance={currentBalance}
              brokerSettings={brokerSettings}
              onNavigateToSettings={() => setActiveTab('settings')}
            />
          )}

          {activeTab === 'analytics' && (
            <AnalyticsView stats={stats} ledger={ledger} startingBalance={startingBalance} />
          )}

          {activeTab === 'health' && <SystemHealthView />}

          {activeTab === 'settings' && (
            <SettingsView
              settings={appSettings}
              activeCapital={activeCapital}
              mt5Account={mt5Account}
              config={scannerConfig}
              brokerSettings={brokerSettings}
              ledger={ledger}
              currentBalance={currentBalance}
              onUpdateSettings={handleUpdateSettings}
              onUpdateBrokerSettings={handleUpdateBrokerSettings}
              onResetDemoBalance={handleResetDemoBalance}
            />
          )}
        </main>
      </div>

      {/* 3. Mobile Bottom Navigation Bar (visible on mobile only) */}
      <BottomNav
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        openTradesCount={ledger.filter((t) => t.result === 'OPEN').length}
        scannerOnline={scannerConfig.enabled}
        onOpenMore={() => setIsMoreDrawerOpen(true)}
        onOpenMoreDrawer={() => setIsMoreDrawerOpen(true)}
      />

      {/* 4. Mobile More Drawer */}
      <MobileMoreDrawer
        isOpen={isMoreDrawerOpen}
        activeTab={activeTab}
        onClose={() => setIsMoreDrawerOpen(false)}
        onSelectTab={(tab) => {
          setActiveTab(tab);
          setIsMoreDrawerOpen(false);
        }}
      />
    </div>
  );
}
