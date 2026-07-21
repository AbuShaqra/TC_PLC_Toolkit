@echo off
title TwinCAT PLC Build
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_plc_project.ps1" %*
echo.
if %errorlevel% equ 0 (
    echo ================ BUILD OK ================
) else (
    echo ============ BUILD FAILED - exit code %errorlevel% ============
)
pause
