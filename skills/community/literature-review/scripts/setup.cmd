@echo off
setlocal DisableDelayedExpansion
call "%~dp0slr.cmd" setup %*
exit /b %errorlevel%
