import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { AssetType } from './src/types.js';
import { analyzeTechnicals } from './server/indicators.js';
import { partition1hCandles, partition15mCandles, partition5mCandles, partition1mCandles } from './server/candleUtils.js';
import { fetchCandles, fetchCurrentPrice, fetchLiveQuote, getMultiTimeframeData } from './server/marketData.js';
import { runAIAnalysis } from './server/geminiTrader.js';
import { runXauusdBacktest } from './server/backtestEngine.js';
import { scanner } from './server/scanner.js';
import { calculatePositionSizing, evaluateTradeRisk } from './server/riskManager.js';
import { storage } from './server/storage.js';
import { mt5Bridge } from './server/mt5Bridge.js';
import { tradeMonitor } from './server/tradeMonitor.js';
import { tradeManagementEngine } from './server/tradeManagementEngine.js';
import { runTradeManagementTests } from './server/tradeManagementTests.js';
import { runAccountingTests } from './server/accountingTests.js';
import { globalLifecycleManager, globalPoiTracker } from './server/tradeQualityEngine.js';
import { telegramService } from './server/telegram.js';

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const httpServer = http.createServer(app);

  app.use(express.json());

  // Health check endpoint (Requirement 9 & Pre-Deployment Audit)
  app.get('/api/health', (req, res) => {
    const report = scanner.getHealthReport();
    const storageStats = storage.getStats();
    const hasBridgeToken = !!((process.env.MT5_BRIDGE_TOKEN || process.env.MT5_API_KEY || '').trim());
    const isPersistenceDurable = !!storageStats.durablePersistence;
    const isDegraded = !hasBridgeToken || !isPersistenceDurable;

    res.json({
      status: isDegraded ? 'degraded' : 'ok',
      scannerStatus: report.scannerStatus, // 'ONLINE' | 'OFFLINE'
      lastScanTime: report.lastScanTime,
      lastScanTimeFormatted: report.lastScanTimeFormatted,
      lastScanTimeIso: report.lastScanTimeIso,
      nextScanTime: report.nextScanTime,
      nextScanTimeFormatted: report.nextScanTimeFormatted,
      nextScanTimeIso: report.nextScanTimeIso,
      secondsToNextScan: report.secondsToNextScan,
      biquoteConnection: report.biquoteConnection,
      lastSuccessfulMarketDataTimestamp: report.lastSuccessfulMarketDataTimestamp,
      lastSuccessfulMarketDataTimeIso: report.lastSuccessfulMarketDataTimeIso,
      workerUptime: report.workerUptimeSeconds,
      workerUptimeFormatted: report.workerUptimeFormatted,
      scanCount: report.scanCount,
      lastDecision: report.lastDecision,
      duplicatePrevented: report.duplicatePrevented,
      activeSetupName: report.activeSetupName,
      isScanning: report.isScanning,
      service: 'Gold AI Challenge 24/7 Scanner Worker',
      marketProvider: 'Biquote (XAUUSD MT5 Feed)',
      storage: storageStats,
      bridgeSecurity: {
        tokenConfigured: hasBridgeToken,
        status: hasBridgeToken ? 'CONFIGURED' : 'UNCONFIGURED_MISSING_TOKEN',
        warning: hasBridgeToken ? undefined : 'DEPLOYMENT REQUIREMENT: Set MT5_BRIDGE_TOKEN in the environment to authorize the Windows MT5 client.',
      },
      scannerRuntime: {
        triggerMode: scanner.getTriggerMode(),
        internalTimerActive: scanner.isInternalTimerActive(),
        intervalSeconds: scanner.getConfig().intervalSeconds,
      },
      environment: {
        runtime: 'Node.js Autonomous Background Worker',
        host: '0.0.0.0',
        port: PORT,
        cronWebhookUrl: '/api/scanner/cron-tick',
        standaloneCommand: 'npm run worker',
        cloudRunScaleToZeroNote: 'Render Free instances sleep after 15m inactivity. Incoming MT5 heartbeats or an external cron pinger (e.g. cron-job.org pinging /api/scanner/cron-tick every 60s) keep it active.',
      },
      time: new Date().toISOString(),
      timestamp: Date.now(),
      aiModel: 'NVIDIA NIM DeepSeek V4 Flash (deepseek-ai/deepseek-v4-flash-0731)',
      hasNvidiaKey: !!process.env.NVIDIA_API_KEY && process.env.NVIDIA_API_KEY !== 'MY_NVIDIA_API_KEY',
      hasGeminiKey: !!process.env.NVIDIA_API_KEY && process.env.NVIDIA_API_KEY !== 'MY_NVIDIA_API_KEY',
    });
  });

  // Get current live market price with Biquote quote details (bid/ask/spread)
  app.get('/api/market/price', async (req, res) => {
    try {
      const asset = (req.query.asset as AssetType) || 'XAU/USD';
      const quote = await fetchLiveQuote(asset);
      res.json({
        asset,
        price: quote.mid,
        bid: quote.bid,
        ask: quote.ask,
        spread: quote.spread,
        high: quote.high,
        low: quote.low,
        marketState: quote.marketState,
        source: quote.source,
        provider: 'Biquote',
        timestamp: Date.now(),
      });
    } catch (error: any) {
      console.error('Error fetching price from Biquote:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch market price' });
    }
  });

  // Get real OHLCV candles from Biquote (up to 1000 bars)
  app.get('/api/market/candles', async (req, res) => {
    try {
      const asset = (req.query.asset as AssetType) || 'XAU/USD';
      const timeframe = (req.query.timeframe as any) || '15m';
      const limit = Math.min(1000, parseInt(req.query.limit as string) || 100);

      const candles = await fetchCandles(asset, timeframe, limit);
      const technicals = analyzeTechnicals(candles);

      res.json({
        asset,
        provider: 'Biquote',
        timeframe,
        candles,
        technicals,
        lastPrice: candles[candles.length - 1]?.close || 0,
      });
    } catch (error: any) {
      console.error('Error fetching candles from Biquote:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch candle data' });
    }
  });

  // Multi-timeframe structure & technicals overview (1H, 15M, 5M)
  app.get('/api/market/multitimeframe', async (req, res) => {
    try {
      const asset = ((req.query.asset as string) || 'XAU/USD') as AssetType;
      const mtfData = await getMultiTimeframeData(asset);
      const quoteTime = typeof mtfData.quote?.timestamp === 'number' ? mtfData.quote.timestamp : Date.now();
      const closedH1 = partition1hCandles(mtfData.candles1h, quoteTime).closedCandles;
      const closedM15 = partition15mCandles(mtfData.candles15m, quoteTime).closedCandles;
      const closedM5 = partition5mCandles(mtfData.candles5m, quoteTime).closedCandles;

      const ind1h = analyzeTechnicals(closedH1.length > 0 ? closedH1 : mtfData.candles1h);
      const ind15m = analyzeTechnicals(closedM15.length > 0 ? closedM15 : mtfData.candles15m);
      const ind5m = analyzeTechnicals(closedM5.length > 0 ? closedM5 : mtfData.candles5m);

      // Determine overall market state
      let marketState: 'TREND' | 'RANGE' | 'CONSOLIDATION' = 'RANGE';
      if (ind1h.structure === 'BULLISH' || ind1h.structure === 'BEARISH') {
        marketState = 'TREND';
      } else if (ind5m.atr14 < 1.8) {
        marketState = 'CONSOLIDATION';
      }

      res.json({
        success: true,
        asset,
        currentPrice: mtfData.currentPrice,
        marketState,
        marketRegime: ind15m.marketRegime,
        regimeContext: ind15m.regimeContext,
        h1: {
          trend: ind1h.structure, // BULLISH | BEARISH | RANGING
          rsi: ind1h.rsi14,
          ema20: ind1h.ema20,
          ema50: ind1h.ema50,
          support: ind1h.support,
          resistance: ind1h.resistance,
        },
        m15: {
          structure: ind15m.structure,
          zone: ind15m.premiumDiscountZone,
          support: ind15m.support,
          resistance: ind15m.resistance,
        },
        m5: {
          structure: ind5m.structure,
          atr: ind5m.atr14,
          rsi: ind5m.rsi14,
          vwap: ind5m.vwap,
        },
        timestamp: Date.now(),
      });
    } catch (error: any) {
      console.error('Error fetching multitimeframe overview:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Run full Multi-timeframe AI Gold Scan (1H, 15M, 5M, 1M)
  app.post('/api/analyze', async (req, res) => {
    try {
      const { asset = 'XAU/USD', balance = 10, losingStreak = 0, brokerSpecs } = req.body;
      const accountBalance = Math.max(1, Number(balance));

      // Gather multi-timeframe live market data
      const marketData = await getMultiTimeframeData(asset);
      const rawTs = marketData.quote?.timestamp;
      const quoteTime = typeof rawTs === 'number'
        ? rawTs
        : typeof rawTs === 'string'
        ? new Date(rawTs).getTime()
        : rawTs instanceof Date
        ? rawTs.getTime()
        : Date.now();

      const part1h = partition1hCandles(marketData.candles1h, quoteTime);
      const part15m = partition15mCandles(marketData.candles15m, quoteTime);
      const part5m = partition5mCandles(marketData.candles5m, quoteTime);
      const part1m = partition1mCandles(marketData.candles1m, quoteTime);

      if (!part1h.isValid || !part15m.isValid || !part5m.isValid || !part1m.isValid ||
          part1h.closedCandles.length === 0 || part15m.closedCandles.length === 0 ||
          part5m.closedCandles.length === 0 || part1m.closedCandles.length === 0) {
        return res.json({
          success: false,
          error: 'DATA_INTEGRITY_FAIL: Market data partitioning validation failed (closed candles required)',
        });
      }

      const validClosedH1 = part1h.closedCandles;
      const validClosedM15 = part15m.closedCandles;
      const validClosedM5 = part5m.closedCandles;
      const validClosedM1 = part1m.closedCandles;

      // Run technical & market structure analysis
      const ind1h = analyzeTechnicals(validClosedH1);
      const ind15m = analyzeTechnicals(validClosedM15);
      const ind5m = analyzeTechnicals(validClosedM5);

      // Run AI Trading Agent (Gemini + Risk Manager + Selective rule check)
      const signal = await runAIAnalysis({
        asset,
        balance: accountBalance,
        currentPrice: marketData.currentPrice,
        indicators1h: ind1h,
        indicators15m: ind15m,
        indicators5m: ind5m,
        candles1h: validClosedH1,
        candles15m: validClosedM15,
        recent5mCandles: validClosedM5,
        recent1mCandles: validClosedM1,
        losingStreak: Number(losingStreak) || 0,
        brokerSpecs,
      });

      res.json({
        success: true,
        signal,
        marketOverview: {
          asset,
          currentPrice: marketData.currentPrice,
          h1Structure: ind1h.structure,
          m15Zone: ind15m.premiumDiscountZone,
          marketRegime: ind15m.marketRegime,
          regimeContext: ind15m.regimeContext,
          m5Atr: ind5m.atr14,
          m5Rsi: ind5m.rsi14,
          support: ind15m.support,
          resistance: ind15m.resistance,
          lastUpdated: Date.now(),
        },
      });
    } catch (error: any) {
      console.error('Analysis error:', error);
      res.status(500).json({ success: false, error: error.message || 'Analysis failed' });
    }
  });

  // Calculate & evaluate risk & position sizing directly
  app.post('/api/risk/evaluate', (req, res) => {
    try {
      const {
        balance = 10,
        entry,
        stopLoss,
        tp1,
        tp2,
        confidence = 78,
        asset = 'XAU/USD',
        brokerSpecs = {},
      } = req.body;

      const evalResult = evaluateTradeRisk({
        balance: Number(balance),
        entry: Number(entry),
        stopLoss: Number(stopLoss),
        tp1: Number(tp1),
        tp2: tp2 ? Number(tp2) : undefined,
        confidence: Number(confidence),
        asset,
        brokerSpecs: {
          accountBalance: Number(balance),
          riskPercent: Number(brokerSpecs.riskPercent ?? 1.5),
          contractSizeOz: Number(brokerSpecs.contractSizeOz ?? 100),
          minimumLot: Number(brokerSpecs.minimumLot ?? 0.01),
          maximumLot: Number(brokerSpecs.maximumLot ?? 100),
          lotStep: Number(brokerSpecs.lotStep ?? 0.01),
          minGoldSlPoints: Number(brokerSpecs.minGoldSlPoints ?? 40),
          maxGoldSlPoints: Number(brokerSpecs.maxGoldSlPoints ?? 50),
          minRr: Number(brokerSpecs.minRr ?? 1.5),
          maxLoss: brokerSpecs.maxLoss !== undefined ? Number(brokerSpecs.maxLoss) : undefined,
        },
      });

      res.json({ success: true, result: evalResult });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Run XAU/USD Historical Backtesting Engine (Strictly Real Data, Zero Mock)
  app.post('/api/backtest/run', async (req, res) => {
    try {
      const { initialCapital = 10, timeRange = '7D', riskPercent, allowAvailableSlice } = req.body || {};
      const parsedCapital = Number(initialCapital) || 10;
      const parsedRange = String(timeRange || '7D') as '1D' | '3D' | '7D' | '14D' | '30D' | '60D' | '90D' | '180D' | '365D';
      const parsedRisk = typeof riskPercent === 'number' && riskPercent > 0 ? Number(riskPercent) : undefined;

      console.log(`[API /api/backtest/run] Received request: Capital = $${parsedCapital}, Period = ${parsedRange}, Risk = ${parsedRisk ?? 15}%, AllowAvailableSlice = ${Boolean(allowAvailableSlice)}`);

      const summary = await runXauusdBacktest({
        initialCapital: parsedCapital,
        timeRange: parsedRange,
        riskPercent: parsedRisk,
        allowAvailableSlice: Boolean(allowAvailableSlice),
      });

      console.log(`[API /api/backtest/run] Completed run ${summary.runId}: ${summary.totalTrades} trades, WinRate: ${summary.winRate}%, NetProfit: $${summary.netProfit}, Candles: ${summary.candlesEvaluated}`);

      // Save backtest results in separate storage
      storage.saveBacktestResult(summary);

      res.json({
        success: true,
        summary,
      });
    } catch (error: any) {
      console.error('[API /api/backtest/run] Execution failed:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'فشل تشغيل الـBacktest.',
        validationReport: error.validationReport,
      });
    }
  });

  // Retrieve last saved backtest results
  app.get('/api/backtest/latest', (req, res) => {
    try {
      const latest = storage.getBacktestResult();
      res.json({ success: true, summary: latest });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Dashboard stats endpoint (Persistent single-source-of-truth)
  app.get('/api/dashboard/stats', (req, res) => {
    try {
      const stats = storage.getDashboardStats();
      const health = scanner.getHealthReport();
      res.json({
        success: true,
        stats: {
          ...stats,
          scannerOnline: health.scannerStatus === 'ONLINE',
          lastScanTimeFormatted: health.lastScanTimeFormatted,
          nextScanTimeFormatted: health.nextScanTimeFormatted,
          secondsToNextScan: health.secondsToNextScan,
          activeSetupName: health.activeSetupName,
        }
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Account balance endpoints (Persistent)
  app.get('/api/account/balance', (req, res) => {
    try {
      const balanceInfo = storage.getBalance();
      res.json({ success: true, ...balanceInfo });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/account/balance', (req, res) => {
    try {
      const { currentBalance, startingBalance } = req.body || {};
      if (typeof currentBalance !== 'number' || isNaN(currentBalance)) {
        return res.status(400).json({ success: false, error: 'currentBalance must be a valid number' });
      }
      const updated = storage.updateBalance(currentBalance, startingBalance);
      res.json({ success: true, ...updated });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/trades/reset-state', async (req, res) => {
    try {
      const result = await storage.resetTradingState();
      globalLifecycleManager.clear();
      globalPoiTracker.clear();
      res.json(result);
    } catch (error: any) {
      console.error('[API /api/trades/reset-state] Reset failed:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Settings: GET current system settings and derived activeCapital
  app.get('/api/settings', async (req, res) => {
    try {
      const settings = storage.getSettings();
      const mt5Status = await mt5Bridge.getAccountStatus();
      let activeCapital = settings.manualCapital;
      if (settings.capitalSource === 'MT5') {
        activeCapital = mt5Status.connected && typeof mt5Status.balance === 'number' ? mt5Status.balance : 0;
      }
      const riskAmount = Number(((activeCapital * settings.riskPerTrade) / 100).toFixed(2));
      const maxAllowedRiskAmount = Number(((activeCapital * settings.maxRiskPerTrade) / 100).toFixed(2));

      const balanceInfo = storage.getBalance();
      res.json({
        success: true,
        settings,
        activeCapital,
        startingBalance: balanceInfo.startingBalance,
        currentBalance: balanceInfo.currentBalance,
        riskAmount,
        maxAllowedRiskAmount,
        mt5Status,
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Settings: PUT update system settings with strict validation
  app.put('/api/settings', async (req, res) => {
    try {
      const patch = req.body || {};
      const saveResult = storage.saveSettings(patch);
      if (!saveResult.success) {
        return res.status(400).json({ success: false, error: saveResult.error });
      }

      const updatedSettings = saveResult.settings;
      const mt5Status = await mt5Bridge.getAccountStatus();
      let activeCapital = updatedSettings.manualCapital;
      if (updatedSettings.capitalSource === 'MT5') {
        activeCapital = mt5Status.connected && typeof mt5Status.balance === 'number' ? mt5Status.balance : 0;
      }

      // Sync scanner state with new settings immediately
      scanner.setAccountContext(activeCapital, 0, {
        accountBalance: activeCapital,
        riskPercent: updatedSettings.riskPerTrade,
        contractSizeOz: updatedSettings.contractSizeOz,
        minimumLot: updatedSettings.minimumLot,
        maximumLot: updatedSettings.maximumLot,
        lotStep: updatedSettings.lotStep,
        maxGoldSlPoints: updatedSettings.maxGoldSlPoints,
        minRr: updatedSettings.minTp1RR,
        maxLoss: updatedSettings.maxLoss,
      });
      scanner.updateConfig({ minConfidence: updatedSettings.minimumConfidence });

      const riskAmount = Number(((activeCapital * updatedSettings.riskPerTrade) / 100).toFixed(2));
      const maxAllowedRiskAmount = Number(((activeCapital * updatedSettings.maxRiskPerTrade) / 100).toFixed(2));
      const balanceInfo = storage.getBalance();

      res.json({
        success: true,
        settings: updatedSettings,
        activeCapital,
        startingBalance: balanceInfo.startingBalance,
        currentBalance: balanceInfo.currentBalance,
        riskAmount,
        maxAllowedRiskAmount,
        mt5Status,
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // MT5 Bridge Authentication Middleware
  const verifyBridgeToken = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const configuredToken = (process.env.MT5_BRIDGE_TOKEN || process.env.MT5_API_KEY || '').trim();
    if (!configuredToken) {
      return res.status(503).json({
        success: false,
        error: 'MT5 bridge is not configured: MT5_BRIDGE_TOKEN is required in the environment before bridge endpoints can be accessed.',
      });
    }
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
    if (!token || token !== configuredToken) {
      return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or missing MT5 bridge token' });
    }
    next();
  };

  // =========================================================================
  // Windows MT5 Bridge Outbound Agent Endpoints
  // =========================================================================

  // Inbound heartbeat from Windows MT5 Bridge Client
  app.post('/api/mt5/bridge/heartbeat', verifyBridgeToken, (req, res) => {
    try {
      const result = mt5Bridge.handleBridgeHeartbeat(req.body);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Windows Bridge polls for pending commands to execute on MT5
  app.get('/api/mt5/bridge/commands/poll', verifyBridgeToken, (req, res) => {
    try {
      const commands = mt5Bridge.pollPendingCommands();
      res.json({ success: true, count: commands.length, commands });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Windows Bridge reports command execution results
  app.post('/api/mt5/bridge/commands/:commandId/result', verifyBridgeToken, (req, res) => {
    try {
      const { commandId } = req.params;
      const result = mt5Bridge.handleCommandResult(commandId, req.body);
      
      // If filled, save to ledger
      if (req.body.status === 'FILLED') {
        const cmdStatus = mt5Bridge.getStatus();
        const cmd = cmdStatus.commands.recent.find((c) => c.commandId === commandId);
        if (cmd) {
          const tradeItem: any = {
            id: `mt5_${req.body.positionTicket || req.body.orderTicket || Date.now()}`,
            tradeNumber: (storage.getTrades(1)[0]?.tradeNumber || 0) + 1,
            date: new Date().toLocaleDateString('ar-EG', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
            isoTime: new Date().toISOString(),
            asset: 'XAU/USD',
            direction: cmd.action,
            entry: req.body.executionPrice || cmd.price,
            sl: cmd.sl,
            slPoints: Math.round(Math.abs((req.body.executionPrice || cmd.price || 0) - cmd.sl) / 0.1),
            tp1: cmd.tp,
            tp1Points: Math.round(Math.abs(cmd.tp - (req.body.executionPrice || cmd.price || 0)) / 0.1),
            tp2: cmd.tp2,
            tp2Points: cmd.tp2 ? Math.round(Math.abs(cmd.tp2 - (req.body.executionPrice || cmd.price || 0)) / 0.1) : undefined,
            rr: '1:2.0',
            riskPercent: 1.5,
            riskAmount: 1.5,
            lotSize: cmd.volume,
            confidence: 85,
            setup: 'GB-V5 Demo Execution',
            result: 'OPEN',
            balanceAfterTrade: storage.getSettings().manualCapital,
            notes: `Executed via Windows MT5 Demo Bridge [Ticket #${req.body.positionTicket || req.body.orderTicket}]`,
          };
          storage.saveTrade(tradeItem);
        }
      }

      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Windows Bridge pushes historical candles for backtesting
  app.post('/api/mt5/bridge/historical-candles', verifyBridgeToken, (req, res) => {
    try {
      const { timeframe, candles } = req.body;
      if (!timeframe || !Array.isArray(candles)) {
        return res.status(400).json({ success: false, error: 'timeframe and candles array required' });
      }
      mt5Bridge.storeHistoricalCandles(timeframe, candles);
      res.json({ success: true, count: candles.length });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Windows Bridge reports confirmed deals from MT5 for ledger reconciliation
  app.post('/api/mt5/bridge/deals', verifyBridgeToken, (req, res) => {
    try {
      const { deals } = req.body;
      if (!Array.isArray(deals)) {
        return res.status(400).json({ success: false, error: 'deals array required' });
      }
      const result = mt5Bridge.handleDealsReport(deals);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // =========================================================================
  // User & Dashboard MT5 Control Endpoints
  // =========================================================================

  // Comprehensive MT5 Status (Account, Safety, Limits, Positions, Commands)
  app.get('/api/mt5/status', (req, res) => {
    res.json(mt5Bridge.getStatus());
  });

  // Enable Demo Auto-Trading (Strict user action required)
  app.post('/api/mt5/auto-trading/enable', (req, res) => {
    const result = mt5Bridge.enableDemoAutoTrading();
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.reason });
    }
    // Also update settings in storage
    storage.saveSettings({ autoTradingEnabled: true, executionMode: 'DEMO', accountMode: 'DEMO' });
    res.json({ success: true, message: 'تم تفعيل التداول التجريبي التلقائي (Demo Auto-Trading) بنجاح.' });
  });

  // Disable Demo Auto-Trading
  app.post('/api/mt5/auto-trading/disable', (req, res) => {
    mt5Bridge.disableDemoAutoTrading();
    storage.saveSettings({ autoTradingEnabled: false });
    res.json({ success: true, message: 'تم إيقاف التداول التجريبي التلقائي.' });
  });

  // Emergency Kill-Switch
  app.post('/api/mt5/kill-switch', (req, res) => {
    const { reason } = req.body || {};
    mt5Bridge.activateKillSwitch(reason || 'Manual Emergency Trigger');
    storage.saveSettings({ autoTradingEnabled: false });
    res.json({ success: true, message: 'تم تفعيل زر الطوارئ (Kill Switch) وإيقاف جميع الأوامر فوراً.' });
  });

  // Reset Kill-Switch
  app.post('/api/mt5/kill-switch/reset', (req, res) => {
    mt5Bridge.resetKillSwitch();
    res.json({ success: true, message: 'تمت إعادة ضبط زر الطوارئ (يبقى التداول معطلاً لحين التفعيل اليدوي الصريح).' });
  });

  // Open Positions
  app.get('/api/mt5/positions', (req, res) => {
    res.json({
      success: true,
      allPositions: mt5Bridge.getAllPositions(),
      botManagedPositions: mt5Bridge.getBotManagedPositions(),
    });
  });

  // MT5 Account info endpoint (Compatibility)
  app.get('/api/mt5/account', async (req, res) => {
    try {
      const account = await mt5Bridge.getAccountStatus();
      res.json({ success: true, account });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // MT5 Order Queue Endpoint
  app.post('/api/mt5/order', async (req, res) => {
    try {
      const {
        symbol = 'XAUUSD',
        signal,
        action,
        lot,
        entryPrice,
        stopLoss,
        takeProfit,
        takeProfit2,
        comment,
      } = req.body;

      let resolvedAction: 'BUY' | 'SELL' | 'BUY_LIMIT' | 'SELL_LIMIT' = 'BUY';
      const dirStr = String(action || signal || '').toUpperCase();
      if (dirStr.includes('BUY LIMIT')) resolvedAction = 'BUY_LIMIT';
      else if (dirStr.includes('SELL LIMIT')) resolvedAction = 'SELL_LIMIT';
      else if (dirStr.includes('SELL')) resolvedAction = 'SELL';
      else resolvedAction = 'BUY';

      const queueRes = mt5Bridge.queueDemoOrder({
        action: resolvedAction,
        symbol: symbol.replace('/', ''),
        volume: Number(lot) || 0.01,
        price: Number(entryPrice),
        sl: Number(stopLoss),
        tp: Number(takeProfit),
        tp2: takeProfit2 ? Number(takeProfit2) : undefined,
        comment: comment || 'GB-V5 Manual Demo Trade',
      });

      if (!queueRes.success) {
        return res.status(400).json({ success: false, error: queueRes.reason });
      }

      res.json({
        success: true,
        commandId: queueRes.commandId,
        message: 'تم إدراج الأمر في قائمة انتظار التنفيذ التجريبي لـ MT5 بنجاح.',
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // MT5 Modify Order Endpoint (Modify SL / TP)
  app.post('/api/mt5/modify', async (req, res) => {
    try {
      const { ticket, stopLoss, takeProfit } = req.body;
      const settings = storage.getSettings();
      const accountMode = settings.accountMode || 'DEMO';

      if (!ticket) {
        return res.status(400).json({ success: false, error: 'رقم التذكرة (ticket) مطلوب.' });
      }

      const result = await mt5Bridge.modifyOrder({
        ticket: Number(ticket),
        stopLoss: stopLoss !== undefined ? Number(stopLoss) : undefined,
        takeProfit: takeProfit !== undefined ? Number(takeProfit) : undefined,
        accountMode,
      });

      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // MT5 Close Order Endpoint
  app.post('/api/mt5/close', async (req, res) => {
    try {
      const { ticket, lot, tradeId, closePrice } = req.body;
      const settings = storage.getSettings();
      const accountMode = settings.accountMode || 'DEMO';

      if (!ticket && !tradeId) {
        return res.status(400).json({ success: false, error: 'رقم التذكرة (ticket) أو معرف الصفقة (tradeId) مطلوب.' });
      }

      const bridgeRes = await mt5Bridge.closeOrder({
        ticket: Number(ticket || 0),
        lot: lot ? Number(lot) : undefined,
        accountMode,
      });

      // Also update in internal ledger if tradeId provided
      if (tradeId) {
        const trades = storage.getTrades(50);
        const existing = trades.find(t => t.id === tradeId);
        if (existing && existing.result === 'OPEN') {
          const exitPrice = Number(closePrice) || existing.entry;
          const isBuy = existing.direction.includes('BUY');
          const plPerOz = isBuy ? exitPrice - existing.entry : existing.entry - exitPrice;
          const profit = Number((plPerOz * (existing.lotSize || 0.01) * 100).toFixed(2));
          storage.closeTrade(tradeId, profit >= 0 ? 'WIN' : 'LOSS', profit, exitPrice);
        }
      }

      res.json({
        success: bridgeRes.success,
        message: bridgeRes.message,
        trades: storage.getTrades(50),
        dailyStats: storage.getTodayStats(),
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // MT5 Query Order Status Endpoint
  app.get('/api/mt5/order-status', async (req, res) => {
    try {
      const ticket = Number(req.query.ticket);
      if (!ticket) {
        return res.status(400).json({ success: false, error: 'رقم التذكرة (ticket) مطلوب.' });
      }
      const result = await mt5Bridge.getOrderStatus(ticket);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Scanner status and config
  app.get('/api/scanner/status', (req, res) => {
    res.json(scanner.getStatus());
  });

  // Scanner pause control
  app.post('/api/scanner/pause', (req, res) => {
    try {
      scanner.pause();
      res.json({ success: true, isPaused: true, status: scanner.getStatus() });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Scanner resume control
  app.post('/api/scanner/resume', (req, res) => {
    try {
      scanner.resume();
      res.json({ success: true, isPaused: false, status: scanner.getStatus() });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Scanner manual trigger
  app.post('/api/scanner/scan-now', async (req, res) => {
    try {
      const { balance, losingStreak, brokerSpecs, force } = req.body || {};
      if (balance !== undefined) {
        scanner.setAccountContext(Number(balance), Number(losingStreak) || 0, brokerSpecs);
      }
      const signal = await scanner.triggerManualScan(Boolean(force));
      res.json({ success: true, signal, config: scanner.getConfig() });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Scanner toggle and config update
  app.post('/api/scanner/toggle', (req, res) => {
    try {
      const {
        enabled,
        intervalSeconds,
        intervalMinutes,
        minConfidence,
        balance,
        losingStreak,
        brokerSpecs,
      } = req.body;
      
      if (balance !== undefined) {
        scanner.setAccountContext(Number(balance), Number(losingStreak) || 0, brokerSpecs);
      }

      const updated = scanner.updateConfig({
        ...(enabled !== undefined ? { enabled: Boolean(enabled) } : {}),
        ...(intervalSeconds !== undefined ? { intervalSeconds: Math.max(10, Number(intervalSeconds)) } : {}),
        ...(intervalMinutes !== undefined ? { intervalMinutes: Math.max(0.5, Number(intervalMinutes)) } : {}),
        ...(minConfidence !== undefined ? { minConfidence: Math.min(100, Math.max(50, Number(minConfidence))) } : {}),
      });

      res.json({ success: true, config: updated });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Manual cancellation of an ACTIVE/APPROVED/DISPATCHED signal
  app.post('/api/scanner/cancel-signal', (req, res) => {
    try {
      const { id } = req.body;
      if (!id) {
        return res.status(400).json({ success: false, error: 'Missing opportunity ID or signal ID (id)' });
      }
      const success = scanner.cancelActiveSignal(id);
      if (success) {
        res.json({ success: true, message: 'Signal cancelled successfully' });
      } else {
        res.status(404).json({ success: false, error: 'Opportunity or Signal not found' });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Persistent storage endpoint: Retrieve scan history (Requirement 7 & 8)
  app.get('/api/scanner/history', (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
      const scans = storage.getScans(limit);
      res.json({ success: true, count: scans.length, scans });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Persistent storage endpoint: Retrieve saved trade signals
  app.get('/api/scanner/signals', (req, res) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 30));
      const signals = storage.getSignals(limit);
      res.json({ success: true, count: signals.length, signals });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Trade Ledger Endpoints (Real Trade & Simulation Ledger)
  app.get('/api/trades', (req, res) => {
    try {
      const limit = Math.min(300, Math.max(1, parseInt(req.query.limit as string) || 100));
      const trades = storage.getTrades(limit);
      const dailyStats = storage.getTodayStats();
      res.json({ success: true, count: trades.length, trades, dailyStats });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/trades', async (req, res) => {
    try {
      const trade = req.body;
      if (!trade) {
        return res.status(400).json({ success: false, error: 'Trade payload is required' });
      }

      const id = trade.id || `trade_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const highestNum = Math.max(0, ...storage.getTrades(300).map((t) => t.tradeNumber || 0));
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

      // Check daily risk limit & daily trade count
      const todayStats = storage.getTodayStats();
      if (trade.result === 'OPEN' && todayStats.tradesCount >= 3) {
        return res.status(400).json({
          success: false,
          error: 'تم تجاوز الحد الأقصى للصفقات اليومية (3 صفقات يومياً) - حماية رأس المال مفعّلة.',
        });
      }
      if (trade.result === 'OPEN' && todayStats.totalRiskPercentUsed + (trade.riskPercent || 0) > 30) {
        return res.status(400).json({
          success: false,
          error: 'تم تجاوز الحد الأقصى للمخاطرة اليومية (30%) - حماية رأس المال مفعّلة.',
        });
      }

      const isClosed = trade.result === 'WIN' || trade.result === 'LOSS';
      const pl = typeof trade.pl === 'number' ? trade.pl : 0;

      const formattedTrade = {
        ...trade,
        id,
        tradeNumber,
        date,
        isoTime,
        asset: trade.asset || 'XAU/USD',
        source: trade.source || 'MANUAL',
        isActive: trade.isActive !== undefined ? trade.isActive : !isClosed,
        pl,
        realizedPnl: isClosed ? pl : undefined,
        closedAt: isClosed ? (trade.closedAt || Date.now()) : undefined,
      };

      const updatedLedger = await storage.saveTradeAsync(formattedTrade);

      // If closed immediately with P&L, update balance and record outcome
      if (isClosed && pl !== 0) {
        await storage.updateBalanceFromManualTrade(pl);
        const outcomeRecord: any = {
          signalId: formattedTrade.signalId || formattedTrade.id,
          tradeId: formattedTrade.id,
          direction: formattedTrade.direction,
          orderType: 'MARKET',
          entry: formattedTrade.entry,
          stopLoss: formattedTrade.sl,
          tp1: formattedTrade.tp1,
          tp2: formattedTrade.tp2,
          outcome: formattedTrade.result,
          realizedPnl: pl,
          pl,
          exitPrice: formattedTrade.exitPrice || (formattedTrade.result === 'WIN' ? formattedTrade.tp1 : formattedTrade.sl),
          source: formattedTrade.source || 'MANUAL',
          closedAt: formattedTrade.closedAt || Date.now(),
          closeReason: formattedTrade.closeReason || 'MANUAL_ENTRY',
          timestamp: Date.now(),
          isoTime: new Date().toISOString(),
        };
        await storage.recordTradeOutcomeAsync(outcomeRecord);
      }

      const dailyStats = storage.getTodayStats();
      res.json({ success: true, trade: formattedTrade, trades: updatedLedger, dailyStats });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.put('/api/trades/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const patch = req.body;
      const trades = storage.getTrades(300);
      const existing = trades.find((t) => t.id === id);
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Trade not found' });
      }

      const wasOpen = existing.result === 'OPEN';
      const prevPl = typeof existing.pl === 'number' ? existing.pl : 0;
      const isNowClosed = patch.result === 'WIN' || patch.result === 'LOSS';
      const newPl = typeof patch.pl === 'number' ? patch.pl : prevPl;

      const updatedItem = {
        ...existing,
        ...patch,
        isActive: patch.isActive !== undefined ? patch.isActive : (isNowClosed ? false : existing.isActive),
        closedAt: isNowClosed ? (patch.closedAt || existing.closedAt || Date.now()) : existing.closedAt,
        realizedPnl: isNowClosed ? newPl : existing.realizedPnl,
        pl: isNowClosed ? newPl : (patch.pl !== undefined ? patch.pl : existing.pl),
      };

      const updatedLedger = await storage.saveTradeAsync(updatedItem);

      // If closed or P&L updated, adjust balance and record outcome
      if (isNowClosed) {
        const delta = wasOpen ? newPl : (newPl - prevPl);
        if (delta !== 0) {
          await storage.updateBalanceFromManualTrade(delta);
        }
        const outcomeRecord: any = {
          signalId: updatedItem.signalId || updatedItem.id,
          tradeId: updatedItem.id,
          direction: updatedItem.direction,
          orderType: 'MARKET',
          entry: updatedItem.entry,
          stopLoss: updatedItem.sl,
          tp1: updatedItem.tp1,
          tp2: updatedItem.tp2,
          outcome: updatedItem.result,
          realizedPnl: newPl,
          pl: newPl,
          exitPrice: updatedItem.exitPrice || (updatedItem.result === 'WIN' ? updatedItem.tp1 : updatedItem.sl),
          source: updatedItem.source || 'MANUAL',
          closedAt: updatedItem.closedAt || Date.now(),
          closeReason: updatedItem.closeReason || 'MANUAL_UPDATE',
          timestamp: Date.now(),
          isoTime: new Date().toISOString(),
        };
        await storage.recordTradeOutcomeAsync(outcomeRecord);
      }

      const dailyStats = storage.getTodayStats();
      res.json({ success: true, trade: updatedItem, trades: updatedLedger, dailyStats });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/trades', async (req, res) => {
    try {
      const updatedLedger = await storage.clearAllTrades();
      const dailyStats = storage.getTodayStats();
      res.json({ success: true, count: 0, trades: updatedLedger, dailyStats });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/trades/:id', (req, res) => {
    try {
      const { id } = req.params;
      const updatedLedger = storage.deleteTrade(id);
      const dailyStats = storage.getTodayStats();
      res.json({ success: true, trades: updatedLedger, dailyStats });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/trades/daily-stats', (req, res) => {
    try {
      const dailyStats = storage.getTodayStats();
      res.json({ success: true, dailyStats });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Trade Lifecycle Monitor Status
  app.get('/api/trades/monitor-status', (req, res) => {
    try {
      res.json({ success: true, status: tradeMonitor.getStatus() });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Phase 4: Trade Management Test Suite
  app.get('/api/trade-management/tests', async (req, res) => {
    try {
      const testReport = await runTradeManagementTests();
      res.json({ success: true, ...testReport });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Phase 4: Trade Management Status
  app.get('/api/trade-management/status', (req, res) => {
    try {
      const openTrades = storage.getTrades(300).filter((t) => t.result === 'OPEN' && t.isActive !== false);
      const settings = storage.getSettings();
      res.json({
        success: true,
        enabled: settings.enableTradeManagement !== false,
        partialClosePercent: settings.partialClosePercent || 50,
        autoTradingEnabled: settings.autoTradingEnabled === true,
        activeTradesCount: openTrades.length,
        activeTrades: openTrades.map((t) => ({
          id: t.id,
          direction: t.direction,
          entry: t.entry,
          sl: t.sl,
          tp1: t.tp1,
          tp2: t.tp2,
          managementState: t.managementState || 'HOLD',
          lastAction: t.lastManagementAction,
          partialClosed: t.partialClosed || false,
          suggestedSL: t.suggestedSL,
          suggestedTP2: t.suggestedTP2,
        })),
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // External 24/7 Cron Tick Webhook (Requirement 11)
  // Can be called every 60s by Cloud Scheduler, cron-job.org, GitHub Actions, or UptimeRobot
  const handleCronTick = async (req: express.Request, res: express.Response) => {
    try {
      const result = await scanner.triggerCronTick();
      res.json({
        success: true,
        timestamp: Date.now(),
        time: new Date().toISOString(),
        message: result.skipped ? `Scan skipped: ${result.reason || 'cooldown'}` : '24/7 Server-side scan tick executed successfully',
        health: result.health,
        signalDecision: result.signal?.signal || 'NO TRADE',
        signal: result.signal,
        status: result.status,
        skipped: result.skipped,
        reason: result.reason,
      });
    } catch (error: any) {
      console.error('Error in /api/scanner/cron-tick:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  };
  app.get('/api/scanner/cron-tick', handleCronTick);
  app.post('/api/scanner/cron-tick', handleCronTick);

  // Get persisted trade outcomes
  app.get('/api/outcomes', (req, res) => {
    try {
      const outcomes = storage.getTradeOutcomes();
      res.json({ success: true, outcomes });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Failed to retrieve outcomes' });
    }
  });

  // Brand-new Telegram integration endpoints
  app.get('/api/telegram/status', (req, res) => {
    try {
      const status = telegramService.getStatus();
      res.json({ success: true, ...status });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Failed to retrieve Telegram status' });
    }
  });

  app.post('/api/telegram/test', async (req, res) => {
    try {
      const result = await telegramService.sendTestNotification();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Failed to trigger Telegram test' });
    }
  });

  /**
   * DIAGNOSTIC TEST ENDPOINT: POST /api/telegram/test-signal
   * Sends a simple direct test message to verify Telegram bot connectivity.
   * Never mutates storage, opportunities, accounting, scanner, or trade ledger state.
   */
  app.post('/api/telegram/test-signal', async (req, res) => {
    try {
      const testMessage = (req.body?.message as string) || '✅ Telegram connection test successful';

      const result = await telegramService.sendSimpleTestMessage(testMessage);

      res.json({
        success: result.success,
        testOnly: true,
        telegramDelivered: result.success,
        message_id: result.telegramMessageId || null,
        message: testMessage,
        error: result.error || null,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        testOnly: true,
        telegramDelivered: false,
        message_id: null,
        error: err.message || 'Failed to execute Telegram test delivery',
      });
    }
  });

  // Manual or programmatic trade outcome recording endpoint
  app.post('/api/record-outcome', (req, res) => {
    try {
      const { signalId, outcome, realizedPnl, exitPrice, source, brokerDealId, brokerOrderId, closeReason } = req.body || {};
      if (!signalId || (outcome !== 'WIN' && outcome !== 'LOSS')) {
        return res.status(400).json({ success: false, error: 'signalId and outcome (WIN or LOSS) are required' });
      }

      const signal = storage.getSignal(signalId);
      const outcomeRecord = {
        signalId,
        tradeId: signal?.id || signalId,
        direction: signal?.signal || 'BUY NOW',
        orderType: signal?.signal?.includes('LIMIT') ? signal.signal : 'MARKET',
        entry: signal?.entry ?? 0,
        stopLoss: signal?.stopLoss ?? 0,
        tp1: signal?.tp1 ?? 0,
        tp2: signal?.tp2 ?? 0,
        outcome,
        realizedPnl: realizedPnl !== undefined ? Number(realizedPnl) : undefined,
        exitPrice: exitPrice !== undefined ? Number(exitPrice) : undefined,
        source: source || 'MANUAL',
        brokerDealId,
        brokerOrderId,
        closeReason,
        closedAt: Date.now(),
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
      };

      const result = storage.recordTradeOutcome(outcomeRecord, signal);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Failed to record outcome' });
    }
  });

  // Future MT5 trade reconciliation endpoint
  app.post('/api/mt5/reconcile', (req, res) => {
    try {
      const { signalOrTradeId, brokerDealId, brokerOrderId, entryPrice, exitPrice, lotSize, realizedPnl, closedAt, closeReason, direction } = req.body || {};
      if (!signalOrTradeId || !brokerDealId || realizedPnl === undefined || exitPrice === undefined) {
        return res.status(400).json({ success: false, error: 'signalOrTradeId, brokerDealId, exitPrice, and realizedPnl are required' });
      }

      const result = storage.reconcileMt5Trade({
        signalOrTradeId,
        brokerDealId,
        brokerOrderId,
        entryPrice: entryPrice ? Number(entryPrice) : undefined,
        exitPrice: Number(exitPrice),
        lotSize: lotSize ? Number(lotSize) : undefined,
        realizedPnl: Number(realizedPnl),
        closedAt: closedAt ? Number(closedAt) : Date.now(),
        closeReason,
        direction,
      });

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Failed to reconcile MT5 trade' });
    }
  });

  // Accounting and P&L diagnostic test suite endpoint
  app.get('/api/tests/accounting', (req, res) => {
    try {
      const suiteResult = runAccountingTests();
      res.json({
        success: true,
        allPassed: suiteResult.allPassed,
        results: suiteResult.results,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Failed to run accounting tests' });
    }
  });

  // Vite middleware for development vs Production static serving
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Gold AI Challenge Scanner backend running on http://0.0.0.0:${PORT}`);
    // Explicitly guarantee scanner background worker is active
    scanner.start();
    // Start trade lifecycle monitor (evaluates open trades every 10s)
    tradeMonitor.start(10000);
    // Initialize brand-new Telegram integration and polling
    telegramService.init();
  });
}

startServer();
