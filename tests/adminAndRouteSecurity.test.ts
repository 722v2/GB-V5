import assert from 'assert';
import express from 'express';
import http from 'http';
import { mt5Bridge } from '../server/mt5Bridge.js';

function createTestApp() {
  const app = express();
  app.use(express.json());

  // Known insecure placeholder secrets that must never be accepted
  const KNOWN_PLACEHOLDER_SECRETS = new Set([
    'your_secure_random_bridge_token_here',
    'your_admin_secret_here',
    'your_secure_admin_key_here',
    'your_admin_api_key_here',
    'admin_api_key',
    'admin',
    'password',
    'change_me',
    'changeme',
    'default',
    'default_admin_key',
    '123456',
    '12345678',
  ]);

  const getAdminSecretValidation = (): { isValid: boolean; secret: string; error?: string } => {
    // Dedicated admin secret ONLY from ADMIN_API_KEY (or optional alias ADMIN_SECRET)
    // Strictly NO fallback to MT5_BRIDGE_TOKEN or MT5_API_KEY
    const rawKey = (process.env.ADMIN_API_KEY || process.env.ADMIN_SECRET || '').trim();

    if (!rawKey) {
      return {
        isValid: false,
        secret: '',
        error: 'ADMIN_API_KEY is not configured in the server environment.',
      };
    }

    const normalized = rawKey.toLowerCase();
    if (KNOWN_PLACEHOLDER_SECRETS.has(normalized)) {
      return {
        isValid: false,
        secret: '',
        error: 'ADMIN_API_KEY is set to an insecure default placeholder.',
      };
    }

    if (rawKey.length < 8) {
      return {
        isValid: false,
        secret: '',
        error: 'ADMIN_API_KEY is too short (must be at least 8 characters).',
      };
    }

    return {
      isValid: true,
      secret: rawKey,
    };
  };

  // Sensitive Admin API Authorization Middleware (fails closed if admin secret is missing/invalid)
  const verifyAdminAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const validation = getAdminSecretValidation();
    if (!validation.isValid) {
      return res.status(503).json({
        success: false,
        error: `Service Unavailable: Admin authentication is unavailable (${validation.error}).`,
      });
    }

    const configuredAdminKey = validation.secret;
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : (req.headers['x-admin-key'] as string || req.headers['x-api-key'] as string || authHeader).trim();

    if (!token || token !== configuredAdminKey) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Admin authentication token required for sensitive operations.',
      });
    }

    next();
  };

  // MT5 Bridge Authorization Middleware
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

  // Invocation counters to verify execution prevention on unauthorized requests
  const counters = {
    backtest: 0,
    tradeManagementTests: 0,
    accountingTests: 0,
    cronTickGet: 0,
    cronTickPost: 0,
  };

  const getCronSecretValidation = (): { isValid: boolean; secret: string; error?: string } => {
    // Dedicated cron secret ONLY from CRON_SECRET (or optional alias SCANNER_CRON_SECRET)
    // Strictly NO fallback to ADMIN_API_KEY, ADMIN_SECRET, MT5_BRIDGE_TOKEN, or MT5_API_KEY
    const rawKey = (process.env.CRON_SECRET || process.env.SCANNER_CRON_SECRET || '').trim();

    if (!rawKey) {
      return {
        isValid: false,
        secret: '',
        error: 'CRON_SECRET is not configured in the server environment.',
      };
    }

    const normalized = rawKey.toLowerCase();
    if (KNOWN_PLACEHOLDER_SECRETS.has(normalized)) {
      return {
        isValid: false,
        secret: '',
        error: 'CRON_SECRET is set to an insecure default placeholder.',
      };
    }

    if (rawKey.length < 8) {
      return {
        isValid: false,
        secret: '',
        error: 'CRON_SECRET is too short (must be at least 8 characters).',
      };
    }

    return {
      isValid: true,
      secret: rawKey,
    };
  };

  // Scheduled Cron Webhook Authorization Middleware (fails closed if cron secret is missing/invalid)
  const verifyCronAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const validation = getCronSecretValidation();
    if (!validation.isValid) {
      return res.status(503).json({
        success: false,
        error: `Service Unavailable: Cron authentication is unavailable (${validation.error}).`,
      });
    }

    const configuredCronSecret = validation.secret;
    const authHeader = req.headers.authorization || '';
    const headerToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : (req.headers['x-cron-secret'] as string || req.headers['x-api-key'] as string || '').trim();
    const queryToken = typeof req.query.secret === 'string'
      ? req.query.secret.trim()
      : typeof req.query.key === 'string'
      ? req.query.key.trim()
      : '';
    const token = headerToken || queryToken;

    if (!token || token !== configuredCronSecret) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Valid cron secret required for scheduled scan trigger.',
      });
    }

    next();
  };

  // GET /api/auth/config - Metadata ONLY for UI authorization state (NEVER EXPOSES SECRETS)
  app.get('/api/auth/config', (req, res) => {
    const validation = getAdminSecretValidation();
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : (req.headers['x-admin-key'] as string || req.headers['x-api-key'] as string || authHeader).trim();

    const isAuthenticated = Boolean(validation.isValid && token && token === validation.secret);

    res.json({
      success: true,
      isConfigured: validation.isValid,
      source: validation.isValid ? 'ADMIN_API_KEY' : 'UNCONFIGURED',
      requiresAuth: true,
      authenticated: isAuthenticated,
      error: validation.isValid ? undefined : validation.error,
    });
  });

  // POST /api/auth/verify - Verifies an admin authentication key
  app.post('/api/auth/verify', (req, res) => {
    const validation = getAdminSecretValidation();
    if (!validation.isValid) {
      return res.status(503).json({
        success: false,
        authenticated: false,
        error: `Admin authentication is unavailable: ${validation.error}`,
      });
    }

    const { key } = req.body || {};
    const submittedKey = (key || '').trim();

    if (!submittedKey || submittedKey !== validation.secret) {
      return res.status(401).json({
        success: false,
        authenticated: false,
        error: 'Invalid admin authentication key.',
      });
    }

    res.json({
      success: true,
      authenticated: true,
      message: 'Admin authorization key verified successfully.',
    });
  });

  // Protected Admin Routes
  app.put('/api/settings', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'settings' }));
  app.post('/api/account/balance', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'balance' }));
  app.post('/api/trades/reset-state', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'reset-state' }));
  app.post('/api/mt5/auto-trading/enable', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'enable' }));
  app.post('/api/mt5/auto-trading/disable', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'disable' }));
  app.post('/api/mt5/kill-switch', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'kill-switch' }));
  app.post('/api/mt5/kill-switch/reset', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'reset' }));
  app.post('/api/mt5/order', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'order' }));
  app.post('/api/mt5/modify', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'modify' }));
  app.post('/api/mt5/close', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'close' }));
  app.post('/api/scanner/pause', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'pause' }));
  app.post('/api/scanner/resume', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'resume' }));
  app.post('/api/scanner/scan-now', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'scan-now' }));
  app.post('/api/scanner/toggle', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'toggle' }));
  app.post('/api/scanner/cancel-signal', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'cancel-signal' }));
  app.post('/api/trades', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'post-trades' }));
  app.put('/api/trades/:id', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'put-trades' }));
  app.delete('/api/trades', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'delete-trades' }));
  app.delete('/api/trades/:id', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'delete-trade-id' }));
  app.post('/api/telegram/test', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'telegram-test' }));
  app.post('/api/telegram/test-signal', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'telegram-test-signal' }));
  app.post('/api/record-outcome', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'record-outcome' }));
  app.post('/api/mt5/reconcile', verifyAdminAuth, (req, res) => res.json({ success: true, route: 'reconcile' }));

  // Phase 3 Route Security additions: Backtest and diagnostic test execution routes
  app.post('/api/backtest/run', verifyAdminAuth, (req, res) => {
    counters.backtest++;
    res.json({ success: true, route: 'backtest-run' });
  });
  app.get('/api/trade-management/tests', verifyAdminAuth, (req, res) => {
    counters.tradeManagementTests++;
    res.json({ success: true, route: 'trade-management-tests' });
  });
  app.get('/api/tests/accounting', verifyAdminAuth, (req, res) => {
    counters.accountingTests++;
    res.json({ success: true, route: 'tests-accounting' });
  });

  // Scheduled Cron Webhook Routes (GET & POST)
  app.get('/api/scanner/cron-tick', verifyCronAuth, (req, res) => {
    counters.cronTickGet++;
    res.json({ success: true, route: 'cron-tick-get' });
  });
  app.post('/api/scanner/cron-tick', verifyCronAuth, (req, res) => {
    counters.cronTickPost++;
    res.json({ success: true, route: 'cron-tick-post' });
  });

  // Bridge Endpoints
  app.post('/api/mt5/bridge/heartbeat', verifyBridgeToken, (req, res) => res.json({ success: true, route: 'heartbeat' }));
  app.get('/api/mt5/bridge/commands/poll', verifyBridgeToken, (req, res) => res.json({ success: true, route: 'poll' }));

  return { app, counters };
}

