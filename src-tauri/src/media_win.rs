// WASAPI only exposes scalar levels here. All COM objects stay on the creating thread.
use std::{ffi::c_void, ptr};

type Raw = *mut c_void;
type Hr = i32;
type Result<T> = std::result::Result<T, Hr>;
const CLSCTX_ALL: u32 = 23;
const EXCLUDED: &[&str] = &[
    "wechat.exe",
    "weixin.exe",
    "qq.exe",
    "wemeetapp.exe",
    "dingtalk.exe",
    "feishu.exe",
    "lark.exe",
    "zoom.exe",
    "ms-teams.exe",
    "teams.exe",
    "discord.exe",
];

#[repr(C)]
struct Guid(u32, u16, u16, [u8; 8]);
const fn guid(value: u128) -> Guid {
    Guid(
        (value >> 96) as u32,
        (value >> 80) as u16,
        (value >> 64) as u16,
        (value as u64).to_be_bytes(),
    )
}
const ENUM_CLASS: Guid = guid(0xbcde0395_e52f_467c_8e3d_c4579291692e);
const ENUM: Guid = guid(0xa95664d2_9614_4f35_a746_de8db63617e6);
const ENDPOINT_VOLUME: Guid = guid(0x5cdf2c82_841e_4546_9722_0cf74078229a);
const MANAGER: Guid = guid(0x77aa99a0_1bd6_484f_8bc7_2c654c9a9b6f);
const CONTROL2: Guid = guid(0xbfb7ff88_7239_4fc9_8fa2_07c950be9c6d);
const SIMPLE_VOLUME: Guid = guid(0x87ce5498_68d6_44e5_9215_6da47ef883d8);
const METER: Guid = guid(0xc02216f6_8c67_4b5b_9d00_d008e73e0064);

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(reserved: Raw, flags: u32) -> Hr;
    fn CoUninitialize();
    fn CoCreateInstance(
        class: *const Guid,
        outer: Raw,
        context: u32,
        iid: *const Guid,
        out: *mut Raw,
    ) -> Hr;
}
#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Raw;
    fn QueryFullProcessImageNameW(handle: Raw, flags: u32, name: *mut u16, len: *mut u32) -> i32;
    fn CloseHandle(handle: Raw) -> i32;
}

fn excluded_process(pid: u32) -> bool {
    unsafe {
        let handle = OpenProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if handle.is_null() {
            return false;
        }
        let mut name = vec![0u16; 32768];
        let mut len = name.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, name.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        if ok == 0 {
            return false;
        }
        let path = String::from_utf16_lossy(&name[..len as usize]);
        let exe = path.rsplit('\\').next().unwrap_or("");
        EXCLUDED.iter().any(|entry| exe.eq_ignore_ascii_case(entry))
    }
}

fn check(hr: Hr) -> Result<()> {
    if hr < 0 {
        Err(hr)
    } else {
        Ok(())
    }
}

