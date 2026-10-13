#!/usr/bin/env python3
"""
Unit tests for historical candle extraction in server/mt5_bridge_client.py
"""

import sys
import os
import unittest
from typing import Any
from unittest.mock import MagicMock, patch

class MockDtype:
    names = ('time', 'open', 'high', 'low', 'close', 'tick_volume')

class MockRate:
    dtype = MockDtype()
    def __init__(self, t=1600000000, o=1900.0, h=1905.0, l=1895.0, c=1902.0, v=100):
        self._data = {'time': t, 'open': o, 'high': h, 'low': l, 'close': c, 'tick_volume': v}
    def __getitem__(self, item):
        return self._data[item]

def create_dummy_rates():
    return [MockRate()]

# Ensure server module can be imported
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'server')))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# Create mock requests module before importing mt5_bridge_client
mock_requests = MagicMock()
mock_requests.exceptions = MagicMock()
mock_requests.exceptions.RequestException = Exception
sys.modules["requests"] = mock_requests

# Create mock MetaTrader5 module before importing mt5_bridge_client
mock_mt5 = MagicMock()
mock_mt5.TIMEFRAME_M1 = 1
mock_mt5.TIMEFRAME_M5 = 5
mock_mt5.TIMEFRAME_M15 = 15
mock_mt5.TIMEFRAME_H1 = 16385
mock_mt5.last_error.return_value = (1, "Success")
sys.modules["MetaTrader5"] = mock_mt5

import server.mt5_bridge_client as bridge_module
from server.mt5_bridge_client import WindowsMT5BridgeClient

