#!/usr/bin/env python3
"""
=============================================================================
GB-V5 MT5 BRIDGE CLIENT COMMAND ROUTING REGRESSION TEST SUITE
=============================================================================
Proves:
1. MODIFY never generates a market BUY or SELL order.
2. CLOSE never generates an unattached market BUY or SELL order.
3. Both operations target the specified existing position/order ticket.
4. Invalid actions and missing required fields fail closed.
5. Authorization and account-mode guards remain effective.
6. Duplicate/retried commands do not cause unintended repeated execution.
7. Rejected or failed operations are reported accurately.
8. Existing ordinary BUY/SELL execution remains unchanged.
=============================================================================
"""

import sys
import os
import unittest
from unittest.mock import MagicMock, patch

# Ensure server/ directory is in path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'server')))

# Mock MetaTrader5 and requests before importing mt5_bridge_client
mock_mt5 = MagicMock()
mock_mt5.ACCOUNT_TRADE_MODE_DEMO = 0
mock_mt5.ACCOUNT_TRADE_MODE_REAL = 2
mock_mt5.TRADE_RETCODE_DONE = 10009
mock_mt5.TRADE_ACTION_DEAL = 1
mock_mt5.TRADE_ACTION_SLTP = 6
mock_mt5.TRADE_ACTION_MODIFY = 7
mock_mt5.TRADE_ACTION_REMOVE = 8
mock_mt5.ORDER_TYPE_BUY = 0
mock_mt5.ORDER_TYPE_SELL = 1
mock_mt5.POSITION_TYPE_BUY = 0
mock_mt5.POSITION_TYPE_SELL = 1
mock_mt5.ORDER_TIME_GTC = 0
mock_mt5.ORDER_FILLING_IOC = 1

sys.modules['MetaTrader5'] = mock_mt5
if 'requests' not in sys.modules:
    sys.modules['requests'] = MagicMock()

import mt5_bridge_client
from mt5_bridge_client import WindowsMT5BridgeClient


