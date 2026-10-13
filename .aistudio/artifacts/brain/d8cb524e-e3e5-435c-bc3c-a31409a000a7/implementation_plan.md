# Final Corrected Phase 4 Implementation Plan: Instance-Bound Telegram Isolation & Boundary Hardening

This plan specifies the exact architectural and code-level remediation to make isolated accounting and trade-management test executions completely incapable of sending real Telegram messages, calling external networks, or mutating production Telegram queue and dispatch files, while preserving production Telegram alerts and existing persistent records.

---

### User Review & Critical Decisions

> [!IMPORTANT]
> **Key Architecture Decisions for Review:**
> 1. **No Shared Retry Loop Manipulation:** Isolated tests will NOT pause or resume the production Telegram retry loop. Isolation relies entirely on the fact that isolated storage instances use an in-memory `NullTelegramNotifier`, making them structurally incapable of accessing the production queue, dispatch storage, or retry loop.
> 2. **Instance-Bound Storage Routing in Tests:** Every test mutation in `server/tradeManagementTests.ts` and helpers (including `storage.saveTrade` calls) is audited and routed exclusively through the supplied `activeStorage` / `customStorage` instance. The production singleton remains 100% untouched.
> 3. **Test-Safe Network Interception:** `globalThis.fetch` is intercepted during tests to throw immediately on any outbound request to `api.telegram.org` without logging URLs, headers, or credentials, with guaranteed restoration in a `finally` block. Interception is a secondary safety net; primary isolation is the notifier boundary.
> 4. **Scoped Acceptance & TypeScript Verification:** `npm run build` must pass successfully, and production files (`server/**/*.ts`, `src/**/*.ts`) must have zero TypeScript errors. Pre-existing test-file type diagnostics are reported separately without expanding scope.
> 5. **Absolute Preservation of JSON Files:** `data/telegram_retry_queue.json` and `data/telegram_dispatches.json` remain untouched and byte-for-byte identical. No historical entries are deleted or modified.

---

## 1. Overview & Core Concept

- **What It Delivers**: Complete, verifiable containment of all Telegram notifications and retry queue operations during test suite execution (`accountingTests` and `tradeManagementTests`), ensuring zero network requests and zero file mutations while guaranteeing normal production alerting behavior remains undisturbed.
- **Root Problem Solved**:
  1. `PersistentStorage.recordTradeOutcome` and `PersistentStorage.closeTrade` called the global `telegramService.sendOutcomeNotification` singleton without checking instance isolation.
  2. `TradeManagementEngine.evaluateSingleTrade`, `executeAction`, and `tradeManagementTests.ts` referenced the production `storage` singleton directly (e.g. `storage.saveTrade`) rather than the isolated test storage instance.
- **Core Value**: Bulletproof test isolation without modifying trading strategies, risk management, or production notifications.

---

## 2. Confirmed Facts vs. Assumptions

### Confirmed Facts (Direct Code & File Verification)
1. **Direct Storage Dispatch**: In `server/storage.ts` line 1721 (`recordTradeOutcome`) and line 2284 (`closeTrade`), `telegramService.sendOutcomeNotification(...)` is called unconditionally on the global `telegramService` singleton, ignoring `this.isProductionStorage`.
2. **Real Leaked Network Requests**: `data/telegram_retry_queue.json` contains entries with `"status": "SENT"` and numeric `"messageId"` values corresponding to test ID `close_test-accounting-separation-...`, proving live HTTP requests were dispatched to `https://api.telegram.org`.
3. **Leaked Dispatch Identifiers**: `data/telegram_dispatches.json` contains active test dispatch keys persisted via `storage.saveTelegramDispatch`.
4. **Engine & Test Singleton Fallbacks**: In `server/tradeManagementEngine.ts` and `server/tradeManagementTests.ts`, some calls or saves default to the production `storage` singleton rather than `activeStorage`.
5. **Passing Snapshot Equality**: Existing storage isolation tests in `tests/storageIsolationRegression.test.ts` verify all 13 storage categories remain equal, but require hardening against outbound fetch attempts and queue mutations.

### Assumptions (Explicitly Documented & Guarded)
1. **Production Alerting Continuity**: In live operation, `storage` is a singleton with `isProductionStorage = true` and must deliver live alerts via `LiveTelegramNotifier` without behavioral regression.
2. **No Data Deletion**: Existing test records inside `data/telegram_retry_queue.json` and `data/telegram_dispatches.json` must remain untouched.

---

## 3. Complete Audit of Every Telegram Outbound Path

