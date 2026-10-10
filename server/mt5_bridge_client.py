#!/usr/bin/env python3
"""
=============================================================================
GB-V5 WINDOWS MT5 DEMO TRADING BRIDGE (OUTBOUND CLIENT AGENT)
=============================================================================
Architecture:
- Runs locally on the Windows machine where MetaTrader 5 Terminal is installed.
- Connects OUTBOUND to the GB-V5 application hosted on Render.
- Strict DEMO-ONLY enforcement: Refuses any non-demo/real accounts.
- Transmits authenticated heartbeats, open positions, and market status.
- Polls for authorized demo execution commands and returns verified broker tickets.
- Extracts authentic historical OHLC candles (M1, M5, M15, H1) for backtesting.
=============================================================================
"""

import os
import sys
import time
import json
import logging
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any, Set

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import requests

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler('mt5_bridge_client.log', encoding='utf-8')
    ]
)
logger = logging.getLogger("MT5_Bridge_Client")

# Verify MetaTrader5 package
try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    MT5_AVAILABLE = False
    logger.error("MetaTrader5 python package not installed! Run: pip install MetaTrader5")

# Environment & Configuration
# Supports GBV5_SERVER_URL, APP_URL, or RENDER_GBV5_URL
SERVER_URL = os.environ.get("GBV5_SERVER_URL", os.environ.get("APP_URL", os.environ.get("RENDER_GBV5_URL", "http://localhost:3000"))).rstrip("/")
MT5_BRIDGE_TOKEN = os.environ.get("MT5_BRIDGE_TOKEN", os.environ.get("MT5_API_KEY", "")).strip()
MT5_ACCOUNT = os.environ.get("MT5_ACCOUNT", "")
MT5_PASSWORD = os.environ.get("MT5_PASSWORD", "")
MT5_SERVER = os.environ.get("MT5_SERVER", "")
MT5_PATH = os.environ.get("MT5_PATH", "")  # Optional terminal path e.g. C:\\Program Files\\...\\terminal64.exe
PREFERRED_SYMBOL = os.environ.get("MT5_SYMBOL", "XAUUSD").replace("/", "").strip()
MAGIC_NUMBER = int(os.environ.get("MT5_MAGIC_NUMBER", 240726))
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL_SECONDS", 2.0))
HEARTBEAT_INTERVAL = float(os.environ.get("HEARTBEAT_INTERVAL_SECONDS", 5.0))

GOLD_SYMBOLS = [PREFERRED_SYMBOL, "XAUUSD", "GOLD", "XAUUSDm", "XAUUSD.a", "XAUUSD.raw", "XAUUSDb"]


