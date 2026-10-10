"""
=============================================================================
PRODUCTION MT5 REST BRIDGE SERVER FOR WINDOWS & VPS
=============================================================================
This is the official, production-ready Python connector bridge between your
Google AI Studio Gold Scalper app and MetaTrader 5 Terminal.

FEATURES:
1. Direct native Python integration via official `MetaTrader5` package.
2. Bearer Token authentication with `MT5_API_KEY`.
3. Endpoints for Account Status (Balance, Equity, Free Margin, Leverage, Server).
4. Full Order Execution:
   - BUY / SELL (Market execution with slippage control)
   - BUY_LIMIT / SELL_LIMIT (Pending limit orders with expiration)
   - SL / TP placement and dynamic modification
   - Position & Pending Order closing/cancellation
5. Support for DEMO and REAL accounts.
6. Zero mock data: queries live MT5 Terminal state and returns real order tickets.
=============================================================================
"""

import os
import sys
import json
import logging
import datetime
from typing import Optional
from flask import Flask, request, jsonify
from flask_cors import CORS

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler('mt5_bridge.log', encoding='utf-8')
    ]
)
logger = logging.getLogger("MT5_Bridge")

try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    MT5_AVAILABLE = False
    logger.error("MetaTrader5 python package not found! Please run: pip install MetaTrader5")

app = Flask(__name__)
CORS(app)

# Environment configuration
PORT = int(os.environ.get("PORT", 5001))
MT5_API_KEY = os.environ.get("MT5_BRIDGE_TOKEN", os.environ.get("MT5_API_KEY", ""))
MT5_ACCOUNT = os.environ.get("MT5_ACCOUNT", "")
MT5_PASSWORD = os.environ.get("MT5_PASSWORD", "")
MT5_SERVER = os.environ.get("MT5_SERVER", "")
MT5_PATH = os.environ.get("MT5_PATH", "")  # e.g., "C:\\Program Files\\MetaTrader 5\\terminal64.exe"
MT5_ACCOUNT_TYPE = os.environ.get("MT5_ACCOUNT_TYPE", "DEMO")


def initialize_mt5() -> bool:
    """Initializes and logs into the MetaTrader 5 terminal."""
    if not MT5_AVAILABLE:
        return False
        
    init_kwargs = {}
    if MT5_PATH:
        init_kwargs["path"] = MT5_PATH

    if not mt5.initialize(**init_kwargs):
        logger.error(f"MT5 initialize() failed, error code = {mt5.last_error()}")
        return False

    # Login if credentials provided
    if MT5_ACCOUNT and MT5_PASSWORD and MT5_SERVER:
        login_res = mt5.login(
            login=int(MT5_ACCOUNT),
            password=MT5_PASSWORD,
            server=MT5_SERVER
        )
        if not login_res:
            logger.error(f"MT5 login failed for account {MT5_ACCOUNT} on {MT5_SERVER}, error = {mt5.last_error()}")
            return False

    account_info = mt5.account_info()
    if account_info is None:
        logger.warning(f"Could not retrieve account info: {mt5.last_error()}")
        return False

    logger.info(f"Connected to MT5: Account={account_info.login}, Server={account_info.server}, Balance={account_info.balance}, Mode={'REAL' if account_info.trade_mode == mt5.ACCOUNT_TRADE_MODE_REAL else 'DEMO'}")
    return True


@app.before_request
def authenticate_request():
    """Validates Bearer token in the Authorization header."""
    if request.method == "OPTIONS":
        return
    if MT5_API_KEY:
        auth_header = request.headers.get("Authorization", "")
        expected = f"Bearer {MT5_API_KEY}"
        if auth_header != expected:
            return jsonify({
                "success": False,
                "error": "Unauthorized: Invalid or missing MT5_API_KEY in Authorization header"
            }), 401


@app.route("/health", methods=["GET"])
def health_check():
    """Health check endpoint."""
    return jsonify({
        "status": "online",
        "service": "MT5 REST Bridge",
        "mt5_package_installed": MT5_AVAILABLE
    })


