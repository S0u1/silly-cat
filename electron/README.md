# SillyCat Electron 22 验证版

在已有依赖的 `electron/` 目录运行 `npm start`。窗口直接加载同仓库的 `prototype/index.html`，使用 Electron 自带的 Chromium。打包时页面目录和托盘 PNG 分别放在 `resources/prototype/` 和 `resources/tray.png`。安装包和 Win7 桌面合成效果需要在 Windows 上验收。

右键猫或使用托盘菜单可隐藏、显示、锁定、重置位置或打开日志目录。头部用于摸猫，解锁后按住身体可拖动。全局键鼠仅在 Windows 正常启动时启用。日志里只有累计事件数和钩子的启动状态。

## 垫片

沙箱 preload 在页面脚本执行前提供 `window.__TAURI__`。只开放固定的 IPC 通道，事件订阅返回可调用的取消函数。

| 能力 | 行为 |
| --- | --- |
| `platform_flags` | 返回 `{win7:false}`，页面使用透明样式 |
| `load_settings`、`save_settings`、`preview_cat_size` | 读写 JSON、广播设置、更改大小并固定右下角 |
| `cursor_local`、`position_locked`、`show_context_menu`、`input_status`、`app_version` | 返回光标 DIP 坐标、锁定状态、菜单关闭结果、钩子状态和计数、应用版本 |
| `setIgnoreCursorEvents`、`startDragging` | 点击穿透、拖动和位置记忆 |
| `held_input_state` | 拒绝，页面沿用 60 秒空闲释放逻辑 |
| `update_status`、`updater_configured` | 固定返回空闲状态和 false |
| `install_update` | 拒绝，提示 demo 不含自动更新 |
| `open_settings`、主窗口 `close()` | 成功返回，设置入口留日志 |
| `autostart_status`、`set_autostart`、`open_login_items`、`open_input_monitoring`、`reset_input_monitoring`、`restart_app`、`open_link` | 拒绝，提示 demo 未实现 |

页面事件为 `silly:key`、`silly:button`、`silly:settings`、`silly:lock`。更新事件仅保留订阅接口。Win7 上原生模块加载失败时猫仍可显示，钩子每两秒重试，最多再试五次。uiohook 提供转换后的键码，AltGr 合成 Ctrl、部分日韩键及非美式布局需按实际键盘核验。

## 自检与回传

运行 `npm run selftest`，或用 `npm run selftest -- --selftest-out "/path/to/output"` 指定输出目录。需要可用的桌面窗口服务。自检使用独立临时配置，注入合成输入，构造菜单并调用动作。终端会打印报告路径、各项结果和退出状态。源码自检读取依赖的 `libuiohook/include/uiohook.h` 并核对内置快照。安装包裁掉头文件时，自检使用同版本的键表快照。

输出含 `selftest.json`、透明原图 `capture-raw.png`、灰底及棋盘格合成图 `capture-gray.png` / `capture-checker.png` 和边框图 `capture-debug.png`。页面截图只能核对渲染输出的 alpha，Win7 桌面是否透出壁纸须单独目检。

正式启动的日志在 Windows 的 `%APPDATA%\SillyCatElectronDemo\demo.log`。启动失败可把该文件发回来。可分别尝试以下选项，改动后退出已有实例再启动。

- `SILLYCAT_DEBUG=1` 显示洋红和青色窗口边框，并每 10 秒在日志里记录一次钩子累计事件数（只有计数）。窗口不可聚焦，没有 DevTools 快捷键。
- `--disable-gpu` 或 `SILLYCAT_DISABLE_GPU=1` 关闭硬件加速，可用于比较白底和 GPU 崩溃问题。
- `SILLYCAT_NO_FORWARD=1` 切换为不传 forward 选项的鼠标穿透调用，用于比较 Win7 上的穿透与拖动松手。

## 打包与安装日志

`npm run dist` 在 `dist/` 出 NSIS 安装包 `SillyCatElectronDemo_win7_x64-setup.exe` 和免安装 `SillyCatElectronDemo_win7_x64.zip`（只出 x64：uiohook-napi 没有 ia32 预编译包）。配置在 `electron-builder.yml`：`signAndEditExecutable: false`，所以能在 macOS 上交叉构建、不需要 wine，代价是 exe 图标是默认的 Electron 图标；`prototype/` 和托盘图标用 `extraResources` 原样带进 `resources/`，不复制进仓库；zip 里额外带 `launchers/` 里的三个 `.bat` 和给测试者看的 `README.txt`。构建要联网下载 Electron 和 NSIS。

`build/installer.nsh` 给安装器加了安装阶段日志，写到 `%APPDATA%\SillyCatElectronDemo\install.log`（UTF-16LE，每次安装追加一段）：各阶段断点、系统版本（读 `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`）、安装器路径和命令行、安装目录，成功或失败时再转储安装器「详情」列表，失败时弹窗告诉用户日志位置。维护时注意：

- 模板没有 `.onInstSuccess` / `.onInstFailed` / `.onGUIEnd`，这里定义了它们；`.onUserAbort` 已被 MUI2 定义，改用 `MUI_CUSTOMFUNCTION_ABORT`。升级 electron-builder 后要重新核对，重复定义 makensis 会报错。
- 不要定义 `customCheckAppRunning`、`customUnInstallCheck`、`customWelcomePage`、`customFinishPage` 等宏：模板用 `!ifmacrodef` 判断，定义了就会替换自带逻辑。这里只用纯追加的 `preInit`、`customInit`、`customFiles_x64`、`customInstall`。
- 模板在非静默安装时对安装段执行 `SetDetailsPrint none`，详情列表里基本没有内容，所以才加了断点行。
- makensis 以 `-WX` 运行，任何警告都会让构建失败。
