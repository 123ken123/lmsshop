# Cach dung: .\them-key.ps1 -ProductId 1 -Keys "KEY-AAA","KEY-BBB"
param([int]$ProductId, [string[]]$Keys, [string]$Token = "doi-thanh-token-admin-cua-ban", [string]$Url = "http://localhost:3000")
$body = @{ productId = $ProductId; keys = $Keys } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$Url/api/admin/keys" -Headers @{ "x-admin-token" = $Token } -ContentType "application/json" -Body $body