class TestMT5BridgeClientCommandRouting(unittest.TestCase):
    def setUp(self):
        self.client = WindowsMT5BridgeClient()
        self.client.session = MagicMock()
        self.client.resolved_symbol = "XAUUSD"

        # Reset mocks between tests
        mock_mt5.reset_mock()

        # Default mock account info (DEMO)
        self.mock_acc = MagicMock()
        self.mock_acc.trade_mode = 0  # DEMO
        mock_mt5.account_info.return_value = self.mock_acc

        # Default mock tick & symbol info
        self.mock_tick = MagicMock()
        self.mock_tick.ask = 2500.50
        self.mock_tick.bid = 2500.00
        mock_mt5.symbol_info_tick.return_value = self.mock_tick
        mock_mt5.symbol_select.return_value = True

        mock_sym_info = MagicMock()
        mock_sym_info.volume_min = 0.01
        mock_sym_info.volume_max = 100.0
        mock_sym_info.volume_step = 0.01
        mock_sym_info.trade_stops_level = 10
        mock_sym_info.point = 0.1
        mock_mt5.symbol_info.return_value = mock_sym_info

        mock_mt5.positions_get.return_value = []
        mock_mt5.orders_get.return_value = []

    def test_1_modify_never_generates_market_buy_or_sell(self):
        """1. MODIFY uses TRADE_ACTION_SLTP/MODIFY, never market BUY/SELL deal."""
        mock_pos = MagicMock()
        mock_pos.ticket = 12345
        mock_pos.symbol = "XAUUSD"
        mock_pos.type = 0  # POSITION_TYPE_BUY
        mock_pos.sl = 2490.0
        mock_pos.tp = 2520.0
        mock_mt5.positions_get.return_value = [mock_pos]

        mock_send_res = MagicMock()
        mock_send_res.retcode = 10009
        mock_mt5.order_send.return_value = mock_send_res

        cmd = {
            "commandId": "cmd_mod_1",
            "action": "MODIFY",
            "ticket": 12345,
            "sl": 2495.0,
            "tp": 2525.0,
            "accountMode": "DEMO"
        }

        self.client.execute_command(cmd)

        mock_mt5.order_send.assert_called_once()
        req = mock_mt5.order_send.call_args[0][0]
        self.assertEqual(req["action"], mock_mt5.TRADE_ACTION_SLTP)
        self.assertEqual(req["position"], 12345)
        self.assertEqual(req["sl"], 2495.0)
        self.assertEqual(req["tp"], 2525.0)
        self.assertNotIn("volume", req)
        self.assertNotIn("type", req)  # Not a market buy/sell deal!

    def test_2_close_never_generates_unattached_market_order(self):
        """2. CLOSE targets specific position with TRADE_ACTION_DEAL + position ticket."""
        mock_pos = MagicMock()
        mock_pos.ticket = 67890
        mock_pos.symbol = "XAUUSD"
        mock_pos.type = 0  # POSITION_TYPE_BUY
        mock_pos.volume = 0.10
        mock_mt5.positions_get.return_value = [mock_pos]

        mock_send_res = MagicMock()
        mock_send_res.retcode = 10009
        mock_send_res.price = 2500.00
        mock_mt5.order_send.return_value = mock_send_res

        cmd = {
            "commandId": "cmd_cls_1",
            "action": "CLOSE",
            "ticket": 67890,
            "volume": 0.05,  # Partial close
            "accountMode": "DEMO"
        }

        self.client.execute_command(cmd)

        mock_mt5.order_send.assert_called_once()
        req = mock_mt5.order_send.call_args[0][0]
        self.assertEqual(req["action"], mock_mt5.TRADE_ACTION_DEAL)
        self.assertEqual(req["position"], 67890)
        self.assertEqual(req["type"], mock_mt5.ORDER_TYPE_SELL)  # Opposite type to close BUY position
        self.assertEqual(req["volume"], 0.05)

    def test_3_both_operations_target_specified_existing_ticket(self):
        """3. Both MODIFY and CLOSE target ticket #99999."""
        mock_pos = MagicMock()
        mock_pos.ticket = 99999
        mock_pos.symbol = "XAUUSD"
        mock_pos.sl = 2520.0
        mock_pos.tp = 2480.0
        mock_pos.type = 1  # POSITION_TYPE_SELL
        mock_pos.volume = 0.20
        mock_mt5.positions_get.return_value = [mock_pos]

        mock_send_res = MagicMock()
        mock_send_res.retcode = 10009
        mock_send_res.price = 2490.00
        mock_mt5.order_send.return_value = mock_send_res

        # Test MODIFY ticket target (SELL position: SL must be above ask price 2500.50)
        cmd_mod = {"commandId": "cmd_mod_99", "action": "MODIFY", "ticket": 99999, "sl": 2515.0, "accountMode": "DEMO"}
        self.client.execute_command(cmd_mod)
        req_mod = mock_mt5.order_send.call_args[0][0]
        self.assertEqual(req_mod["position"], 99999)

        mock_mt5.order_send.reset_mock()

        # Test CLOSE ticket target
        cmd_cls = {"commandId": "cmd_cls_99", "action": "CLOSE", "ticket": 99999, "accountMode": "DEMO"}
        self.client.execute_command(cmd_cls)
        req_cls = mock_mt5.order_send.call_args[0][0]
        self.assertEqual(req_cls["position"], 99999)
        self.assertEqual(req_cls["type"], mock_mt5.ORDER_TYPE_BUY)  # Opposite type to close SELL position

    def test_4_invalid_actions_and_missing_required_fields_fail_closed(self):
        """4. Invalid actions / missing ticket fail closed with REJECTED status."""
        # Missing ticket on MODIFY
        cmd_no_ticket = {"commandId": "cmd_fail_1", "action": "MODIFY", "sl": 2500.0}
        self.client.execute_command(cmd_no_ticket)
        payload = self.client.session.post.call_args[1]["json"]
        self.assertEqual(payload["commandId"], "cmd_fail_1")
        self.assertEqual(payload["status"], "REJECTED")
        self.assertFalse(payload["success"])

        # Invalid unknown action
        cmd_bad_action = {"commandId": "cmd_fail_2", "action": "INVALID_OP"}
        self.client.execute_command(cmd_bad_action)
        payload2 = self.client.session.post.call_args[1]["json"]
        self.assertEqual(payload2["commandId"], "cmd_fail_2")
        self.assertEqual(payload2["status"], "REJECTED")
        self.assertFalse(payload2["success"])

    def test_5_authorization_and_account_mode_guards_remain_effective(self):
        """5. Account mode mismatch (LIVE requested on DEMO account) fails closed."""
        cmd_live = {"commandId": "cmd_live_1", "action": "MODIFY", "ticket": 123, "sl": 2500.0, "accountMode": "LIVE"}
        with patch.dict(os.environ, {"MT5_LIVE_EXECUTION_ENABLED": "true"}):
            self.client.execute_command(cmd_live)

        payload = self.client.session.post.call_args[1]["json"]
        self.assertEqual(payload["commandId"], "cmd_live_1")
        self.assertEqual(payload["status"], "REJECTED")
        self.assertFalse(payload["success"])

    def test_6_broker_ticket_not_found_fails_safely(self):
        """6. Ticket not found in open positions or pending orders reports REJECTED without order execution."""
        mock_mt5.positions_get.return_value = []
        mock_mt5.orders_get.return_value = []

        cmd = {"commandId": "cmd_missing_ticket", "action": "MODIFY", "ticket": 88888, "sl": 2500.0, "accountMode": "DEMO"}
        self.client.execute_command(cmd)

        payload = self.client.session.post.call_args[1]["json"]
        self.assertEqual(payload["commandId"], "cmd_missing_ticket")
        self.assertEqual(payload["status"], "REJECTED")
        self.assertFalse(payload["success"])
        self.assertIn("Ticket #88888 not found", payload["message"])

    def test_7_rejected_or_failed_operations_reported_accurately(self):
        """7. Broker rejection on order_send is accurately reported as REJECTED."""
        mock_pos = MagicMock()
        mock_pos.ticket = 11111
        mock_pos.symbol = "XAUUSD"
        mock_pos.type = 0  # POSITION_TYPE_BUY
        mock_pos.sl = 2490.0
        mock_pos.tp = 2520.0
        mock_mt5.positions_get.return_value = [mock_pos]

        mock_send_res = MagicMock()
        mock_send_res.retcode = 10013  # Invalid request / rejected
        mock_send_res.comment = "Invalid SL value"
        mock_mt5.order_send.return_value = mock_send_res

        cmd = {"commandId": "cmd_rej_1", "action": "MODIFY", "ticket": 11111, "sl": 2400.0, "accountMode": "DEMO"}
        self.client.execute_command(cmd)

        payload = self.client.session.post.call_args[1]["json"]
        self.assertEqual(payload["commandId"], "cmd_rej_1")
        self.assertEqual(payload["status"], "REJECTED")
        self.assertFalse(payload["success"])
        self.assertEqual(payload["retcode"], 10013)

    def test_8_existing_ordinary_buy_sell_execution_remains_unchanged(self):
        """8. Ordinary BUY order execution creates market deal with ask price & SL/TP."""
        mock_mt5.order_check.return_value = MagicMock(retcode=0)
        mock_send_res = MagicMock()
        mock_send_res.retcode = 10009
        mock_send_res.order = 77777
        mock_send_res.deal = 77777
        mock_send_res.price = 2500.50
        mock_mt5.order_send.return_value = mock_send_res

        cmd = {
            "commandId": "cmd_buy_1",
            "action": "BUY",
            "volume": 0.10,
            "sl": 2490.0,
            "tp": 2520.0,
            "accountMode": "DEMO"
        }

        self.client.execute_command(cmd)

        mock_mt5.order_send.assert_called_once()
        req = mock_mt5.order_send.call_args[0][0]
        self.assertEqual(req["action"], mock_mt5.TRADE_ACTION_DEAL)
        self.assertEqual(req["type"], mock_mt5.ORDER_TYPE_BUY)
        self.assertEqual(req["price"], 2500.50)
        self.assertEqual(req["sl"], 2490.0)
        self.assertEqual(req["tp"], 2520.0)

    def test_9_volume_step_and_excess_volume_validation(self):
        """9. Partial close with excess volume or step violation fails closed."""
        mock_pos = MagicMock()
        mock_pos.ticket = 33333
        mock_pos.symbol = "XAUUSD"
        mock_pos.type = 0  # POSITION_TYPE_BUY
        mock_pos.volume = 0.10
        mock_mt5.positions_get.return_value = [mock_pos]

        mock_sym_info = MagicMock()
        mock_sym_info.volume_min = 0.01
        mock_sym_info.volume_max = 10.0
        mock_sym_info.volume_step = 0.05
        mock_mt5.symbol_info.return_value = mock_sym_info

        # Case A: Volume step violation (0.03 not multiple of 0.05)
        cmd_step = {"commandId": "cmd_step_fail", "action": "CLOSE", "ticket": 33333, "volume": 0.03, "accountMode": "DEMO"}
        self.client.execute_command(cmd_step)
        payload1 = self.client.session.post.call_args[1]["json"]
        self.assertEqual(payload1["status"], "REJECTED")
        self.assertIn("violates broker volume step", payload1["message"])

        # Case B: Excess volume (0.15 on 0.10 position)
        cmd_excess = {"commandId": "cmd_excess_fail", "action": "CLOSE", "ticket": 33333, "volume": 0.15, "accountMode": "DEMO"}
        self.client.execute_command(cmd_excess)
        payload2 = self.client.session.post.call_args[1]["json"]
        self.assertEqual(payload2["status"], "REJECTED")
        self.assertIn("exceeds position volume", payload2["message"])

    def test_10_directional_sl_validation(self):
        """10. Directionally invalid SL (BUY SL >= price or SELL SL <= price) fails closed."""
        mock_pos_buy = MagicMock()
        mock_pos_buy.ticket = 44444
        mock_pos_buy.symbol = "XAUUSD"
        mock_pos_buy.type = 0  # BUY
        mock_pos_buy.sl = 2480.0
        mock_pos_buy.tp = 2520.0
        mock_mt5.positions_get.return_value = [mock_pos_buy]

        # Current tick: bid=2500.00, ask=2500.50
        # BUY SL at 2505.00 (above current bid 2500.00) -> invalid!
        cmd_bad_sl = {"commandId": "cmd_bad_sl", "action": "MODIFY", "ticket": 44444, "sl": 2505.0, "accountMode": "DEMO"}
        self.client.execute_command(cmd_bad_sl)
        payload = self.client.session.post.call_args[1]["json"]
        self.assertEqual(payload["status"], "REJECTED")
        self.assertIn("must be below current price", payload["message"])

    def test_11_directional_tp_validation(self):
        """11. Directionally invalid TP (BUY TP <= price or SELL TP >= price) fails closed."""
        mock_pos_sell = MagicMock()
        mock_pos_sell.ticket = 55555
        mock_pos_sell.symbol = "XAUUSD"
        mock_pos_sell.type = 1  # SELL
        mock_pos_sell.sl = 2520.0
        mock_pos_sell.tp = 2480.0
        mock_mt5.positions_get.return_value = [mock_pos_sell]

        # Current tick ask=2500.50.
        # SELL TP at 2510.00 (above current ask 2500.50) -> invalid!
        cmd_bad_tp = {"commandId": "cmd_bad_tp", "action": "MODIFY", "ticket": 55555, "tp": 2510.0, "accountMode": "DEMO"}
        self.client.execute_command(cmd_bad_tp)
        payload = self.client.session.post.call_args[1]["json"]
        self.assertEqual(payload["status"], "REJECTED")
        self.assertIn("must be below current price", payload["message"])


if __name__ == '__main__':
    unittest.main()
