@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo === gcodeviewer build ===

if not exist node_modules (
   echo Installing npm dependencies...
   call npm install
   if errorlevel 1 (
      echo npm install failed.
      exit /b 1
   )
)

where wasm-pack >nul 2>nul
if errorlevel 1 (
   echo wasm-pack not found on PATH - skipping the Rust/WASM fast path.
   echo The build will fall back to a JS stub ^(see WASM_FileProcessor\pkg-fallback^) and the
   echo library still works fully via its TypeScript parser. To enable the WASM fast path,
   echo install Rust + wasm-pack ^(cargo install wasm-pack^) and re-run this script.
) else (
   echo Building WASM module...
   call npm run build:wasm
   if errorlevel 1 (
      echo WASM build failed - continuing with the JS fallback stub instead.
   )
)

echo Type-checking...
call npm run check
if errorlevel 1 (
   echo Type-check failed.
   exit /b 1
)

echo Building library...
call npm run build
if errorlevel 1 (
   echo Build failed.
   exit /b 1
)

echo.
echo Build succeeded. Output is in dist\.
endlocal
