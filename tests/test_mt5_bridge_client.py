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

if __name__ == "__main__":
    unittest.main()
