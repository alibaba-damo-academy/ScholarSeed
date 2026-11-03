# Optional settings for the current PowerShell session. No credentials belong here.
# Dot-source only when existing execution policy permits; otherwise paste these lines.
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PAPER_DL_MODE = 'interactive'
$env:PAPER_DL_ZOTERO_MODE = 'off'
Remove-Item Env:PAPER_DL_CDP_ENDPOINT, Env:PAPER_DL_CDP_PROFILE, Env:PAPER_DL_AUTO_LAUNCH_CHROME -ErrorAction SilentlyContinue
# All skill copies on this machine must use the same pool root, outside run directories.
# $env:PAPER_DL_BROWSER_POOL_DIR = Join-Path $env:USERPROFILE '.paper-dl\browser-pool'
# $env:PAPER_DL_CHROME_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
# Edge can also be selected, e.g. 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'.
# Edge uses <pool>\slot-N\edge-profile and the default <pool>\edge-profile-template.
# PAPER_DL_PROFILE_TEMPLATE overrides the default and must match the selected browser.
# For Edge, leave it unset or point it to a template created with browser_pool.py create-template --browser edge --source-profile <closed Edge user-data directory>.
# $env:PAPER_DL_PROFILE_TEMPLATE = Join-Path $env:USERPROFILE '.paper-dl\browser-pool\profile-template'
# Platform runtime override: use one .exe/.py executable or a source directory.
# $env:PAPER_DL_EXECUTABLE = 'C:\paper-dl\.venv\Scripts\paper-dl.exe'
# $env:PAPER_DL_ROOT = 'C:\paper-dl'
# $env:PAPER_DL_PAPER_TIMEOUT = '600'
# $env:PAPER_DL_BATCH_TIMEOUT = '1800'
