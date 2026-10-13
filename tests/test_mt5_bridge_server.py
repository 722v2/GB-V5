#!/usr/bin/env python3
"""
Unit tests for isolated mock execution of server/mt5_bridge_server.py
Verifies that every order_send call site enforces centralized authorization guards.
"""

import sys
import os
import unittest
from unittest.mock import MagicMock, patch

# Ensure paths
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'server')))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# Mock flask and flask_cors before importing mt5_bridge_server
mock_flask = MagicMock()
mock_app = MagicMock()

def mock_route(*args, **kwargs):
    def decorator(f):
        return f
    return decorator

def mock_before_request(f):
    return f

mock_app.route = mock_route
mock_app.before_request = mock_before_request
mock_flask.Flask.return_value = mock_app

def mock_jsonify(data):
    return data

mock_flask.jsonify = mock_jsonify
mock_request = MagicMock()
mock_flask.request = mock_request
sys.modules["flask"] = mock_flask

mock_cors = MagicMock()
sys.modules["flask_cors"] = mock_cors

# Mock MetaTrader5 before importing mt5_bridge_server
mock_mt5 = MagicMock()
mock_mt5.ACCOUNT_TRADE_MODE_DEMO = 0
mock_mt5.ACCOUNT_TRADE_MODE_CONTEST = 1
mock_mt5.ACCOUNT_TRADE_MODE_REAL = 2
mock_mt5.ORDER_TYPE_BUY = 0
mock_mt5.ORDER_TYPE_SELL = 1
mock_mt5.ORDER_TYPE_BUY_LIMIT = 2
mock_mt5.ORDER_TYPE_SELL_LIMIT = 3
mock_mt5.TRADE_ACTION_DEAL = 1
mock_mt5.TRADE_ACTION_PENDING = 5
mock_mt5.TRADE_ACTION_SLTP = 6
mock_mt5.TRADE_ACTION_MODIFY = 7
mock_mt5.TRADE_ACTION_REMOVE = 8
mock_mt5.ORDER_TIME_GTC = 0
mock_mt5.ORDER_FILLING_IOC = 1
mock_mt5.ORDER_FILLING_FOK = 0
mock_mt5.ORDER_FILLING_RETURN = 2
mock_mt5.TRADE_RETCODE_DONE = 10009
mock_mt5.POSITION_TYPE_BUY = 0
mock_mt5.POSITION_TYPE_SELL = 1
mock_mt5.last_error.return_value = (1, "Success")
sys.modules["MetaTrader5"] = mock_mt5

import server.mt5_bridge_server as server_module

