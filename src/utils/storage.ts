import { AccountStats, BrokerSettings, DEFAULT_BROKER_SETTINGS, TradeLedgerItem, TradeSignal } from '../types.js';

const STORAGE_KEYS = {
  BALANCE: 'gold_ai_balance',
  STARTING_BALANCE: 'gold_ai_starting_balance',
  LEDGER: 'gold_ai_trade_ledger',
  LAST_SIGNAL: 'gold_ai_last_signal',
  SCANNER_ENABLED: 'gold_ai_scanner_enabled',
  BROKER_SETTINGS: 'gold_ai_broker_settings',
};

export function loadBrokerSettings(): BrokerSettings {
  const saved = localStorage.getItem(STORAGE_KEYS.BROKER_SETTINGS);
  if (!saved) return DEFAULT_BROKER_SETTINGS;
  try {
    const parsed = JSON.parse(saved);
    return {
      accountBalance: Number(parsed.accountBalance ?? DEFAULT_BROKER_SETTINGS.accountBalance),
      riskPercent: Number(parsed.riskPercent ?? DEFAULT_BROKER_SETTINGS.riskPercent),
      contractSizeOz: Number(parsed.contractSizeOz ?? DEFAULT_BROKER_SETTINGS.contractSizeOz),
      minimumLot: Number(parsed.minimumLot ?? DEFAULT_BROKER_SETTINGS.minimumLot),
      maximumLot: Number(parsed.maximumLot ?? DEFAULT_BROKER_SETTINGS.maximumLot),
      lotStep: Number(parsed.lotStep ?? DEFAULT_BROKER_SETTINGS.lotStep),
      maxGoldSlPoints: Number(parsed.maxGoldSlPoints ?? DEFAULT_BROKER_SETTINGS.maxGoldSlPoints),
      minRr: Number(parsed.minRr ?? DEFAULT_BROKER_SETTINGS.minRr),
    };
  } catch {
    return DEFAULT_BROKER_SETTINGS;
  }
}

export function saveBrokerSettings(settings: BrokerSettings): void {
  localStorage.setItem(STORAGE_KEYS.BROKER_SETTINGS, JSON.stringify(settings));
}

export function loadStartingBalance(): number {
  const saved = localStorage.getItem(STORAGE_KEYS.STARTING_BALANCE);
  return saved ? parseFloat(saved) : 25.0;
}

export function saveStartingBalance(val: number) {
  localStorage.setItem(STORAGE_KEYS.STARTING_BALANCE, val.toString());
}

export function loadCurrentBalance(): number {
  const saved = localStorage.getItem(STORAGE_KEYS.BALANCE);
  return saved ? parseFloat(saved) : loadStartingBalance();
}

export function saveCurrentBalance(val: number) {
  localStorage.setItem(STORAGE_KEYS.BALANCE, Number(val.toFixed(2)).toString());
}

export function loadTradeLedger(): TradeLedgerItem[] {
  const saved = localStorage.getItem(STORAGE_KEYS.LEDGER);
  if (!saved) return [];
  try {
    return JSON.parse(saved);
  } catch {
    return [];
  }
}

export function saveTradeLedger(ledger: TradeLedgerItem[]) {
  localStorage.setItem(STORAGE_KEYS.LEDGER, JSON.stringify(ledger));
}

export function loadLastSignal(): TradeSignal | null {
  const saved = localStorage.getItem(STORAGE_KEYS.LAST_SIGNAL);
  if (!saved) return null;
  try {
    return JSON.parse(saved);
  } catch {
    return null;
  }
}

export function saveLastSignal(signal: TradeSignal) {
  localStorage.setItem(STORAGE_KEYS.LAST_SIGNAL, JSON.stringify(signal));
}

/**
 * Calculates complete account stats from ledger items
 */