| # | Outbound Method | File & Line | Target / Transport | Containment Mechanism |
| :- | :--- | :--- | :--- | :--- |
| 1 | `sendMessageDirectly` | `server/telegram.ts:1085` | `globalThis.fetch('https://api.telegram.org/...')` | Bypassed entirely by `NullTelegramNotifier` on test instances; intercepted by test fetch guard as fallback. |
| 2 | `sendOutcomeNotification` | `server/storage.ts:1721, 2284` | Calls telegram notifier | Routed to `this.telegramNotifier.sendOutcomeNotification` (Null on test instances). |
| 3 | `sendManagementNotification` | `server/tradeManagementEngine.ts:1208` | Calls telegram notifier | Routed to `activeStorage.getTelegramNotifier()`. |
| 4 | `processRetryQueue` | `server/telegram.ts:435` | Background retry loop | Isolated test instances do not register with or call `telegramService`; retry loop remains untouched and never processes test records. |

---

## 4. Technical Architecture: Explicit Instance-Bound Notifier Boundary

```
                       ┌──────────────────────────────────────────────┐
                       │             ITelegramNotifier                │
                       │  - sendOutcomeNotification(outcome, trade)   │
                       │  - sendManagementNotification(msg, options)  │
                       │  - isTelegramDispatched(key): boolean        │
                       │  - saveTelegramDispatch(key): void           │
                       └───────────────────────┬──────────────────────┘
                                               │
               ┌───────────────────────────────┴───────────────────────────────┐
               ▼                                                               ▼
┌─────────────────────────────────────────────┐                 ┌─────────────────────────────────────────────┐
│            LiveTelegramNotifier             │                 │            NullTelegramNotifier             │
│  - Wraps global telegramService             │                 │  - 100% In-Memory Sandbox                   │
│  - Dispatches to api.telegram.org           │                 │  - Zero network calls (no fetch)            │
│  - Persists to data/telegram_*.json         │                 │  - Zero disk writes (no fs)                 │
│  - Used EXCLUSIVELY by prod singleton       │                 │  - Used EXCLUSIVELY by isolated test inst.  │
└─────────────────────────────────────────────┘                 └─────────────────────────────────────────────┘
```

---

## 5. Exact Files & Functions to Modify

### 1. `server/storage.ts`
- Define `ITelegramNotifier` interface and implement `NullTelegramNotifier` (in-memory sandbox) and `LiveTelegramNotifier` (delegates to `telegramService`).
- Update `PersistentStorage`:
  - Add private `telegramNotifier: ITelegramNotifier;`.
  - In constructor, initialize with `LiveTelegramNotifier` if `isProductionStorage` is true, else `NullTelegramNotifier`.
  - In `recordTradeOutcome` and `closeTrade`, call `this.telegramNotifier.sendOutcomeNotification(...)`.
  - Add `public getTelegramNotifier(): ITelegramNotifier { return this.telegramNotifier; }`.

### 2. `server/tradeManagementEngine.ts`
- In `executeAction`, ensure `activeStorage.saveTrade(trade)` is called instead of global `storage.saveTrade(trade)`.
- Pass `activeStorage.getTelegramNotifier()` to management notifications.

### 3. `server/tradeManagementTests.ts`
- Audit all `storage` references. Ensure any `storage.saveTrade` or test helper calls within test setup pass or target `activeStorage` rather than the production singleton.

### 4. `tests/storageIsolationRegression.test.ts`
- Implement robust test-safe fetch interception:
  ```ts
  const originalFetch = globalThis.fetch;
  let telegramFetchAttempted = false;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes('api.telegram.org')) {
      telegramFetchAttempted = true;
      throw new Error('Test Isolation Violation: Outbound Telegram network call attempted');
    }
    return originalFetch(input, init);
  };
  ```
- Wrapped in `try ... finally { globalThis.fetch = originalFetch; }`.
- Verify SHA-256 hashes of `data/telegram_retry_queue.json` and `data/telegram_dispatches.json` before and after test execution to guarantee zero file modification.
- Verify all 13 production storage categories remain byte-for-byte identical.

---

## 6. Multi-Layer Regression Verification Matrix

| Verification Check | Target / Tool | Acceptance Criteria |
| :--- | :--- | :--- |
| **Outbound Network Interception** | `tests/storageIsolationRegression.test.ts` | 0 calls to `api.telegram.org` |
| **Queue File SHA-256 Immutability** | `data/telegram_retry_queue.json` | Exact hash match before and after all test suites |
| **Dispatch File SHA-256 Immutability** | `data/telegram_dispatches.json` | Exact hash match before and after all test suites |
| **13 Storage Categories Snapshot** | Production `storage` singleton | Strict deep equality before and after all test suites |
| **Accounting Test Suite** | `server/accountingTests.ts` | 14 / 14 tests pass on isolated instance |
| **Trade Management Test Suite** | `server/tradeManagementTests.ts` | 18 / 18 tests pass on isolated instance |
| **Production Build Check** | `npm run build` | Clean production build with exit code 0 |
| **Production TypeScript Check** | `npx tsc --noEmit` | 0 errors in production source files |
