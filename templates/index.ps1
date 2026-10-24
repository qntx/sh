# sh.qntx.org tool directory. S1: list every tool and exit 1.

$Host.UI.WriteErrorLine("Usage: irm https://sh.qntx.org/<tool>/ps | iex")
$Host.UI.WriteErrorLine("")
$Host.UI.WriteErrorLine("Tools:")
# @qntx-constants
$Host.UI.WriteErrorLine("")
$Host.UI.WriteErrorLine("Unix:")
$Host.UI.WriteErrorLine("  curl -fsSL https://sh.qntx.org/<tool> | sh")
exit 1
