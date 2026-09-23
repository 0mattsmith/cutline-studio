# Sideloads the Cutline Studio Word Add-in for development using official Microsoft tools
# Requires Node.js (which is installed on this system)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Starting Cutline Studio Word Add-in" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 1. Ensure the required Microsoft Office Add-in tools are available
Write-Host "`n[1/3] Installing Office Add-in development tools (if needed)..." -ForegroundColor Yellow
npm install -g office-addin-dev-certs office-addin-debugging http-server

# 2. Generate and install a trusted development certificate for localhost
Write-Host "`n[2/3] Verifying/Installing local HTTPS certificates..." -ForegroundColor Yellow
npx office-addin-dev-certs install

$certDir = "$env:USERPROFILE\.office-addin-dev-certs"
$cert = "$certDir\localhost.crt"
$key = "$certDir\localhost.key"

# Stop any existing http-server on port 8000 to avoid conflicts
$existingProcess = Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue
if ($existingProcess) {
    Write-Host "Stopping existing server on port 8000..." -ForegroundColor Gray
    Stop-Process -Id $existingProcess.OwningProcess -Force -ErrorAction SilentlyContinue
}

# Start the secure HTTPS server in the background
Write-Host "Starting local HTTPS server (https://127.0.0.1:8000)..." -ForegroundColor Gray
$serverProcess = Start-Process -PassThru -WindowStyle Hidden -FilePath "npx.cmd" -ArgumentList "http-server", ".", "-S", "-C", """$cert""", "-K", """$key""", "-p", "8000", "--cors"

# 3. Sideload the add-in into Microsoft Word
Write-Host "`n[3/3] Sideloading into Microsoft Word..." -ForegroundColor Yellow
Write-Host "Word should open shortly with the Add-in loaded on the Home tab." -ForegroundColor Green
npx office-addin-debugging start manifest.xml desktop --app word --no-debug

Write-Host "`nPress ENTER to stop the server and remove the sideloaded Add-in..." -ForegroundColor Cyan
while ($Host.UI.RawUI.KeyAvailable) { $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") }
Read-Host

# Cleanup
Write-Host "`nCleaning up..." -ForegroundColor Yellow
npx office-addin-debugging stop manifest.xml
if (!$serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force
}
Write-Host "Done!" -ForegroundColor Green
