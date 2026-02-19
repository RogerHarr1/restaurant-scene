$baseUrl = "https://restaurant-scene.roger-jay-harrington.workers.dev"

# Step 1: Import all restaurants
Write-Host "=== IMPORTING 399 RESTAURANTS ===" -ForegroundColor Cyan
$json = Get-Content -Path ".\all_restaurants.json" -Raw
$result = Invoke-RestMethod -Method POST -Uri "$baseUrl/api/import" -ContentType "application/json" -Body $json
Write-Host "Import result: $($result | ConvertTo-Json -Depth 3)" -ForegroundColor Green

# Step 2: Enrich in batches of 20 (to avoid timeout)
Write-Host "`n=== ENRICHING ALL RESTAURANTS ===" -ForegroundColor Cyan
$enrichResult = Invoke-RestMethod -Method POST -Uri "$baseUrl/api/enrich" -ContentType "application/json"
Write-Host "Enrich result: enriched=$($enrichResult.enriched)" -ForegroundColor Green

# Step 3: Summary
Write-Host "`n=== RESULTS ===" -ForegroundColor Cyan
$providers = @{}
$noProvider = 0
foreach ($r in $enrichResult.results) {
    if ($r.provider) {
        if ($providers.ContainsKey($r.provider)) {
            $providers[$r.provider]++
        } else {
            $providers[$r.provider] = 1
        }
    } else {
        $noProvider++
    }
}

Write-Host "Newsletter providers detected:" -ForegroundColor Yellow
foreach ($p in $providers.Keys) {
    Write-Host "  $p : $($providers[$p])"
}
Write-Host "  No provider: $noProvider"
Write-Host "`nDone! Check D1 console for full details." -ForegroundColor Green
