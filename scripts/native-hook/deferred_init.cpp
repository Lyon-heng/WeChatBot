#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <eh.h>
#include <exception>
#include <system_error>
#include "deferred_init.h"
#include "version_proxy.h"
#include "global.h"
#include "http_server.h"

static void PersistLine(const char* line) noexcept;

namespace {
volatile LONG state=0,cancelled=0,reportedLogError=0;
PVOID volatile currentStage=const_cast<char*>("scheduled");
SRWLOCK logLock=SRWLOCK_INIT;
constexpr DWORD warningMs=30000;
struct NativeFault { unsigned int code; void* address; };
void __cdecl TranslateFault(unsigned int code,EXCEPTION_POINTERS* info){throw NativeFault{code,info&&info->ExceptionRecord?info->ExceptionRecord->ExceptionAddress:nullptr};}
const char* Stage() noexcept {return static_cast<const char*>(InterlockedCompareExchangePointer(&currentStage,nullptr,nullptr));}
void ExceptionLog(const char* kind,unsigned long code,const void* address,const char* message) noexcept {
    char line[1024],text[384]{};
    if(message)for(size_t i=0;i<sizeof(text)-1&&message[i];++i){const auto c=static_cast<unsigned char>(message[i]);text[i]=c<32||c==127?' ':static_cast<char>(c);}
    HMODULE owner=nullptr;wchar_t module[32768]{};char moduleName[260]="unknown";unsigned long long offset=0;
    if(address&&GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,reinterpret_cast<LPCWSTR>(address),&owner)){
        GetModuleFileNameW(owner,module,_countof(module));const wchar_t* name=wcsrchr(module,L'\\');name=name?name+1:module;
        WideCharToMultiByte(CP_UTF8,0,name,-1,moduleName,sizeof(moduleName),nullptr,nullptr);
        offset=reinterpret_cast<ULONG_PTR>(address)-reinterpret_cast<ULONG_PTR>(owner);
    }
    sprintf_s(line,"[WeChatAgent] pid=%lu exception=%s stage=%s code=0x%08lX module=%s offset=0x%llX message=%s\n",GetCurrentProcessId(),kind,Stage(),code,moduleName,offset,text);
    OutputDebugStringA(line);PersistLine(line);WeChatAgentInitLog("initialization_exception",code);
}
DWORD WINAPI Initialize(LPVOID module){
    WeChatAgentInitStage("worker_enter");HMODULE own=nullptr;
    if(!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_PIN,reinterpret_cast<LPCWSTR>(&ScheduleWeChatAgentInit),&own)){
        const DWORD code=GetLastError();InterlockedExchange(&state,4);WeChatAgentInitLog("module_pin_failed",code);return 0;
    }
    const auto started=GetTickCount64();WeChatAgentInitStage("waiting_for_weixin_dll");HMODULE core=nullptr;bool delayed=false;
    while(!InterlockedCompareExchange(&cancelled,0,0)){
        if(GetModuleHandleExW(0,L"Weixin.dll",&core))break;
        if(!delayed&&GetTickCount64()-started>=warningMs){delayed=true;WeChatAgentInitLog("module_wait_delayed",warningMs);}
        Sleep(delayed?250:50);
    }
    if(InterlockedCompareExchange(&cancelled,0,0)){
        if(core)FreeLibrary(core);InterlockedExchange(&state,5);WeChatAgentInitLog("initialization_cancelled");return 0;
    }
    WeChatAgentInitLog("weixin_dll_ready",static_cast<DWORD>(GetTickCount64()-started));InterlockedExchange(&state,2);
    // Only this initialization worker translates SEH; other host threads are untouched.
    const auto previous=_set_se_translator(TranslateFault);
    try{
        WeChatAgentInitStage("custom_init_enter");CustomInit(static_cast<HMODULE>(module));WeChatAgentInitStage("custom_init_returned");
        const bool ready=g_httpServer&&g_httpServer->IsRunning();InterlockedExchange(&state,ready?3:4);
        WeChatAgentInitLog(ready?"initialization_ready":"initialization_failed",g_StartPort);
    }catch(const NativeFault& fault){InterlockedExchange(&state,4);ExceptionLog("seh",fault.code,fault.address,nullptr);}
     catch(const std::system_error& error){InterlockedExchange(&state,4);ExceptionLog("system_error",static_cast<unsigned long>(error.code().value()),nullptr,error.what());}
     catch(const std::exception& error){InterlockedExchange(&state,4);ExceptionLog("cpp",0,nullptr,error.what());}
     catch(...){InterlockedExchange(&state,4);ExceptionLog("unknown",0,nullptr,nullptr);}
    _set_se_translator(previous);
    // Never reinstall partially applied hooks. Recovery requires a new process.
    return 0;
}
}