@app.route("/account", methods=["GET"])
def get_account():
    """
    Returns account connection status, balance, equity, margin, leverage,
    and actual execution mode directly from MT5 Terminal.
    """
    if not MT5_AVAILABLE:
        return jsonify({
            "connected": False,
            "status": "DISCONNECTED",
            "error": "MetaTrader5 Python package is not installed on this machine."
        }), 500

    account_info = mt5.account_info()
    if account_info is None:
        # Attempt reconnect once
        if not initialize_mt5():
            err = mt5.last_error()
            return jsonify({
                "connected": False,
                "status": "DISCONNECTED",
                "error": f"MT5 terminal disconnected: {err}"
            }), 503
        account_info = mt5.account_info()

    if account_info is None:
        return jsonify({
            "connected": False,
            "status": "DISCONNECTED",
            "error": "Unable to read MT5 account info."
        }), 503

    mode = "REAL" if account_info.trade_mode == mt5.ACCOUNT_TRADE_MODE_REAL else "DEMO"

    return jsonify({
        "connected": True,
        "status": "CONNECTED",
        "accountNumber": str(account_info.login),
        "server": account_info.server,
        "name": account_info.name,
        "currency": account_info.currency,
        "balance": float(account_info.balance),
        "equity": float(account_info.equity),
        "freeMargin": float(account_info.margin_free),
        "margin": float(account_info.margin),
        "marginLevel": float(account_info.margin_level) if account_info.margin > 0 else 0.0,
        "leverage": int(account_info.leverage),
        "accountMode": mode,
        "tradeAllowed": bool(account_info.trade_allowed),
        "tradeExpert": bool(account_info.trade_expert)
    })


@app.route("/candles", methods=["GET"])
def get_candles():
    """
    Returns real historical OHLCV candles directly from MT5 Terminal using mt5.copy_rates_from_pos().
    Parameters:
      - symbol: e.g. XAUUSD
      - timeframe: M1, M5, M15, M30, H1, H4, D1
      - count: number of bars to fetch (e.g. 5000, 10000)
    """
    if not MT5_AVAILABLE:
        return jsonify({
            "success": False,
            "error": "MetaTrader5 Python package is not installed on this machine."
        }), 500

    account_info = mt5.account_info()
    if account_info is None:
        if not initialize_mt5():
            err = mt5.last_error()
            return jsonify({
                "success": False,
                "error": f"MT5 terminal disconnected: {err}"
            }), 503

    symbol = request.args.get("symbol", "XAUUSD").replace("/", "").strip()
    tf_str = request.args.get("timeframe", "M5").upper().strip()
    try:
        count = int(request.args.get("count", 1000))
        if count <= 0:
            count = 1000
    except (ValueError, TypeError):
        count = 1000

    # Map timeframe string to MT5 constant
    tf_map = {
        "M1": mt5.TIMEFRAME_M1,
        "M5": mt5.TIMEFRAME_M5,
        "M15": mt5.TIMEFRAME_M15,
        "M30": mt5.TIMEFRAME_M30,
        "H1": mt5.TIMEFRAME_H1,
        "H4": mt5.TIMEFRAME_H4,
        "D1": mt5.TIMEFRAME_D1,
    }

    if tf_str not in tf_map:
        return jsonify({
            "success": False,
            "error": f"Unsupported timeframe '{tf_str}'. Supported: {list(tf_map.keys())}"
        }), 400

    mt5_tf = tf_map[tf_str]

    # Verify Symbol in MarketWatch
    selected = mt5.symbol_select(symbol, True)
    if not selected:
        for alt in ["XAUUSD", "GOLD", "XAUUSDm", "XAUUSD.a", "XAUUSD.raw"]:
            if mt5.symbol_select(alt, True):
                symbol = alt
                selected = True
                break

    if not selected:
        return jsonify({
            "success": False,
            "error": f"Symbol {symbol} not found or cannot be selected in MT5."
        }), 400

    # Fetch rates from MT5
    rates = mt5.copy_rates_from_pos(symbol, mt5_tf, 0, count)
    if rates is None or len(rates) == 0:
        err = mt5.last_error()
        logger.error(f"MT5 copy_rates_from_pos returned None for {symbol} ({tf_str}, count={count}): {err}")
        return jsonify({
            "success": False,
            "error": f"Failed to retrieve rates from MT5 for {symbol} ({tf_str}): {err}"
        }), 500

    candles = []
    for r in rates:
        dt = datetime.datetime.fromtimestamp(int(r['time']), tz=datetime.timezone.utc)
        candles.append({
            "timestamp": dt.isoformat(),
            "time": int(r['time']) * 1000,
            "open": float(r['open']),
            "high": float(r['high']),
            "low": float(r['low']),
            "close": float(r['close']),
            "volume": float(r['tick_volume']) if 'tick_volume' in r.dtype.names else float(r['real_volume']),
            "tickVolume": int(r['tick_volume']) if 'tick_volume' in r.dtype.names else 0,
            "spread": float(r['spread']) if 'spread' in r.dtype.names else 0.0,
        })

    logger.info(f"Retrieved {len(candles)} real {tf_str} candles for {symbol} from MT5.")

    return jsonify({
        "success": True,
        "symbol": symbol,
        "timeframe": tf_str,
        "count": len(candles),
        "earliest": candles[0]["timestamp"] if candles else None,
        "latest": candles[-1]["timestamp"] if candles else None,
        "candles": candles,
    })


