#[cfg(windows)]
mod windows {
    use std::backtrace::Backtrace;
    use std::env;
    use std::ffi::OsString;
    use std::fmt::Write as _;
    use std::fs::{self, OpenOptions};
    use std::io::Write as _;
    use std::os::windows::ffi::OsStringExt as _;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    use windows_sys::Win32::UI::Shell::{FOLDERID_Desktop, SHGetKnownFolderPath};
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    const LOG_DIR: &str = "com.drew.sillycat";
    const LOG_NAME: &str = "silly-cat.log";
    /// 出错弹窗时同时放到桌面上的日志副本，方便用户找到并发回来。正常启动不会往桌面写任何东西。
    const DESKTOP_LOG_NAME: &str = "捣蛋猫-错误日志.txt";
    const LOG_LIMIT: u64 = 256 * 1024;
    static READY: AtomicBool = AtomicBool::new(false);
    static LOG_LOCK: Mutex<()> = Mutex::new(());

    pub fn windows_version() -> Option<(u32, u32, u32)> {
        static VERSION: OnceLock<Option<(u32, u32, u32)>> = OnceLock::new();
        *VERSION.get_or_init(|| {
            let mut version = OSVERSIONINFOW {
                dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
                ..Default::default()
            };
            // SAFETY: version 是大小已初始化的可写 OSVERSIONINFOW。
            if unsafe { RtlGetVersion(&mut version) } != 0 {
                return None;
            }
            Some((
                version.dwMajorVersion,
                version.dwMinorVersion,
                version.dwBuildNumber,
            ))
        })
    }

    fn log_dir() -> Option<PathBuf> {
        let local = env::var_os("LOCALAPPDATA")?;
        if local.is_empty() {
            return None;
        }
        Some(PathBuf::from(local).join(LOG_DIR))
    }

    pub fn log(level: &str, message: &str) {
        let Some(dir) = log_dir() else { return };
        if fs::create_dir_all(&dir).is_err() {
            return;
        }
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs());
        let mut entry = String::new();
        for line in message.split_terminator('\n') {
            let _ = writeln!(entry, "{timestamp} {level} {line}");
        }

        let path = dir.join(LOG_NAME);
        // 崩溃时也尝试追加，但不能等另一个线程腾出日志锁。
        let lock = LOG_LOCK.try_lock().ok();
        if lock.is_some() && fs::metadata(&path).is_ok_and(|meta| meta.len() > LOG_LIMIT) {
            let _ = fs::rename(&path, path.with_extension("log.old"));
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = file.write_all(entry.as_bytes());
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16()
            .map(|unit| if unit == 0 { 0xfffd } else { unit })
            .chain(std::iter::once(0))
            .collect()
    }

    /// 系统当前用户的桌面目录。用已知文件夹接口取，跟随 OneDrive 等对桌面的重定向。
    fn desktop_dir() -> Option<PathBuf> {
        let mut raw: *mut u16 = std::ptr::null_mut();
        // SAFETY: 成功时 raw 指向以 NUL 结尾的宽字符串，读完后必须用 CoTaskMemFree 释放；失败时也可能要释放。
        unsafe {
            let result = SHGetKnownFolderPath(&FOLDERID_Desktop, 0, std::ptr::null_mut(), &mut raw);
            if raw.is_null() {
                return None;
            }
            let mut len = 0;
            while *raw.add(len) != 0 {
                len += 1;
            }
            let path = OsString::from_wide(std::slice::from_raw_parts(raw, len));
            CoTaskMemFree(raw.cast());
            (result >= 0 && len > 0).then(|| PathBuf::from(path))
        }
    }

    /// 把完整日志（读不到就用这次的错误信息）存一份到桌面，带 UTF-8 BOM：Win7 的记事本没有 BOM 会把中文显示成乱码。
    fn export_to_desktop(message: &str) -> Option<PathBuf> {
        let mut body = b"\xEF\xBB\xBF".to_vec();
        match log_dir().and_then(|dir| fs::read(dir.join(LOG_NAME)).ok()) {
            Some(log) if !log.is_empty() => body.extend_from_slice(&log),
            _ => body.extend_from_slice(message.as_bytes()),
        }
        let target = desktop_dir()?.join(DESKTOP_LOG_NAME);
        fs::write(&target, body).ok()?;
        Some(target)
    }

    fn show_error(message: &str) {
        let path = export_to_desktop(message)
            .or_else(|| log_dir().map(|dir| dir.join(LOG_NAME)))
            .map_or_else(
                || "%LOCALAPPDATA%\\com.drew.sillycat\\silly-cat.log（LOCALAPPDATA 未设置）".into(),
                |path| path.to_string_lossy().into_owned(),
            );
        let body = wide(&format!(
            "捣蛋猫没能启动，或者刚才崩溃了。\n\n原因：{message}\n\n日志文件：{path}\n\n请把这个日志发到你拿到安装包的地方（比如群里），或者 https://github.com/S0u1/silly-cat/issues。"
        ));
        let title = wide("捣蛋猫");
        // SAFETY: 两个字符串都以 NUL 结尾，在同步调用期间有效。
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                body.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }

    pub fn install() {
        let main_thread = std::thread::current().id();
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let thread = std::thread::current();
            let show_popup = thread.id() == main_thread || !READY.load(Ordering::Acquire);
            let name = thread.name().unwrap_or("未命名");
            let payload = info.payload();
            let message = if let Some(text) = payload.downcast_ref::<&str>() {
                *text
            } else if let Some(text) = payload.downcast_ref::<String>() {
                text.as_str()
            } else {
                "未知 panic 消息"
            };
            let location = info.location().map_or_else(
                || "未知位置".into(),
                |loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()),
            );
            let backtrace = Backtrace::force_capture();
            log(
                "ERROR",
                &format!("panic（线程 {name}，{location}）：{message}\n{backtrace}"),
            );
            if show_popup {
                show_error(message);
            }
            previous(info);
        }));
    }

    pub fn mark_ready() {
        READY.store(true, Ordering::Release);
    }

    pub fn fatal(message: &str) {
        log("ERROR", message);
        show_error(message);
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
mod noop {
    pub fn install() {}
    pub fn log(_level: &str, _message: &str) {}
    pub fn mark_ready() {}
    // 非 Windows 保留原有的 Tauri 启动错误处理。
    #[allow(dead_code)]
    pub fn fatal(_message: &str) {}
}

#[cfg(not(windows))]
pub use noop::*;
#[cfg(windows)]
pub use windows::*;
