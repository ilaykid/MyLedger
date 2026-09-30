@echo off
REM Double-click to open MyLedger (starts it if it is not running).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" -StartOnly
