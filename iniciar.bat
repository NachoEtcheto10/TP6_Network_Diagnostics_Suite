@echo off
REM Inicia el agente de red (puerto 4000) y la app web (puerto 8081) en dos ventanas.
cd /d "%~dp0"
if not exist "server\node_modules" (cd server && call npm install && cd ..)
if not exist "mobile\node_modules" (cd mobile && call npm install && cd ..)
start "NDS Agent (red + backend)" cmd /k "cd /d %~dp0server && npm start"
start "NDS App (Expo web)" cmd /k "cd /d %~dp0mobile && npx expo start --web --port 8081"
echo.
echo Agente:  http://localhost:4000/
echo App:     http://localhost:8081/   (se abre sola cuando termina de compilar)
echo.
