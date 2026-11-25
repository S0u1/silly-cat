// Keep the MTA and its COM interfaces on one thread across active samples.
use crate::media_win::Prober;
use std::{
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

const IDLE: Duration = Duration::from_secs(10);
struct State {
    last_call: Option<Instant>,
    sample: Option<(Instant, bool)>,
    worker: Option<thread::JoinHandle<()>>,
}
static STATE: Mutex<State> = Mutex::new(State {
    last_call: None,
    sample: None,
    worker: None,
});

pub fn latest() -> bool {
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
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
    state
        .sample
        .is_some_and(|(t, active)| active && t.elapsed() < Duration::from_secs(3))
}

fn run() {
    let mut probe = None;
    loop {
        let last_call = STATE.lock().unwrap_or_else(|e| e.into_inner()).last_call;
        if last_call.is_some_and(|t| t.elapsed() < IDLE) {
            if probe.is_none() {
                probe = Prober::new().ok();
            }
            let active = probe
                .as_mut()
                .and_then(|p| p.sample(&[std::process::id()]).ok());
            if active.is_none() {
                probe = None;
            }
            STATE.lock().unwrap_or_else(|e| e.into_inner()).sample =
                Some((Instant::now(), active.unwrap_or(false)));
        }
        thread::sleep(Duration::from_secs(1));
    }
}
