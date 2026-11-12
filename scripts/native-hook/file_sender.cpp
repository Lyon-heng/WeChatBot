#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <cstdint>
#include <filesystem>
#include <string>
#include "global.h"
#include "file_sender.h"
namespace WeixinSend {struct InnerStruct2;InnerStruct2* BuildSendParam1(uint64_t);void BuildSendParam2_Image(uint64_t*);}
namespace WeChatAgentFile {
bool Ready(){
    auto module=GetModuleHandleW(L"Weixin.dll");if(!module)return false;
    const auto base=reinterpret_cast<uintptr_t>(module);
    const auto* dos=reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
    const auto* pe=reinterpret_cast<const IMAGE_NT_HEADERS64*>(base+dos->e_lfanew);
    auto executable=[base,pe](uintptr_t rva){if(rva>=pe->OptionalHeader.SizeOfImage)return false;MEMORY_BASIC_INFORMATION info{};return VirtualQuery(reinterpret_cast<void*>(base+rva),&info,sizeof(info))&&info.State==MEM_COMMIT&&(info.Protect&(PAGE_EXECUTE|PAGE_EXECUTE_READ|PAGE_EXECUTE_READWRITE|PAGE_EXECUTE_WRITECOPY));};
    if(!executable(Factory)||!executable(Constructor)||!executable(offset::send_message)||!executable(offset::create_param2))return false;
    for(auto rva:{OwnerVtable,Vtable}){if(rva+8>=pe->OptionalHeader.SizeOfImage)return false;MEMORY_BASIC_INFORMATION info{};if(!VirtualQuery(reinterpret_cast<void*>(base+rva),&info,sizeof(info))||info.State!=MEM_COMMIT||(info.Protect&(PAGE_NOACCESS|PAGE_GUARD)))return false;const auto address=*reinterpret_cast<uintptr_t*>(base+rva);if(address<base||!executable(address-base))return false;}
    // Reject another layout even if its advertised version was preserved.
    const unsigned char prologue[]={0x55,0x41,0x56,0x56,0x57,0x53};
    return memcmp(reinterpret_cast<void*>(base+Factory),prologue,sizeof(prologue))==0;
}
bool Send(const std::string& target,const std::string& path){
    if(!Ready())return false;const auto base=reinterpret_cast<uintptr_t>(GetModuleHandleW(L"Weixin.dll"));
    struct Shared {uintptr_t body,owner;};Shared value{};
    using Create=Shared*(*)(Shared*);reinterpret_cast<Create>(base+Factory)(&value);
    if(!value.body||value.body!=value.owner+0x10||*reinterpret_cast<uintptr_t*>(value.owner)!=base+OwnerVtable||*reinterpret_cast<uintptr_t*>(value.body)!=base+Vtable)return false;
    const int count=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,path.data(),static_cast<int>(path.size()),nullptr,0);if(count<=0)return false;
    std::wstring wide(count,L'\0');if(MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,path.data(),static_cast<int>(path.size()),wide.data(),count)!=count)return false;
    const std::filesystem::path local(wide);const auto filename=local.filename().u8string();
    // Fields shared by native outgoing appmsg objects, initialized by the
    // real constructor. This is the file class, never the emoji/image class.
    *reinterpret_cast<std::string*>(value.body+0xB0)=target;
    *reinterpret_cast<std::wstring*>(value.body+0xE0)=wide;
    *reinterpret_cast<uint32_t*>(value.body+0xD8)=49;
    *reinterpret_cast<uint32_t*>(value.body+0xDC)=6;
    *reinterpret_cast<std::string*>(value.body+0x168)=std::string(reinterpret_cast<const char*>(filename.data()),filename.size());
    *reinterpret_cast<uint64_t*>(value.body+0x188)=std::filesystem::file_size(local);
    auto first=WeixinSend::BuildSendParam1(value.owner);auto second=static_cast<uint64_t*>(HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,0xE8));if(!first||!second)return false;
    WeixinSend::BuildSendParam2_Image(second);using Dispatch=__int64(*)(uint64_t,uint64_t);
    reinterpret_cast<Dispatch>(base+offset::send_message)(reinterpret_cast<uint64_t>(first),reinterpret_cast<uint64_t>(second));
    return true; // The reader, not native acceptance, confirms delivery.
}
}
