// Read-only CoreAudio HAL properties (AudioHardware.h and AudioHardwareBase.h).
use std::{
    ffi::{c_char, c_void, CStr},
    mem::size_of,
    ptr,
};

const EXCLUDED: &[&str] = &[
    "com.tencent.xinWeChat",
    "com.tencent.qq",
    "com.tencent.meeting",
    "com.alibaba.DingTalkMac",
    "com.bytedance.lark",
    "com.electron.lark",
    "us.zoom.xos",
    "com.microsoft.teams",
    "com.microsoft.teams2",
    "com.apple.FaceTime",
    "com.apple.avconferenced",
    "com.apple.systemsoundserverd",
    "com.apple.audio.systemsoundserverd",
    "com.hnc.Discord",
    "com.drew.sillycat",
];
const SYSTEM: u32 = 1;
const GLOBAL: u32 = u32::from_be_bytes(*b"glob");
const OUTPUT: u32 = u32::from_be_bytes(*b"outp");
#[repr(C)]
struct Address {
    selector: u32,
    scope: u32,
    element: u32,
}
impl Address {
    fn new(selector: &[u8; 4], scope: u32, element: u32) -> Self {
        Self {
            selector: u32::from_be_bytes(*selector),
            scope,
            element,
        }
    }
}
#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectHasProperty(id: u32, addr: *const Address) -> u8;
    fn AudioObjectGetPropertyDataSize(
        id: u32,
        addr: *const Address,
        qualifier_len: u32,
        qualifier: *const c_void,
        len: *mut u32,
    ) -> i32;
    fn AudioObjectGetPropertyData(
        id: u32,
        addr: *const Address,
        qualifier_len: u32,
        qualifier: *const c_void,
        len: *mut u32,
        data: *mut c_void,
    ) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringGetLength(s: *const c_void) -> isize;
    fn CFStringGetCString(s: *const c_void, buf: *mut c_char, capacity: isize, encoding: u32)
        -> u8;
    fn CFRelease(object: *const c_void);
}

// Caller pairs the HAL selector with its declared POD result type.
unsafe fn scalar<T: Default>(id: u32, selector: &[u8; 4], scope: u32, element: u32) -> Option<T> {
    let mut value = T::default();
    let mut len = size_of::<T>() as u32;
    let addr = Address::new(selector, scope, element);
    let status = AudioObjectGetPropertyData(
        id,
        &addr,
        0,
        ptr::null(),
        &mut len,
        (&mut value as *mut T).cast(),
    );
    (status == 0 && len as usize == size_of::<T>()).then_some(value)
}

fn process_objects(addr: &Address) -> Vec<u32> {
    let mut len = 0;
    unsafe {
        if AudioObjectGetPropertyDataSize(SYSTEM, addr, 0, ptr::null(), &mut len) != 0
            || len == 0
            || len & 3 != 0
        {
            return Vec::new();
        }
        let mut ids = vec![0u32; len as usize / 4];
        if AudioObjectGetPropertyData(
            SYSTEM,
            addr,
            0,
            ptr::null(),
            &mut len,
            ids.as_mut_ptr().cast(),
        ) != 0
        {
            return Vec::new();
        }
        ids.truncate(len as usize / 4);
        ids
    }
}

fn eligible_process(id: u32) -> bool {
    unsafe {
        if scalar::<u32>(id, b"piro", GLOBAL, 0) != Some(1) {
            return false;
        }
        match scalar::<i32>(id, b"ppid", GLOBAL, 0) {
            Some(pid) if pid as u32 != std::process::id() => (),
            _ => return false,
        }
        let cf = scalar::<*const c_void>(id, b"pbid", GLOBAL, 0).unwrap_or(ptr::null());
        // Command-line players may have no bundle.
        if cf.is_null() {
            return true;
        }
        let mut buf = vec![0; (CFStringGetLength(cf) * 4 + 1) as usize];
        let ok = CFStringGetCString(cf, buf.as_mut_ptr(), buf.len() as isize, 0x08000100);
        CFRelease(cf);
        if ok == 0 {
            return false;
        }
        let bundle = CStr::from_ptr(buf.as_ptr()).to_string_lossy();
        !EXCLUDED.iter().any(|&entry| {
            bundle
                .strip_prefix(entry)
                .is_some_and(|suffix| suffix.is_empty() || suffix.starts_with('.'))
        })
    }
}

fn audible_device(device: u32) -> bool {
    unsafe {
        let mute = scalar::<u32>(device, b"mute", OUTPUT, 0);
        let volume = scalar::<f32>(device, b"volm", OUTPUT, 0);
        let channels = [1, 2].map(|channel| {
            let muted = mute
                .or_else(|| scalar(device, b"mute", OUTPUT, channel))
                .unwrap_or(0);
            let level = volume.or_else(|| scalar(device, b"volm", OUTPUT, channel));
            (muted, level)
        });
        let default_level = if channels.iter().all(|(_, level)| level.is_none()) {
            1.0
        } else {
            0.0
        };
        channels
            .iter()
            .any(|(muted, level)| *muted == 0 && level.unwrap_or(default_level) >= 0.01)
    }
}

pub fn sample() -> (bool, &'static str) {
    let list = Address::new(b"prs#", GLOBAL, 0);
    let by_process = unsafe { AudioObjectHasProperty(SYSTEM, &list) != 0 };
    let device = unsafe { scalar::<u32>(SYSTEM, b"dOut", GLOBAL, 0) }.unwrap_or(0);
    let audible = device != 0 && audible_device(device);
    if by_process {
        (
            audible && process_objects(&list).into_iter().any(eligible_process),
            "process",
        )
    } else {
        (
            audible && unsafe { scalar::<u32>(device, b"gone", GLOBAL, 0) == Some(1) },
            "device",
        )
    }
}
