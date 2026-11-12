#define WIN32_LEAN_AND_MEAN
#define CPPHTTPLIB_WIN32
#include <Windows.h>
#include <cstdio>
#include <cwchar>
#include <stdexcept>
#include "httplib.h"
#include "global.h"
#include "http_server.h"
#include "deferred_init.h"
HMODULE g_hModule=nullptr;
int g_StartPort=0;
static const wchar_t* mode=nullptr;
static volatile LONG calls=0;
void RegisterRoutes(httplib::Server& server){
    if(wcscmp(mode,L"routes")==0)throw std::runtime_error("fixture route registration failure");
    server.Get("/fixture",[](const httplib::Request&,httplib::Response& response){response.set_content("fixture","text/plain");});
}
void CustomInit(HMODULE){
    InterlockedIncrement(&calls);
    if(wcscmp(mode,L"cpp")==0){WeChatAgentInitStage("test_cpp");throw std::runtime_error("fixture cpp failure");}
    if(wcscmp(mode,L"seh")==0){WeChatAgentInitStage("test_seh");RaiseException(EXCEPTION_ACCESS_VIOLATION,0,0,nullptr);}
    g_httpServer=new HttpServer();g_httpServer->Start("127.0.0.1",g_StartPort);
}
int wmain(int argc,wchar_t** argv){
    if(argc!=4)return 2;mode=argv[1];g_StartPort=_wtoi(argv[2]);g_hModule=GetModuleHandleW(nullptr);
    const bool delayed=wcscmp(mode,L"delay")==0;
    if(!delayed&&!LoadLibraryW(argv[3]))return 3;
    ScheduleWeChatAgentInit(g_hModule);ScheduleWeChatAgentInit(g_hModule);
    if(delayed){Sleep(100);if(!LoadLibraryW(argv[3]))return 4;}
    const auto started=GetTickCount64();
    while(GetTickCount64()-started<5000){const char* value=WeChatAgentInitState();if(strcmp(value,"ready")==0||strcmp(value,"failed")==0)break;Sleep(10);}
    printf("%s %ld\n",WeChatAgentInitState(),calls);fflush(stdout);getchar();
    CancelWeChatAgentInit();if(g_httpServer){g_httpServer->Stop();delete g_httpServer;g_httpServer=nullptr;}
    return 0;
}
