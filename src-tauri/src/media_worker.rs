// Keep the MTA and its COM interfaces on one thread across active samples.
use crate::media_win::RetryProbe;
use std::{
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

const IDLE: Duration = Duration::from_secs(10);
struct State {
    unsupported: bool,
    last_call: Option<Instant>,
    sample: Option<(Instant, bool)>,
    worker: Option<thread::JoinHandle<()>>,
}
static STATE: Mutex<State> = Mutex::new(State {
    unsupported: false,
    last_call: None,
    sample: None,
    worker: None,
});

pub fn latest() -> Option<bool> {
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if state.unsupported {
        return None;
    }
    if !matches!(&state.worker, Some(worker) if !worker.is_finished()) {
        state.sample = None;
        state.worker = thread::Builder::new()
            .name("silly-media-probe".into())
            .spawn(run)
            .ok();
    }
    if state.last_call.is_some_and(|t| t.elapsed() >= IDLE) {
        state.sample = None;
    }
    state.last_call = Some(Instant::now());
    Some(
        state
            .sample
            .is_some_and(|(t, active)| active && t.elapsed() < Duration::from_secs(3)),
    )
}

fn run() {
    let mut probe = RetryProbe::new();
    loop {
        let last_call = STATE.lock().unwrap_or_else(|e| e.into_inner()).last_call;
        if last_call.is_some_and(|t| t.elapsed() < IDLE) {
            let active = probe.poll(&[std::process::id()]).unwrap_or(Some(false));
            let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
            match active {
                Some(active) => state.sample = Some((Instant::now(), active)),
                None => {
                    state.unsupported = true;
                    return;
                }
            }
        }
        thread::sleep(Duration::from_secs(1));
    }
}
