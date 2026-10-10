import fs from 'fs';
import path from 'path';
import { storage } from './storage.js';

const GLOBAL_TELEGRAM_SERVICE_KEY = Symbol.for('__GOLD_AI_TELEGRAM_SERVICE__');
const GLOBAL_TELEGRAM_POLLING_RUNNING = Symbol.for('__GOLD_AI_TELEGRAM_POLLING_RUNNING__');

export let applicationStartedAt: number = Date.now();

/**
 * Actionability & Staleness Windows for Gold (XAUUSD) Trading Alerts:
 * 
 * In intraday XAUUSD trading on M5/M15/M1 charts:
 * 1. Trade Signals (SIGNAL_NEW):
 *    - Valid for up to 15 minutes (900,000 ms), representing 1 x 15M candle or 3 x 5M candles.
 *    - Beyond 15 minutes, price has likely moved significantly from the designated entry price,
 *      so delivering a stale entry alert could lead to hazardous late execution.
 * 2. Active Trade Management & Lifecycle Events (TP1, Breakeven, Early Exit, Trade Close):
 *    - Valid for up to 30 minutes (1,800,000 ms).
 *    - These are informative lifecycle updates essential for the user's ledger and trade awareness.
 * 
 * Persistent Retry Queue Behavior on Restart:
 * - A pending notification created within its actionability window MUST survive server restarts
 *   and continue retrying until delivered or expired.
 * - Truly historical notifications (exceeding their actionability window) are suppressed.
 * - Notifications already marked as SENT remain recorded for deduplication and are NEVER resent.
 */
export const TELEGRAM_SIGNAL_ACTIONABILITY_MS = 15 * 60 * 1000; // 15 minutes for trade entry signals
export const TELEGRAM_MGMT_ACTIONABILITY_MS = 30 * 60 * 1000;   // 30 minutes for trade management / exits
export const TELEGRAM_DEFAULT_ACTIONABILITY_MS = 15 * 60 * 1000;

export function isNotificationActionable(createdAt: number, event?: string): boolean {
  if (!createdAt || isNaN(createdAt) || createdAt <= 0) return false;
  const ageMs = Date.now() - createdAt;
  const maxAgeMs = (event && (
    event.includes('TP1') ||
    event.includes('BREAK_EVEN') ||
    event.includes('MANAGEMENT') ||
    event.includes('EARLY_EXIT') ||
    event.includes('CLOSE') ||
    event.includes('OUTCOME')
  ))
    ? TELEGRAM_MGMT_ACTIONABILITY_MS
    : TELEGRAM_SIGNAL_ACTIONABILITY_MS;

  return ageMs <= maxAgeMs;
}

export function getApplicationStartedAt(): number {
  return applicationStartedAt;
}

export function setApplicationStartedAt(timestamp: number): void {
  applicationStartedAt = timestamp;
  const svc = (globalThis as any)[GLOBAL_TELEGRAM_SERVICE_KEY];
  if (svc && typeof svc.setApplicationStartedAt === 'function') {
    svc.setApplicationStartedAt(timestamp);
  } else {
    console.log(`[TELEGRAM] Application event boundary initialized: ${applicationStartedAt}`);
  }
}

/**
 * Centralized helper: safely escape dynamic/user-generated values interpolated into
 * Telegram messages using parse_mode="HTML".
 * Prevents HTTP 400 "Bad Request: can't parse entities" caused by unescaped
 * characters (&, <, >, ", ').
 */
