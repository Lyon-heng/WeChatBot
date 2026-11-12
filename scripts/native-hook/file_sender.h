#pragma once
#include <cstdint>
#include <string>
namespace WeChatAgentFile {
    // Reviewed against the bundled 4.1.10.27 PE. See FILE_TRANSFER.md.
    inline constexpr uintptr_t Factory=0x1C4CE70;
    inline constexpr uintptr_t Constructor=0x18EEDC0;
    inline constexpr uintptr_t OwnerVtable=0x84F96B8;
    inline constexpr uintptr_t Vtable=0x84F9748;
    bool Ready();
    bool Send(const std::string& target,const std::string& path);
}
