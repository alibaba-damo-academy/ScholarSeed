@echo off
setlocal DisableDelayedExpansion
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
if defined SCHOLARSEED_SKILL_PYTHON goto product
where scholarseed-skill-python >nul 2>&1
if errorlevel 1 (
  echo [slr] Launch this skill from ScholarSeed Desktop or Serve. 1>&2
  exit /b 1
)
call scholarseed-skill-python "%~dp0bootstrap.py" %*
exit /b %errorlevel%
:product
call "%SCHOLARSEED_SKILL_PYTHON%" "%~dp0bootstrap.py" %*
exit /b %errorlevel%