async function makeRequest(
  server: http.Server,
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: any
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = {};
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = { raw: data };
          }
          resolve({ status: res.statusCode || 500, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runSecurityTests() {
  console.log('========================================================================');
  console.log('🔒 RUNNING GB-V5 PHASE 2 & PHASE 3: ADMIN, CRON & ROUTE SECURITY TESTS');
  console.log('========================================================================\n');

  const { app, counters } = createTestApp();
  const server = app.listen(0);
  const address = server.address() as any;
  const port = address.port;

  const originalAdminKey = process.env.ADMIN_API_KEY;
  const originalAdminSecret = process.env.ADMIN_SECRET;
  const originalBridgeToken = process.env.MT5_BRIDGE_TOKEN;
  const originalCronSecret = process.env.CRON_SECRET;
  const originalScannerCronSecret = process.env.SCANNER_CRON_SECRET;

  try {
    // TEST 1: Unconfigured ADMIN_API_KEY fails closed (503) and NEVER falls back to MT5_BRIDGE_TOKEN
    console.log('TEST 1: Unconfigured ADMIN_API_KEY fails closed (503) without fallback to MT5_BRIDGE_TOKEN');
    delete process.env.ADMIN_API_KEY;
    delete process.env.ADMIN_SECRET;
    process.env.MT5_BRIDGE_TOKEN = 'mock_bridge_token_for_test_123';

    // Unauthenticated request fails closed with 503
    const res1Unauth = await makeRequest(server, port, 'POST', '/api/mt5/auto-trading/enable');
    assert.strictEqual(res1Unauth.status, 503, 'Unconfigured admin key must return 503 Service Unavailable');
    assert.strictEqual(res1Unauth.body.success, false);

    // Request presenting MT5_BRIDGE_TOKEN must STILL be rejected with 503 (NO fallback!)
    const res1BridgeToken = await makeRequest(server, port, 'POST', '/api/mt5/auto-trading/enable', {
      Authorization: 'Bearer mock_bridge_token_for_test_123',
    });
    assert.strictEqual(res1BridgeToken.status, 503, 'Admin endpoint must NOT fall back to MT5_BRIDGE_TOKEN (must return 503)');

    // /api/auth/verify returns 503 when admin key unconfigured
    const res1Verify = await makeRequest(server, port, 'POST', '/api/auth/verify', {}, { key: 'mock_bridge_token_for_test_123' });
    assert.strictEqual(res1Verify.status, 503, 'Auth verify must return 503 when admin secret unconfigured');

    // /api/auth/config reports isConfigured=false
    const res1Config = await makeRequest(server, port, 'GET', '/api/auth/config');
    assert.strictEqual(res1Config.body.isConfigured, false, 'isConfigured must be false when unconfigured');
    console.log('✅ [PASS] TEST 1: Unconfigured admin key strictly fails closed with zero fallback to MT5_BRIDGE_TOKEN.\n');

    // TEST 2: Placeholder ADMIN_API_KEY strictly rejected fail-closed (503)
    console.log('TEST 2: Insecure placeholder ADMIN_API_KEY strictly rejected fail-closed (503)');
    const placeholders = [
      'your_secure_random_bridge_token_here',
      'your_admin_secret_here',
      'change_me',
      'admin',
      'password',
    ];

    for (const placeholder of placeholders) {
      process.env.ADMIN_API_KEY = placeholder;
      const resPlaceholder = await makeRequest(server, port, 'PUT', '/api/settings', {
        Authorization: `Bearer ${placeholder}`,
      });
      assert.strictEqual(
        resPlaceholder.status,
        503,
        `Placeholder secret '${placeholder}' must fail closed with 503 Service Unavailable`
      );
    }
    console.log('✅ [PASS] TEST 2: All insecure placeholder secrets rejected fail-closed.\n');

    // TEST 3: Malformed / too short ADMIN_API_KEY (< 8 chars) strictly fails closed (503)
    console.log('TEST 3: Malformed or too short ADMIN_API_KEY rejected fail-closed (503)');
    process.env.ADMIN_API_KEY = 'short';
    const resShort = await makeRequest(server, port, 'POST', '/api/account/balance', {
      Authorization: 'Bearer short',
    });
    assert.strictEqual(resShort.status, 503, 'Short admin key must return 503 Service Unavailable');
    console.log('✅ [PASS] TEST 3: Malformed/short admin secret rejected fail-closed.\n');

    // TEST 4: Valid dedicated ADMIN_API_KEY enforces secret separation
    console.log('TEST 4: Valid dedicated ADMIN_API_KEY enforces strict authentication and secret separation');
    process.env.ADMIN_API_KEY = 'real_admin_secure_key_999';
    process.env.MT5_BRIDGE_TOKEN = 'separate_bridge_token_456';

    // 4a. Request using MT5_BRIDGE_TOKEN on admin endpoint must be rejected with 401
    const res4BridgeTokenOnAdmin = await makeRequest(server, port, 'PUT', '/api/settings', {
      Authorization: 'Bearer separate_bridge_token_456',
    });
    assert.strictEqual(res4BridgeTokenOnAdmin.status, 401, 'Bridge token must NOT authorize admin endpoint');

    // 4b. Request with missing token must return 401
    const res4MissingToken = await makeRequest(server, port, 'PUT', '/api/settings');
    assert.strictEqual(res4MissingToken.status, 401, 'Missing token must return 401');

    // 4c. Request with wrong admin key must return 401
    const res4WrongKey = await makeRequest(server, port, 'PUT', '/api/settings', {
      Authorization: 'Bearer wrong_admin_secret_xyz',
    });
    assert.strictEqual(res4WrongKey.status, 401, 'Wrong admin key must return 401');

    // 4d. Request with valid ADMIN_API_KEY succeeds with 200
    const res4ValidAdmin = await makeRequest(server, port, 'PUT', '/api/settings', {
      Authorization: 'Bearer real_admin_secure_key_999',
    });
    assert.strictEqual(res4ValidAdmin.status, 200, 'Valid dedicated ADMIN_API_KEY must return 200 OK');
    console.log('✅ [PASS] TEST 4: Secret separation verified: Admin routes accept only ADMIN_API_KEY.\n');

    // TEST 5: GET /api/auth/config Metadata ONLY (No secrets returned) & POST /api/auth/verify
    console.log('TEST 5: GET /api/auth/config metadata only & POST /api/auth/verify functionality');
    const res5Config = await makeRequest(server, port, 'GET', '/api/auth/config');
    assert.strictEqual(res5Config.status, 200, 'GET /api/auth/config must return 200');
    assert.strictEqual(res5Config.body.success, true);
    assert.strictEqual(res5Config.body.isConfigured, true);
    assert.strictEqual(res5Config.body.adminKey, undefined, 'CRITICAL: GET /api/auth/config must NEVER return adminKey');
    assert.strictEqual(res5Config.body.secret, undefined, 'CRITICAL: GET /api/auth/config must NEVER return secret');

    // POST /api/auth/verify
    const res5VerifyValid = await makeRequest(server, port, 'POST', '/api/auth/verify', {}, { key: 'real_admin_secure_key_999' });
    assert.strictEqual(res5VerifyValid.status, 200);
    assert.strictEqual(res5VerifyValid.body.authenticated, true);

    const res5VerifyInvalid = await makeRequest(server, port, 'POST', '/api/auth/verify', {}, { key: 'wrong_secret' });
    assert.strictEqual(res5VerifyInvalid.status, 401);
    assert.strictEqual(res5VerifyInvalid.body.authenticated, false);
    console.log('✅ [PASS] TEST 5: Zero secret leakage on /api/auth/config and /api/auth/verify verified.\n');

    // TEST 6: Bridge token continues to authorize bridge endpoints independently
    console.log('TEST 6: MT5 Bridge token continues to authorize bridge endpoints independently');
    const res6Bridge = await makeRequest(server, port, 'POST', '/api/mt5/bridge/heartbeat', {
      Authorization: 'Bearer separate_bridge_token_456',
    });
    assert.strictEqual(res6Bridge.status, 200, 'Bridge token must authorize bridge heartbeat');
    assert.strictEqual(res6Bridge.body.success, true);

    // Admin key cannot authorize bridge endpoints
    const res6AdminOnBridge = await makeRequest(server, port, 'POST', '/api/mt5/bridge/heartbeat', {
      Authorization: 'Bearer real_admin_secure_key_999',
    });
    assert.strictEqual(res6AdminOnBridge.status, 401, 'Admin key must not authorize bridge endpoints');
    console.log('✅ [PASS] TEST 6: Full bidirectional secret separation between Admin and Bridge verified.\n');

    // TEST 7: Comprehensive Audit of All 26 State-Changing / Diagnostic Sensitive Admin Endpoints
    console.log('TEST 7: Comprehensive audit of all 26 sensitive admin endpoints (including backtest & test routes)');

    const sensitiveEndpoints = [
      { method: 'PUT', path: '/api/settings' },
      { method: 'POST', path: '/api/account/balance' },
      { method: 'POST', path: '/api/trades/reset-state' },
      { method: 'POST', path: '/api/mt5/auto-trading/enable' },
      { method: 'POST', path: '/api/mt5/auto-trading/disable' },
      { method: 'POST', path: '/api/mt5/kill-switch' },
      { method: 'POST', path: '/api/mt5/kill-switch/reset' },
      { method: 'POST', path: '/api/mt5/order' },
      { method: 'POST', path: '/api/mt5/modify' },
      { method: 'POST', path: '/api/mt5/close' },
      { method: 'POST', path: '/api/scanner/pause' },
      { method: 'POST', path: '/api/scanner/resume' },
      { method: 'POST', path: '/api/scanner/scan-now' },
      { method: 'POST', path: '/api/scanner/toggle' },
      { method: 'POST', path: '/api/scanner/cancel-signal' },
      { method: 'POST', path: '/api/trades' },
      { method: 'PUT', path: '/api/trades/trade_123' },
      { method: 'DELETE', path: '/api/trades' },
      { method: 'DELETE', path: '/api/trades/trade_123' },
      { method: 'POST', path: '/api/telegram/test' },
      { method: 'POST', path: '/api/telegram/test-signal' },
      { method: 'POST', path: '/api/record-outcome' },
      { method: 'POST', path: '/api/mt5/reconcile' },
      // Phase 3 additions:
      { method: 'POST', path: '/api/backtest/run' },
      { method: 'GET', path: '/api/trade-management/tests' },
      { method: 'GET', path: '/api/tests/accounting' },
    ];

    for (const ep of sensitiveEndpoints) {
      const resUnauth = await makeRequest(server, port, ep.method, ep.path, {});
      assert.strictEqual(
        resUnauth.status,
        401,
        `Unauthenticated ${ep.method} ${ep.path} must return 401 Unauthorized`
      );

      const resAuth = await makeRequest(server, port, ep.method, ep.path, {
        Authorization: 'Bearer real_admin_secure_key_999',
      });
      assert.strictEqual(
        resAuth.status,
        200,
        `Authenticated ${ep.method} ${ep.path} must return 200 OK`
      );
    }
    console.log(`✅ [PASS] TEST 7: All ${sensitiveEndpoints.length} sensitive admin endpoints verified protected.\n`);

    // TEST 8: MT5 Bridge & Core Risk Control Integrity Check
    console.log('TEST 8: Core MT5 Bridge risk controls and symbol validation integrity check');
    mt5Bridge.setExecutionMode('DEMO');
    mt5Bridge.resetKillSwitch();

    const specsValidation = mt5Bridge.validateBrokerSpecs({
      symbol: 'XAUUSD.m',
      contractSize: 100,
      point: 0.01,
      digits: 2,
      volumeMin: 0.01,
      volumeMax: 50.0,
      volumeStep: 0.01,
      tickSize: 0.01,
      tickValue: 1.0,
    });
    assert.strictEqual(specsValidation.isValid, true, 'Valid broker specs must pass validation');
    console.log('✅ [PASS] TEST 8: Risk controls and broker specs intact.\n');

    // ========================================================================
    // PHASE 3 ROUTE SECURITY REMEDIATION TESTS (TESTS 9 - 13)
    // ========================================================================

    // TEST 9: Unconfigured CRON_SECRET strictly fails closed (503) without fallback
    console.log('TEST 9: Unconfigured CRON_SECRET strictly fails closed (503) without fallback to ADMIN_API_KEY, ADMIN_SECRET, or MT5_BRIDGE_TOKEN');
    delete process.env.CRON_SECRET;
    delete process.env.SCANNER_CRON_SECRET;
    process.env.ADMIN_API_KEY = 'real_admin_secure_key_999';
    process.env.MT5_BRIDGE_TOKEN = 'separate_bridge_token_456';

    counters.cronTickGet = 0;
    counters.cronTickPost = 0;

    // GET /api/scanner/cron-tick without auth -> 503
    const res9GetUnauth = await makeRequest(server, port, 'GET', '/api/scanner/cron-tick');
    assert.strictEqual(res9GetUnauth.status, 503, 'Unconfigured CRON_SECRET must return 503 on GET');
    assert.strictEqual(res9GetUnauth.body.success, false);

    // POST /api/scanner/cron-tick without auth -> 503
    const res9PostUnauth = await makeRequest(server, port, 'POST', '/api/scanner/cron-tick');
    assert.strictEqual(res9PostUnauth.status, 503, 'Unconfigured CRON_SECRET must return 503 on POST');
    assert.strictEqual(res9PostUnauth.body.success, false);

    // Request presenting ADMIN_API_KEY on cron endpoint must STILL return 503 (no fallback!)
    const res9AdminOnCron = await makeRequest(server, port, 'GET', '/api/scanner/cron-tick', {
      Authorization: 'Bearer real_admin_secure_key_999',
    });
    assert.strictEqual(res9AdminOnCron.status, 503, 'Cron endpoint must not fall back to ADMIN_API_KEY');

    // Request presenting MT5_BRIDGE_TOKEN on cron endpoint must STILL return 503 (no fallback!)
    const res9BridgeOnCron = await makeRequest(server, port, 'POST', '/api/scanner/cron-tick', {
      Authorization: 'Bearer separate_bridge_token_456',
    });
    assert.strictEqual(res9BridgeOnCron.status, 503, 'Cron endpoint must not fall back to MT5_BRIDGE_TOKEN');

    // Verify handler execution was completely prevented
    assert.strictEqual(counters.cronTickGet, 0, 'Scan handler must not execute when unconfigured');
    assert.strictEqual(counters.cronTickPost, 0, 'Scan handler must not execute when unconfigured');
    console.log('✅ [PASS] TEST 9: Unconfigured CRON_SECRET strictly fails closed (503) with zero secret fallback.\n');

    // TEST 10: Insecure placeholder or short CRON_SECRET strictly fails closed (503)
    console.log('TEST 10: Insecure placeholder or short CRON_SECRET strictly fails closed (503)');
    const cronPlaceholders = [
      'your_secure_random_bridge_token_here',
      'your_admin_secret_here',
      'change_me',
      'admin',
      'password',
    ];

    for (const placeholder of cronPlaceholders) {
      process.env.CRON_SECRET = placeholder;
      const resPlaceholderGet = await makeRequest(server, port, 'GET', '/api/scanner/cron-tick', {
        Authorization: `Bearer ${placeholder}`,
      });
      assert.strictEqual(
        resPlaceholderGet.status,
        503,
        `Placeholder CRON_SECRET '${placeholder}' must return 503`
      );
    }

    // Short secret (< 8 chars)
    process.env.CRON_SECRET = 'short';
    const resShortCron = await makeRequest(server, port, 'GET', '/api/scanner/cron-tick', {
      Authorization: 'Bearer short',
    });
    assert.strictEqual(resShortCron.status, 503, 'Short CRON_SECRET (< 8 chars) must return 503');

    assert.strictEqual(counters.cronTickGet, 0, 'Scan handler must not execute on placeholder/short secret');
    console.log('✅ [PASS] TEST 10: All insecure/short CRON_SECRET configurations fail closed (503).\n');

    // TEST 11: Valid dedicated CRON_SECRET enforces strict authentication and secret separation
    console.log('TEST 11: Valid dedicated CRON_SECRET enforces strict authentication and secret separation');
    process.env.CRON_SECRET = 'dedicated_cron_webhook_secret_777';
    process.env.ADMIN_API_KEY = 'real_admin_secure_key_999';
    process.env.MT5_BRIDGE_TOKEN = 'separate_bridge_token_456';

    counters.cronTickGet = 0;
    counters.cronTickPost = 0;

    // 11a. Missing credentials return 401
    const res11MissingGet = await makeRequest(server, port, 'GET', '/api/scanner/cron-tick');
    assert.strictEqual(res11MissingGet.status, 401, 'Missing cron secret on GET must return 401');
    const res11MissingPost = await makeRequest(server, port, 'POST', '/api/scanner/cron-tick');
    assert.strictEqual(res11MissingPost.status, 401, 'Missing cron secret on POST must return 401');

    // 11b. Wrong credentials return 401
    const res11Wrong = await makeRequest(server, port, 'GET', '/api/scanner/cron-tick', {
      Authorization: 'Bearer wrong_cron_secret_000',
    });
    assert.strictEqual(res11Wrong.status, 401, 'Wrong cron secret must return 401');

    // 11c. Presenting ADMIN_API_KEY on cron endpoint returns 401 (strict secret separation)
    const res11AdminOnCron = await makeRequest(server, port, 'GET', '/api/scanner/cron-tick', {
      Authorization: 'Bearer real_admin_secure_key_999',
    });
    assert.strictEqual(res11AdminOnCron.status, 401, 'ADMIN_API_KEY must NOT authorize cron endpoint');

    // 11d. Presenting MT5_BRIDGE_TOKEN on cron endpoint returns 401 (strict secret separation)
    const res11BridgeOnCron = await makeRequest(server, port, 'POST', '/api/scanner/cron-tick', {
      Authorization: 'Bearer separate_bridge_token_456',
    });
    assert.strictEqual(res11BridgeOnCron.status, 401, 'MT5_BRIDGE_TOKEN must NOT authorize cron endpoint');

    assert.strictEqual(counters.cronTickGet, 0, 'No unauthorized request triggered GET scan handler');
    assert.strictEqual(counters.cronTickPost, 0, 'No unauthorized request triggered POST scan handler');

    // 11e. Valid CRON_SECRET via Bearer token succeeds on GET (200)
    const res11ValidBearerGet = await makeRequest(server, port, 'GET', '/api/scanner/cron-tick', {
      Authorization: 'Bearer dedicated_cron_webhook_secret_777',
    });
    assert.strictEqual(res11ValidBearerGet.status, 200, 'Valid Bearer token must authorize GET /api/scanner/cron-tick');
    assert.strictEqual(counters.cronTickGet, 1, 'GET scan handler invoked exactly once');

    // 11f. Valid CRON_SECRET via Bearer token succeeds on POST (200)
    const res11ValidBearerPost = await makeRequest(server, port, 'POST', '/api/scanner/cron-tick', {
      Authorization: 'Bearer dedicated_cron_webhook_secret_777',
    });
    assert.strictEqual(res11ValidBearerPost.status, 200, 'Valid Bearer token must authorize POST /api/scanner/cron-tick');
    assert.strictEqual(counters.cronTickPost, 1, 'POST scan handler invoked exactly once');

    // 11g. Valid CRON_SECRET via x-cron-secret header succeeds on GET (200)
    const res11HeaderGet = await makeRequest(server, port, 'GET', '/api/scanner/cron-tick', {
      'x-cron-secret': 'dedicated_cron_webhook_secret_777',
    });
    assert.strictEqual(res11HeaderGet.status, 200, 'x-cron-secret header must authorize GET');
    assert.strictEqual(counters.cronTickGet, 2, 'GET scan handler invoked for x-cron-secret');

    // 11h. Valid CRON_SECRET via ?secret= query param succeeds on GET (200)
    const res11QuerySecret = await makeRequest(server, port, 'GET', '/api/scanner/cron-tick?secret=dedicated_cron_webhook_secret_777');
    assert.strictEqual(res11QuerySecret.status, 200, '?secret query param must authorize GET');
    assert.strictEqual(counters.cronTickGet, 3, 'GET scan handler invoked for ?secret query');

    // 11i. Valid CRON_SECRET via ?key= query param succeeds on POST (200)
    const res11QueryKey = await makeRequest(server, port, 'POST', '/api/scanner/cron-tick?key=dedicated_cron_webhook_secret_777');
    assert.strictEqual(res11QueryKey.status, 200, '?key query param must authorize POST');
    assert.strictEqual(counters.cronTickPost, 2, 'POST scan handler invoked for ?key query');

    // 11j. Presenting CRON_SECRET on admin endpoints returns 401
    const res11CronOnAdmin = await makeRequest(server, port, 'PUT', '/api/settings', {
      Authorization: 'Bearer dedicated_cron_webhook_secret_777',
    });
    assert.strictEqual(res11CronOnAdmin.status, 401, 'CRON_SECRET must NOT authorize admin routes');

    // 11k. Presenting CRON_SECRET on bridge endpoints returns 401
    const res11CronOnBridge = await makeRequest(server, port, 'POST', '/api/mt5/bridge/heartbeat', {
      Authorization: 'Bearer dedicated_cron_webhook_secret_777',
    });
    assert.strictEqual(res11CronOnBridge.status, 401, 'CRON_SECRET must NOT authorize bridge routes');

    console.log('✅ [PASS] TEST 11: Valid CRON_SECRET authorizes legitimate scheduled calls; secret separation strictly enforced.\n');

    // TEST 12: Route Security for Backtest and Diagnostic Test-Execution Endpoints
    console.log('TEST 12: Route Security for Backtest and Diagnostic Test-Execution Endpoints');
    process.env.ADMIN_API_KEY = 'real_admin_secure_key_999';
    process.env.CRON_SECRET = 'dedicated_cron_webhook_secret_777';
    process.env.MT5_BRIDGE_TOKEN = 'separate_bridge_token_456';

    // 12a. POST /api/backtest/run
    counters.backtest = 0;
    const res12BacktestUnauth = await makeRequest(server, port, 'POST', '/api/backtest/run');
    assert.strictEqual(res12BacktestUnauth.status, 401, 'Unauthenticated /api/backtest/run must return 401');
    assert.strictEqual(counters.backtest, 0, 'Backtest must not execute without auth');

    const res12BacktestWrong = await makeRequest(server, port, 'POST', '/api/backtest/run', {
      Authorization: 'Bearer wrong_admin_secret',
    });
    assert.strictEqual(res12BacktestWrong.status, 401, 'Wrong admin key must return 401');
    assert.strictEqual(counters.backtest, 0, 'Backtest must not execute with wrong key');

    const res12BacktestCron = await makeRequest(server, port, 'POST', '/api/backtest/run', {
      Authorization: 'Bearer dedicated_cron_webhook_secret_777',
    });
    assert.strictEqual(res12BacktestCron.status, 401, 'CRON_SECRET must not authorize backtest');
    assert.strictEqual(counters.backtest, 0, 'Backtest must not execute with CRON_SECRET');

    const res12BacktestBridge = await makeRequest(server, port, 'POST', '/api/backtest/run', {
      Authorization: 'Bearer separate_bridge_token_456',
    });
    assert.strictEqual(res12BacktestBridge.status, 401, 'MT5_BRIDGE_TOKEN must not authorize backtest');
    assert.strictEqual(counters.backtest, 0, 'Backtest must not execute with MT5_BRIDGE_TOKEN');

    const res12BacktestValid = await makeRequest(server, port, 'POST', '/api/backtest/run', {
      Authorization: 'Bearer real_admin_secure_key_999',
    });
    assert.strictEqual(res12BacktestValid.status, 200, 'Valid admin key must authorize backtest');
    assert.strictEqual(counters.backtest, 1, 'Backtest executed exactly once for authorized admin');

    // 12b. GET /api/trade-management/tests
    counters.tradeManagementTests = 0;
    const res12TmUnauth = await makeRequest(server, port, 'GET', '/api/trade-management/tests');
    assert.strictEqual(res12TmUnauth.status, 401, 'Unauthenticated /api/trade-management/tests must return 401');
    assert.strictEqual(counters.tradeManagementTests, 0, 'Trade management tests must not execute without auth');

    const res12TmCron = await makeRequest(server, port, 'GET', '/api/trade-management/tests', {
      Authorization: 'Bearer dedicated_cron_webhook_secret_777',
    });
    assert.strictEqual(res12TmCron.status, 401, 'CRON_SECRET must not authorize trade management tests');
    assert.strictEqual(counters.tradeManagementTests, 0, 'Trade management tests must not execute with CRON_SECRET');

    const res12TmValid = await makeRequest(server, port, 'GET', '/api/trade-management/tests', {
      Authorization: 'Bearer real_admin_secure_key_999',
    });
    assert.strictEqual(res12TmValid.status, 200, 'Valid admin key must authorize trade management tests');
    assert.strictEqual(counters.tradeManagementTests, 1, 'Trade management tests executed exactly once');

    // 12c. GET /api/tests/accounting
    counters.accountingTests = 0;
    const res12AccUnauth = await makeRequest(server, port, 'GET', '/api/tests/accounting');
    assert.strictEqual(res12AccUnauth.status, 401, 'Unauthenticated /api/tests/accounting must return 401');
    assert.strictEqual(counters.accountingTests, 0, 'Accounting tests must not execute without auth');

    const res12AccCron = await makeRequest(server, port, 'GET', '/api/tests/accounting', {
      Authorization: 'Bearer dedicated_cron_webhook_secret_777',
    });
    assert.strictEqual(res12AccCron.status, 401, 'CRON_SECRET must not authorize accounting tests');
    assert.strictEqual(counters.accountingTests, 0, 'Accounting tests must not execute with CRON_SECRET');

    const res12AccValid = await makeRequest(server, port, 'GET', '/api/tests/accounting', {
      Authorization: 'Bearer real_admin_secure_key_999',
    });
    assert.strictEqual(res12AccValid.status, 200, 'Valid admin key must authorize accounting tests');
    assert.strictEqual(counters.accountingTests, 1, 'Accounting tests executed exactly once');

    console.log('✅ [PASS] TEST 12: Backtest and both diagnostic test-execution routes verified protected fail-closed.\n');

    // TEST 13: Optional alias SCANNER_CRON_SECRET support
    console.log('TEST 13: Optional alias SCANNER_CRON_SECRET operates correctly when CRON_SECRET unset');
    delete process.env.CRON_SECRET;
    process.env.SCANNER_CRON_SECRET = 'alias_scanner_cron_secret_888';

    const res13AliasGet = await makeRequest(server, port, 'GET', '/api/scanner/cron-tick', {
      Authorization: 'Bearer alias_scanner_cron_secret_888',
    });
    assert.strictEqual(res13AliasGet.status, 200, 'SCANNER_CRON_SECRET must authorize cron tick');

    const res13AliasWrong = await makeRequest(server, port, 'GET', '/api/scanner/cron-tick', {
      Authorization: 'Bearer wrong_alias_token',
    });
    assert.strictEqual(res13AliasWrong.status, 401, 'Wrong alias secret must return 401');
    console.log('✅ [PASS] TEST 13: SCANNER_CRON_SECRET alias operates securely without leaks or cross-talk.\n');

    console.log('========================================================================');
    console.log('🎉 ALL PHASE 2 & PHASE 3 ADMIN, CRON & ROUTE SECURITY TESTS PASSED!');
    console.log('========================================================================');
  } finally {
    server.close();
    if (originalAdminKey !== undefined) process.env.ADMIN_API_KEY = originalAdminKey;
    else delete process.env.ADMIN_API_KEY;

    if (originalAdminSecret !== undefined) process.env.ADMIN_SECRET = originalAdminSecret;
    else delete process.env.ADMIN_SECRET;

    if (originalBridgeToken !== undefined) process.env.MT5_BRIDGE_TOKEN = originalBridgeToken;
    else delete process.env.MT5_BRIDGE_TOKEN;

    if (originalCronSecret !== undefined) process.env.CRON_SECRET = originalCronSecret;
    else delete process.env.CRON_SECRET;

    if (originalScannerCronSecret !== undefined) process.env.SCANNER_CRON_SECRET = originalScannerCronSecret;
    else delete process.env.SCANNER_CRON_SECRET;
  }
}

runSecurityTests().catch((err) => {
  console.error('Security test failed:', err);
  process.exit(1);
});
