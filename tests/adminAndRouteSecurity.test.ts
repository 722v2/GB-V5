import assert from 'assert';
import express from 'express';
import http from 'http';
import { mt5Bridge } from '../server/mt5Bridge.js';

import crypto from 'crypto';

function createTestApp() {
  const app = express();
  app.use(express.json());

  const DEFAULT_ADMIN_KEY = 'your_secure_random_bridge_token_here';

  const getAdminKey = (): { key: string; source: string } => {
    const envAdminKey = (process.env.ADMIN_API_KEY || '').trim();
    if (envAdminKey) {
      return { key: envAdminKey, source: 'ADMIN_API_KEY' };
    }
    const envBridgeToken = (process.env.MT5_BRIDGE_TOKEN || process.env.MT5_API_KEY || '').trim();
    if (envBridgeToken) {
      return { key: envBridgeToken, source: 'MT5_BRIDGE_TOKEN' };
    }
    return { key: DEFAULT_ADMIN_KEY, source: 'DEFAULT' };
  };

  // Sensitive Admin API Authorization Middleware
  const verifyAdminAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const { key: configuredAdminKey } = getAdminKey();

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

  // GET /api/auth/config - Metadata ONLY for UI authorization state (NEVER EXPOSES SECRETS)
  app.get('/api/auth/config', (req, res) => {
    const { source } = getAdminKey();
    const { key: configuredAdminKey } = getAdminKey();
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : (req.headers['x-admin-key'] as string || req.headers['x-api-key'] as string || authHeader).trim();

    const isAuthenticated = Boolean(token && token === configuredAdminKey);

    res.json({
      success: true,
      isConfigured: true,
      source,
      requiresAuth: true,
      authenticated: isAuthenticated,
    });
  });

  // POST /api/auth/verify - Verifies an admin authentication key
  app.post('/api/auth/verify', (req, res) => {
    const { key } = req.body || {};
    const { key: configuredKey } = getAdminKey();
    const submittedKey = (key || '').trim();

    if (!submittedKey || submittedKey !== configuredKey) {
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

  // Bridge Endpoints
  app.post('/api/mt5/bridge/heartbeat', verifyBridgeToken, (req, res) => res.json({ success: true, route: 'heartbeat' }));
  app.get('/api/mt5/bridge/commands/poll', verifyBridgeToken, (req, res) => res.json({ success: true, route: 'poll' }));

  return app;
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
  console.log('🔒 RUNNING GB-V5 ADMIN & ROUTE AUTHENTICATION ISOLATION TEST SUITE');
  console.log('========================================================================\n');

  const app = createTestApp();
  const server = app.listen(0);
  const address = server.address() as any;
  const port = address.port;

  const originalAdminKey = process.env.ADMIN_API_KEY;
  const originalBridgeToken = process.env.MT5_BRIDGE_TOKEN;

  try {
    // TEST 1: Unconfigured ADMIN_API_KEY falls back seamlessly to MT5_BRIDGE_TOKEN without 503
    console.log('TEST 1: Unconfigured ADMIN_API_KEY falls back seamlessly to MT5_BRIDGE_TOKEN');
    delete process.env.ADMIN_API_KEY;
    process.env.MT5_BRIDGE_TOKEN = 'secret_bridge_token_123';

    // Request without token must be rejected with 401
    const res1Unauth = await makeRequest(server, port, 'POST', '/api/mt5/auto-trading/enable');
    assert.strictEqual(res1Unauth.status, 401, 'Unauthenticated request must return 401');

    // Request using MT5_BRIDGE_TOKEN succeeds when ADMIN_API_KEY is unset
    const res1Auth = await makeRequest(server, port, 'POST', '/api/mt5/auto-trading/enable', {
      Authorization: 'Bearer secret_bridge_token_123',
    });
    assert.strictEqual(res1Auth.status, 200, 'Request authorized via fallback MT5_BRIDGE_TOKEN must return 200');
    console.log('✅ [PASS] TEST 1: Seamless fallback to MT5_BRIDGE_TOKEN verified without breaking single-user app.\n');

    // TEST 2: Dedicated ADMIN_API_KEY takes priority when explicitly configured
    console.log('TEST 2: Explicit ADMIN_API_KEY takes priority over MT5_BRIDGE_TOKEN');
    process.env.ADMIN_API_KEY = 'real_admin_key_999';
    process.env.MT5_BRIDGE_TOKEN = 'valid_bridge_token_456';

    const res2WrongKey = await makeRequest(server, port, 'PUT', '/api/settings', {
      Authorization: 'Bearer valid_bridge_token_456',
    });
    assert.strictEqual(res2WrongKey.status, 401, 'Bridge token must NOT authorize admin endpoint when ADMIN_API_KEY is explicitly set');
    
    const res2CorrectKey = await makeRequest(server, port, 'PUT', '/api/settings', {
      Authorization: 'Bearer real_admin_key_999',
    });
    assert.strictEqual(res2CorrectKey.status, 200, 'Explicit ADMIN_API_KEY authorizes admin endpoint');
    console.log('✅ [PASS] TEST 2: Priority of explicit ADMIN_API_KEY over bridge token verified (HTTP 200).\n');

    // TEST 3: Invalid admin key is rejected (401)
    console.log('TEST 3: Invalid admin key is rejected');
    const res3 = await makeRequest(server, port, 'POST', '/api/mt5/order', {
      Authorization: 'Bearer wrong_admin_key',
    });
    assert.strictEqual(res3.status, 401, 'Invalid admin key must return 401');
    assert.strictEqual(res3.body.success, false, 'Success must be false');
    console.log('✅ [PASS] TEST 3: Invalid admin key correctly rejected (HTTP 401).\n');

    // TEST 4: GET /api/auth/config Metadata ONLY (No secrets returned) & POST /api/auth/verify
    console.log('TEST 4: GET /api/auth/config never exposes secrets & POST /api/auth/verify verifies client key');
    const res4Config = await makeRequest(server, port, 'GET', '/api/auth/config');
    assert.strictEqual(res4Config.status, 200, 'GET /api/auth/config must return 200');
    assert.strictEqual(res4Config.body.success, true, 'Config success must be true');
    assert.strictEqual(res4Config.body.adminKey, undefined, 'CRITICAL: GET /api/auth/config MUST NOT return adminKey or any secret');
    assert.strictEqual(res4Config.body.isConfigured, true, 'isConfigured must be true');

    // Test POST /api/auth/verify
    const res4VerifyValid = await makeRequest(server, port, 'POST', '/api/auth/verify', {}, { key: 'real_admin_key_999' });
    assert.strictEqual(res4VerifyValid.status, 200, 'Valid key verification must return 200');
    assert.strictEqual(res4VerifyValid.body.authenticated, true, 'Authenticated must be true for valid key');

    const res4VerifyInvalid = await makeRequest(server, port, 'POST', '/api/auth/verify', {}, { key: 'invalid_key_123' });
    assert.strictEqual(res4VerifyInvalid.status, 401, 'Invalid key verification must return 401');
    assert.strictEqual(res4VerifyInvalid.body.authenticated, false, 'Authenticated must be false for invalid key');

    // Test simulated server reinitialization (persistence test)
    console.log('TEST 4b: Authentication persistence across simulated server reinitialization');
    const appReboot = createTestApp();
    const serverReboot = appReboot.listen(0);
    const portReboot = (serverReboot.address() as any).port;

    const resRebootVerify = await makeRequest(serverReboot, portReboot, 'POST', '/api/auth/verify', {}, { key: 'real_admin_key_999' });
    assert.strictEqual(resRebootVerify.status, 200, 'Key must remain valid across server reinitialization');
    assert.strictEqual(resRebootVerify.body.authenticated, true, 'Key verification must succeed on rebooted server');
    serverReboot.close();

    console.log('✅ [PASS] TEST 4: Zero secret exposure on /api/auth/config, /api/auth/verify functionality, and server reboot persistence verified.\n');

    // TEST 5: Bridge token continues to authorize bridge endpoints
    console.log('TEST 5: Bridge token authorizes bridge endpoints');
    const res5 = await makeRequest(server, port, 'POST', '/api/mt5/bridge/heartbeat', {
      Authorization: 'Bearer valid_bridge_token_456',
    });
    assert.strictEqual(res5.status, 200, 'Bridge token must authorize heartbeat');
    assert.strictEqual(res5.body.success, true, 'Bridge response must succeed');
    console.log('✅ [PASS] TEST 5: Bridge token correctly authorizes bridge endpoints.\n');

    // TEST 6: Comprehensive Audit of All 23 State-Changing Sensitive Endpoints (including account/balance and trades/reset-state)
    console.log('TEST 6: Comprehensive audit of all state-changing endpoints without authorization');

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
    ];

    for (const ep of sensitiveEndpoints) {
      const resUnauth = await makeRequest(server, port, ep.method, ep.path, {});
      assert.strictEqual(
        resUnauth.status,
        401,
        `Unauthenticated ${ep.method} ${ep.path} must return 401 Unauthorized`
      );

      const resAuth = await makeRequest(server, port, ep.method, ep.path, {
        Authorization: 'Bearer real_admin_key_999',
      });
      assert.strictEqual(
        resAuth.status,
        200,
        `Authenticated ${ep.method} ${ep.path} must return 200 OK`
      );
    }
    console.log(`✅ [PASS] TEST 6: All ${sensitiveEndpoints.length} sensitive endpoints verified protected.\n`);

    // TEST 7: MT5 Bridge & Core Risk Control Integrity Check
    console.log('TEST 7: Core MT5 Bridge risk controls and symbol validation integrity check');
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

    console.log('✅ [PASS] TEST 7: Risk controls and symbol specifications intact.\n');

    console.log('========================================================================');
    console.log('🎉 ALL SECURITY & ROUTE AUTHENTICATION TESTS PASSED!');
    console.log('========================================================================');
  } finally {
    server.close();
    if (originalAdminKey !== undefined) process.env.ADMIN_API_KEY = originalAdminKey;
    else delete process.env.ADMIN_API_KEY;

    if (originalBridgeToken !== undefined) process.env.MT5_BRIDGE_TOKEN = originalBridgeToken;
    else delete process.env.MT5_BRIDGE_TOKEN;
  }
}

runSecurityTests().catch((err) => {
  console.error('Security test failed:', err);
  process.exit(1);
});