// COM interfaces start with a vtable pointer. Each use specifies the SDK slot and ABI.
// All interfaces below inherit IUnknown (0 QueryInterface, 1 AddRef, 2 Release).
macro_rules! method {
    ($object:expr, $slot:expr, $ty:ty) => {{
        let table = *($object.0 as *const *const Raw);
        std::mem::transmute::<Raw, $ty>(*table.add($slot))
    }};
}
struct Interface(Raw);
impl Interface {
    fn obtain(call: impl FnOnce(*mut Raw) -> Hr) -> Result<Self> {
        let mut raw = ptr::null_mut();
        check(call(&mut raw))?;
        if raw.is_null() {
            Err(0x80004003u32 as Hr)
        } else {
            Ok(Self(raw))
        }
    }
    fn query(&self, iid: &Guid) -> Result<Self> {
        unsafe {
            let query = method!(
                self,
                0,
                unsafe extern "system" fn(Raw, *const Guid, *mut Raw) -> Hr
            );
            Self::obtain(|out| query(self.0, iid, out))
        }
    }
    // IMMDevice : IUnknown, 3 Activate
    unsafe fn activate(&self, iid: &Guid) -> Result<Self> {
        let activate = method!(
            self,
            3,
            unsafe extern "system" fn(Raw, *const Guid, u32, Raw, *mut Raw) -> Hr
        );
        Self::obtain(|out| activate(self.0, iid, CLSCTX_ALL, ptr::null_mut(), out))
    }
    unsafe fn value<T: Default>(&self, slot: usize) -> Result<T> {
        let get = method!(self, slot, unsafe extern "system" fn(Raw, *mut T) -> Hr);
        let mut value = T::default();
        check(get(self.0, &mut value))?;
        Ok(value)
    }
}
impl Drop for Interface {
    fn drop(&mut self) {
        unsafe {
            method!(self, 2, unsafe extern "system" fn(Raw) -> u32)(self.0);
        }
    }
}
struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub struct Prober {
    enumerator: Interface,
    _apartment: Apartment, // field drop order releases the enumerator first
}
impl Prober {
    pub fn new() -> Result<Self> {
        unsafe {
            check(CoInitializeEx(ptr::null_mut(), 0))?; // COINIT_MULTITHREADED
            let apartment = Apartment;
            let enumerator = Interface::obtain(|out| {
                CoCreateInstance(&ENUM_CLASS, ptr::null_mut(), CLSCTX_ALL, &ENUM, out)
            })?;
            Ok(Self {
                enumerator,
                _apartment: apartment,
            })
        }
    }
    pub fn sample(&mut self, exclude_pids: &[u32]) -> Result<bool> {
        unsafe {
            // IMMDeviceEnumerator : IUnknown, 4 GetDefaultAudioEndpoint(eRender, eConsole)
            let endpoint = method!(
                self.enumerator,
                4,
                unsafe extern "system" fn(Raw, i32, i32, *mut Raw) -> Hr
            );
            let device = match Interface::obtain(|out| endpoint(self.enumerator.0, 0, 0, out)) {
                Err(hr) if hr == 0x80070490u32 as Hr => return Ok(false), // E_NOTFOUND
                result => result?,
            };
            let volume = device.activate(&ENDPOINT_VOLUME)?;
            // IAudioEndpointVolume : IUnknown, 15 GetMute, 9 GetMasterVolumeLevelScalar
            if volume.value::<i32>(15)? != 0 || volume.value::<f32>(9)? < 0.01 {
                return Ok(false);
            }
            let manager = device.activate(&MANAGER)?;
            // IAudioSessionManager2 : IAudioSessionManager : IUnknown, 5 GetSessionEnumerator
            let enumerate = method!(manager, 5, unsafe extern "system" fn(Raw, *mut Raw) -> Hr);
            let sessions = Interface::obtain(|out| enumerate(manager.0, out))?;
            // IAudioSessionEnumerator : IUnknown, 3 GetCount, 4 GetSession
            let count: i32 = sessions.value(3)?;
            let get = method!(
                sessions,
                4,
                unsafe extern "system" fn(Raw, i32, *mut Raw) -> Hr
            );
            let mut result = Ok(false);
            for i in 0..count {
                // A disappearing session must not hide another audible session.
                let active = Interface::obtain(|out| get(sessions.0, i, out))
                    .and_then(|session| session_active(&session, exclude_pids));
                match active {
                    Ok(true) => return Ok(true),
                    Err(hr) => result = Err(hr),
                    Ok(false) => (),
                }
            }
            result
        }
    }
}
unsafe fn session_active(session: &Interface, exclude_pids: &[u32]) -> Result<bool> {
    // IAudioSessionControl : IUnknown, 3 GetState (AudioSessionStateActive = 1)
    if session.value::<i32>(3)? != 1 {
        return Ok(false);
    }
    let control = session.query(&CONTROL2)?;
    // IAudioSessionControl2 : IAudioSessionControl, 15 IsSystemSoundsSession, 14 GetProcessId
    let system = method!(control, 15, unsafe extern "system" fn(Raw) -> Hr)(control.0);
    check(system)?;
    if system == 0 {
        return Ok(false);
    }
    let pid: u32 = control.value(14)?;
    if exclude_pids.contains(&pid) || excluded_process(pid) {
        return Ok(false);
    }
    // ISimpleAudioVolume : IUnknown, 6 GetMute, 4 GetMasterVolume
    // Optional: a session that cannot report its own volume is judged by the meter alone.
    if let Ok(volume) = session.query(&SIMPLE_VOLUME) {
        if volume.value::<i32>(6)? != 0 || volume.value::<f32>(4)? < 0.01 {
            return Ok(false);
        }
    }
    // IAudioMeterInformation : IUnknown, 3 GetPeakValue
    Ok(session.query(&METER)?.value::<f32>(3)? > 0.01)
}
