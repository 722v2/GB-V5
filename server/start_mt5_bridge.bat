@echo off
title GB-V5 Windows MT5 Demo Trading Bridge Client
echo ===============================================================
echo Starting GB-V5 Windows MT5 Demo Trading Bridge (Outbound Agent)
echo ===============================================================
echo.

:: 1. Check Python installation
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed or not in PATH!
    echo Please install Python 3.10+ from python.org and ensure 'Add Python to PATH' is checked.
    pause
    exit /b
)

:: 2. Install / verify dependencies
echo Verifying Python dependencies (MetaTrader5, requests, python-dotenv)...
pip install -r mt5_requirements.txt

:: 3. Environment configuration
:: If .env file exists in the directory, python-dotenv will load it automatically.
:: Otherwise, set default variables below:
if "%RENDER_GBV5_URL%"=="" set RENDER_GBV5_URL=https://your-app.onrender.com
if "%MT5_BRIDGE_TOKEN%"=="" echo [WARNING] MT5_BRIDGE_TOKEN is not set. Please set MT5_BRIDGE_TOKEN in your environment or .env file.
if "%MT5_SYMBOL%"=="" set MT5_SYMBOL=XAUUSD
if "%MT5_MAGIC_NUMBER%"=="" set MT5_MAGIC_NUMBER=240726

echo.
echo ===============================================================
echo Target GB-V5 URL : %RENDER_GBV5_URL%
echo Target Symbol    : %MT5_SYMBOL%
echo Mode             : STRICT DEMO ONLY
echo ===============================================================
echo.

:LOOP
echo Launching Windows MT5 Bridge Client...
python mt5_bridge_client.py
echo.
echo [WARNING] Bridge client exited. Restarting in 5 seconds (Press Ctrl+C to stop)...
timeout /t 5 /nobreak >nul
goto LOOP
