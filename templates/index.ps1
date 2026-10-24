# sh.qntx.org tool directory. S1: list every tool and exit 1.

[Console]::Error.WriteLine("Usage: irm https://sh.qntx.org/<tool>/ps | iex")
[Console]::Error.WriteLine("")
[Console]::Error.WriteLine("Tools:")
# @qntx-constants
[Console]::Error.WriteLine("")
[Console]::Error.WriteLine("Unix:")
[Console]::Error.WriteLine("  curl -fsSL https://sh.qntx.org/<tool> | sh")
$global:LASTEXITCODE = 1