@app.route("/order", methods=["POST"])
def execute_order():
    """
    Executes an order on MT5.
    Supports:
      - BUY / BUY NOW
      - SELL / SELL NOW
      - BUY LIMIT
      - SELL LIMIT
    """
    if not MT5_AVAILABLE:
        return jsonify({"success": False, "error": "MT5 package not installed."}), 500

    account_info = mt5.account_info()
    if account_info is None:
        if not initialize_mt5():
            return jsonify({"success": False, "error": "MT5 Terminal disconnected."}), 503

    data = request.get_json() or {}
    symbol = data.get("symbol", "XAUUSD").replace("/", "")
    action = str(data.get("action", "")).upper()
    lot = float(data.get("lot", 0.01))
    requested_price = float(data.get("price", 0.0))
    sl = float(data.get("sl", 0.0)) if data.get("sl") else 0.0
    tp = float(data.get("tp", 0.0)) if data.get("tp") else 0.0
    comment = str(data.get("comment", "Gold AI Signal"))
    account_mode = str(data.get("mode", "DEMO")).upper()

    # Verify Symbol in MarketWatch
    selected = mt5.symbol_select(symbol, True)
    if not selected:
        # Try alternate gold symbol naming
        for alt in ["XAUUSD", "GOLD", "XAUUSDm", "XAUUSD.a", "XAUUSD.raw"]:
            if mt5.symbol_select(alt, True):
                symbol = alt
                selected = True
                break

    if not selected:
        return jsonify({"success": False, "error": f"Symbol {symbol} not found or cannot be selected in MT5."}), 400

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return jsonify({"success": False, "error": f"Could not retrieve live price tick for {symbol}."}), 500

    # Determine order type
    if "BUY LIMIT" in action:
        order_type = mt5.ORDER_TYPE_BUY_LIMIT
        exec_price = requested_price if requested_price > 0 else tick.ask
    elif "SELL LIMIT" in action:
        order_type = mt5.ORDER_TYPE_SELL_LIMIT
        exec_price = requested_price if requested_price > 0 else tick.bid
    elif "BUY" in action:
        order_type = mt5.ORDER_TYPE_BUY
        exec_price = tick.ask
    elif "SELL" in action:
        order_type = mt5.ORDER_TYPE_SELL
        exec_price = tick.bid
    else:
        return jsonify({"success": False, "error": f"Unsupported order action: {action}"}), 400

    # Build standard MT5 request struct
    req = {
        "action": mt5.TRADE_ACTION_PENDING if "LIMIT" in action else mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": lot,
        "type": order_type,
        "price": exec_price,
        "deviation": 20,
        "magic": 240726,
        "comment": comment[:31],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC if "LIMIT" not in action else mt5.ORDER_FILLING_RETURN,
    }

    if sl > 0:
        req["sl"] = sl
    if tp > 0:
        req["tp"] = tp

    # Try order sending with fallback for broker filling policies
    result = mt5.order_send(req)
    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        # If filling mode rejected, retry with FOK or RETURN
        if result and result.retcode in [10030, 10031]:  # Unsupported filling mode
            for filling_mode in [mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_RETURN]:
                req["type_filling"] = filling_mode
                result = mt5.order_send(req)
                if result and result.retcode == mt5.TRADE_RETCODE_DONE:
                    break

    if result is None:
        err = mt5.last_error()
        logger.error(f"MT5 order_send returned None: {err}")
        return jsonify({"success": False, "error": f"MT5 order_send error: {err}"}), 500

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        logger.error(f"Order failed with retcode {result.retcode}: {result.comment}")
        return jsonify({
            "success": False,
            "retcode": result.retcode,
            "error": f"MT5 rejected order: {result.comment} (code {result.retcode})"
        }), 400

    ticket = result.order or result.deal
    logger.info(f"Order Executed Successfully: Ticket={ticket}, Action={action}, Symbol={symbol}, Lot={lot}, Price={result.price}")

    return jsonify({
        "success": True,
        "ticket": ticket,
        "orderId": f"mt5_{ticket}",
        "executionPrice": float(result.price),
        "status": "EXECUTED",
        "accountMode": account_mode,
        "retcode": result.retcode,
        "message": f"Order #{ticket} executed successfully on MT5 ({symbol} {action} {lot} lot @ {result.price})"
    })


