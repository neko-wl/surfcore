# SnowLuma 一键启动连中四个坑（弹框 ×2、Electron 当 node、黑框）

> 2026-11-11 凌晨。用户报「surfcore 一键启动失败」→ 逐层拆出四个独立原因。

## 现象

- 用户原话：「surfcore一键启动失败」→「win11弹出你要打开此文件吗？snowluma起不来」
  →「还是有弹框」→「d:\snowluma\node.exe的黑框」。
- 复现步骤：设置 → SurfCore → 概览 → 一键启动（勾选 QQ），SnowLuma 未运行时。
- 影响面：SnowLuma 起不来 = QQ 网关不在 = 机器人整体离线。不丢数据，手动开
  `D:\SnowLuma\launcher.bat` 可恢复。
- 为什么今晚才暴露：`launchSnowLuma()` 第一件事是探 3000/3001，**在跑就返回「已在运行」**。
  SnowLuma 一直开着，所以「去启动」这条分支从来没被真正执行过。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH | Windows 11 / DSH 0.2.1-rc.5 |
| SurfCore | 0.9.0（含上游 0.8.9 合并） |
| 安装方式 | git（`D:\Nexus\surfcore`） |
| 其它 | SnowLuma 自带 node v24.22.1；PATH node 已换 v24.21.0 |

## 根因（四个，互相遮挡）

1. **「你要打开此文件吗？」弹框 #1** —— `D:\SnowLuma` 下 95 个文件里 82 个带
   Mark-of-the-Web（网络来源标记），含 `launcher.bat` / `node.exe`。后台非交互启动时没人点确认。
2. **弹框 #2 是 VBS** —— 隐藏黑框模式下会生成 `state/snowluma-launch.vbs` 并用
   `explorer.exe` 打开，Windows 对脚本弹确认框。
3. **Electron 当 node** —— `spawnSnowLumaDetached` 和 legacy+隐藏分支都用
   `process.execPath`。DSH 宿主是 Electron，它指向 `DeepSeek Harness.exe`，
   拿它跑 `index.mjs` 等于让 Electron 当 node，静默失败。
4. **黑框** —— 父进程用 `windowsHide` 创建（完全没有控制台）。SnowLuma 自己再 spawn
   子进程时，Windows 会为子进程分配**可见**的新控制台。实测：父 13232 窗口=0，
   子 8488 窗口=1508824。

## 完整逻辑

- **链路**：`plugins/surfcore/lib/index.js` → `launchSnowLuma()` → `resolveSnowLumaLauncher()`
  → `spawnSnowLumaDetached()` → 写 `state/snowluma-launch.vbs` → 执行器 → `WScript.Shell.Run(node.exe entry, 0, False)`。
  读这个文件的只有本插件；VBS 是一次性生成物。
- **机制**：两个 Windows 契约被踩中——
  ① 带 MOTW 的可执行/脚本由程序拉起时会要求确认（不是 UAC，是附件管理器）；
  ② 控制台程序的子进程：父无控制台 → Windows 分配新可见控制台；父有隐藏控制台 → 继承。
- **爆炸半径**：1 个进程（SnowLuma 启动）× 1 个读者 × 静默失败 3 分 = 3。不碰用户数据/密钥/花钱。
- **取舍**：
  A. 继续用 `windowsHide` 直接 spawn node —— 简单，但黑框无解（契约限制）。
  B. VBS + `wscript.exe` + `window style 0` —— 多一层 VBS，但「隐藏控制台」可被继承，且不弹框。
  选 B：A 已证明做不到。
- **生效与重启**：插件代码由 DSH 宿主加载，**必须重启 DSH** 才生效；改配置即时生效。

## 修法

两次提交（都已进 `dev`）：

1. `82864b0`（合并 `1aa0d8f`）——新增 `resolveSnowLumaNode()`：
   `snowluma.nodePath` → SnowLuma 自带 `node.exe` → 宿主本身是 node 时用 execPath → 空（回落 launcher.bat）。
   同时收窄 `nodePathEnv()`：只有 execPath 真是 node 才塞进 PATH。
2. `3926076`（合并 `f58e089`）——VBS 改由 `wscript.exe` 执行（不再 explorer）；
   legacy+隐藏黑框分支也改走 `spawnSnowLumaDetached`，不再直接 spawn node。

回滚：`git revert f58e089 1aa0d8f`；配置侧可把 `snowluma.launchMode` 设回 `legacy`、
`platforms.hideConsoles` 设 `false`（会闪黑框但能用）。

## 验证

```powershell
# 1) 进程与窗口（关键：子进程窗口必须是 0）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*SnowLuma*' } |
  ForEach-Object { $p = Get-Process -Id $_.ProcessId; "$($_.ProcessId) 窗口=$($p.MainWindowHandle)" }
# 实测：13264 窗口=0；884（子）窗口=0
# 对照（修前）：13232 窗口=0；8488（子）窗口=1508824 ← 黑框

# 2) 端口
Get-NetTCPConnection -LocalPort 3000,3001 -State Listen

# 3) 无 MOTW
Get-ChildItem D:\SnowLuma -Recurse -File | ForEach-Object {
  Get-Item $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue }
# 期望：无输出
```

对照实验（证明 wscript+style 0 有效）：同一 node 命令，
`windowsHide` 起的父进程其子进程窗口 1508824；`wscript` style 0 起的父进程其子进程窗口 0。

## 残余

- `D:\SnowLuma` 里**以后新放进去的下载文件**会重新带 MOTW，需要再跑一次
  `Get-ChildItem D:\SnowLuma -Recurse -File | Unblock-File`。
- 本机 `node v22.23.4` 的 `fs.cpSync` 会让进程直接崩（`0xC0000409`），已换 v24.21.0；
  旧目录改名 `node-v22.23.4-BROKEN-cpSync-20261111` 留在原地。
- 结论里「一键启动成功」只在真机手动点过验证，未做自动化。