class TestHistoricalCandleSync(unittest.TestCase):
    def setUp(self):
        self.client = WindowsMT5BridgeClient()
        self.client.is_terminal_connected = True
        self.client.candles_synced = False
        self.client.resolved_symbol = "XAUUSD.m"
        self.client.session = MagicMock()
        mock_mt5.reset_mock()
        mock_mt5.symbol_select.side_effect = None
        mock_mt5.symbol_select.return_value = True
        mock_mt5.copy_rates_from_pos.side_effect = None
        mock_mt5.copy_rates_from_pos.return_value = None

    def test_symbol_select_failure(self):
        """Test behavior when mt5.symbol_select() fails (returns False)."""
        mock_mt5.symbol_select.return_value = False
        
        # Mock copy_rates_from_pos returning empty list so it proceeds safely
        mock_mt5.copy_rates_from_pos.return_value = None

        self.client.sync_historical_candles()

        # Check symbol_select was called with symbol and True
        mock_mt5.symbol_select.assert_called_once_with("XAUUSD.m", True)
        self.assertTrue(self.client.candles_synced)

    def test_copy_rates_returns_none_or_empty(self):
        """Test behavior when copy_rates_from_pos() returns None or [] for timeframes."""
        mock_mt5.symbol_select.return_value = True
        # First return None, then empty array
        mock_mt5.copy_rates_from_pos.side_effect = [None, [], None, []]

        self.client.sync_historical_candles()

        # session.post should NOT have been called since no candles were returned
        self.client.session.post.assert_not_called()
        self.assertTrue(self.client.candles_synced)

    def test_http_non_200_response(self):
        """Test behavior when server responds with non-200 HTTP status code."""
        mock_mt5.symbol_select.return_value = True
        
        mock_mt5.copy_rates_from_pos.return_value = create_dummy_rates()

        # Mock non-200 response
        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.text = "Internal Server Error Details"
        self.client.session.post.return_value = mock_response

        self.client.sync_historical_candles()

        # Verify POST was attempted for all 4 timeframes
        self.assertEqual(self.client.session.post.call_count, 4)
        self.assertTrue(self.client.candles_synced)

    def test_network_exception(self):
        """Test behavior when network exception occurs during HTTP POST."""
        mock_mt5.symbol_select.return_value = True

        mock_mt5.copy_rates_from_pos.return_value = create_dummy_rates()

        self.client.session.post.side_effect = Exception("Network Connection Refused")

        self.client.sync_historical_candles()

        # Should attempt all 4 timeframes despite network exception on each
        self.assertEqual(self.client.session.post.call_count, 4)
        self.assertTrue(self.client.candles_synced)

    def test_exception_on_one_timeframe_continues_subsequent(self):
        """Test that an exception on one timeframe allows subsequent timeframes to continue."""
        mock_mt5.symbol_select.return_value = True

        dummy_rates = create_dummy_rates()

        # M1 raises RuntimeError, M5/M15/H1 return rates
        mock_mt5.copy_rates_from_pos.side_effect = [
            RuntimeError("MT5 IPC Failure on M1"),
            dummy_rates,
            dummy_rates,
            dummy_rates
        ]

        mock_response = MagicMock()
        mock_response.status_code = 200
        self.client.session.post.return_value = mock_response

        self.client.sync_historical_candles()

        # session.post should be called 3 times (M5, M15, H1) skipping failed M1
        self.assertEqual(self.client.session.post.call_count, 3)
        self.assertTrue(self.client.candles_synced)

    def test_batching_historical_candles(self):
        """Test that large candle arrays are split into bounded batches of 500 candles per HTTP POST request."""
        mock_mt5.symbol_select.return_value = True

        # Generate 1200 dummy rates for M1, and None for M5, M15, H1
        large_rates = [MockRate(t=1600000000 + i) for i in range(1200)]
        mock_mt5.copy_rates_from_pos.side_effect = [
            large_rates,
            None,
            None,
            None
        ]

        mock_response = MagicMock()
        mock_response.status_code = 200
        self.client.session.post.return_value = mock_response

        self.client.sync_historical_candles()

        # 1200 candles / 500 batch size = 3 batches (500, 500, 200)
        self.assertEqual(self.client.session.post.call_count, 3)
        batch_1_len = len(self.client.session.post.call_args_list[0].kwargs['json']['candles'])
        batch_2_len = len(self.client.session.post.call_args_list[1].kwargs['json']['candles'])
        batch_3_len = len(self.client.session.post.call_args_list[2].kwargs['json']['candles'])
        self.assertEqual(batch_1_len, 500)
        self.assertEqual(batch_2_len, 500)
        self.assertEqual(batch_3_len, 200)
        self.assertTrue(self.client.candles_synced)

