@echo off
cd /d "%~dp0"
set BASE_URL=https://rise-lagged-cottage.ngrok-free.dev
set STEAM_API_KEY=61FA7CCE1E8DA6B4D1FBA2FD781FC2AF
set ADMIN_STEAM_IDS=
set SESSION_SECRET=qwerty-замініть-на-довгий-випадковий-текст-12345
node server.js
pause