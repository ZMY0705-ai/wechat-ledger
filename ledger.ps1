#!/usr/bin/env pwsh
# ledger 包装脚本：直通传参，绕开 npm 会吞掉 --flag 的行为
# 用法：.\ledger init --initial 5000
$script = Join-Path $PSScriptRoot 'cli/src/index.js'
& node --disable-warning=ExperimentalWarning $script @args
exit $LASTEXITCODE