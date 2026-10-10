import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

function extractKeyRole(key: string): 'service_role' | 'secret_key' | 'anon' | 'unknown' {
  try {
    if (!key) return 'unknown';
    const trimmed = key.trim();
    if (trimmed.startsWith('sb_secret_')) return 'secret_key';
    if (trimmed.startsWith('sb_publishable_')) return 'anon';

    const parts = trimmed.split('.');
    if (parts.length === 3) {
      // Decode JWT payload without exposing secret token
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const payloadStr = Buffer.from(base64, 'base64').toString('utf8');
      const payload = JSON.parse(payloadStr);
      if (payload && payload.role === 'service_role') return 'service_role';
      if (payload && payload.role === 'anon') return 'anon';
      if (payload && typeof payload.role === 'string') return payload.role as any;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function getSupabaseCredentials(): { url: string; key: string; keySource: string; keyRole: 'service_role' | 'secret_key' | 'anon' | 'unknown' } | null {
  const rawUrl =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_PROJECT_URL;

  let rawKey: string | undefined;
  let keySource = 'NONE';

  // 1. First priority: Server-side privileged Service Role / Secret keys
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    rawKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    keySource = 'SUPABASE_SERVICE_ROLE_KEY';
  } else if (process.env.SUPABASE_SECRET_KEY) {
    rawKey = process.env.SUPABASE_SECRET_KEY;
    keySource = 'SUPABASE_SECRET_KEY';
  } else if (process.env.SUPABASE_SERVICE_KEY) {
    rawKey = process.env.SUPABASE_SERVICE_KEY;
    keySource = 'SUPABASE_SERVICE_KEY';
  } else if (process.env.SUPABASE_KEY) {
    rawKey = process.env.SUPABASE_KEY;
    keySource = 'SUPABASE_KEY';
  } else if (process.env.SUPABASE_API_KEY) {
    rawKey = process.env.SUPABASE_API_KEY;
    keySource = 'SUPABASE_API_KEY';
  } else if (process.env.SUPABASE_ANON_KEY) {
    rawKey = process.env.SUPABASE_ANON_KEY;
    keySource = 'SUPABASE_ANON_KEY';
  } else if (process.env.VITE_SUPABASE_ANON_KEY) {
    rawKey = process.env.VITE_SUPABASE_ANON_KEY;
    keySource = 'VITE_SUPABASE_ANON_KEY';
  } else if (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    rawKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    keySource = 'NEXT_PUBLIC_SUPABASE_ANON_KEY';
  }

  if (!rawUrl || !rawKey) {
    return null;
  }

  let url = rawUrl.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  const key = rawKey.trim().replace(/^["']|["']$/g, '');

  if (!url || !key) {
    return null;
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }

  const keyRole = extractKeyRole(key);

  return { url, key, keySource, keyRole };
}

function createSupabaseClientInstance(): SupabaseClient | null {
  const creds = getSupabaseCredentials();
  if (!creds) {
    return null;
  }

  try {
    const client = createClient(creds.url, creds.key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    console.log(`[Supabase] URL: ${creds.url}`);
    console.log(`[Supabase] Key source: ${creds.keySource}`);
    console.log(`[Supabase] Auth role: ${creds.keyRole}`);

    if (creds.keyRole === 'anon') {
      console.warn(
        `[Supabase Warning] Backend initialized with 'anon' (publishable) key from ${creds.keySource}. ` +
        `Table operations may be restricted if RLS is enabled. Set 'SUPABASE_SERVICE_ROLE_KEY' in your server environment.`
      );
    }

    return client;
  } catch (err: any) {
    console.error('[Supabase] Failed to initialize Supabase client:', err?.message || err);
    return null;
  }
}

export type SupabaseStatus = 'NOT_CONFIGURED' | 'INITIALIZING' | 'CONNECTED' | 'DEGRADED';

// Runtime cached instance
let runtimeSupabaseInstance: SupabaseClient | null = createSupabaseClientInstance();
let connectionStatus: SupabaseStatus = runtimeSupabaseInstance ? 'INITIALIZING' : 'NOT_CONFIGURED';
let lastSuccessfulQueryTime: number | null = null;
let lastFailureTime: number | null = null;
let lastFailureError: string | null = null;
let totalSuccessfulQueries = 0;
let totalFailedQueries = 0;
let verifiedConnection = false;

if (!runtimeSupabaseInstance) {
  console.log(
    '[Supabase] SUPABASE_URL or key not set in environment. PersistentStorage is operating in resilient local-backup mode and will auto-persist to Supabase once configured.'
  );
}

// Temporary connectivity & backoff state
let consecutiveNetworkFailures = 0;
let supabaseBackoffUntil = 0;
let hasLoggedBackoff = false;

/**
 * Checks whether an error is a transport/network layer failure (e.g. fetch failed, DNS, timeout)
 */
export function isSupabaseTransportError(err: any): boolean {
  if (!err) return false;
  const msg = String(err?.message || err);
  const name = String(err?.name || '');
  const code = String(err?.code || '');

  return (
    (name === 'TypeError' && msg.includes('fetch failed')) ||
    msg.includes('fetch failed') ||
    msg.includes('UND_ERR') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('EAI_AGAIN') ||
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT'
  );
}

/**
 * Checks if Supabase is currently available (configured and not in network backoff)
 */
export function isSupabaseAvailable(): boolean {
  if (!isSupabaseConfigured()) {
    return false;
  }
  const now = Date.now();
  if (now < supabaseBackoffUntil) {
    return false;
  }
  if (hasLoggedBackoff) {
    console.log('[Supabase] Backoff cooldown expired. Attempting to resume Supabase persistence operations.');
    hasLoggedBackoff = false;
  }
  return true;
}

/**
 * Called when a Supabase operation succeeds to reset failure counters and mark connection active
 */
export function recordSupabaseSuccess(): void {
  connectionStatus = 'CONNECTED';
  verifiedConnection = true;
  totalSuccessfulQueries++;
  lastSuccessfulQueryTime = Date.now();
  lastFailureError = null;

  if (consecutiveNetworkFailures > 0 || supabaseBackoffUntil > 0) {
    console.log('[Supabase] Connection verified successfully. Cloud database synchronization active.');
  }
  consecutiveNetworkFailures = 0;
  supabaseBackoffUntil = 0;
  hasLoggedBackoff = false;
}

/**
 * Called when a Supabase operation fails. If it is a transport-level failure, triggers exponential backoff.
 */
export function recordSupabaseError(err: any, context?: string): void {
  connectionStatus = 'DEGRADED';
  totalFailedQueries++;
  lastFailureTime = Date.now();
  lastFailureError = String(err?.message || err);

  if (!isSupabaseTransportError(err)) {
    // Normal database/query error (e.g. 400 Bad Request, schema mismatch) - log without triggering network backoff
    const ctx = context ? ` [${context}]` : '';
    console.warn(`[Supabase Error]${ctx}:`, err?.message || err);
    return;
  }

  consecutiveNetworkFailures++;
  // Exponential backoff: 15s -> 30s -> 60s -> 120s -> 240s, capped at 300s (5 minutes)
  const backoffSeconds = Math.min(300, 15 * Math.pow(2, Math.min(consecutiveNetworkFailures - 1, 5)));
  supabaseBackoffUntil = Date.now() + (backoffSeconds * 1000);

  if (!hasLoggedBackoff || consecutiveNetworkFailures === 1 || consecutiveNetworkFailures % 10 === 0) {
    const ctx = context ? ` during ${context}` : '';
    console.warn(
      `[Supabase] Network transport failure${ctx} (${err?.message || 'fetch failed'}). ` +
      `Entering temporary backoff for ${backoffSeconds}s (failures: ${consecutiveNetworkFailures}). ` +
      `Local JSON persistence remains primary and 100% active.`
    );
    hasLoggedBackoff = true;
  }
}

/**
 * Safely executes a Supabase query with automatic backoff and transport failure suppression.
 * Returns null if in backoff or if network transport fails.
 */
export async function executeSupabaseQuery<T = any>(
  queryFn: (client: SupabaseClient) => PromiseLike<{ data?: T; error?: any } | any> | Promise<{ data?: T; error?: any } | any> | any,
  context?: string
): Promise<{ data?: T; error?: any } | null> {
  if (!isSupabaseAvailable()) {
    return null;
  }
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    const res = await queryFn(client);
    if (res && res.error) {
      recordSupabaseError(res.error, context);
      if (!isSupabaseTransportError(res.error)) {
        if (context) {
          console.warn(`[Supabase Error] [${context}]:`, res.error?.message || res.error);
        }
      }
      return res;
    }
    recordSupabaseSuccess();
    return res;
  } catch (err: any) {
    recordSupabaseError(err, context);
    return null;
  }
}

export function isSupabaseConfigured(): boolean {
  if (runtimeSupabaseInstance === null && getSupabaseCredentials() !== null) {
    runtimeSupabaseInstance = createSupabaseClientInstance();
    if (runtimeSupabaseInstance && connectionStatus === 'NOT_CONFIGURED') {
      connectionStatus = 'INITIALIZING';
    }
  }
  return runtimeSupabaseInstance !== null;
}

export function getSupabaseClient(): SupabaseClient | null {
  if (runtimeSupabaseInstance === null && getSupabaseCredentials() !== null) {
    runtimeSupabaseInstance = createSupabaseClientInstance();
  }
  return runtimeSupabaseInstance;
}

/**
 * Returns the exact connection state: 'NOT_CONFIGURED' | 'INITIALIZING' | 'CONNECTED' | 'DEGRADED'
 * Crucial rule: Never report CONNECTED unless a real query has verified connectivity.
 */
export function getSupabaseStatus(): SupabaseStatus {
  if (!isSupabaseConfigured()) {
    return 'NOT_CONFIGURED';
  }
  if (consecutiveNetworkFailures > 0 || Date.now() < supabaseBackoffUntil) {
    return 'DEGRADED';
  }
  if (verifiedConnection && connectionStatus === 'CONNECTED') {
    return 'CONNECTED';
  }
  // Configured with credentials but not yet verified against live database
  return connectionStatus === 'INITIALIZING' ? 'INITIALIZING' : 'DEGRADED';
}

/**
 * Diagnostic status object
 */
export function getSupabaseDiagnostics() {
  const configured = isSupabaseConfigured();
  const status = getSupabaseStatus();
  return {
    status,
    configured,
    isAvailable: isSupabaseAvailable(),
    verifiedConnection,
    totalSuccessfulQueries,
    totalFailedQueries,
    lastSuccessfulQueryTime,
    lastFailureTime,
    lastFailureError,
    keyRole: getSupabaseCredentials()?.keyRole || 'unknown',
  };
}

/**
 * Test helpers for mock injection
 */
export function setSupabaseClientForTesting(mockClient: SupabaseClient | null, status?: SupabaseStatus): void {
  runtimeSupabaseInstance = mockClient;
  if (status) {
    connectionStatus = status;
    verifiedConnection = status === 'CONNECTED';
  } else if (!mockClient) {
    connectionStatus = 'NOT_CONFIGURED';
    verifiedConnection = false;
  } else {
    connectionStatus = 'INITIALIZING';
    verifiedConnection = false;
  }
  consecutiveNetworkFailures = 0;
  supabaseBackoffUntil = 0;
}

export function resetSupabaseStateForTesting(): void {
  runtimeSupabaseInstance = createSupabaseClientInstance();
  connectionStatus = runtimeSupabaseInstance ? 'INITIALIZING' : 'NOT_CONFIGURED';
  verifiedConnection = false;
  lastSuccessfulQueryTime = null;
  lastFailureTime = null;
  lastFailureError = null;
  totalSuccessfulQueries = 0;
  totalFailedQueries = 0;
  consecutiveNetworkFailures = 0;
  supabaseBackoffUntil = 0;
  hasLoggedBackoff = false;
}

// Export the real SupabaseClient instance or null when unconfigured
export const supabase: SupabaseClient | null = runtimeSupabaseInstance;



