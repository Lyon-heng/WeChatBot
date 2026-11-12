@echo off
rem 构建朋友圈探针 DLL。需先装 Visual Studio Build Tools（含 MSVC x64 与 Windows SDK）。
rem 若 wbprobe.dll 正被微信加载，请先完全退出微信再构建，或改用 build_probe.bat wbprobe_new.dll
setlocal
set "VC=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207"
set "SDK=C:\Program Files (x86)\Windows Kits\10"
set "SDKV=10.0.26100.0"
set "PATH=%VC%\bin\Hostx64\x64;%PATH%"
set "INCLUDE=%VC%\include;%SDK%\Include\%SDKV%\ucrt;%SDK%\Include\%SDKV%\um;%SDK%\Include\%SDKV%\shared;%SDK%\Include\%SDKV%\winrt"
set "LIB=%VC%\lib\x64;%SDK%\Lib\%SDKV%\ucrt\x64;%SDK%\Lib\%SDKV%\um\x64"
set "ROOT=%~dp0..\.."
set "MH=%ROOT%\components\WeChat-Hook\minhook"
set "OUT=%~1"
if "%OUT%"=="" set "OUT=wbprobe.dll"
cd /d "%~dp0"
cl /nologo /LD /O2 /W3 /I"%MH%\include" probe.c "%MH%\src\trampoline.c" "%MH%\src\hook.c" "%MH%\src\buffer.c" "%MH%\src\hde\hde64.c" /Fe:%OUT%