class TestMT5BridgeServerAuthorization(unittest.TestCase):
    def setUp(self):
        mock_mt5.reset_mock()
        mock_mt5.ACCOUNT_TRADE_MODE_DEMO = 0
        mock_mt5.ACCOUNT_TRADE_MODE_REAL = 2
        mock_mt5.TRADE_RETCODE_DONE = 10009
        mock_mt5.ORDER_TYPE_BUY = 0
        mock_mt5.ORDER_TYPE_SELL = 1
        mock_mt5.TRADE_ACTION_DEAL = 1
        mock_mt5.TRADE_ACTION_SLTP = 6
        mock_mt5.POSITION_TYPE_BUY = 0
        mock_mt5.POSITION_TYPE_SELL = 1
        mock_mt5.symbol_select.return_value = True

        mock_tick = MagicMock()
        mock_tick.ask = 2650.0
        mock_tick.bid = 2649.5
        mock_mt5.symbol_info_tick.return_value = mock_tick

        mock_res = MagicMock()
        mock_res.retcode = 10009
        mock_res.order = 998877
        mock_res.deal = 887766
        mock_res.price = 2650.0
        mock_res.comment = "Done"
        mock_mt5.order_send.return_value = mock_res

        self.orig_env = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.orig_env)

    # ------------------ /order Tests ------------------

    def test_order_demo_allowed_on_demo_account(self):
        """DEMO order on DEMO account should succeed and call order_send."""
        acc = MagicMock()
        acc.trade_mode = 0  # DEMO
        mock_mt5.account_info.return_value = acc

        mock_request.get_json.return_value = {
            "symbol": "XAUUSD",
            "action": "BUY",
            "lot": 0.01,
            "mode": "DEMO"
        }

        resp = server_module.execute_order()
        self.assertTrue(isinstance(resp, dict))
        self.assertTrue(resp.get("success"))
        mock_mt5.order_send.assert_called()

    def test_order_demo_rejected_on_real_account(self):
        """DEMO order on REAL account must be rejected fail-closed to avoid accidental live trades."""
        acc = MagicMock()
        acc.trade_mode = 2  # REAL
        mock_mt5.account_info.return_value = acc

        mock_request.get_json.return_value = {
            "symbol": "XAUUSD",
            "action": "BUY",
            "lot": 0.01,
            "mode": "DEMO"
        }

        resp, status = server_module.execute_order()
        self.assertEqual(status, 400)
        self.assertFalse(resp.get("success"))
        self.assertIn("Account mismatch", resp.get("error", ""))
        mock_mt5.order_send.assert_not_called()

    def test_order_live_rejected_without_env_flag(self):
        """LIVE order must be rejected (403) if MT5_LIVE_EXECUTION_ENABLED is not set."""
        if "MT5_LIVE_EXECUTION_ENABLED" in os.environ:
            del os.environ["MT5_LIVE_EXECUTION_ENABLED"]

        acc = MagicMock()
        acc.trade_mode = 2  # REAL
        mock_mt5.account_info.return_value = acc

        mock_request.get_json.return_value = {
            "symbol": "XAUUSD",
            "action": "BUY",
            "lot": 0.01,
            "mode": "LIVE"
        }

        resp, status = server_module.execute_order()
        self.assertEqual(status, 403)
        self.assertFalse(resp.get("success"))
        self.assertIn("LIVE/REAL execution disabled", resp.get("error", ""))
        mock_mt5.order_send.assert_not_called()

    def test_order_live_rejected_on_demo_account_even_if_flag_enabled(self):
        """LIVE order must be rejected (400) if terminal is DEMO even if flag is true."""
        os.environ["MT5_LIVE_EXECUTION_ENABLED"] = "true"

        acc = MagicMock()
        acc.trade_mode = 0  # DEMO
        mock_mt5.account_info.return_value = acc

        mock_request.get_json.return_value = {
            "symbol": "XAUUSD",
            "action": "BUY",
            "lot": 0.01,
            "mode": "LIVE"
        }

        resp, status = server_module.execute_order()
        self.assertEqual(status, 400)
        self.assertFalse(resp.get("success"))
        self.assertIn("Account mismatch", resp.get("error", ""))
        mock_mt5.order_send.assert_not_called()

    def test_order_live_allowed_when_flag_enabled_and_real_account(self):
        """LIVE order must succeed and call order_send when flag is true AND terminal is verified REAL."""
        os.environ["MT5_LIVE_EXECUTION_ENABLED"] = "true"

        acc = MagicMock()
        acc.trade_mode = 2  # REAL
        mock_mt5.account_info.return_value = acc

        mock_request.get_json.return_value = {
            "symbol": "XAUUSD",
            "action": "BUY",
            "lot": 0.01,
            "mode": "LIVE"
        }

        resp = server_module.execute_order()
        self.assertTrue(isinstance(resp, dict))
        self.assertTrue(resp.get("success"))
        mock_mt5.order_send.assert_called()

    # ------------------ /modify Tests ------------------

    def test_modify_allowed_on_demo(self):
        """Modify on DEMO terminal should succeed."""
        acc = MagicMock()
        acc.trade_mode = 0  # DEMO
        mock_mt5.account_info.return_value = acc

        pos = MagicMock()
        pos.symbol = "XAUUSD"
        pos.sl = 2600.0
        pos.tp = 2700.0
        mock_mt5.positions_get.return_value = [pos]

        mock_request.get_json.return_value = {
            "ticket": 123456,
            "stopLoss": 2610.0,
            "mode": "DEMO"
        }

        resp = server_module.modify_order()
        self.assertTrue(isinstance(resp, dict))
        self.assertTrue(resp.get("success"))
        mock_mt5.order_send.assert_called()

    def test_modify_rejected_on_real_account_without_live_flag(self):
        """Modify on REAL terminal without MT5_LIVE_EXECUTION_ENABLED must be blocked."""
        if "MT5_LIVE_EXECUTION_ENABLED" in os.environ:
            del os.environ["MT5_LIVE_EXECUTION_ENABLED"]

        acc = MagicMock()
        acc.trade_mode = 2  # REAL
        mock_mt5.account_info.return_value = acc

        mock_request.get_json.return_value = {
            "ticket": 123456,
            "stopLoss": 2610.0,
            "mode": "LIVE"
        }

        resp, status = server_module.modify_order()
        self.assertEqual(status, 403)
        mock_mt5.order_send.assert_not_called()

    def test_modify_allowed_on_real_account_with_live_flag(self):
        """Modify on REAL terminal with MT5_LIVE_EXECUTION_ENABLED=true and mode=LIVE succeeds."""
        os.environ["MT5_LIVE_EXECUTION_ENABLED"] = "true"

        acc = MagicMock()
        acc.trade_mode = 2  # REAL
        mock_mt5.account_info.return_value = acc

        pos = MagicMock()
        pos.symbol = "XAUUSD"
        pos.sl = 2600.0
        pos.tp = 2700.0
        mock_mt5.positions_get.return_value = [pos]

        mock_request.get_json.return_value = {
            "ticket": 123456,
            "stopLoss": 2610.0,
            "mode": "LIVE"
        }

        resp = server_module.modify_order()
        self.assertTrue(isinstance(resp, dict))
        self.assertTrue(resp.get("success"))
        mock_mt5.order_send.assert_called()

    # ------------------ /close Tests ------------------

    def test_close_allowed_on_demo(self):
        """Close on DEMO terminal should succeed."""
        acc = MagicMock()
        acc.trade_mode = 0  # DEMO
        mock_mt5.account_info.return_value = acc

        pos = MagicMock()
        pos.symbol = "XAUUSD"
        pos.volume = 0.01
        pos.type = 0  # BUY
        mock_mt5.positions_get.return_value = [pos]

        mock_request.get_json.return_value = {
            "ticket": 123456,
            "mode": "DEMO"
        }

        resp = server_module.close_order()
        self.assertTrue(isinstance(resp, dict))
        self.assertTrue(resp.get("success"))
        mock_mt5.order_send.assert_called()

    def test_close_rejected_on_real_account_without_live_flag(self):
        """Close on REAL terminal without MT5_LIVE_EXECUTION_ENABLED must be blocked."""
        if "MT5_LIVE_EXECUTION_ENABLED" in os.environ:
            del os.environ["MT5_LIVE_EXECUTION_ENABLED"]

        acc = MagicMock()
        acc.trade_mode = 2  # REAL
        mock_mt5.account_info.return_value = acc

        mock_request.get_json.return_value = {
            "ticket": 123456,
            "mode": "LIVE"
        }

        resp, status = server_module.close_order()
        self.assertEqual(status, 403)
        mock_mt5.order_send.assert_not_called()

    def test_close_allowed_on_real_account_with_live_flag(self):
        """Close on REAL terminal with MT5_LIVE_EXECUTION_ENABLED=true and mode=LIVE succeeds."""
        os.environ["MT5_LIVE_EXECUTION_ENABLED"] = "true"

        acc = MagicMock()
        acc.trade_mode = 2  # REAL
        mock_mt5.account_info.return_value = acc

        pos = MagicMock()
        pos.symbol = "XAUUSD"
        pos.volume = 0.01
        pos.type = 0  # BUY
        mock_mt5.positions_get.return_value = [pos]

        mock_request.get_json.return_value = {
            "ticket": 123456,
            "mode": "LIVE"
        }

        resp = server_module.close_order()
        self.assertTrue(isinstance(resp, dict))
        self.assertTrue(resp.get("success"))
        mock_mt5.order_send.assert_called()

if __name__ == "__main__":
    unittest.main()
