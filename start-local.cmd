@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\express\package.json" (
  echo Installation des dependances du site...
  call npm.cmd install
  if errorlevel 1 goto failed
)
echo.
echo Assistant liturgique disponible sur http://127.0.0.1:3000
echo Gardez cette fenetre ouverte pendant l'utilisation.
echo.
node server.mjs
if errorlevel 1 goto failed
goto end

:failed
echo.
echo Le serveur n'a pas pu demarrer. Verifiez que Node.js est installe et que le port 3000 est libre.
pause
:end
endlocal
