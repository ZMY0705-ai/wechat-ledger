@echo off
REM ledger 包装脚本：直通传参，绕开 npm 会吞掉 --flag 的行为
node --disable-warning=ExperimentalWarning "%~dp0cli\src\index.js" %*