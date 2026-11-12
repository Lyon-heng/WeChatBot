# 网易云登录与音源检查

音乐页把“检索歌曲”“保存登录”“读取音源”分别显示。搜索结果不证明音源可用，手机授权不证明程序收到并保存凭据；以页面检查结果为准。

## 登录

可使用页面二维码，扫码后在手机确认。后台处理等待、确认、授权回执和凭据保存，刷新不等于取消扫码。临时网络错误保留流程并显示阶段，二维码过期后重新生成。

若授权后仍未登录，可展开其他登录选项，使用桌面版“官方窗口登录”。用户直接在独立网易云官方窗口完成登录或验证；程序接收该会话凭据，不导入其他浏览器会话、不代解验证码。尚未保存凭据时，“检查登录”不会取消正在进行的扫码。

凭据仅由后台接收并用 Windows 当前账户 DPAPI 加密，不回传前端、不交给模型、不进入源码或发行包。换 Windows 账户或直接搬移加密文件不保证能解密，应重新登录。

## 搜得到但不能制作

搜索结果点击“检查音源”，核对歌曲 ID、歌手、版本及账号权限。系统区分未登录、仅试听、无完整音源和平台错误。别名帮助匹配歌手，但不把现场、翻唱或其他版本自动替换成原版。

会员、地区、下架及平台限制均可能使歌曲不可读。例如邓紫棋《泡沫》能搜到，不代表匿名用户或任意登录账号能取得完整音源。项目不使用共享 Cookie、不解锁付费音源、不绕过风控或验证码。

登录不会自动开始制作或发送。歌曲制作、混音和缓存见[声音工作室](VOICE_STUDIO.md)。

## 维护入口

账号服务位于 `packages/netease/`，官方窗口在 `scripts/netease-login-window.cjs`，桌面接入在 `desktop/main.cjs`。二维码回执保留原始 Set-Cookie 并合并凭据；音源优先使用新版标准音质接口。

实现参考：[api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)、[Netease_url](https://github.com/Suxiaoqinx/Netease_url)、[Music Assistant 网易云接入](https://www.music-assistant.io/music-providers/netease-cloud-music/)。参考项目的完整能力不代表本项目均已接入。

回归：`node --test scripts/test-netease-account.mjs scripts/test-netease-song-link.mjs`。模拟检查不替代真实账号登录和歌曲权限验收。
