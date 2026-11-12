# GitHub 源码与 Release 发布

当前仓库地址为 Lyon-heng/WeChatBot，默认分支 main。仓库现按维护者要求公开；0.5.1 为历史基线，此后按普通版本迭代保留历史；上传前仍需核对实际访问范围，所有提交和附件均排除用户数据。普通版本更新保留提交、标签、Issues 和 PR，不重用以前的清空授权。

## 顺序

1. 按[发行流程](RELEASE_WORKFLOW.md)核对实际变更，创建 docs/releases/<版本>.md，并更新根更新日志。
2. 统一版本后构建，隔离验收并检查归档排除。不能把文档修订当作已完成打包。
3. 检查完整差异、凭据边界、许可证和 git diff --check。
4. 核对远端变更，提交源码和日志，推送 main；本地分支名称可能不同，先检查。
5. 在已验证提交创建同版本标签及 Release，上传对应附件，发布后再核对名称、大小和校验值。

## 命令示例

以下是 0.5.4 **完成构建后**的示例，需要本机 GitHub CLI 已安装并有写入权限。附件位于源码仓库外的发行目录，不能照抄旧版相对路径。遇到同名标签先检查归属，不覆盖已有版本。

```powershell
$releaseVersion = '0.5.4'
$releaseTag = "v$releaseVersion"
$releaseOutput = '<输出目录>\artifacts-0.5.4'
git fetch origin
git status --short --branch
git diff --check
# 完整审查并提交后：
git push origin HEAD:main
git tag $releaseTag
git push origin $releaseTag
$releaseAssets = @(
  "$releaseOutput\WeChatBot-Setup-$releaseVersion-x64.exe",
  "$releaseOutput\WeChatBot-$releaseVersion-portable-x64.zip",
  "$releaseOutput\WeChatBot-voice-components.zip",
  "$releaseOutput\SHA256SUMS.txt",
  "$releaseOutput\VERIFICATION.json"
)
gh release create $releaseTag --repo Lyon-heng/WeChatBot --verify-tag --title "WeChatBot $releaseVersion" --notes-file "docs/releases/$releaseVersion.md" $releaseAssets
```

可选语音附件只有实际构建成功时才列入上传。安装器、便携包和大型组件不放 Git 源码历史。上传后重新核对远端附件哈希；尚未执行的检查不能写成通过，不把 VERIFICATION.json 的基础元数据自动当作完整验收报告。
