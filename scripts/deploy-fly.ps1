param(
  [string]$App = "phoenix-site",
  [int]$WaitMinutes = 10
)

$ErrorActionPreference = "Stop"
$taskProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$flyConfig = Join-Path $taskProjectRoot "fly.toml"
$waitTimeout = "${WaitMinutes}m"

& flyctl deploy $taskProjectRoot `
  --app $App `
  --config $flyConfig `
  --remote-only `
  --wait-timeout $waitTimeout

if ($LASTEXITCODE -ne 0) {
  throw "Fly deploy failed with exit code $LASTEXITCODE."
}

$publicUrl = "https://$App.fly.dev/index.html"
for ($attempt = 1; $attempt -le 12; $attempt++) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Method Head -Uri $publicUrl -TimeoutSec 20
    if ($response.StatusCode -lt 500) {
      Write-Output "Fly deploy verified: $publicUrl returned HTTP $($response.StatusCode)."
      exit 0
    }
  } catch {
    if ($attempt -eq 12) { throw }
  }
  Start-Sleep -Seconds 5
}

throw "Fly deploy completed, but the public health check did not succeed."
