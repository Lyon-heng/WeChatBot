# 发布朋友圈的调用链（4.1.10.27，动态栈采样得到）

## 方法

1. `moments-sampler.dll` 注入微信主进程，10ms 周期挂起线程、抓栈、恢复（不改代码、不改页面属性）。
2. 先把空闲状态采一遍得到基线（26 个不同栈）。
3. 用户在电脑端发一条朋友圈，同一进程再采一遍（52 个栈）。
4. 与基线做差集得到 25 个新栈；再对栈内每个函数扫描字符串引用，找 `SnsPublishPanel`。

## 结果：一条完整且只出现一次的调用链

```
hits=1  depth=16  tid=27868

0xBC5170                      （不在函数表，可能是回调桩）
0x274BD9   函数 0x274BC0  +0x19  (0x39)
0x509AE4   函数 0x509A80  +0x64  (0x174)
0x1A90A25  函数 0x1A908E0 +0x145 (0x171)
0x320C974  函数 0x320C6D0 +0x2A4 (0x47D)
0x3EDD36E  函数 0x3EDD200 +0x16E (0xD41)
0x3EDCF61  函数 0x3EDCD10 +0x251 (0x385)   ← 引用 SnsPublishPanel_%d
0x3EBABF7  函数 0x3EBA9C0 +0x237 (0x359)   ← 引用 SnsPublishPanel
0x1CBD6E0  函数 0x1CBD4F0 +0x1F0 (0x369)
0x25AA0B   函数 0x25A9E0  +0x2B  (0x96)
0x25C109   函数 0x25BE00  +0x309 (0x373)
0x5171DD   函数 0x5163F0  +0xDED (0xE21)
0x5F9E00   函数 0x5F9D00  +0x100 (0x10E)
0x5FB28A   函数 0x5FB070  +0x21A (0x22F8)
0x1705A0   函数 0x170410  +0x190 (0x213)
0x146EE4   函数 0x146E50  +0x94  (0xC5)
```

由外向内读：消息循环与任务派发（0x146E50 → 0x170410 → 0x5FB070 → 0x5F9D00 → 0x5163F0 →
0x25BE00 → 0x25A9E0 → 0x1CBD4F0）→ **发布面板**（0x3EBA9C0 / 0x3EDCD10）→ 0x3EDD200 →
0x320C6D0 → 0x1A908E0 → 0x509A80。

## 已知与推断

- `0x3EBA9C0` 与 `0x3EDCD10` 是仅有的两个引用 `SnsPublishPanel` 字样的函数；采样里各出现一次，
  与“用户点发送”这种一次性动作吻合。
- 真正的网络发送不在这一栈里：另有一组高命中栈落在 `mars::comm::SocketSelect`（0x48C8710）与
  `IOPoller::Poll`（0x6487900），那是腾讯自研网络库 mars 的常驻线程——发布请求是异步投给它的。
- 下一步：在发布面板往下的几层（0x3EDD200、0x320C6D0、0x1A908E0、0x509A80）里找“构造 SNS
  protobuf 并投递给 mars”的调用点。

## 复现方式

```bash
node tools/sample-run.mjs start     # 开始采样（180 秒窗口）
# 此时在电脑端发一条朋友圈
node tools/sample-run.mjs stop      # 停止并导出到 %TEMP%\wechatwb-moments-samples.txt
```

分析时与 `build/baseline-idle.txt` 做差集，再按 SNS 关键字筛选函数。

## 追加：网络层是静态链接的 mars

- 微信 4.1.10.27 的 `Weixin.dll` 里内置了腾讯自研网络库 mars（字符串可见
  `mars::stn::ShortLinkTaskManager::__RunOnStartTask`、`mars::stn::LongLink::__Run`、
  `mars::comm::SocketSelect`、`IOPoller::Poll`，源码路径泄漏为
  `E:/xwechat/agent/workspace/mars_win_llvm_2/mars-wechat/mars/...`）。
- 因此不需要跨模块调用：SNS 请求最终走 `mars::stn` 的任务队列，调用点在同一个 DLL 内。
- 相关地址（尚未验证用途，仅供下一步使用）：
  - `0x47CC770` `ShortLinkTaskManager::__RunOnStartTask`
  - `0x4781450` `ShortLink::__Run`
  - `0x47AB970` `LongLink::__Run`
- 采样的 52 个栈里没有一条经过上述任务函数：说明提交任务的时刻极短（微秒级），
  采样抓不到。要拿到这一步，必须换成**在函数入口页布防**（守卫页命中即抓栈），
  或对任务提交函数做内联钩子——两者都比采样激进。

## 已确认的边界

- 静态：字符串零引用、无 RTTI、导入表只有 KERNEL32 → 无法靠静态定位。
- 动态（采样）：能确认“发布面板被打开”，抓不到“请求被构造与提交”。
- 下一步必须二选一：入口页布防（不改代码，但会命中任意任务，需要多轮筛选）
  或内联钩子（精确但改代码，风险高）。