export function escapeTelegramHtml(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface TelegramStatus {
  registered: boolean;
  chatId: string | null;
  botId: string | null;
}

export interface PendingPnlRequest {
  signalId: string;
  outcome: 'WIN' | 'LOSS';
  signal: any;
  messageId?: number;
  originalMessageText?: string;
  requestedAt: number;
}

export interface QueuedTelegramNotification {
  notificationId: string;
  tradeId?: string;
  event: string;
  chatId: string;
  message: string;
  replyMarkup?: any;
  status: 'PENDING' | 'SENT' | 'FAILED' | 'SUPPRESSED';
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number;
  telegramMessageId?: number;
  lastError?: string;
  createdAt: number;
  sentAt?: number;
}

export class TelegramService {
  private botToken: string | null = null;
  private privateChatId: string | null = null;
  private botId: string | null = null;
  private lastSendError: string | null = null;
  private configPath = path.join(process.cwd(), 'data', 'telegram_private_chat.json');
  private messageMappingPath = path.join(process.cwd(), 'data', 'telegram_signal_messages.json');
  private pendingPnlPath = path.join(process.cwd(), 'data', 'telegram_pending_pnl.json');
  private retryQueuePath = path.join(process.cwd(), 'data', 'telegram_retry_queue.json');
  private isRunning = false;
  private isInitializing = false;
  private abortController: AbortController | null = null;
  private lastUpdateId = 0;
  private signalMessageIds: Record<string, number> = {};
  private pendingPnlRequests: Map<string, PendingPnlRequest> = new Map();
  private notificationQueue: Map<string, QueuedTelegramNotification> = new Map();
  private retryTimer: NodeJS.Timeout | null = null;
  private rateLimitedUntil = 0;
  private hasLoggedRateLimit = false;
  private lastActiveSignalUpdate = new Map<string, number>();
  private applicationStartedAt: number = applicationStartedAt;

  constructor() {
    console.log(`[TELEGRAM] Application event boundary initialized: ${this.applicationStartedAt}`);
    this.botToken = this.getBotToken();
    this.botId = this.getBotIdFromToken(this.botToken);
    this.loadRegisteredChat();
    this.loadMessageMapping();
    this.loadPendingPnlRequests();
    this.loadNotificationQueue();
    this.startRetryLoop();
  }

  public setApplicationStartedAt(ts: number): void {
    this.applicationStartedAt = ts;
    applicationStartedAt = ts;
    console.log(`[TELEGRAM] Application event boundary initialized: ${this.applicationStartedAt}`);
  }

  public getApplicationStartedAt(): number {
    return this.applicationStartedAt;
  }

  /**
   * Extract retry_after seconds from Telegram 429 error response or description
   */
  private extractRetryAfterSeconds(body: any, statusText?: string): number {
    if (typeof body?.parameters?.retry_after === 'number' && body.parameters.retry_after > 0) {
      return body.parameters.retry_after;
    }
    const str = `${body?.description || ''} ${statusText || ''}`;
    const match = str.match(/retry\s+after\s+(\d+)/i);
    if (match && match[1]) {
      const parsed = parseInt(match[1], 10);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return 60; // Safe 60-second default fallback
  }

  /**
   * Check if Telegram is currently in 429 rate-limit cooldown
   */
  public isRateLimited(): boolean {
    const now = Date.now();
    if (now < this.rateLimitedUntil) {
      if (!this.hasLoggedRateLimit) {
        const remainingSec = Math.ceil((this.rateLimitedUntil - now) / 1000);
        console.warn(`[Telegram] Rate limited by Telegram API (HTTP 429). Pausing outbound requests for ${remainingSec}s until ${new Date(this.rateLimitedUntil).toISOString()}.`);
        this.hasLoggedRateLimit = true;
      }
      return true;
    }
    if (this.hasLoggedRateLimit) {
      console.log('[Telegram] Rate limit cooldown period expired. Resuming Telegram requests.');
      this.hasLoggedRateLimit = false;
    }
    return false;
  }

  /**
   * Set rate limit cooldown from 429 response
   */
  private handleRateLimitResponse(body: any, statusText?: string): void {
    const retrySec = this.extractRetryAfterSeconds(body, statusText);
    this.rateLimitedUntil = Date.now() + retrySec * 1000;
    this.hasLoggedRateLimit = false;
    this.isRateLimited(); // logs concise warning once
    this.lastSendError = `Telegram API Rate Limited (429): retry after ${retrySec}s`;
  }

  /**
   * Dynamically resolve and sanitize Telegram bot token from environment
   */
  public getBotToken(): string | null {
    const raw = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || this.botToken || '';
    if (!raw) return null;
    const sanitized = raw.trim().replace(/^["']|["']$/g, '');
    return sanitized.length > 0 ? sanitized : null;
  }

  /**
   * Get authorized user IDs from environment variables
   */
  public getAuthorizedUserIds(): string[] {
    const raw = process.env.TELEGRAM_AUTHORIZED_USER_IDS || process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_USER_ID || '';
    if (!raw) return [];
    return raw
      .split(/[,\s]+/)
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s.length > 0);
  }

  /**
   * Check if user/chat is authorized
   */
  public isAuthorized(userIdOrChatId: string | number): boolean {
    const authorized = this.getAuthorizedUserIds();
    if (authorized.length === 0) return true;
    const target = String(userIdOrChatId).trim();
    return authorized.includes(target);
  }

  /**
   * Load stored pending P&L requests from disk
   */
  private loadPendingPnlRequests(): void {
    try {
      if (fs.existsSync(this.pendingPnlPath)) {
        const data = JSON.parse(fs.readFileSync(this.pendingPnlPath, 'utf8'));
        if (data && typeof data === 'object') {
          for (const [chatId, req] of Object.entries(data)) {
            this.pendingPnlRequests.set(chatId, req as PendingPnlRequest);
          }
          console.log(`[Telegram] Loaded ${this.pendingPnlRequests.size} pending P&L input requests.`);
        }
      }
    } catch (err) {
      console.error('[Telegram] Error loading pending P&L requests:', err);
    }
  }

  /**
   * Save pending P&L requests to disk safely
   */
  private savePendingPnlRequests(): void {
    try {
      const dir = path.dirname(this.pendingPnlPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const obj: Record<string, PendingPnlRequest> = {};
      for (const [chatId, req] of this.pendingPnlRequests.entries()) {
        obj[chatId] = req;
      }
      fs.writeFileSync(this.pendingPnlPath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      console.error('[Telegram] Error saving pending P&L requests:', err);
    }
  }

  /**
   * Clear pending P&L request for a chat
   */
  public clearPendingPnlRequest(chatId: string): void {
    this.pendingPnlRequests.delete(chatId);
    this.savePendingPnlRequests();
  }

  /**
   * Load stored signal message ID mapping from disk
   */
  private loadMessageMapping(): void {
    try {
      if (fs.existsSync(this.messageMappingPath)) {
        this.signalMessageIds = JSON.parse(fs.readFileSync(this.messageMappingPath, 'utf8'));
      }
    } catch (err) {
      console.error('[Telegram] Error loading message mapping:', err);
    }
  }

  /**
   * Save signal message ID mapping to disk safely
   */
  private saveMessageMapping(): void {
    try {
      const dir = path.dirname(this.messageMappingPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.messageMappingPath, JSON.stringify(this.signalMessageIds, null, 2), 'utf8');
    } catch (err) {
      console.error('[Telegram] Error saving message mapping:', err);
    }
  }

  private safelySaveTelegramDispatch(key: string): void {
    try {
      if (typeof storage !== 'undefined' && storage && typeof storage.saveTelegramDispatch === 'function') {
        storage.saveTelegramDispatch(key);
      }
    } catch {
      // safe guard against circular import during early bootstrap
    }
  }

  private safelyIsTelegramDispatched(key: string): boolean {
    try {
      if (typeof storage !== 'undefined' && storage && typeof storage.isTelegramDispatched === 'function') {
        return storage.isTelegramDispatched(key);
      }
    } catch {
      // safe guard
    }
    return false;
  }

  /**
   * Load stored persistent retry queue from disk
   */
  private loadNotificationQueue(): void {
    try {
      if (fs.existsSync(this.retryQueuePath)) {
        const data = JSON.parse(fs.readFileSync(this.retryQueuePath, 'utf8'));
        if (Array.isArray(data)) {
          let suppressedCount = 0;
          for (const item of data) {
            if (!item || !item.notificationId) continue;

            // 1. Preserve all SENT items for persistent idempotency
            if (item.status === 'SENT') {
              this.notificationQueue.set(item.notificationId, item);
              this.safelySaveTelegramDispatch(item.notificationId);
              continue;
            }

            // 2. Check if item is experimental/test trade
            const isTestTrade = !!(item.tradeId && (
              item.tradeId.startsWith('test_') ||
              item.tradeId.startsWith('phantom-') ||
              item.tradeId.startsWith('mock_') ||
              item.tradeId.startsWith('adversarial_') ||
              item.event === 'ADVERSARIAL_TEST_EVENT' ||
              item.event === 'PRODUCTION_VERIFY_SIGNAL'
            ));

            if (isTestTrade) {
              console.log(`[TELEGRAM] Historical event suppressed:\nnotificationId=${item.notificationId}\neventTimestamp=${item.createdAt || 0}\napplicationStartedAt=${this.applicationStartedAt}`);
              item.status = 'SUPPRESSED';
              item.lastError = 'Experimental/test event suppressed';
              this.notificationQueue.set(item.notificationId, item);
              suppressedCount++;
              continue;
            }

            // 3. Check staleness against XAUUSD actionability window (survives restart if still actionable)
            const isActionable = isNotificationActionable(item.createdAt || 0, item.event);

            if (!isActionable) {
              console.log(`[TELEGRAM] Historical event suppressed:\nnotificationId=${item.notificationId}\neventTimestamp=${item.createdAt || 0}\napplicationStartedAt=${this.applicationStartedAt}`);
              item.status = 'SUPPRESSED';
              item.lastError = 'Historical event suppressed: exceeded actionability window';
              this.notificationQueue.set(item.notificationId, item);
              suppressedCount++;
              continue;
            }

            console.log(`[Telegram] Restored actionable pending notification on restart: ${item.notificationId} (age: ${Math.round((Date.now() - (item.createdAt || 0)) / 1000)}s)`);
            this.notificationQueue.set(item.notificationId, item);
          }
          if (suppressedCount > 0) {
            console.log(`[Telegram] Suppressed ${suppressedCount} historical/experimental pending queue items on startup.`);
            this.saveNotificationQueue();
          }
          console.log(`[Telegram] Loaded ${this.notificationQueue.size} items from persistent notification queue.`);
        }
      }
    } catch (err) {
      console.error('[Telegram] Error loading notification queue:', err);
    }
  }

  /**
   * Save persistent retry queue to disk safely
   */
  private saveNotificationQueue(): void {
    try {
      const dir = path.dirname(this.retryQueuePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const array = Array.from(this.notificationQueue.values());
      // Prune successfully sent items older than 48 hours to bound memory/disk
      const cutoff = Date.now() - 48 * 3600 * 1000;
      const filtered = array.filter(item => item.status === 'PENDING' || (item.createdAt || 0) > cutoff);
      fs.writeFileSync(this.retryQueuePath, JSON.stringify(filtered, null, 2), 'utf8');
    } catch (err) {
      console.error('[Telegram] Error saving notification queue:', err);
    }
  }

  /**
   * Start background retry loop for reliable notification delivery
   */
  private startRetryLoop(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      this.processRetryQueue().catch((err) => {
        console.error('[Telegram] Error in background retry queue worker:', err);
      });
    }, 3000);
    if (this.retryTimer.unref) {
      this.retryTimer.unref();
    }
  }

  /**
   * Background processor for pending retries with exponential backoff & rate-limit awareness
   */
  public async processRetryQueue(): Promise<void> {
    if (this.isRateLimited()) {
      return;
    }

    const token = this.getBotToken();
    if (!token) return;

    const now = Date.now();
    let queueModified = false;

    for (const [id, item] of this.notificationQueue.entries()) {
      if (item.status !== 'PENDING') continue;
      if (now < item.nextRetryAt) continue;

      // Actionability check: suppress if pending notification has aged past actionability window
      if (!isNotificationActionable(item.createdAt || 0, item.event)) {
        console.log(`[TELEGRAM] Historical event suppressed:\nnotificationId=${id}\neventTimestamp=${item.createdAt}\napplicationStartedAt=${this.applicationStartedAt}`);
        item.status = 'SUPPRESSED';
        item.lastError = 'Pending notification exceeded maximum actionability window';
        queueModified = true;
        continue;
      }

      if (item.attempts >= item.maxAttempts) {
        item.status = 'FAILED';
        item.lastError = item.lastError || 'Max retry attempts exceeded';
        queueModified = true;
        console.warn(`[Telegram Queue] Notification ${id} marked FAILED after ${item.attempts} attempts.`);
        continue;
      }

      const chatId = item.chatId || this.getPrivateChatId();
      if (!chatId) continue;

      // Normalize any unescaped ampersands in stored message before retrying
      if (item.message && typeof item.message === 'string') {
        item.message = item.message.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/gi, '&amp;');
      }

      const isTestItem = Boolean(
        item.tradeId?.startsWith('test_') ||
        item.notificationId?.startsWith('signal_test_')
      );

      item.attempts += 1;
      const sentMsg = await this.sendMessageDirectly(chatId, item.message, item.replyMarkup);
      if (sentMsg && sentMsg.message_id) {
        item.status = 'SENT';
        item.sentAt = Date.now();
        item.telegramMessageId = sentMsg.message_id;
        this.safelySaveTelegramDispatch(id);
        queueModified = true;
        console.log(`[Telegram Queue] Notification ${id} delivered successfully on attempt ${item.attempts}.`);
      } else {
        const backoffMs = this.isRateLimited()
          ? Math.max(3000, this.rateLimitedUntil - Date.now())
          : Math.min(60000, 2000 * Math.pow(2, item.attempts - 1));
        item.nextRetryAt = Date.now() + backoffMs;
        item.lastError = this.lastSendError || 'Transient failure';
        queueModified = true;
        console.warn(`[Telegram Queue] Notification ${id} attempt ${item.attempts} failed. Next retry in ${Math.round(backoffMs / 1000)}s.`);
      }
    }

    if (queueModified) {
      this.saveNotificationQueue();
    }
  }

  public getLastSendError(): string | null {
    return this.lastSendError;
  }

  /**
   * Dispatches a notification through the idempotent persistent retry queue
   */
  public async dispatchReliableNotification(options: {
    notificationId: string;
    tradeId?: string;
    event: string;
    message: string;
    replyMarkup?: any;
    maxAttempts?: number;
    eventTimestamp?: number;
    allowTestDispatch?: boolean;
  }): Promise<{ success: boolean; telegramMessageId?: number; queued?: boolean; suppressed?: boolean; error?: string }> {
    const { notificationId, tradeId, event, message, replyMarkup, maxAttempts = 10 } = options;
    const eventTimestamp = options.eventTimestamp ?? Date.now();

    // 1. CHECK PERSISTENT DEDUPLICATION FIRST:
    // If already marked as SENT in notificationQueue or in storage.isTelegramDispatched, idempotent return success!
    const existing = this.notificationQueue.get(notificationId);
    if ((existing && existing.status === 'SENT') || this.safelyIsTelegramDispatched(notificationId)) {
      console.log(`[Telegram Queue] Idempotent duplicate prevented for notification ${notificationId}. Already sent.`);
      return { success: true, telegramMessageId: existing?.telegramMessageId };
    }

    const isTestAllowed = Boolean(
      options.allowTestDispatch === true &&
      (options.tradeId?.startsWith('test_') ||
        options.event === 'PRODUCTION_VERIFY_SIGNAL')
    );

    // 2. STARTUP BOUNDARY CHECK:
    // If the event timestamp is prior to the application start time,
    // this is a historical event (restored from DB/storage/reconciliation). Suppress it!
    if (eventTimestamp < this.applicationStartedAt) {
      console.log(`[TELEGRAM] Historical event suppressed:\nnotificationId=${notificationId}\neventTimestamp=${eventTimestamp}\napplicationStartedAt=${this.applicationStartedAt}`);
      return { success: false, suppressed: true };
    }

    // 3. EXPERIMENTAL / TEST TRADE SUPPRESSION
    // Prevent experimental and test trades from sending notifications (unless explicitly allowed test)
    if (!isTestAllowed && tradeId && (
      tradeId.startsWith('test_') ||
      tradeId.startsWith('phantom-') ||
      tradeId.startsWith('mock_') ||
      tradeId.startsWith('adversarial_') ||
      event === 'ADVERSARIAL_TEST_EVENT' ||
      event === 'PRODUCTION_VERIFY_SIGNAL'
    )) {
      console.log(`[TELEGRAM] Historical event suppressed:\nnotificationId=${notificationId}\neventTimestamp=${eventTimestamp}\napplicationStartedAt=${this.applicationStartedAt}`);
      return { success: false, suppressed: true };
    }

    // Genuinely new event
    console.log(`[TELEGRAM] New event dispatched:\nnotificationId=${notificationId}`);
    // NOTE: Deduplication is ONLY recorded after Telegram API confirms successful delivery (or in recovery queue).

    const chatId = this.getPrivateChatId();
    if (!chatId) {
      // Queue as pending until chat is registered
      const queuedItem: QueuedTelegramNotification = {
        notificationId,
        tradeId,
        event,
        chatId: '',
        message,
        replyMarkup,
        status: 'PENDING',
        attempts: 0,
        maxAttempts,
        nextRetryAt: Date.now() + 5000,
        createdAt: eventTimestamp,
        lastError: 'NOT_REGISTERED: Waiting for private chat registration',
      };
      this.notificationQueue.set(notificationId, queuedItem);
      this.saveNotificationQueue();
      return { success: false, queued: true };
    }

    // Attempt immediate delivery if not rate limited
    if (!this.isRateLimited()) {
      const sentMsg = await this.sendMessageDirectly(chatId, message, replyMarkup);
      if (sentMsg && sentMsg.message_id) {
        const sentItem: QueuedTelegramNotification = {
          notificationId,
          tradeId,
          event,
          chatId,
          message,
          replyMarkup,
          status: 'SENT',
          attempts: 1,
          maxAttempts,
          nextRetryAt: 0,
          telegramMessageId: sentMsg.message_id,
          createdAt: eventTimestamp,
          sentAt: Date.now(),
        };
        this.notificationQueue.set(notificationId, sentItem);
        this.saveNotificationQueue();
        this.safelySaveTelegramDispatch(notificationId);
        return { success: true, telegramMessageId: sentMsg.message_id };
      }
    }

    // If immediate send failed or rate-limited -> enqueue with exponential backoff
    const attempts = (existing?.attempts || 0) + 1;
    const backoffMs = this.isRateLimited()
      ? Math.max(3000, this.rateLimitedUntil - Date.now())
      : Math.min(60000, 2000 * Math.pow(2, attempts - 1));

    const pendingItem: QueuedTelegramNotification = {
      notificationId,
      tradeId,
      event,
      chatId,
      message,
      replyMarkup,
      status: 'PENDING',
      attempts,
      maxAttempts,
      nextRetryAt: Date.now() + backoffMs,
      createdAt: existing?.createdAt || eventTimestamp,
      lastError: this.lastSendError || (this.isRateLimited() ? 'Rate limited (429)' : 'Outbound failure'),
    };
    this.notificationQueue.set(notificationId, pendingItem);
    this.saveNotificationQueue();

    return { success: false, queued: true };
  }

  /**
   * Get internal notification queue items (for diagnostics and testing)
   */
  public getNotificationQueue(): QueuedTelegramNotification[] {
    return Array.from(this.notificationQueue.values());
  }

  /**
   * Clear retry queue (for test cleanup)
   */
  public clearRetryQueue(): void {
    this.notificationQueue.clear();
    this.saveNotificationQueue();
  }

  /**
   * Safe parser for bot ID from token
   */
  private getBotIdFromToken(token: string | null): string | null {
    if (!token) return null;
    const parts = token.split(':');
    return parts[0] || null;
  }

  /**
   * Load stored private chat ID from disk or storage fallback or env vars
   */
  private loadRegisteredChat(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        if (data && data.chatId) {
          this.privateChatId = String(data.chatId);
          console.log(`[Telegram] Loaded registered private chat ID: ${this.privateChatId}`);
          return;
        }
      }
      const storageChatId = storage.getTelegramChatId();
      if (storageChatId) {
        this.privateChatId = storageChatId;
        console.log(`[Telegram] Loaded registered private chat ID from storage: ${this.privateChatId}`);
        return;
      }
      const authorizedIds = this.getAuthorizedUserIds();
      if (authorizedIds.length > 0) {
        this.privateChatId = authorizedIds[0];
        console.log(`[Telegram] Loaded private chat ID from authorized user env config: ${this.privateChatId}`);
      }
    } catch (err) {
      console.error('[Telegram] Error loading registered chat ID:', err);
    }
  }

  /**
   * Get active private chat ID with persistent storage and env fallback
   */
  public getPrivateChatId(): string | null {
    if (this.privateChatId) {
      return this.privateChatId;
    }
    const persisted = storage.getTelegramChatId();
    if (persisted) {
      this.privateChatId = persisted;
      return this.privateChatId;
    }
    if (fs.existsSync(this.configPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        if (data && data.chatId) {
          this.privateChatId = String(data.chatId);
          return this.privateChatId;
        }
      } catch {
        // ignore disk read errors
      }
    }
    const authorizedIds = this.getAuthorizedUserIds();
    if (authorizedIds.length > 0) {
      this.privateChatId = authorizedIds[0];
      return this.privateChatId;
    }
    return null;
  }

  /**
   * Save private chat ID to disk safely and permanently in Firestore
   */
  private saveRegisteredChat(chatId: string): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify({ chatId, registeredAt: new Date().toISOString() }, null, 2), 'utf8');
      this.privateChatId = chatId;
      console.log(`[Telegram] Registered and saved new private chat ID: ${chatId}`);

      // Permanently persist to Firestore
      storage.saveTelegramChatId(chatId).catch((err) => {
        console.error('[Telegram] Error saving chat ID to Firestore:', err);
      });
    } catch (err) {
      console.error('[Telegram] Error saving registered chat ID:', err);
    }
  }

  /**
   * Stop polling loop and cancel in-flight requests cleanly
   */
  public stop(): void {
    this.isRunning = false;
    (globalThis as any)[GLOBAL_TELEGRAM_POLLING_RUNNING] = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    console.log('[Telegram] Polling loop stopped cleanly.');
  }

  /**
   * Initialize long-polling to detect /start command from the user
   */
  public async init(): Promise<void> {
    const token = this.getBotToken();
    if (!token) {
      console.warn('[Telegram] TELEGRAM_BOT_TOKEN is not configured in Secrets. Telegram service is offline.');
      return;
    }
    this.botToken = token;
    this.botId = this.getBotIdFromToken(token);

    if (this.isRunning || this.isInitializing || (globalThis as any)[GLOBAL_TELEGRAM_POLLING_RUNNING]) {
      console.log('[Telegram] Polling is already active or initializing. Skipping duplicate init call.');
      return;
    }

    this.isInitializing = true;
    (globalThis as any)[GLOBAL_TELEGRAM_POLLING_RUNNING] = true;

    try {
      // Check and clear any conflicting webhook configuration on Telegram's servers
      await this.ensureWebhookRemoved();

      // Ensure persistent storage chat ID is loaded and applied immediately on startup
      try {
        await storage.waitUntilReady();
        const persistedChatId = storage.getTelegramChatId();
        if (persistedChatId) {
          this.privateChatId = persistedChatId;
          console.log(`[Telegram] Active private chat ID verified from persistent storage: ${this.privateChatId}`);
        }
      } catch (storageErr) {
        console.warn('[Telegram] Warning waiting for storage during init:', storageErr);
      }

      console.log('[Telegram] Brand-new Telegram integration initialized. Starting private chat detection polling...');
      this.isRunning = true;
      this.runPollingLoop().catch((err) => {
        console.error('[Telegram] Unexpected error in polling loop:', err);
      });
    } catch (err: any) {
      console.error('[Telegram] Error during polling initialization:', err?.message || err);
      (globalThis as any)[GLOBAL_TELEGRAM_POLLING_RUNNING] = false;
      this.isRunning = false;
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Check and remove any configured webhook before starting getUpdates long polling
   */
  private async ensureWebhookRemoved(): Promise<void> {
    const token = this.getBotToken();
    if (!token) return;

    try {
      const infoUrl = `https://api.telegram.org/bot${token}/getWebhookInfo`;
      const res = await fetch(infoUrl);
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data?.ok && data?.result?.url) {
          console.log(`[Telegram] Webhook currently configured: "${data.result.url}". Removing webhook to prevent 409 conflict...`);
          const deleteUrl = `https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`;
          const deleteRes = await fetch(deleteUrl);
          const deleteData = (await deleteRes.json()) as any;
          if (deleteData?.ok) {
            console.log('[Telegram] Webhook removed successfully. getUpdates polling can proceed.');
          } else {
            console.warn('[Telegram] Failed to remove webhook:', deleteData?.description);
          }
        } else {
          console.log('[Telegram] Webhook check passed: No active webhook detected for this bot.');
        }
      } else {
        console.warn(`[Telegram] getWebhookInfo returned HTTP ${res.status}. Attempting deleteWebhook fallback...`);
        await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`);
      }
    } catch (err: any) {
      console.warn('[Telegram] Error checking/removing webhook:', err?.message || err);
    }
  }

  /**
   * Non-overlapping sequential polling loop with 409 Conflict handling and graceful backoff
   */
  private async runPollingLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        if (this.isRateLimited()) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        const token = this.getBotToken();
        if (!token) break;

        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${this.lastUpdateId + 1}&limit=10&timeout=2`;
        const res = await fetch(url, { signal });

        if (res.status === 429) {
          let body: any = null;
          try {
            body = await res.json();
          } catch {}
          this.handleRateLimitResponse(body, res.statusText);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        if (res.status === 409) {
          // Telegram 409 Conflict: Another getUpdates request terminated this one.
          // This typically happens during Render zero-downtime deploy handover or when previous instance is draining.
          console.warn('[Telegram] 409 Conflict from getUpdates (another instance or deploy handover in progress). Waiting 5s before retrying...');
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        if (!res.ok) {
          console.warn(`[Telegram Polling Warning] HTTP error ${res.status}. Backing off 3s...`);
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }

        const body = (await res.json()) as any;
        if (body && body.ok && Array.isArray(body.result)) {
          for (const update of body.result) {
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
            await this.processUpdate(update);
          }
        }

        // Sequential rest interval between polling cycles
        if (this.isRunning) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch (err: any) {
        if (err?.name === 'AbortError' || !this.isRunning) {
          break;
        }
        console.debug(`[Telegram Polling Warning] ${err?.message || err}`);
        if (this.isRunning) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      } finally {
        this.abortController = null;
      }
    }
  }

  /**
   * Process incoming webhook / polling updates
   */
  private async processUpdate(update: any): Promise<void> {
    if (!update) return;

    // Handle button presses / callback queries
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    if (!update.message) return;

    const message = update.message;
    const chatId = String(message.chat?.id || '');
    const chatType = message.chat?.type; // 'private' | 'group' | 'supergroup' | 'channel'
    const text = String(message.text || '').trim();

    // Constraint: ONLY allow private chats, never groups, channels, or self
    if (chatType !== 'private') {
      return;
    }

    if (this.botId && chatId === this.botId) {
      console.warn(`[Telegram] Rejecting registration attempt from bot's own self ID: ${chatId}`);
      return;
    }

    // Check for /start command
    if (text.startsWith('/start')) {
      const currentChatId = this.getPrivateChatId();
      // Check authorization whitelist if configured
      const fromId = String(message.from?.id || '');
      if (!this.isAuthorized(chatId) && !this.isAuthorized(fromId)) {
        console.warn(`[Telegram] Unauthorized /start attempt from Chat ID: ${chatId} / User ID: ${fromId}.`);
        await this.sendMessageDirectly(chatId, '⚠️ عذراً، هذا المعرف غير مصرح له باستخدام نظام التداول الآلي.');
        return;
      }

      // Save chat ID if it's new or not yet registered
      if (currentChatId !== chatId) {
        this.saveRegisteredChat(chatId);
        
        // Send a welcoming confirmation message
        await this.sendMessageDirectly(chatId, `
<b>🤖 تفعيل نظام Gold AI Trader بنجاح!</b>

السلام عليكم ورحمة الله وبركاته،
تم ربط هذا الحساب الخاص بنظام التداول الآلي والتحليل الذكي للذهب (XAU/USD).

📈 ستصلك إشعارات الصفقات وإشارات التداول والتقارير الدورية وإجراءات إدارة الصفقات مباشرة ومجاناً هنا في هذه المحادثة الخاصة الآمنة بالكامل.

⏱ <i>الوقت: ${new Date().toLocaleTimeString('ar-EG')}</i>
        `.trim());
      } else {
        // Just send a friendly response that they're already connected
        await this.sendMessageDirectly(chatId, `
<b>ℹ️ نظام Gold AI نشط بالفعل!</b>

هذا الحساب مسجّل ونشط بالفعل لتلقي كافة إشعارات صفقات الذهب وإدارة رأس المال. لا توجد حاجة لإعادة التفعيل.

⏱ <i>الوقت: ${new Date().toLocaleTimeString('ar-EG')}</i>
        `.trim());
      }
      return;
    }

    // Check for /cancel command
    if (text.startsWith('/cancel')) {
      if (this.pendingPnlRequests.has(chatId)) {
        this.clearPendingPnlRequest(chatId);
        await this.sendMessageDirectly(chatId, '❌ تم إلغاء عملية توثيق نتيجة الصفقة.');
      } else {
        await this.sendMessageDirectly(chatId, 'ℹ️ لا توجد عملية توثيق معلقة لإلغائها.');
      }
      return;
    }

    // Check if there is an active pending P&L input waiting for this chat
    const pending = this.pendingPnlRequests.get(chatId);
    if (pending) {
      const cleanText = text.replace(/[$€£\s]/g, '');
      const numMatch = cleanText.match(/[-+]?[0-9]*\.?[0-9]+/);
      if (!numMatch || isNaN(parseFloat(numMatch[0]))) {
        const eg = pending.outcome === 'WIN' ? '12.50' : '4.00';
        await this.sendMessageDirectly(
          chatId,
          `⚠️ <b>قيمة غير صالحة!</b>\nيرجى كتابة رقم صحيح لقيمة ${pending.outcome === 'WIN' ? 'الربح' : 'الخسارة'} بالدولار (USD).\nمثال: <code>${eg}</code>\n\n<i>أرسل /cancel لإلغاء العملية</i>`
        );
        return;
      }

      const rawAmount = parseFloat(numMatch[0]);
      // Authoritative P&L: WIN is positive profit, LOSS is negative loss
      const finalRealizedPnl = pending.outcome === 'WIN' ? Math.abs(rawAmount) : -Math.abs(rawAmount);
      const exitPrice = pending.outcome === 'WIN' ? Number(pending.signal.tp1) : Number(pending.signal.stopLoss);

      const record: any = {
        signalId: pending.signal.id,
        tradeId: pending.signal.id,
        direction: pending.signal.signal,
        orderType: 'MARKET',
        entry: Number(pending.signal.entry),
        stopLoss: Number(pending.signal.stopLoss),
        tp1: Number(pending.signal.tp1),
        tp2: pending.signal.tp2 ? Number(pending.signal.tp2) : undefined,
        outcome: pending.outcome,
        realizedPnl: finalRealizedPnl,
        pl: finalRealizedPnl,
        exitPrice: exitPrice,
        source: 'MANUAL',
        closedAt: Date.now(),
        closeReason: 'MANUAL_TELEGRAM_BUTTON',
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
      };

      const res = await storage.recordTradeOutcomeAsync(record, pending.signal);
      if (res.success) {
        delete this.signalMessageIds[pending.signalId];
        this.saveMessageMapping();

        if (pending.messageId) {
          try {
            await this.removeInlineKeyboard(chatId, pending.messageId);
            const outcomeStr = pending.outcome === 'WIN' ? '🟢 صفقة رابحة (WIN)' : '🔴 صفقة خاسرة (LOSS)';
            const updatedText = `
${pending.originalMessageText || ''}

<b>📝 النتيجة المعتمدة:</b> ${outcomeStr}
💰 <b>الـ P&L الفعلي المحقق:</b> ${finalRealizedPnl >= 0 ? '+' : ''}$${finalRealizedPnl.toFixed(2)}
            `.trim();
            await this.editMessageText(chatId, pending.messageId, updatedText);
          } catch (e) {
            console.warn('[Telegram] Could not edit original message:', e);
          }
        }

        const newBal = storage.getCurrentBalance();
        const outcomeStr = pending.outcome === 'WIN' ? '🟢 صفقة رابحة (WIN)' : '🔴 صفقة خاسرة (LOSS)';
        this.clearPendingPnlRequest(chatId);

        const sigType = escapeTelegramHtml(pending.signal.signal || 'TRADE');
        const sigAsset = escapeTelegramHtml(pending.signal.asset || 'XAU/USD');
        const formattedBal = escapeTelegramHtml(Number(newBal).toFixed(2));
        const pnlStr = escapeTelegramHtml(`${finalRealizedPnl >= 0 ? '+' : ''}$${finalRealizedPnl.toFixed(2)}`);
        const timeStr = escapeTelegramHtml(new Date().toLocaleTimeString('ar-EG'));

        await this.sendMessageDirectly(
          chatId,
          `
✅ <b>تم توثيق الصفقة وتحديث رصيد الحساب بنجاح!</b>

📊 <b>الصفقة:</b> ${sigType} (${sigAsset})
📝 <b>النتيجة:</b> ${outcomeStr}
💵 <b>الـ P&L الفعلي المعتمد:</b> ${pnlStr}
🏦 <b>رصيد الحساب الجديد:</b> $${formattedBal}

⏱ <i>الوقت: ${timeStr}</i>
          `.trim()
        );
      } else {
        const errDesc = escapeTelegramHtml(res.message || 'فشل التوثيق');
        await this.sendMessageDirectly(chatId, `❌ <b>حدث خطأ أثناء حفظ النتيجة:</b> ${errDesc}`);
      }
      return;
    }
  }

  /**
   * Send text directly to a specific chat ID
   */
  private async sendMessageDirectly(chatId: string, text: string, replyMarkup?: any): Promise<any> {
    if (this.isRateLimited()) {
      return null;
    }

    const token = this.getBotToken();
    if (!token) {
      this.lastSendError = 'TELEGRAM_BOT_TOKEN is not configured.';
      return null;
    }

    // Sanitize any unescaped ampersands that might have slipped through in dynamic text
    const sanitizedText = text.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/gi, '&amp;');

    try {
      this.lastSendError = null;
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: sanitizedText,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
      });

      if (res.status === 429) {
        let body: any = null;
        try {
          body = await res.json();
        } catch {}
        this.handleRateLimitResponse(body, res.statusText);
        return null;
      }

      const body = await res.json() as any;
      if (body && body.ok === true) {
        return body.result;
      }
      
      const errMsg = body?.description || `HTTP ${res.status}`;

      // Fallback defense-in-depth: If Telegram rejected due to HTML parse error, retry with stripped tags
      if (res.status === 400 && typeof errMsg === 'string' && (errMsg.toLowerCase().includes('parse entities') || errMsg.toLowerCase().includes('entity') || errMsg.toLowerCase().includes('tag'))) {
        console.warn(`[Telegram Entity Parse Error] Retrying without HTML formatting for chat ${chatId}: ${errMsg}`);
        const plainText = sanitizedText.replace(/<[^>]+>/g, '');
        try {
          const retryRes = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: plainText,
              disable_web_page_preview: true,
              ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            }),
          });
          const retryBody = await retryRes.json() as any;
          if (retryBody && retryBody.ok === true) {
            return retryBody.result;
          }
        } catch (retryErr: any) {
          console.error('[Telegram Fallback Error]', retryErr);
        }
      }

      this.lastSendError = `Telegram API Error (${res.status}): ${errMsg}`;
      console.error(`[Telegram Outbound Error] sendMessage to chat ${chatId} failed (HTTP ${res.status}): ${errMsg}`);
      return null;
    } catch (err: any) {
      this.lastSendError = `Network error: ${err?.message || err}`;
      console.error(`[Telegram Network Error] Error sending message to chat ${chatId}:`, err?.message || err);
      return null;
    }
  }

  /**
   * Edit message text on Telegram
   */
  private async editMessageText(chatId: string, messageId: number, text: string, replyMarkup?: any): Promise<boolean> {
    if (this.isRateLimited()) {
      return false;
    }

    const token = this.getBotToken();
    if (!token) return false;

    // Sanitize any unescaped ampersands that might have slipped through in dynamic text
    const sanitizedText = text.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/gi, '&amp;');

    try {
      const url = `https://api.telegram.org/bot${token}/editMessageText`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: sanitizedText,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
      });

      if (res.status === 429) {
        let body: any = null;
        try {
          body = await res.json();
        } catch {}
        this.handleRateLimitResponse(body, res.statusText);
        return false;
      }

      const body = await res.json() as any;
      if (body && body.ok === true) {
        return true;
      }

      const errMsg = body?.description || `HTTP ${res.status}`;

      // Fallback defense-in-depth: If Telegram rejected due to HTML parse error, retry with stripped tags
      if (res.status === 400 && typeof errMsg === 'string' && (errMsg.toLowerCase().includes('parse entities') || errMsg.toLowerCase().includes('entity') || errMsg.toLowerCase().includes('tag'))) {
        console.warn(`[Telegram Entity Parse Error] Retrying edit without HTML formatting for chat ${chatId}: ${errMsg}`);
        const plainText = sanitizedText.replace(/<[^>]+>/g, '');
        try {
          const retryRes = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: messageId,
              text: plainText,
              disable_web_page_preview: true,
              ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            }),
          });
          const retryBody = await retryRes.json() as any;
          if (retryBody && retryBody.ok === true) {
            return true;
          }
        } catch (retryErr: any) {
          console.error('[Telegram Fallback Error in editMessageText]', retryErr);
        }
      }

      console.error(`[Telegram Outbound Error] editMessageText ${messageId} in chat ${chatId} failed (HTTP ${res.status}): ${errMsg}`);
      return false;
    } catch (err: any) {
      console.error(`[Telegram Network Error] Error editing message text ${messageId} in chat ${chatId}:`, err?.message || err);
      return false;
    }
  }

  /**
   * Remove inline keyboard markup from a message
   */
  private async removeInlineKeyboard(chatId: string, messageId: number): Promise<boolean> {
    if (this.isRateLimited()) {
      return false;
    }

    const token = this.getBotToken();
    if (!token) return false;

    try {
      const url = `https://api.telegram.org/bot${token}/editMessageReplyMarkup`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] }
        }),
      });

      if (res.status === 429) {
        let body: any = null;
        try {
          body = await res.json();
        } catch {}
        this.handleRateLimitResponse(body, res.statusText);
        return false;
      }

      const body = await res.json() as any;
      if (body && body.ok === true) {
        return true;
      }
      console.error(`[Telegram Outbound Error] removeInlineKeyboard ${messageId} in chat ${chatId} failed (HTTP ${res.status}): ${body?.description || 'Unknown error'}`);
      return false;
    } catch (err: any) {
      console.error(`[Telegram Network Error] Error removing inline keyboard for message ${messageId} in chat ${chatId}:`, err?.message || err);
      return false;
    }
  }

  /**
   * Answer a callback query to acknowledge the button press in UI
   */
  private async answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false): Promise<boolean> {
    if (this.isRateLimited()) {
      return false;
    }

    const token = this.getBotToken();
    if (!token) return false;

    try {
      const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          ...(text ? { text, show_alert: showAlert } : {}),
        }),
      });

      if (res.status === 429) {
        let body: any = null;
        try {
          body = await res.json();
        } catch {}
        this.handleRateLimitResponse(body, res.statusText);
        return false;
      }

      const body = await res.json() as any;
      if (body && body.ok === true) {
        return true;
      }
      console.error(`[Telegram Outbound Error] answerCallbackQuery ${callbackQueryId} failed (HTTP ${res.status}): ${body?.description || 'Unknown error'}`);
      return false;
    } catch (err: any) {
      console.error(`[Telegram Network Error] Error answering callback query ${callbackQueryId}:`, err?.message || err);
      return false;
    }
  }

  /**
   * Handles button clicks from users (callback_query updates)
   */
  private async handleCallbackQuery(callbackQuery: any): Promise<void> {
    const queryId = callbackQuery.id;
    const data = String(callbackQuery.data || '').trim();
    const message = callbackQuery.message;
    if (!message) return;

    const chatId = String(message.chat?.id || '');
    const messageId = message.message_id;

    // We only process queries matching our expected actions
    const parts = data.split(':');
    if (parts.length < 2) {
      await this.answerCallbackQuery(queryId, 'بيانات غير صالحة (Invalid callback data)');
      return;
    }

    const action = parts[0];
    const signalId = parts.slice(1).join(':');

    if (action !== 'win' && action !== 'loss' && action !== 'not_entered' && action !== 'entered') {
      await this.answerCallbackQuery(queryId, 'إجراء غير معروف (Unknown action)');
      return;
    }

    try {
      // 1. Fetch signal to verify its existence
      const signal = await storage.getSignalFromStorage(signalId);
      if (!signal) {
        await this.answerCallbackQuery(queryId, 'الإشارة غير موجودة في الذاكرة (Signal not found)');
        return;
      }

      // Check for existing outcome to prevent duplicates
      const existingOutcome = storage.getTradeOutcome(signalId);
      const existingTrade = storage.getTrade(signalId);

      if (existingOutcome || (existingTrade && existingTrade.result !== 'OPEN')) {
        await this.removeInlineKeyboard(chatId, messageId);
        const curResult = existingOutcome?.outcome || existingTrade?.result;
        await this.answerCallbackQuery(queryId, `تم توثيق هذه الإشارة مسبقاً كـ: ${curResult}`, true);
        return;
      }

      if (action === 'entered') {
        // Confirm trade exists in ledger (save as OPEN for active management)
        if (!existingTrade) {
          const newTrade: any = {
            id: signal.id,
            signalId: signal.id,
            tradeNumber: (storage.getTrades(1)[0]?.tradeNumber || 0) + 1,
            date: new Date(signal.timestamp || Date.now()).toLocaleDateString('ar-EG', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
            isoTime: new Date(signal.timestamp || Date.now()).toISOString(),
            asset: signal.asset || 'XAU/USD',
            direction: signal.signal as any,
            entry: Number(signal.entry),
            sl: Number(signal.stopLoss),
            slPoints: signal.slPoints || Math.round(Math.abs(Number(signal.entry) - Number(signal.stopLoss)) / 0.1),
            tp1: Number(signal.tp1),
            tp1Points: signal.tp1Points || Math.round(Math.abs(Number(signal.tp1) - Number(signal.entry)) / 0.1),
            tp2: signal.tp2 ? Number(signal.tp2) : undefined,
            tp2Points: signal.tp2Points || (signal.tp2 ? Math.round(Math.abs(Number(signal.tp2) - Number(signal.entry)) / 0.1) : undefined),
            lotSize: signal.standardLot ?? signal.recommendedLotSize ?? 0.01,
            riskPercent: signal.riskPercent || 15,
            riskAmount: signal.riskAmount || 1.5,
            confidence: signal.confidence || 75,
            setup: signal.setup || 'Telegram Signal',
            rr: signal.rr || '1:1.5',
            result: 'OPEN',
            pl: 0,
            isActive: true,
            source: 'MANUAL',
            notes: 'تم الدخول وتوثيقه عبر زر التليجرام',
          };
          await storage.saveTradeAsync(newTrade);
        }

        signal.lifecycleState = 'ENTERED';
        storage.saveSignal(signal);

        await this.answerCallbackQuery(queryId, '🟢 تم توثيق الدخول في الصفقة (ENTERED) - قيد المتابعة النشطة وإدارة الأهداف');

        const activeKeyboard = {
          inline_keyboard: [
            [
              { text: '🟢 WIN (توثيق ربح)', callback_data: `win:${signal.id}` },
              { text: '🔴 LOSS (توثيق خسارة)', callback_data: `loss:${signal.id}` }
            ]
          ]
        };

        const updatedText = `
${message.text}

<b>📌 حالة الصفقة:</b> 🟢 تم الدخول (ENTERED) - قيد المتابعة وإدارة الأهداف (TP/SL)
        `.trim();
        await this.editMessageText(chatId, messageId, updatedText, activeKeyboard);

      } else if (action === 'win' || action === 'loss') {
        // Confirm trade exists in ledger (save as OPEN if not yet present)
        if (!existingTrade) {
          const newTrade: any = {
            id: signal.id,
            signalId: signal.id,
            tradeNumber: (storage.getTrades(1)[0]?.tradeNumber || 0) + 1,
            date: new Date(signal.timestamp || Date.now()).toLocaleDateString('ar-EG', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
            isoTime: new Date(signal.timestamp || Date.now()).toISOString(),
            asset: signal.asset || 'XAU/USD',
            direction: signal.signal as any,
            entry: Number(signal.entry),
            sl: Number(signal.stopLoss),
            slPoints: signal.slPoints || Math.round(Math.abs(Number(signal.entry) - Number(signal.stopLoss)) / 0.1),
            tp1: Number(signal.tp1),
            tp1Points: signal.tp1Points || Math.round(Math.abs(Number(signal.tp1) - Number(signal.entry)) / 0.1),
            tp2: signal.tp2 ? Number(signal.tp2) : undefined,
            tp2Points: signal.tp2Points || (signal.tp2 ? Math.round(Math.abs(Number(signal.tp2) - Number(signal.entry)) / 0.1) : undefined),
            lotSize: signal.standardLot ?? signal.recommendedLotSize ?? 0.01,
            riskPercent: signal.riskPercent || 15,
            riskAmount: signal.riskAmount || 1.5,
            confidence: signal.confidence || 75,
            setup: signal.setup || 'Telegram Signal',
            rr: signal.rr || '1:1.5',
            result: 'OPEN',
            pl: 0,
            isActive: true,
            source: 'MANUAL',
            notes: 'تم الدخول يدوياً عبر زر التليجرام',
          };
          await storage.saveTradeAsync(newTrade);
        }

        const outcomeVal = action === 'win' ? 'WIN' : 'LOSS';
        const lotSize = signal.standardLot ?? signal.recommendedLotSize ?? 0.01;
        const estProfit = Math.abs(Number(signal.tp1) - Number(signal.entry)) * 100 * lotSize;
        const estLoss = Math.abs(Number(signal.entry) - Number(signal.stopLoss)) * 100 * lotSize;
        const egVal = outcomeVal === 'WIN' ? estProfit.toFixed(2) : estLoss.toFixed(2);

        // Store pending P&L request awaiting user reply with USD amount
        this.pendingPnlRequests.set(chatId, {
          signalId: signal.id,
          outcome: outcomeVal,
          signal,
          messageId,
          originalMessageText: message.text,
          requestedAt: Date.now(),
        });
        this.savePendingPnlRequests();

        await this.answerCallbackQuery(
          queryId,
          outcomeVal === 'WIN' ? '🟢 يرجى إرسال قيمة الربح المحقق بالدولار' : '🔴 يرجى إرسال قيمة الخسارة المحققة بالدولار'
        );

        if (outcomeVal === 'WIN') {
          await this.sendMessageDirectly(
            chatId,
            `🟢 <b>توثيق صفقة رابحة (WIN)</b>\n\n` +
            `📊 <b>الصفقة:</b> ${signal.signal} (${signal.asset || 'XAU/USD'})\n` +
            `📈 <b>الدخول:</b> $${Number(signal.entry).toFixed(2)} | <b>الهدف TP1:</b> $${Number(signal.tp1).toFixed(2)}\n\n` +
            `✍️ <b>يرجى إرسال قيمة الربح الفعلي المحقق بالدولار (USD):</b>\n` +
            `<i>(أرسل الرقم في المحادثة مباشرة، مثال: <code>${egVal}</code> أو <code>15.00</code>)</i>\n\n` +
            `❌ <i>لإلغاء العملية أرسل: /cancel</i>`
          );
        } else {
          await this.sendMessageDirectly(
            chatId,
            `🔴 <b>توثيق صفقة خاسرة (LOSS)</b>\n\n` +
            `📊 <b>الصفقة:</b> ${signal.signal} (${signal.asset || 'XAU/USD'})\n` +
            `📈 <b>الدخول:</b> $${Number(signal.entry).toFixed(2)} | <b>وقف الخسارة SL:</b> $${Number(signal.stopLoss).toFixed(2)}\n\n` +
            `✍️ <b>يرجى إرسال قيمة الخسارة الفعلية بالدولار (USD):</b>\n` +
            `<i>(أرسل الرقم في المحادثة مباشرة، مثال: <code>${egVal}</code> أو <code>-${egVal}</code>)</i>\n\n` +
            `❌ <i>لإلغاء العملية أرسل: /cancel</i>`
          );
        }

      } else if (action === 'not_entered') {
        const res = storage.markSignalOrOpportunityNotEntered(signalId);
        if (res.success) {
          // Proactively remove from active signal tracking
          delete this.signalMessageIds[signalId];
          this.saveMessageMapping();

          await this.answerCallbackQuery(queryId, '⚪ تم وضع الإشارة كـ لم يتم الدخول (NOT ENTERED)');
          await this.removeInlineKeyboard(chatId, messageId);

          const updatedText = `
${message.text}

<b>📝 النتيجة الموثقة يدوياً:</b> ⚪ لم يتم الدخول (NOT ENTERED)
          `.trim();
          await this.editMessageText(chatId, messageId, updatedText);
        } else {
          await this.answerCallbackQuery(queryId, 'فشل وضع الحالة كـ NOT ENTERED');
        }
      }
    } catch (err: any) {
      console.error('[Telegram] Callback handler error:', err);
      await this.answerCallbackQuery(queryId, 'حدث خطأ غير متوقع');
    }
  }

  /**
   * Send a general message to the registered user private chat ONLY
   */
  public async sendMessage(text: string): Promise<{ success: boolean; error?: string }> {
    const token = this.getBotToken();
    if (!token) {
      return { success: false, error: 'Telegram service bot token not configured.' };
    }

    const chatId = this.getPrivateChatId();
    if (!chatId) {
      return { success: false, error: 'NOT_REGISTERED' };
    }

    const result = await this.sendMessageDirectly(chatId, text);
    return {
      success: !!result,
      error: result ? undefined : (this.lastSendError || 'فشل إرسال الرسالة إلى تليجرام'),
    };
  }

  /**
   * Send high-priority system alerts (e.g. MT5 Bridge, Kill-Switch)
   */
  public async sendSystemAlert(text: string): Promise<{ success: boolean; error?: string }> {
    try {
      return await this.sendMessage(text);
    } catch (err: any) {
      console.warn('[Telegram] sendSystemAlert suppressed error:', err?.message);
      return { success: false, error: err?.message };
    }
  }

  /**
   * Get the current registration status
   */
  public getStatus(): TelegramStatus {
    const chatId = this.getPrivateChatId();
    const token = this.getBotToken();
    const botId = this.getBotIdFromToken(token);
    return {
      registered: chatId !== null,
      chatId: chatId,
      botId: botId,
    };
  }

  /**
   * Sends a simple direct test message to verify connectivity (e.g. for /api/telegram/test-signal)
   */
  public async sendSimpleTestMessage(customText?: string, options?: { allowTestDispatch?: boolean }): Promise<{
    success: boolean;
    telegramMessageId?: number;
    chatId?: string;
    error?: string;
  }> {
    const token = this.getBotToken();
    if (!token) {
      return { success: false, error: 'TELEGRAM_BOT_TOKEN is not configured in environment.' };
    }

    const chatId = this.getPrivateChatId();
    if (!chatId) {
      return { success: false, error: 'No Telegram private chat ID registered. Send /start to the bot or set TELEGRAM_AUTHORIZED_USER_IDS.' };
    }

    const text = customText || '✅ Telegram connection test successful';
    const result = await this.sendMessageDirectly(chatId, text);

    if (result && result.message_id) {
      return {
        success: true,
        telegramMessageId: result.message_id,
        chatId,
      };
    }

    return {
      success: false,
      error: this.lastSendError || 'Telegram API rejected message delivery.',
    };
  }

  /**
   * Sends a beautiful test notification to the detected private chat
   */
  public async sendTestNotification(): Promise<{ success: boolean; error?: string }> {
    const token = this.getBotToken();
    if (!token) {
      return { success: false, error: 'البوت غير مكوّن. يرجى إدخال TELEGRAM_BOT_TOKEN في متغيرات البيئة (Secrets).' };
    }

    const chatId = this.getPrivateChatId();
    if (!chatId) {
      return { success: false, error: 'لم يتم العثور على معرّف المحادثة الخاصة (Chat ID). يرجى فتح البوت وإرسال /start أو ضبط TELEGRAM_AUTHORIZED_USER_IDS.' };
    }

    const text = `
<b>🧪 تجربة اتصال نظام Gold AI Trader</b>

الاتصال يعمل بنجاح ومؤمّن بالكامل!
ستصلك كافة التحليلات وإشعارات الصفقات وإجراءات إدارة الصفقات (Phase 4) هنا مباشرة وبشكل آمن تماماً.

🟢 <b>حالة الاتصال:</b> ممتازة (نشط)
🔒 <b>نوع القناة:</b> محادثة خاصة مشفّرة (Private Chat)
⏱ <b>الوقت:</b> ${new Date().toLocaleTimeString('ar-EG')}
    `.trim();

    const result = await this.sendMessageDirectly(chatId, text);
    return {
      success: !!result,
      error: result ? undefined : (this.lastSendError || 'فشل إرسال الرسالة إلى تليجرام'),
    };
  }

  /**
   * Formats and delivers a mock / test trading signal alert
   */
  public async sendMockSignalNotification(): Promise<{ success: boolean; error?: string }> {
    const token = this.getBotToken();
    if (!token) {
      return { success: false, error: 'البوت غير مكوّن. يرجى إدخال TELEGRAM_BOT_TOKEN في متغيرات البيئة (Secrets).' };
    }

    const chatId = this.getPrivateChatId();
    if (!chatId) {
      return { success: false, error: 'لم يتم العثور على معرّف المحادثة الخاصة (Chat ID). يرجى فتح البوت وإرسال /start أو ضبط TELEGRAM_AUTHORIZED_USER_IDS.' };
    }

    const mockSignal = {
      signal: 'BUY (TEST)',
      entry: 2515.50,
      stopLoss: 2505.00,
      slPoints: 105,
      tp1: 2530.00,
      tp2: 2545.00,
      riskPercent: 1.5,
      riskAmount: 15.00,
      confidence: 94,
      setup: 'Bullish Engulfing H4 (تجريبي - اختبار اتصال)',
    };

    const text = `
<b>⚠️ إشارة تجريبية - اختبار اتصال فقط (TEST SIGNAL — NOT A REAL TRADE)</b>

🟢 <b>الصفقة المقترحة:</b> شراء تجريبي (TEST BUY NOW)
📊 <b>الأصل:</b> XAU/USD (الذهب)
📈 <b>سعر الدخول التجريبي:</b> $${escapeTelegramHtml(mockSignal.entry.toFixed(2))}
🛑 <b>وقف الخسارة التجريبي (SL):</b> $${escapeTelegramHtml(mockSignal.stopLoss.toFixed(2))} (${escapeTelegramHtml(mockSignal.slPoints)} نقطة)
🎯 <b>الهدف الأول التجريبي (TP1):</b> $${escapeTelegramHtml(mockSignal.tp1.toFixed(2))}
🎯 <b>الهدف الثاني التجريبي (TP2):</b> ${escapeTelegramHtml(mockSignal.tp2.toFixed(2))}
⚖️ <b>المخاطرة المحاكية:</b> ${escapeTelegramHtml(mockSignal.riskPercent)}% ($${escapeTelegramHtml(mockSignal.riskAmount.toFixed(2))})
🧠 <b>نسبة الثقة:</b> ${escapeTelegramHtml(mockSignal.confidence)}%
🛠️ <b>النموذج الفني:</b> ${escapeTelegramHtml(mockSignal.setup)}

📢 <i>هذه الرسالة تهدف فقط لاختبار جودة وسرعة تسليم إشعارات الصفقات عبر التليجرام. لم يتم فتح أو تنفيذ أي صفقات حقيقية في حسابك.</i>

⏱ <i>الوقت: ${escapeTelegramHtml(new Date().toLocaleTimeString('ar-EG'))}</i>
    `.trim();

    const result = await this.sendMessageDirectly(chatId, text);
    return {
      success: !!result,
      error: result ? undefined : (this.lastSendError || 'فشل إرسال الإشارة التجريبية إلى تليجرام'),
    };
  }

  /**
   * Formats and delivers a newly qualified trade signal alert
   */
  public async sendSignalNotification(signal: any, options?: { allowTestDispatch?: boolean }): Promise<boolean> {
    const isTestAllowed = Boolean(
      options?.allowTestDispatch === true &&
      (signal.isTest === true || String(signal.id).startsWith('test_'))
    );

    const isBuy = String(signal.signal).toUpperCase().includes('BUY');
    const actionEmoji = isBuy ? '🟢' : '🔴';
    const actionText = isBuy ? 'شراء الآن (BUY NOW)' : 'بيع الآن (SELL NOW)';

    const entryStr = !isNaN(Number(signal.entry)) ? Number(signal.entry).toFixed(2) : String(signal.entry ?? '0.00');
    const slStr = !isNaN(Number(signal.stopLoss)) ? Number(signal.stopLoss).toFixed(2) : String(signal.stopLoss ?? '0.00');
    const slPointsStr = signal.slPoints !== undefined ? String(signal.slPoints) : '0';
    const tp1Str = !isNaN(Number(signal.tp1)) ? Number(signal.tp1).toFixed(2) : String(signal.tp1 ?? '0.00');
    const tp2Str = signal.tp2 && !isNaN(Number(signal.tp2)) ? '$' + escapeTelegramHtml(Number(signal.tp2).toFixed(2)) : 'غير محدد';
    const riskPercentStr = escapeTelegramHtml(signal.riskPercent ?? 15);
    const riskAmountStr = !isNaN(Number(signal.riskAmount)) ? Number(signal.riskAmount).toFixed(2) : '1.50';
    const confidenceStr = escapeTelegramHtml(signal.confidence ?? 0);
    const setupStr = escapeTelegramHtml(signal.setup || 'غير محدد');
    const assetStr = escapeTelegramHtml(signal.asset || 'XAU/USD (الذهب)');
    const timeStr = escapeTelegramHtml(new Date().toLocaleTimeString('ar-EG'));

    const text = `
<b>🔔 إشارة تداول جديدة من Gold AI Scanner!</b>

${actionEmoji} <b>الصفقة المقترحة:</b> ${escapeTelegramHtml(actionText)}
📊 <b>الأصل:</b> ${assetStr}
📈 <b>سعر الدخول:</b> $${escapeTelegramHtml(entryStr)}
🛑 <b>وقف الخسارة (SL):</b> $${escapeTelegramHtml(slStr)} (${escapeTelegramHtml(slPointsStr)} نقطة)
🎯 <b>الهدف الأول (TP1):</b> $${escapeTelegramHtml(tp1Str)}
🎯 <b>الهدف الثاني (TP2):</b> ${tp2Str}
⚖️ <b>المخاطرة:</b> ${riskPercentStr}% ($${escapeTelegramHtml(riskAmountStr)})
🧠 <b>نسبة الثقة:</b> ${confidenceStr}%
🛠️ <b>النموذج الفني:</b> ${setupStr}

⏱ <i>الوقت: ${timeStr}</i>
    `.trim();

    // Attach entry & outcome buttons linked to this signal ID
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '🟢 دخلت الصفقة (ENTERED)', callback_data: `entered:${signal.id}` },
          { text: '⚪ لم أدخل (NOT ENTERED)', callback_data: `not_entered:${signal.id}` }
        ],
        [
          { text: '✅ WIN', callback_data: `win:${signal.id}` },
          { text: '❌ LOSS', callback_data: `loss:${signal.id}` }
        ]
      ]
    };

    const notificationId = `signal_${signal.id}`;
    const eventTimestamp = signal.timestamp || signal.createdAt || Date.now();
    const result = await this.dispatchReliableNotification({
      notificationId,
      tradeId: signal.id,
      event: isTestAllowed ? 'TEST_SIGNAL' : 'SIGNAL_NEW',
      message: text,
      replyMarkup,
      eventTimestamp,
      allowTestDispatch: isTestAllowed,
    });

    if (result.telegramMessageId) {
      this.signalMessageIds[signal.id] = result.telegramMessageId;
      this.saveMessageMapping();
    }
    // Return true ONLY if delivery was confirmed by Telegram API (result.success is true only on successful delivery)
    return Boolean(result.success);
  }

  /**
   * Formats and delivers continuous trade management notifications (Phase 4)
   */
  public async sendManagementNotification(
    formattedMessage: string,
    options?: { notificationId?: string; tradeId?: string; event?: string; eventTimestamp?: number }
  ): Promise<boolean> {
    const tradeId = options?.tradeId || 'general';
    const notificationId = options?.notificationId || `mgmt_${tradeId}_${options?.event || 'general'}`;
    const result = await this.dispatchReliableNotification({
      notificationId,
      tradeId: options?.tradeId,
      event: options?.event || 'TRADE_MANAGEMENT',
      message: formattedMessage,
      eventTimestamp: options?.eventTimestamp || Date.now(),
    });
    return Boolean(result.success);
  }

  /**
   * Update active signals with latest price and floating P&L on Telegram
   * DEPRECATED: Replaced by event-driven post-entry trade management notifications (TP1_REACHED, BE_LOCKED, WEAKENING, INVALIDATED).
   * Normal HOLD/development between Entry and TP1/SL produces ZERO Telegram API calls to prevent rate limiting.
   */
  public async updateActiveSignals(_currentPrice: number): Promise<void> {
    // No-op: Periodic floating P&L updates are intentionally disabled.
    return;
  }

  /**
   * Formats and delivers completed trade outcome alerts
   */
  public async sendOutcomeNotification(
    outcome: any,
    trade: any,
    options?: { notificationId?: string; eventTimestamp?: number }
  ): Promise<boolean> {
    const chatId = this.getPrivateChatId();
    if (chatId) {
      // Remove inline outcome buttons on the original signal message to prevent late manual callbacks
      const signalId = outcome.signalId || trade?.signalId || trade?.id || outcome.tradeId;
      if (signalId && this.signalMessageIds[signalId]) {
        const origMsgId = this.signalMessageIds[signalId];
        this.removeInlineKeyboard(chatId, origMsgId).catch(() => {});
        delete this.signalMessageIds[signalId];
        this.saveMessageMapping();
      }
    }

    const isWin = outcome.outcome === 'WIN';
    const isBreakEven = outcome.outcome === 'BREAK_EVEN';
    const outcomeEmoji = isWin ? '🟢' : isBreakEven ? '⚪' : '🔴';
    const outcomeText = isWin ? 'صفقة رابحة (WIN)' : isBreakEven ? 'نقطة الدخول / تعادل (BREAK EVEN)' : 'صفقة خاسرة (LOSS)';
    const pnlSign = outcome.realizedPnl >= 0 ? '+' : '';

    const pnlVal = !isNaN(Number(outcome.realizedPnl)) ? Number(outcome.realizedPnl).toFixed(2) : '0.00';
    const entryVal = !isNaN(Number(outcome.entry || trade?.entry)) ? Number(outcome.entry || trade?.entry).toFixed(2) : '0.00';
    const exitPriceVal = !isNaN(Number(outcome.exitPrice || trade?.exitPrice)) ? Number(outcome.exitPrice || trade?.exitPrice).toFixed(2) : '0.00';
    const closeReasonVal = escapeTelegramHtml(outcome.closeReason || trade?.closeReason || 'تصفية يدوية أو نظام الوقف');
    const assetVal = escapeTelegramHtml(trade?.asset || outcome.asset || 'XAU/USD (الذهب)');
    const timeVal = escapeTelegramHtml(new Date().toLocaleTimeString('ar-EG'));

    const text = `
<b>${outcomeEmoji} توثيق نتيجة صفقة من Gold AI!</b>

📊 <b>الأصل:</b> ${assetVal}
🎯 <b>النتيجة:</b> ${escapeTelegramHtml(outcomeText)}
💰 <b>الربح/الخسارة المحققة:</b> ${pnlSign}$${escapeTelegramHtml(pnlVal)}
📈 <b>سعر الدخول:</b> $${escapeTelegramHtml(entryVal)}
📉 <b>سعر الخروج:</b> $${escapeTelegramHtml(exitPriceVal)}
ℹ️ <b>سبب الإغلاق:</b> ${closeReasonVal}

⏱ <i>الوقت: ${timeVal}</i>
    `.trim();

    const notificationId = options?.notificationId || `close_${trade?.id || outcome.tradeId || 'trade'}`;
    const eventTimestamp = options?.eventTimestamp || outcome.timestamp || (trade?.exitTime ? new Date(trade.exitTime).getTime() : Date.now());

    const result = await this.dispatchReliableNotification({
      notificationId,
      tradeId: trade?.id || outcome.tradeId,
      event: 'OUTCOME_CLOSE',
      message: text,
      eventTimestamp,
    });
    return Boolean(result.success);
  }

  /**
   * Check if there are active signals currently tracked
   */
  public hasActiveSignals(): boolean {
    return Object.keys(this.signalMessageIds).length > 0;
  }

  /**
   * Get the mapped Telegram message ID for a signal
   */
  public getTelegramMessageId(signalId: string): number | undefined {
    return this.signalMessageIds[signalId];
  }
}

// Ensure process-wide singleton across bundled chunks and re-evaluations
const existingInstance = (globalThis as any)[GLOBAL_TELEGRAM_SERVICE_KEY] as TelegramService | undefined;
export const telegramService: TelegramService = existingInstance || new TelegramService();
(globalThis as any)[GLOBAL_TELEGRAM_SERVICE_KEY] = telegramService;

// Graceful cleanup on process exit
if (typeof process !== 'undefined' && process.on) {
  process.once('SIGTERM', () => {
    telegramService.stop();
  });
  process.once('SIGINT', () => {
    telegramService.stop();
  });
}

