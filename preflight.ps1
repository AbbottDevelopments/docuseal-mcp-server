# DocuSeal MCP Server - Stateful-mode preflight
# Uses PowerShell-native Invoke-WebRequest so JSON bodies are not mangled by
# curl.exe argument parsing on Windows.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\preflight.ps1

$ErrorActionPreference = "Continue"
$URL   = "https://docuseal-mcp-server-production.up.railway.app"
$TOKEN = "3QQ4VvJfsOOMaSPU4LURiq2nyMQNt8bD"

function Show($label, [ConsoleColor]$color = "Cyan") {
  Write-Host ""
  Write-Host "=== $label ===" -ForegroundColor $color
}

# 1. Health
Show "1. Health"
try {
  $h = Invoke-RestMethod -Uri "$URL/health" -Method Get
  $h | ConvertTo-Json
} catch {
  Write-Host "Health check failed: $_" -ForegroundColor Red
  exit 1
}

# 2. Initialize (capture Mcp-Session-Id)
Show "2. Initialize (capturing Mcp-Session-Id header)"
$initBody = @{
  jsonrpc = "2.0"
  id      = 1
  method  = "initialize"
  params  = @{
    protocolVersion = "2025-06-18"
    capabilities    = @{}
    clientInfo      = @{ name = "preflight"; version = "0.1" }
  }
} | ConvertTo-Json -Depth 10 -Compress

$headers = @{
  "Authorization" = "Bearer $TOKEN"
  "Accept"        = "application/json, text/event-stream"
}

try {
  $initResp = Invoke-WebRequest -Uri "$URL/mcp" -Method Post -Headers $headers -ContentType "application/json" -Body $initBody
  $initStatus = $initResp.StatusCode
  $initDesc = $initResp.StatusDescription
  Write-Host "Status: $initStatus $initDesc"
  Write-Host "Headers:"
  foreach ($k in $initResp.Headers.Keys) {
    $v = $initResp.Headers[$k]
    Write-Host "  ${k}: $v"
  }
  Write-Host ""
  Write-Host "Body:"
  Write-Host $initResp.Content
} catch {
  Write-Host "Initialize failed: $_" -ForegroundColor Red
  if ($_.Exception.Response) {
    $code = $_.Exception.Response.StatusCode.value__
    Write-Host "Status: $code"
  }
  exit 1
}

$SID = $initResp.Headers["Mcp-Session-Id"]
if ($SID -is [array]) { $SID = $SID[0] }
Write-Host ""
Write-Host ">>> Captured session ID: $SID" -ForegroundColor Green

if (-not $SID) {
  Write-Host "ERROR: No Mcp-Session-Id header returned. Server is not in stateful mode." -ForegroundColor Red
  exit 1
}

# 3. notifications/initialized
Show "3. notifications/initialized"
$notifBody = '{"jsonrpc":"2.0","method":"notifications/initialized"}'
$sessHeaders = @{
  "Authorization"   = "Bearer $TOKEN"
  "Accept"          = "application/json, text/event-stream"
  "Mcp-Session-Id"  = $SID
}
try {
  $n = Invoke-WebRequest -Uri "$URL/mcp" -Method Post -Headers $sessHeaders -ContentType "application/json" -Body $notifBody
  $nStatus = $n.StatusCode
  $nBody = $n.Content
  Write-Host "Status: $nStatus"
  Write-Host "Body: $nBody"
} catch {
  Write-Host "notifications/initialized failed: $_" -ForegroundColor Red
}

# 4. tools/list
Show "4. tools/list (should return 5 tools)"
$toolsBody = '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
try {
  $t = Invoke-WebRequest -Uri "$URL/mcp" -Method Post -Headers $sessHeaders -ContentType "application/json" -Body $toolsBody
  $tStatus = $t.StatusCode
  $tCT = $t.Headers["Content-Type"]
  if ($tCT -is [array]) { $tCT = $tCT[0] }
  $tBody = $t.Content
  Write-Host "Status: $tStatus"
  Write-Host "Content-Type: $tCT"
  Write-Host "Body:"
  Write-Host $tBody
} catch {
  Write-Host "tools/list failed: $_" -ForegroundColor Red
}

# 5. GET /mcp with session (SSE stream should hold open)
Show "5. GET /mcp WITH session (should hold open with text/event-stream)"
Write-Host "(will timeout after 3s, which is healthy)" -ForegroundColor Yellow
try {
  $g = Invoke-WebRequest -Uri "$URL/mcp" -Method Get -Headers $sessHeaders -TimeoutSec 3
  $gStatus = $g.StatusCode
  $gCT = $g.Headers["Content-Type"]
  if ($gCT -is [array]) { $gCT = $gCT[0] }
  Write-Host "Status: $gStatus"
  Write-Host "Content-Type: $gCT"
} catch {
  $msg = $_.Exception.Message
  if ($msg -match "timed out|canceled|operation was canceled") {
    Write-Host "Stream timed out after 3s. Healthy." -ForegroundColor Green
  } else {
    Write-Host "GET error: $msg" -ForegroundColor Yellow
  }
}

# 6. GET /mcp without session
Show "6. GET /mcp WITHOUT session (should 400)"
try {
  $noSessHeaders = @{ "Authorization" = "Bearer $TOKEN" }
  $g2 = Invoke-WebRequest -Uri "$URL/mcp" -Method Get -Headers $noSessHeaders -TimeoutSec 3
  $g2Status = $g2.StatusCode
  Write-Host "Status: $g2Status"
} catch {
  if ($_.Exception.Response) {
    $code = $_.Exception.Response.StatusCode.value__
    Write-Host "Status: $code (expected 400)" -ForegroundColor Green
  } else {
    $emsg = $_.Exception.Message
    Write-Host "Error: $emsg"
  }
}

Show "Preflight complete" "Green"