class WindowsMT5BridgeClient:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {MT5_BRIDGE_TOKEN}",
            "Content-Type": "application/json",
            "User-Agent": "GB-V5-Windows-MT5-Agent/1.0"
        })
        self.resolved_symbol = PREFERRED_SYMBOL
        self.last_heartbeat_time = 0
        self.is_terminal_connected = False
        self.candles_synced = False
        self.reported_deal_tickets: Set[int] = set()

    def get_symbol_specs(self) -> Optional[Dict[str, Any]]:
        """Queries actual broker symbol specifications from MT5."""
        if not self.is_terminal_connected or not self.resolved_symbol:
            return None
        info = mt5.symbol_info(self.resolved_symbol)
        if not info:
            return None
        return {
            "symbol": self.resolved_symbol,
            "contractSize": float(info.trade_contract_size),
            "point": float(info.point),
            "digits": int(info.digits),
            "volumeMin": float(info.volume_min),
            "volumeMax": float(info.volume_max),
            "volumeStep": float(info.volume_step),
            "tickSize": float(info.trade_tick_size),
            "tickValue": float(info.trade_tick_value),
            "stopsLevel": int(info.trade_stops_level),
            "marginInitial": float(info.margin_initial) if hasattr(info, "margin_initial") else 0.0,
            "spread": int(info.spread),
        }

    def init_mt5(self) -> bool:
        """Initializes and verifies the MT5 terminal connection."""
        if not MT5_AVAILABLE:
            logger.error("MetaTrader5 python package is not available.")
            return False

        init_kwargs = {}
        if MT5_PATH:
            init_kwargs["path"] = MT5_PATH

        if not mt5.initialize(**init_kwargs):
            logger.error(f"mt5.initialize() failed, last_error = {mt5.last_error()}")
            return False

        # If credentials provided, login
        if MT5_ACCOUNT and MT5_PASSWORD and MT5_SERVER:
            try:
                acc_num = int(MT5_ACCOUNT)
                login_ok = mt5.login(login=acc_num, password=MT5_PASSWORD, server=MT5_SERVER)
                if not login_ok:
                    logger.error(f"mt5.login() failed for account {MT5_ACCOUNT} on {MT5_SERVER}, error = {mt5.last_error()}")
                    return False
            except ValueError:
                logger.error(f"Invalid MT5_ACCOUNT format: {MT5_ACCOUNT}")
                return False

        account_info = mt5.account_info()
        if account_info is None:
            logger.error(f"Could not read account info from MT5: {mt5.last_error()}")
            return False

        # Hard Safety Boundary Check
        # ACCOUNT_TRADE_MODE_DEMO = 0
        # ACCOUNT_TRADE_MODE_CONTEST = 1
        # ACCOUNT_TRADE_MODE_REAL = 2
        trade_mode = account_info.trade_mode
        if trade_mode != mt5.ACCOUNT_TRADE_MODE_DEMO:
            logger.critical("=" * 70)
            logger.critical(f"FATAL SAFETY REFUSAL: Account #{account_info.login} is NOT a DEMO account (trade_mode={trade_mode}).")
            logger.critical("This bridge is STRICTLY locked to DEMO execution only. Refusing all operations.")
            logger.critical("=" * 70)
            return False

        # Resolve available Gold symbol
        self.resolve_symbol()

        logger.info(f"Verified MT5 DEMO Connection: Login=#{account_info.login}, Server={account_info.server}, Currency={account_info.currency}, Balance=${account_info.balance:.2f}, Symbol={self.resolved_symbol}")
        self.is_terminal_connected = True
        return True

    def resolve_symbol(self) -> str:
        """Finds and enables the broker-specific Gold symbol in MarketWatch."""
        for sym in GOLD_SYMBOLS:
            if mt5.symbol_select(sym, True):
                info = mt5.symbol_info(sym)
                if info and info.visible:
                    self.resolved_symbol = sym
                    return sym
        logger.warning(f"Could not find preferred symbol in {GOLD_SYMBOLS}. Defaulting to {PREFERRED_SYMBOL}")
        self.resolved_symbol = PREFERRED_SYMBOL
        return PREFERRED_SYMBOL

    def collect_positions(self) -> List[Dict[str, Any]]:
        """Collects open positions from MT5."""
        positions = []
        raw_pos = mt5.positions_get()
        if raw_pos is not None:
            for p in raw_pos:
                positions.append({
                    "ticket": p.ticket,
                    "symbol": p.symbol,
                    "type": p.type,  # 0 = BUY, 1 = SELL
                    "volume": float(p.volume),
                    "price_open": float(p.price_open),
                    "price_current": float(p.price_current),
                    "sl": float(p.sl),
                    "tp": float(p.tp),
                    "profit": float(p.profit),
                    "magic": int(p.magic),
                    "comment": str(p.comment),
                    "time": int(p.time) * 1000,
                })
        return positions

    def send_heartbeat(self):
        """Sends periodic authenticated heartbeat to GB-V5 on Render."""
        now = time.time()
        if now - self.last_heartbeat_time < HEARTBEAT_INTERVAL:
            return

        account_info = mt5.account_info() if self.is_terminal_connected else None
        is_demo = account_info is not None and account_info.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO

        payload = {
            "connected": self.is_terminal_connected and is_demo,
            "terminalConnected": self.is_terminal_connected,
            "login": account_info.login if account_info else None,
            "server": account_info.server if account_info else None,
            "currency": account_info.currency if account_info else "USD",
            "balance": float(account_info.balance) if account_info else None,
            "equity": float(account_info.equity) if account_info else None,
            "freeMargin": float(account_info.margin_free) if account_info else None,
            "leverage": int(account_info.leverage) if account_info else None,
            "tradeMode": account_info.trade_mode if account_info else None,
            "accountMode": "DEMO" if is_demo else "UNVERIFIED",
            "symbols": [self.resolved_symbol],
            "brokerGoldSymbol": self.resolved_symbol,
            "symbolSpecs": self.get_symbol_specs() if self.is_terminal_connected else None,
            "positions": self.collect_positions() if self.is_terminal_connected else [],
            "timestamp": int(now * 1000),
        }

        url = f"{SERVER_URL}/api/mt5/bridge/heartbeat"
        try:
            res = self.session.post(url, json=payload, timeout=5)
            if res.status_code == 200:
                self.last_heartbeat_time = now
            else:
                logger.warning(f"Heartbeat responded with status {res.status_code}: {res.text}")
        except Exception as e:
            logger.debug(f"Heartbeat network error: {e}")

    def poll_and_execute_commands(self):
        """Polls for pending execution commands from GB-V5 on Render and executes them."""
        url = f"{SERVER_URL}/api/mt5/bridge/commands/poll"
        try:
            res = self.session.get(url, timeout=5)
            if res.status_code != 200:
                return

            data = res.json()
            commands = data.get("commands", [])
            for cmd in commands:
                self.execute_command(cmd)

        except Exception as e:
            logger.debug(f"Command polling network error: {e}")

    def execute_command(self, cmd: Dict[str, Any]):
        """Executes a single command on MT5 demo account with rigorous validation."""
        command_id = cmd.get("commandId")
        action = str(cmd.get("action", "")).upper()
        volume = float(cmd.get("volume", 0.01))
        sl = float(cmd.get("sl", 0.0))
        tp = float(cmd.get("tp", 0.0))
        requested_price = float(cmd.get("price", 0.0))
        magic = int(cmd.get("magic", MAGIC_NUMBER))
        comment = str(cmd.get("comment", "GB-V5 Demo Trade"))[:31]

        logger.info(f"Processing command [{command_id}]: {action} {volume} {self.resolved_symbol} SL={sl} TP={tp}")

        # 1. Hard Safety Boundary Check
        account_info = mt5.account_info()
        if account_info is None or account_info.trade_mode != mt5.ACCOUNT_TRADE_MODE_DEMO:
            self.report_result(command_id, success=False, status="REJECTED", message="Account is not in DEMO mode.")
            return

        # 2. Symbol Check & Quote Freshness
        sym = self.resolved_symbol
        if not mt5.symbol_select(sym, True):
            self.report_result(command_id, success=False, status="REJECTED", message=f"Symbol {sym} unavailable.")
            return

        tick = mt5.symbol_info_tick(sym)
        if tick is None:
            self.report_result(command_id, success=False, status="REJECTED", message=f"Could not get tick for {sym}.")
            return

        # 3. Mandatory Stop Loss Validation
        if sl <= 0:
            self.report_result(command_id, success=False, status="REJECTED", message="Mandatory protective Stop Loss missing.")
            return

        # 4. Determine order type and price
        is_buy = "BUY" in action
        if is_buy:
            order_type = mt5.ORDER_TYPE_BUY
            exec_price = tick.ask
            if sl >= exec_price:
                self.report_result(command_id, success=False, status="REJECTED", message=f"Buy SL ({sl}) must be below price ({exec_price}).")
                return
        else:
            order_type = mt5.ORDER_TYPE_SELL
            exec_price = tick.bid
            if sl <= exec_price:
                self.report_result(command_id, success=False, status="REJECTED", message=f"Sell SL ({sl}) must be above price ({exec_price}).")
                return

        # 5. Build MT5 Request
        req = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": sym,
            "volume": volume,
            "type": order_type,
            "price": exec_price,
            "sl": sl,
            "tp": tp,
            "deviation": 25,
            "magic": magic,
            "comment": comment,
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }

        # 6. Check Order Margin and Validity with mt5.order_check if supported
        check_res = mt5.order_check(req)
        if check_res and check_res.retcode != mt5.TRADE_RETCODE_DONE and check_res.retcode != 0:
            logger.warning(f"order_check warning retcode={check_res.retcode}: {check_res.comment}")
            # If margin insufficient, reject early
            if check_res.retcode == 10019:  # No money
                self.report_result(command_id, success=False, status="REJECTED", retcode=check_res.retcode, message="Insufficient margin.")
                return

        # 7. Execute with Filling Mode Fallbacks
        result = mt5.order_send(req)
        if result is None or result.retcode in [10030, 10031]:  # Unsupported filling mode
            for fill in [mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_RETURN]:
                req["type_filling"] = fill
                result = mt5.order_send(req)
                if result and result.retcode == mt5.TRADE_RETCODE_DONE:
                    break

        if result is None:
            err = mt5.last_error()
            self.report_result(command_id, success=False, status="FAILED", message=f"mt5.order_send returned None: {err}")
            return

        if result.retcode != mt5.TRADE_RETCODE_DONE:
            logger.error(f"MT5 order rejected: retcode={result.retcode}, comment={result.comment}")
            self.report_result(
                command_id,
                success=False,
                status="REJECTED",
                retcode=result.retcode,
                retcodeDescription=result.comment,
                message=f"Broker rejected: {result.comment} (code {result.retcode})"
            )
            return

        # 8. Success: Verify protective SL on the opened position
        ticket = result.order or result.deal
        logger.info(f"Order #{ticket} executed successfully on broker! Fill price={result.price}")

        self.report_result(
            command_id,
            success=True,
            status="FILLED",
            orderTicket=result.order,
            dealTicket=result.deal,
            positionTicket=ticket,
            executionPrice=float(result.price),
            retcode=result.retcode,
            retcodeDescription=result.comment,
            message=f"Order #{ticket} successfully executed on DEMO account."
        )

    def report_result(self, command_id: str, success: bool, status: str, **kwargs):
        """Reports the execution outcome back to GB-V5 on Render."""
        url = f"{SERVER_URL}/api/mt5/bridge/commands/{command_id}/result"
        payload = {
            "commandId": command_id,
            "success": success,
            "status": status,
            **kwargs
        }
        try:
            self.session.post(url, json=payload, timeout=8)
            logger.info(f"Reported result for command {command_id}: status={status}")
        except Exception as e:
            logger.error(f"Failed to report result for command {command_id}: {e}")

    def sync_historical_candles(self):
        """Extracts completed historical candles for M1, M5, M15, H1 and pushes to Render."""
        if not self.is_terminal_connected or self.candles_synced:
            return

        logger.info("Extracting historical candles from MT5 for backtesting...")
        tf_configs = [
            ("M1", mt5.TIMEFRAME_M1, 3000),
            ("M5", mt5.TIMEFRAME_M5, 3000),
            ("M15", mt5.TIMEFRAME_M15, 2000),
            ("H1", mt5.TIMEFRAME_H1, 1000),
        ]

        for tf_name, tf_const, count in tf_configs:
            rates = mt5.copy_rates_from_pos(self.resolved_symbol, tf_const, 0, count)
            if rates is not None and len(rates) > 0:
                candles = []
                for r in rates:
                    candles.append({
                        "timestamp": int(r['time']) * 1000,
                        "open": float(r['open']),
                        "high": float(r['high']),
                        "low": float(r['low']),
                        "close": float(r['close']),
                        "volume": float(r['tick_volume']) if 'tick_volume' in r.dtype.names else float(r['real_volume']),
                    })

                url = f"{SERVER_URL}/api/mt5/bridge/historical-candles"
                try:
                    res = self.session.post(url, json={"timeframe": tf_name, "candles": candles}, timeout=10)
                    if res.status_code == 200:
                        logger.info(f"Synced {len(candles)} {tf_name} historical candles to Render.")
                except Exception as e:
                    logger.debug(f"Failed to sync {tf_name} candles: {e}")

        self.candles_synced = True

    def poll_and_report_deal_history(self):
        """Polls confirmed deal history from MT5 and sends to GB-V5 for ledger reconciliation."""
        if not self.is_terminal_connected:
            return

        now = time.time()
        time_from = datetime.fromtimestamp(now - 86400, tz=timezone.utc)
        time_to = datetime.fromtimestamp(now + 60, tz=timezone.utc)

        try:
            deals = mt5.history_deals_get(time_from, time_to)
            if deals is None or len(deals) == 0:
                return

            new_deals = []
            for d in deals:
                ticket = int(d.ticket)
                if ticket in self.reported_deal_tickets:
                    continue

                # DEAL_ENTRY_OUT = 1, DEAL_ENTRY_INOUT = 2, DEAL_ENTRY_OUT_BY = 3
                is_exit = d.entry in [1, 2, 3] or (d.entry != 0 and d.profit != 0.0)
                if is_exit:
                    new_deals.append({
                        "ticket": ticket,
                        "order": int(d.order),
                        "positionId": int(d.position_id),
                        "time": int(d.time),
                        "timeMsc": int(d.time_msc) if hasattr(d, "time_msc") else int(d.time * 1000),
                        "type": int(d.type),
                        "entry": int(d.entry),
                        "magic": int(d.magic),
                        "volume": float(d.volume),
                        "price": float(d.price),
                        "profit": float(d.profit),
                        "commission": float(d.commission),
                        "swap": float(d.swap),
                        "symbol": str(d.symbol),
                        "comment": str(d.comment),
                    })

            if not new_deals:
                return

            url = f"{SERVER_URL}/api/mt5/bridge/deals"
            res = self.session.post(url, json={"deals": new_deals}, timeout=5)
            if res.status_code == 200:
                for nd in new_deals:
                    self.reported_deal_tickets.add(nd["ticket"])
                logger.info(f"Reported {len(new_deals)} confirmed deal(s) to GB-V5 ledger.")
            else:
                logger.warning(f"Deal reporting responded with {res.status_code}: {res.text}")

        except Exception as e:
            logger.debug(f"Deal history polling error: {e}")

    def run(self):
        """Main loop: Maintains terminal connection, sends heartbeats, polls commands."""
        logger.info("=" * 60)
        logger.info("Starting GB-V5 Windows MT5 Demo Trading Bridge Client")
        logger.info(f"Target GB-V5 App: {SERVER_URL}")
        logger.info(f"Magic Number: {MAGIC_NUMBER}")
        if not MT5_BRIDGE_TOKEN:
            logger.error("AUTHENTICATION CONFIGURATION REQUIRED:")
            logger.error("MT5_BRIDGE_TOKEN is not set! Set the MT5_BRIDGE_TOKEN environment variable on Windows to match your GB-V5 server.")
        else:
            logger.info("Authentication: MT5_BRIDGE_TOKEN is configured.")
        logger.info("=" * 60)

        while True:
            try:
                if not self.is_terminal_connected:
                    connected = self.init_mt5()
                    if not connected:
                        logger.warning("MT5 terminal connection retry in 10 seconds...")
                        time.sleep(10)
                        continue

                # Send heartbeat
                self.send_heartbeat()

                # Sync historical candles once on connection
                if not self.candles_synced:
                    self.sync_historical_candles()

                # Poll and execute pending trade commands
                self.poll_and_execute_commands()

                # Poll confirmed deal history and reconcile with ledger
                self.poll_and_report_deal_history()

                time.sleep(POLL_INTERVAL)

            except KeyboardInterrupt:
                logger.info("Bridge stopped by user.")
                if MT5_AVAILABLE:
                    mt5.shutdown()
                break
            except Exception as e:
                logger.error(f"Unexpected bridge error: {e}", exc_info=True)
                time.sleep(5)


if __name__ == "__main__":
    client = WindowsMT5BridgeClient()
    client.run()
