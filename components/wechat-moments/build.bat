@echo off
setlocal
cd /d "%~dp0"
set "MSVC=C:////Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207"
set "SDK=C:////Program Files (x86)\Windows Kits\10"
set "SDKVER=10.0.26100.0"
set "INCLUDE=%MSVC%\include;%SDK%\Include\%SDKVER%\ucrt;%SDK%\Include\%SDKVER%\shared;%SDK%\Include\%SDKVER%\um"
set "LIB=%MSVC%\lib\x64;%SDK%\Lib\%SDKVER%\ucrt\x64;%SDK%\Lib\%SDKVER%\um\x64"
set "PATH=%MSVC%\bin\Hostx64\x64;%PATH%"
if not exist build mkdir build
if not exist build\prod mkdir build\prod
echo === mock ===
cl /nologo /O2 /W3 /LD /DWM_OFFLINE_TEST moments-bridge.c /Fe:build\WeChatMomentsMock.dll /Fo:build\ /link ws2_32.lib bcrypt.lib
if errorlevel 1 exit /b 1
echo === production ===
cl /nologo /O2 /W3 /LD moments-bridge.c /Fe:build\WeChatMoments.dll /Fo:build\prod\ /link ws2_32.lib bcrypt.lib
if errorlevel 1 exit /b 1
echo === mock host ===
cl /nologo /O2 /W3 mock-host.c /Fe:build\mock-host.exe /Fo:build\ /link ws2_32.lib
if errorlevel 1 exit /b 1

cl /nologo /O2 /W3 /LD probe.c /Fe:build\moments-probe.dll /Fo:build\ /link ws2_32.lib
if errorlevel 1 exit /b 1
cl /nologo /O2 /W3 probe-host.c /Fe:build\probe-host.exe /Fo:build\
if errorlevel 1 exit /b 1
echo BUILD_OK