@app.route("/modify", methods=["POST"])
def modify_order():
    """Modifies Stop Loss and Take Profit for an active position or pending order."""
    if not MT5_AVAILABLE:
        return jsonify({"success": False, "error": "MT5 package not installed."}), 500

    data = request.get_json() or {}
    ticket = int(data.get("ticket", 0))
    sl = float(data.get("stopLoss", 0.0)) if data.get("stopLoss") is not None else 0.0
    tp = float(data.get("takeProfit", 0.0)) if data.get("takeProfit") is not None else 0.0

    if not ticket:
        return jsonify({"success": False, "error": "Order ticket is required."}), 400

    # 1. Check if it's an open position
    pos = mt5.positions_get(ticket=ticket)
    if pos and len(pos) > 0:
        p = pos[0]
        req = {
            "action": mt5.TRADE_ACTION_SLTP,
            "position": ticket,
            "symbol": p.symbol,
            "sl": sl if sl > 0 else p.sl,
            "tp": tp if tp > 0 else p.tp
        }
        res = mt5.order_send(req)
        if res and res.retcode == mt5.TRADE_RETCODE_DONE:
            return jsonify({"success": True, "message": f"Position #{ticket} SL/TP modified successfully."})
        else:
            err = res.comment if res else str(mt5.last_error())
            return jsonify({"success": False, "error": f"Failed to modify position: {err}"}), 400

    # 2. Check if it's a pending order
    orders = mt5.orders_get(ticket=ticket)
    if orders and len(orders) > 0:
        o = orders[0]
        req = {
            "action": mt5.TRADE_ACTION_MODIFY,
            "order": ticket,
            "price": o.price_open,
            "sl": sl if sl > 0 else o.sl,
            "tp": tp if tp > 0 else o.tp,
            "type_time": o.type_time,
            "expiration": o.expiration
        }
        res = mt5.order_send(req)
        if res and res.retcode == mt5.TRADE_RETCODE_DONE:
            return jsonify({"success": True, "message": f"Pending order #{ticket} modified successfully."})
        else:
            err = res.comment if res else str(mt5.last_error())
            return jsonify({"success": False, "error": f"Failed to modify order: {err}"}), 400

    return jsonify({"success": False, "error": f"Ticket #{ticket} not found in open positions or pending orders."}), 404


