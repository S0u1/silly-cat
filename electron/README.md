# 捣蛋猫 兼容版

供原版装不上或缺少 WebView2 的 Windows x64 电脑使用。兼容版使用 Electron 22.3.27 自带的 Chromium。安装包按当前用户安装，zip 解压后可直接运行 SillyCatElectronDemo.exe。桌面和开始菜单显示「捣蛋猫 兼容版」。

## 使用与排查

点托盘图标或右键猫可以打开设置、检查更新、切换显示、锁定或重置位置、打开日志文件夹和退出。按住身体可拖动，按住头部可摸猫。Windows 7 使用 Aero 时显示透明窗口，关闭桌面合成时使用卡片背景。

设置、窗口位置和锁定状态保存在原来的 `%APPDATA%\SillyCatElectronDemo\`。这个文件夹也保存运行日志 `silly-cat.log` 和安装日志 `install.log`。运行日志超过 256 KiB 后，下次追加时轮换为 `silly-cat.log.old`。致命运行错误会把当前日志复制到桌面「捣蛋猫兼容版-错误日志.txt」，安装失败会生成「捣蛋猫兼容版-安装日志.txt」。桌面不可写时按弹窗提示从日志文件夹获取。调试启动脚本的用法见随包 README.txt。

## 开发和验收

在本目录执行 `npm ci`、`npm run selftest`、`npm run dist`。自测需可用的桌面窗口服务、回环网络及项目的 Tauri CLI。页面直接加载同仓库的 prototype 资源，preload 提供其使用的 Tauri 接口。macOS 可开发和交叉打包，真实系统键鼠、合成、登录项及安装升级流程须在 Windows 上验收。自测使用临时配置和模拟的系统操作。`npm run selftest -- --selftest-out /path/to/output` 可指定窗口自测报告及截图的输出目录。

macOS 上运行 dist 时，准备脚本按 package-lock.json 的版本和 SHA-512 完整性值补齐 Koffi 的 Windows x64 预编译模块。

构建输出位于 dist/，包含当前用户 NSIS 安装包和免安装 zip。产品内部标识和默认目录与之前的 Electron 安装一致。NSIS 模板读取已有安装位置，没有比较新旧产品版本号的降级拦截。安装脚本保留模板的进程检查、卸载和结束页逻辑。

## 发布签名与更新清单

1. 将 package.json 和锁文件中的应用版本对齐原版 tauri.conf.json。运行自测和构建。
2. 使用原版对应的私钥，在安全的发布环境执行 `tauri signer sign --private-key-path <私钥文件> --app-version <版本> dist/SillyCat_<版本>_electron_x64-setup.exe`。保留生成的 .sig。签名中的受信版本号必须和清单完全相同。
3. 执行 `node tools/make-electron-manifest.mjs <版本> <标签> SillyCat_<版本>_electron_x64-setup.exe dist/SillyCat_<版本>_electron_x64-setup.exe.sig dist/latest-electron.json`。版本和标签分别填写，例如 0.0.7 与 v0.0.7。
4. 在同一 GitHub Release 上传安装包、latest-electron.json 和供手动下载的 zip。自动更新从 releases/latest/download/latest-electron.json 获取 windows-x86_64 安装包，并在启动安装器前核对签名和版本。
