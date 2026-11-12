// 4.1.10.27 的常量表。
// 规则：**未验证的常量一律写 0**。组件会检查 0，然后拒绝执行原生调用并如实报告，
// 绝不出现“猜一个地址试试”——猜错的代价是微信进程崩溃。
#ifndef WM_PROFILE_H
#define WM_PROFILE_H

// 目标核心：微信 4.1.10.27（本应用 Hook 使用的那一份）
#define WM_WECHAT_VERSION "4.1.10.27"
#define WM_CORE_SHA256 "f487e4f56930456a25fb0d7b058c77e2dcd364e268d49bdfff4dc0e3be26ba36"

// ---- 已确认的事实（只读静态扫描得到，与常量无关） ----
// /cgi-bin/micromsg-bin/mmsnspost 字符串位于 RVA 0x8B5DA6C，但代码不直接引用它
// （小鱼是自己把 endpoint 字符串传进参数结构），因此字符串本身不参与定位。
#define WM_CGI_MMSNSPOST "/cgi-bin/micromsg-bin/mmsnspost"
#define WM_CGI_MMSNSOBJECTDETAIL "/cgi-bin/micromsg-bin/mmsnsobjectdetail"
#define WM_CGI_ID_POST 209
#define WM_CGI_ID_DETAIL 210

// ---- 待定位（RVAs，全部相对 Weixin.dll 模块基址） ----
// 定位方法见 README 与 analyze.py；确认一个填一个，填之前保持 0。
#define WM_POST_INFO 0x0ULL
#define WM_POST_CTOR 0x0ULL
#define WM_POST_VTABLE 0x0ULL
#define WM_DETAIL_INFO 0x0ULL
#define WM_DETAIL_CTOR 0x0ULL
#define WM_DETAIL_VTABLE 0x0ULL
#define WM_ROOT_GLOBAL 0x0ULL
#define WM_MANAGER_VTABLE 0x0ULL
#define WM_MANAGER_DISPATCH 0x0ULL
#define WM_ALLOCATE 0x0ULL
#define WM_PROTO_PARSE 0x0ULL
#define WM_HOLDER_DATA 0x0ULL
#define WM_HOLDER_SIZE 0x0ULL

// 与 xiaoyu 的 4.2.0.13 验证过的相对关系（供定位时参照，不是可用地址）：
//   manager = *(void**)*(root + 0x2c8)，root = *(void**)(core + ROOT_GLOBAL)
//   post  参数对象大小 0x270，detail 对象 0xf0
//   info 块前 16 字节从 core+*_INFO 拷贝，随后写 CGI 号(4)、endpoint 指针(8)、
//   endpoint 长度(8)、63(8)、info[56]=1
#define WM_POST_OBJECT_SIZE 0x270
#define WM_DETAIL_OBJECT_SIZE 0x0f0
#define WM_MANAGER_ROOT_OFFSET 0x2c8

// 全部常量是否就绪
#define WM_READY() (WM_POST_INFO && WM_POST_CTOR && WM_POST_VTABLE && WM_ROOT_GLOBAL && \
                    WM_MANAGER_VTABLE && WM_MANAGER_DISPATCH && WM_ALLOCATE && \
                    WM_PROTO_PARSE && WM_HOLDER_DATA && WM_HOLDER_SIZE)

#endif
