@echo off
setlocal
cd /d "%~dp0"
set "MSVC=C:/Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207"
set "SDK=C:/Program Files (x86)\Windows Kits\10"
set "SDKVER=10.0.26100.0"
set "INCLUDE=%MSVC%\include;%SDK%\Include\%SDKVER%\ucrt;%SDK%\Include\%SDKVER%\shared;%SDK%\Include\%SDKVER%\um"
set "LIB=%MSVC%\lib\x64;%SDK%\Lib\%SDKVER%\ucrt\x64;%SDK%\Lib\%SDKVER%\um\x64"
set "PATH=%MSVC%\bin\Hostx64\x64;%PATH%"
if not exist obj mkdir obj
cl /nologo /O2 /W3 /LD wb_moments.c /Fe:bin\wb_moments_r8.dll /Fo:obj\ /link /IMPLIB:obj\r2.lib
if errorlevel 1 exit /b 1
cl /nologo /O2 /W3 wb_load.c /Fe:bin\wb_load.exe /Fo:obj\ /link psapi.lib
echo EXIT=%errorlevel%