void ScheduleWeChatAgentInit(HMODULE module){
    if(InterlockedCompareExchange(&state,1,0)!=0)return;
    HANDLE thread=CreateThread(nullptr,0,Initialize,module,0,nullptr);
    if(thread)CloseHandle(thread);
    else{const DWORD code=GetLastError();InterlockedExchange(&state,4);char line[160];sprintf_s(line,"[WeChatAgent] initialization worker creation failed code=%lu\n",code);OutputDebugStringA(line);}
}
void CancelWeChatAgentInit(){InterlockedExchange(&cancelled,1);}
const char* WeChatAgentInitState(){
    switch(InterlockedCompareExchange(&state,0,0)){
    case 0:return "idle";case 1:return "waiting_for_module";case 2:return "initializing";case 3:return "ready";case 5:return "cancelled";default:return "failed";
    }
}
void WeChatAgentInitStage(const char* stage) noexcept {InterlockedExchangePointer(&currentStage,const_cast<char*>(stage));WeChatAgentInitLog(stage);}
void WeChatAgentInitLog(const char* stage,unsigned long detail) noexcept {
    char line[280];SYSTEMTIME time{};GetLocalTime(&time);
    sprintf_s(line,"[WeChatAgent] %04u-%02u-%02u %02u:%02u:%02u pid=%lu stage=%s detail=%lu\n",time.wYear,time.wMonth,time.wDay,time.wHour,time.wMinute,time.wSecond,GetCurrentProcessId(),stage,detail);
    OutputDebugStringA(line);
    PersistLine(line);
}

static void PersistLine(const char* line) noexcept {
    // Win32 logging avoids the same C++ mutex/runtime failure being diagnosed.
    wchar_t filename[32768]{};DWORD error=0;const DWORD size=GetModuleFileNameW(g_hModule,filename,_countof(filename));
    if(!size||size>=_countof(filename))error=GetLastError();
    else{
        bool valid=true;for(int i=0;i<3;++i){auto slash=wcsrchr(filename,L'\\');if(!slash){valid=false;break;}*slash=L'\0';}
        if(!valid)error=ERROR_BAD_PATHNAME;
        else if(wcscat_s(filename,L"\\logs")!=0)error=ERROR_BUFFER_OVERFLOW;
        else if(!CreateDirectoryW(filename,nullptr)&&GetLastError()!=ERROR_ALREADY_EXISTS)error=GetLastError();
        else if(wcscat_s(filename,L"\\hook-init.log")!=0)error=ERROR_BUFFER_OVERFLOW;
        else{
            AcquireSRWLockExclusive(&logLock);
            HANDLE file=CreateFileW(filename,FILE_APPEND_DATA,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);
            if(file==INVALID_HANDLE_VALUE)error=GetLastError();
            else{DWORD written=0;const DWORD length=static_cast<DWORD>(strlen(line));if(!WriteFile(file,line,length,&written,nullptr))error=GetLastError();else if(written!=length)error=ERROR_WRITE_FAULT;CloseHandle(file);}
            ReleaseSRWLockExclusive(&logLock);
        }
    }
    if(error&&InterlockedCompareExchange(&reportedLogError,1,0)==0){char failure[160];sprintf_s(failure,"[WeChatAgent] pid=%lu stage=log_write_failed detail=%lu\n",GetCurrentProcessId(),error);OutputDebugStringA(failure);}
}