export function calculateAccountStats(startingBalance: number, currentBalance: number, ledger: TradeLedgerItem[]): AccountStats {
  const closedTrades = ledger.filter((t) => t.result === 'WIN' || t.result === 'LOSS');
  const wins = closedTrades.filter((t) => t.result === 'WIN');
  const losses = closedTrades.filter((t) => t.result === 'LOSS');

  const numberOfTrades = closedTrades.length;
  const winCount = wins.length;
  const lossCount = losses.length;
  const winRate = numberOfTrades > 0 ? Number(((winCount / numberOfTrades) * 100).toFixed(1)) : 0;

  const totalPl = Number((currentBalance - startingBalance).toFixed(2));
  const plPercent = startingBalance > 0 ? Number(((totalPl / startingBalance) * 100).toFixed(2)) : 0;

  const winAmounts = wins.map((t) => t.pl);
  const lossAmounts = losses.map((t) => Math.abs(t.pl));

  const averageWin = winCount > 0 ? Number((winAmounts.reduce((a, b) => a + b, 0) / winCount).toFixed(2)) : 0;
  const averageLoss = lossCount > 0 ? Number((lossAmounts.reduce((a, b) => a + b, 0) / lossCount).toFixed(2)) : 0;
  const largestWin = winCount > 0 ? Math.max(...winAmounts) : 0;
  const largestLoss = lossCount > 0 ? Math.max(...lossAmounts) : 0;

  // Streaks calculation
  let currentWinningStreak = 0;
  let currentLosingStreak = 0;
  let maxWinningStreak = 0;
  let maxLosingStreak = 0;

  for (const t of closedTrades) {
    if (t.result === 'WIN') {
      currentWinningStreak++;
      currentLosingStreak = 0;
      if (currentWinningStreak > maxWinningStreak) maxWinningStreak = currentWinningStreak;
    } else if (t.result === 'LOSS') {
      currentLosingStreak++;
      currentWinningStreak = 0;
      if (currentLosingStreak > maxLosingStreak) maxLosingStreak = currentLosingStreak;
    }
  }

  // Drawdown calculation
  let peak = startingBalance;
  let runningBalance = startingBalance;
  let maxDrawdownAmount = 0;
  let maxDrawdownPercent = 0;

  for (const t of closedTrades) {
    runningBalance += t.pl;
    if (runningBalance > peak) {
      peak = runningBalance;
    }
    const dd = peak - runningBalance;
    if (dd > maxDrawdownAmount) {
      maxDrawdownAmount = dd;
      maxDrawdownPercent = peak > 0 ? (dd / peak) * 100 : 0;
    }
  }

  // Average RR calculation
  let totalRR = 0;
  let validRRCount = 0;
  for (const t of closedTrades) {
    if (t.rr) {
      const parts = t.rr.split(':');
      if (parts.length === 2) {
        const val = parseFloat(parts[1]);
        if (!isNaN(val)) {
          totalRR += val;
          validRRCount++;
        }
      }
    }
  }
  const averageRR = validRRCount > 0 ? Number((totalRR / validRRCount).toFixed(2)) : 0;

  const totalRiskTaken = Number(ledger.reduce((acc, t) => acc + (t.riskAmount || 0), 0).toFixed(2));

  // Phase 5B Separate Analytics Metrics
  const manualTrades = ledger.filter((t) => (t.source === 'MANUAL' || !t.source) && t.result !== 'NOT_ENTERED');
  const userTradesEntered = manualTrades.length;
  const userTradesWon = manualTrades.filter((t) => t.result === 'WIN').length;
  const userTradesLost = manualTrades.filter((t) => t.result === 'LOSS').length;
  const userTradesPl = Number(manualTrades.filter((t) => t.result === 'WIN' || t.result === 'LOSS').reduce((acc, t) => acc + (t.pl || 0), 0).toFixed(2));

  const mt5Trades = ledger.filter((t) => t.source === 'MT5' && t.result !== 'NOT_ENTERED');
  const mt5TradesExecuted = mt5Trades.length;
  const mt5TradesWon = mt5Trades.filter((t) => t.result === 'WIN').length;
  const mt5TradesLost = mt5Trades.filter((t) => t.result === 'LOSS').length;
  const mt5TradesPl = Number(mt5Trades.filter((t) => t.result === 'WIN' || t.result === 'LOSS').reduce((acc, t) => acc + (t.pl || 0), 0).toFixed(2));

  const signalsNotEntered = ledger.filter((t) => t.result === 'NOT_ENTERED').length;

  return {
    currentBalance: Number(currentBalance.toFixed(2)),
    startingBalance: Number(startingBalance.toFixed(2)),
    totalPl,
    plPercent,
    drawdown: Number(maxDrawdownAmount.toFixed(2)),
    drawdownPercent: Number(maxDrawdownPercent.toFixed(1)),
    numberOfTrades,
    wins: winCount,
    losses: lossCount,
    winRate,
    averageWin,
    averageLoss,
    largestWin,
    largestLoss,
    winningStreak: maxWinningStreak,
    losingStreak: currentLosingStreak, // return current streak for risk adaptation
    averageRR,
    totalRiskTaken,
    // Phase 5B Separate Analytics
    signalsGenerated: numberOfTrades + signalsNotEntered,
    signalsNotEntered,
    userTradesEntered,
    userTradesWon,
    userTradesLost,
    userTradesPl,
    mt5TradesExecuted,
    mt5TradesWon,
    mt5TradesLost,
    mt5TradesPl,
    userReportedPnl: userTradesPl,
    brokerConfirmedPnl: mt5TradesPl,
  };
}
