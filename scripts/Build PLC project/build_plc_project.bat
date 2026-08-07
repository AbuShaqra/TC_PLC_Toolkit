@echo off
title TwinCAT Build
rem Arguments are forwarded verbatim, so the solution can be named positionally:
rem   build_plc_project.bat TcSample_1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_plc_project.ps1" %*
echo.
if %errorlevel% equ 0 (
    echo ================ BUILD OK ================
) else (
    echo ============ BUILD FAILED - exit code %errorlevel% ============
)
pause
