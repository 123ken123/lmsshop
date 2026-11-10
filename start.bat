@echo off
cd /d "%~dp0"
rem === DOI 2 DONG DUOI THANH CHUOI RIENG CUA BAN (dai, ngau nhien) ===
set WEBHOOK_KEY=doi-thanh-chuoi-dai-ngau-nhien
set ADMIN_TOKEN=doi-thanh-token-admin-cua-ban
set PORT=3000
set ACCOUNT_NO=0971438618
rem Khi chay sau ngrok/Render/Railway thi bo chu "rem" o dong duoi:
rem set TRUST_PROXY=1
node server.js
pause