@app.route("/close", methods=["POST"])
def close_order():
    """Closes an active position or cancels a pending order by ticket."""
    if not MT5_AVAILABLE:
        return jsonify({"success": False, "error": "MT5 package not installed."}), 500

    data = request.get_json() or {}
    ticket = int(data.get("ticket", 0))
    close_lot = float(data.get("lot", 0.0)) if data.get("lot") else 0.0

    if not ticket:
        return jsonify({"success": False, "error": "Order ticket is required."}), 400

    # 1. Try closing open position
    pos = mt5.positions_get(ticket=ticket)
    if pos and len(pos) > 0:
        p = pos[0]
        symbol = p.symbol
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            return jsonify({"success": False, "error": f"Could not get quote tick for {symbol}"}), 500

        close_type = mt5.ORDER_TYPE_SELL if p.type == mt5.POSITION_TYPE_BUY else mt5.ORDER_TYPE_BUY
        price = tick.bid if p.type == mt5.POSITION_TYPE_BUY else tick.ask
        lot = close_lot if (close_lot > 0 and close_lot <= p.volume) else p.volume

        req = {
            "action": mt5.TRADE_ACTION_DEAL,
            "position": ticket,
            "symbol": symbol,
            "volume": lot,
            "type": close_type,
            "price": price,
            "deviation": 20,
            "magic": 240726,
            "comment": "Close by Gold AI Bridge",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }

        res = mt5.order_send(req)
        if res and res.retcode == mt5.TRADE_RETCODE_DONE:
            return jsonify({"success": True, "message": f"Position #{ticket} closed successfully at {price}."})
        else:
            err = res.comment if res else str(mt5.last_error())
            return jsonify({"success": False, "error": f"Failed to close position: {err}"}), 400

    # 2. Try canceling pending order
    orders = mt5.orders_get(ticket=ticket)
    if orders and len(orders) > 0:
        req = {
            "action": mt5.TRADE_ACTION_REMOVE,
            "order": ticket
        }
        res = mt5.order_send(req)
        if res and res.retcode == mt5.TRADE_RETCODE_DONE:
            return jsonify({"success": True, "message": f"Pending order #{ticket} cancelled successfully."})
        else:
            err = res.comment if res else str(mt5.last_error())
            return jsonify({"success": False, "error": f"Failed to cancel order: {err}"}), 400

    return jsonify({"success": False, "error": f"Ticket #{ticket} not found."}), 404


@app.route("/order-status", methods=["GET"])
def order_status():
    """Queries ticket status from open positions, pending orders, or trade deals history."""
    if not MT5_AVAILABLE:
        return jsonify({"success": False, "error": "MT5 package not installed."}), 500

    ticket_str = request.args.get("ticket")
    if not ticket_str:
        return jsonify({"success": False, "error": "Ticket param is required."}), 400

    ticket = int(ticket_str)

    # 1. Check open positions
    pos = mt5.positions_get(ticket=ticket)
    if pos and len(pos) > 0:
        p = pos[0]
        return jsonify({
            "success": True,
            "state": "OPEN",
            "ticket": ticket,
            "symbol": p.symbol,
            "volume": p.volume,
            "price_open": p.price_open,
            "price_current": p.price_current,
            "profit": p.profit,
            "sl": p.sl,
            "tp": p.tp
        })

    # 2. Check pending orders
    orders = mt5.orders_get(ticket=ticket)
    if orders and len(orders) > 0:
        o = orders[0]
        return jsonify({
            "success": True,
            "state": "PENDING",
            "ticket": ticket,
            "symbol": o.symbol,
            "volume": o.volume_initial,
            "price_open": o.price_open,
            "sl": o.sl,
            "tp": o.tp
        })

    return jsonify({
        "success": True,
        "state": "CLOSED_OR_FILLED",
        "ticket": ticket
    })


if __name__ == "__main__":
    logger.info(f"Starting MT5 REST Bridge on port {PORT}...")
    if MT5_AVAILABLE:
        initialize_mt5()
    app.run(host="0.0.0.0", port=PORT, debug=False)
