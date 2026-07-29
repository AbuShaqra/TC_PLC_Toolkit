@echo off
title TwinCAT Build - PLC Project
rem Arguments are forwarded verbatim, so the solution can be named positionally:
rem   build_plc_project.bat MyProject
rem -STA is belt-and-braces: powershell.exe -File is STA already, and a -TcVersion pin needs it.
powershell -STA -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_plc_project.ps1" %*
echo.
if %errorlevel% equ 0 (
    echo ================ BUILD OK ================
) else (
    echo ============ BUILD FAILED - exit code %errorlevel% ============
)
pause