class TestLiveExecutionSafety(unittest.TestCase):
    def setUp(self):
        self.client = WindowsMT5BridgeClient()
        self.client.is_terminal_connected = True
        self.client.resolved_symbol = "XAUUSD.m"
        self.client.session = MagicMock()
        self.client.report_result = MagicMock()
        mock_mt5.reset_mock()
        mock_mt5.ACCOUNT_TRADE_MODE_DEMO = 0
        mock_mt5.ACCOUNT_TRADE_MODE_REAL = 2
        mock_mt5.ORDER_TYPE_BUY = 0
        mock_mt5.ORDER_TYPE_SELL = 1
        mock_mt5.TRADE_ACTION_DEAL = 1
        mock_mt5.ORDER_TIME_GTC = 0
        mock_mt5.ORDER_FILLING_IOC = 1
        mock_mt5.TRADE_RETCODE_DONE = 10009
        mock_mt5.symbol_select.return_value = True

        mock_tick = MagicMock()
        mock_tick.ask = 2500.0
        mock_tick.bid = 2499.5
        mock_mt5.symbol_info_tick.return_value = mock_tick

        mock_order_result = MagicMock()
        mock_order_result.retcode = 10009
        mock_order_result.order = 123456
        mock_order_result.deal = 654321
        mock_order_result.price = 2500.0
        mock_mt5.order_send.return_value = mock_order_result

        # Save env
        self.orig_env = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.orig_env)

    def test_live_command_rejected_when_live_disabled(self):
        """LIVE execution command must be rejected fail-closed if MT5_LIVE_EXECUTION_ENABLED is not set."""
        if "MT5_LIVE_EXECUTION_ENABLED" in os.environ:
            del os.environ["MT5_LIVE_EXECUTION_ENABLED"]

        mock_acc = MagicMock()
        mock_acc.trade_mode = 2  # REAL
        mock_mt5.account_info.return_value = mock_acc

        cmd = {
            "commandId": "cmd_test_live_1",
            "action": "BUY",
            "volume": 0.01,
            "price": 2500.0,
            "sl": 2490.0,
            "tp": 2515.0,
            "accountMode": "LIVE",
        }

        self.client.execute_command(cmd)

        self.client.report_result.assert_called_once()
        args, kwargs = self.client.report_result.call_args
        self.assertEqual(kwargs.get("status"), "REJECTED")
        self.assertIn("LIVE/REAL execution blocked", kwargs.get("message", ""))
        mock_mt5.order_send.assert_not_called()

    def test_live_command_rejected_on_demo_account_even_if_configured(self):
        """LIVE command must be rejected if account is DEMO even if MT5_LIVE_EXECUTION_ENABLED is true."""
        os.environ["MT5_LIVE_EXECUTION_ENABLED"] = "true"

        mock_acc = MagicMock()
        mock_acc.trade_mode = 0  # DEMO
        mock_mt5.account_info.return_value = mock_acc

        cmd = {
            "commandId": "cmd_test_live_2",
            "action": "BUY",
            "volume": 0.01,
            "price": 2500.0,
            "sl": 2490.0,
            "tp": 2515.0,
            "accountMode": "LIVE",
        }

        self.client.execute_command(cmd)

        self.client.report_result.assert_called_once()
        args, kwargs = self.client.report_result.call_args
        self.assertEqual(kwargs.get("status"), "REJECTED")
        self.assertIn("Account mismatch", kwargs.get("message", ""))
        mock_mt5.order_send.assert_not_called()

    def test_live_command_accepted_when_live_configured_on_real_account(self):
        """LIVE command must succeed when configured AND terminal is verified REAL account."""
        os.environ["MT5_LIVE_EXECUTION_ENABLED"] = "true"

        mock_acc = MagicMock()
        mock_acc.trade_mode = 2  # REAL
        mock_mt5.account_info.return_value = mock_acc
        mock_mt5.order_check.return_value = MagicMock(retcode=0)

        cmd = {
            "commandId": "cmd_test_live_3",
            "action": "BUY",
            "volume": 0.01,
            "price": 2500.0,
            "sl": 2490.0,
            "tp": 2515.0,
            "accountMode": "LIVE",
        }

        self.client.execute_command(cmd)

        mock_mt5.order_send.assert_called()
        self.client.report_result.assert_called_once()
        args, kwargs = self.client.report_result.call_args
        self.assertEqual(kwargs.get("status"), "FILLED")

    def test_unsupported_trade_mode_rejected(self):
        """Unsupported trade_mode (e.g. 99) must fail closed."""
        mock_acc = MagicMock()
        mock_acc.trade_mode = 99  # Invalid
        mock_mt5.account_info.return_value = mock_acc

        cmd = {
            "commandId": "cmd_test_live_4",
            "action": "BUY",
            "volume": 0.01,
            "price": 2500.0,
            "sl": 2490.0,
            "tp": 2515.0,
            "accountMode": "DEMO",
        }

        self.client.execute_command(cmd)

        self.client.report_result.assert_called_once()
        args, kwargs = self.client.report_result.call_args
        self.assertEqual(kwargs.get("status"), "REJECTED")
        self.assertIn("Unverified or unsupported", kwargs.get("message", ""))
        mock_mt5.order_send.assert_not_called()

if __name__ == "__main__":
    unittest.main()
