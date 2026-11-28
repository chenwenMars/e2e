//! `@e2e-dev/desktop`'s native driver: macOS accessibility, input, launch,
//! and capture, called from the engine's JavaScript through NAPI-RS. Every
//! call that talks to another process runs on a blocking thread and
//! resolves with an envelope (`{ ok, data }` or `{ ok, error }`), never a
//! rejection, so the engine maps each failure onto its error contract.

#![cfg(target_os = "macos")]

mod actions;
mod ax;
mod failure;
mod input;
mod launch;
mod layout;
mod refs;
mod roles;
mod snapshot;
mod system;
mod windows;

mod process;

use actions::Sheet;
use failure::{Failure, Outcome, codes, envelope};
use napi::bindgen_prelude::spawn_blocking;
use napi_derive::napi;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Once;
use std::time::{Duration, Instant};

/// How long one request to another app may take before it gives up, in seconds.
const MESSAGING_TIMEOUT_SECONDS: f32 = 1.0;

fn init() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| ax::set_global_timeout(MESSAGING_TIMEOUT_SECONDS));
}

fn deadline(timeout_ms: f64) -> Instant {
    Instant::now() + Duration::from_millis(timeout_ms.max(0.0) as u64)
}

/// Runs `work` on a blocking thread and answers its envelope. The work runs in an autorelease pool: a blocking thread
/// has none, and the AppKit and Foundation calls a launch makes would otherwise leak what they autorelease for as long
/// as the worker lives.
async fn blocking(work: impl FnOnce() -> Outcome<Value> + Send + 'static) -> Value {
    init();
    match spawn_blocking(move || objc2::rc::autoreleasepool(|_| work())).await {
        Ok(outcome) => envelope(outcome),
        Err(error) => envelope(Err(Failure::unconfirmed(codes::INTERNAL, format!("the native call failed: {error}")))),
    }
}

fn data<T: serde::Serialize>(value: T) -> Outcome<Value> {
    serde_json::to_value(value).map_err(|error| Failure::refused(codes::INTERNAL, error.to_string()))
}

#[napi(object)]
pub struct Status {
    pub accessibility: bool,
    pub screen_recording: bool,
}

/// The permissions this process holds. The driver's version is the version of the package it ships in, which the
/// loader reads; the crate itself is never versioned.
#[napi]
pub fn status() -> Status {
    init();
    Status { accessibility: ax::trusted(), screen_recording: system::screen_recording() }
}

/// Whether the screen is locked; `null` when that cannot be told.
#[napi]
pub fn screen_locked() -> Option<bool> {
    system::screen_locked()
}

/// When a process started, in microseconds since the epoch; `null` when it is not running.
#[napi]
pub fn process_started(pid: i32) -> Option<f64> {
    process::started(pid).map(|micros| micros as f64)
}

/// Every process that carries the launch `token`; `null` when the processes cannot be listed. It reads
/// every process, which takes tens of milliseconds, so it runs on a blocking thread, off the JavaScript thread.
#[napi]
pub async fn processes_carrying(token: String) -> Option<Vec<i32>> {
    spawn_blocking(move || process::carrying(&token)).await.ok().flatten()
}

/// Drops the refs of a process that quit.
#[napi]
pub fn forget_process(pid: i32) {
    refs::forget_process(pid);
}

#[napi(object)]
pub struct LaunchOptions {
    pub path: Option<String>,
    pub bundle_id: Option<String>,
    pub arguments: Vec<String>,
    /// The whole environment the app is started with, beside launchd's own.
    pub environment: HashMap<String, String>,
    /// Marks the process the launch starts, as `E2E_DESKTOP_LAUNCH`.
    pub token: String,
    pub activate: bool,
    pub timeout_ms: f64,
    /// How long the search for the launched process may take once `open` has exited.
    pub claim_ms: f64,
    /// Names the launch, so `cancelInput` can stop it before it starts the app.
    pub input_id: Option<u32>,
}

/// Starts a new instance of an app.
#[napi(ts_return_type = "Promise<NativeEnvelope<NativeLaunched>>")]
pub async fn launch(options: LaunchOptions) -> Value {
    // The budget counts from the call, not from when a blocking thread picks the work up.
    let asked = Instant::now();
    blocking(move || {
        let mut environment: Vec<(String, String)> = options.environment.into_iter().collect();
        environment.sort();
        let request = launch::LaunchRequest {
            path: options.path,
            bundle_id: options.bundle_id,
            arguments: options.arguments,
            environment,
            token: options.token,
            activate: options.activate,
            timeout: Duration::from_millis(options.timeout_ms.max(0.0) as u64),
            claim: Duration::from_millis(options.claim_ms.max(0.0) as u64),
            asked,
            input_id: options.input_id,
        };
        data(launch::launch(request)?)
    })
    .await
}

/// The windows of a process.
#[napi(ts_return_type = "Promise<NativeEnvelope<NativeWindow[]>>")]
pub async fn list_windows(pid: i32) -> Value {
    blocking(move || data(windows::list(pid)?)).await
}

#[napi(object)]
pub struct SnapshotOptions {
    pub pid: i32,
    pub window_id: String,
    pub max_depth: u32,
    pub interactive: bool,
    pub timeout_ms: f64,
}

fn window_id(id: &str) -> Outcome<u32> {
    id.parse::<u32>().map_err(|_| Failure::refused(codes::WINDOW_NOT_FOUND, format!("\"{id}\" is not a window id")))
}

/// One window's accessibility tree.
#[napi(ts_return_type = "Promise<NativeEnvelope<NativeSnapshot>>")]
pub async fn snapshot(options: SnapshotOptions) -> Value {
    let deadline = deadline(options.timeout_ms);
    blocking(move || {
        let request = snapshot::Request {
            pid: options.pid,
            window: window_id(&options.window_id)?,
            max_depth: options.max_depth as usize,
            interactive: options.interactive,
            deadline,
        };
        data(snapshot::snapshot(request)?)
    })
    .await
}

#[napi(object)]
pub struct ActOptions {
    /// The ref a snapshot handed out.
    pub r#ref: String,
    /// `click`, `doubleClick`, `rightClick`, `focus`, `clear`, `check`, `uncheck`, `scrollTo`, `hover`, `setValue`, `selectAll`, `select`, `scroll`, or `type`.
    pub action: String,
    pub value: Option<String>,
    pub direction: Option<String>,
    pub pages: Option<f64>,
    pub physical: Option<bool>,
    /// Names this action's run, so `cancelInput` can stop it before it sends input.
    pub input_id: Option<u32>,
    pub timeout_ms: f64,
}

/// One action on the element a ref names.
#[napi(ts_return_type = "Promise<NativeEnvelope<Record<string, never>>>")]
pub async fn act(options: ActOptions) -> Value {
    let deadline = deadline(options.timeout_ms);
    blocking(move || {
        let text = || options.value.clone().ok_or_else(|| Failure::refused(codes::INVALID_ARGS, format!("{} needs a value", options.action)));
        let action = match options.action.as_str() {
            "click" => actions::Action::Click,
            "doubleClick" => actions::Action::DoubleClick,
            "rightClick" => actions::Action::RightClick,
            "focus" => actions::Action::Focus,
            "clear" => actions::Action::Clear,
            "check" => actions::Action::Check(true),
            "uncheck" => actions::Action::Check(false),
            "scrollTo" => actions::Action::ScrollTo,
            "hover" => actions::Action::Hover,
            "setValue" => actions::Action::SetValue(text()?),
            "selectAll" => actions::Action::SelectAll,
            "select" => actions::Action::Select(text()?),
            "scroll" => actions::Action::Scroll { direction: options.direction.clone().unwrap_or_else(|| "down".into()), pages: options.pages.unwrap_or(0.5) },
            "type" => actions::Action::Type { text: text()?, physical: options.physical.unwrap_or(false) },
            other => return Err(Failure::refused(codes::INVALID_ARGS, format!("no action \"{other}\""))),
        };
        actions::act(&options.r#ref, action, options.input_id, deadline)?;
        Ok(serde_json::json!({}))
    })
    .await
}

/// A fresh id for one call's input (`act`, `press`, `pointer`, `launch`), unique in the process: every Node worker
/// thread shares the addon, and with it the ids `cancelInput` reaches.
#[napi]
pub fn input_id() -> u32 {
    crate::input::next_input_id()
}

/// Stops the call (`act`, `press`, `pointer`, `launch`) that was given `inputId`: it sends no input from then on, though what it sent stays sent.
#[napi]
pub fn cancel_input(input_id: u32) {
    crate::input::cancel_input(input_id);
}

#[napi(object)]
pub struct PressOptions {
    pub pid: i32,
    pub window_id: String,
    /// A combo such as `cmd+a` or `return`.
    pub combo: String,
    pub physical: bool,
    /// A ref whose element must still hold the app's focus when the key goes: a locator's control.
    pub focused_ref: Option<String>,
    /// Names this press, so `cancelInput` can stop it before it sends the key.
    pub input_id: Option<u32>,
    pub timeout_ms: f64,
}

/// Checks that a key combo can be pressed on this Mac's keyboard layout, the way `press` reads it, and sends nothing: a
/// caller that moves focus first can refuse a combo the layout cannot type before anything changed.
#[napi(ts_return_type = "Promise<NativeEnvelope<Record<string, never>>>")]
pub async fn check_combo(combo: String) -> Value {
    blocking(move || {
        input::parse_combo(&combo)?;
        Ok(serde_json::json!({}))
    })
    .await
}

/// Presses a key combo into a window.
#[napi(ts_return_type = "Promise<NativeEnvelope<Record<string, never>>>")]
pub async fn press(options: PressOptions) -> Value {
    let deadline = deadline(options.timeout_ms);
    blocking(move || {
        actions::press(
            options.pid,
            window_id(&options.window_id)?,
            &options.combo,
            options.physical,
            options.focused_ref.as_deref(),
            options.input_id,
            deadline,
        )?;
        Ok(serde_json::json!({}))
    })
    .await
}

/// Brings a window and its app forward. `inputId` names it, so `cancelInput` stops it before it changes the focus.
#[napi(ts_return_type = "Promise<NativeEnvelope<Record<string, never>>>")]
pub async fn focus_window(pid: i32, window_id_text: String, input_id: Option<u32>, timeout_ms: Option<f64>) -> Value {
    let deadline = deadline(timeout_ms.unwrap_or(60_000.0));
    blocking(move || {
        actions::focus_window(pid, window_id(&window_id_text)?, input_id, deadline)?;
        Ok(serde_json::json!({}))
    })
    .await
}

/// Closes a window as its close button does. `inputId` names it, so `cancelInput` stops it before the button is pressed.
#[napi(ts_return_type = "Promise<NativeEnvelope<Record<string, never>>>")]
pub async fn close_window(pid: i32, window_id_text: String, input_id: Option<u32>, timeout_ms: Option<f64>) -> Value {
    let deadline = deadline(timeout_ms.unwrap_or(60_000.0));
    blocking(move || {
        actions::close_window(pid, window_id(&window_id_text)?, input_id, deadline)?;
        Ok(serde_json::json!({}))
    })
    .await
}

/// The window a point was taken in, which must still take the click when it goes.
#[napi(object)]
pub struct PointerTarget {
    pub pid: i32,
    pub window_id: String,
    /// Whether a sheet on the window held its focus when the point was taken.
    pub sheet: bool,
    /// That sheet's key, as `listWindows` gave it (`sheet_id`): another sheet in its place, or one with no key, does not
    /// take the click.
    pub sheet_id: Option<String>,
    /// The point is on a node with no ref, which takes no click of its own: no control may be under it when it goes.
    pub content: Option<bool>,
}

/// Physical pointer input at a point on screen: `tap`, `doubleTap`, `secondaryTap`, or `hover`. `inputId` names it, so
/// `cancelInput` stops what it has yet to send. With `target`, no click goes once another window, a new sheet, or
/// another app took the focus from that window.
#[napi(ts_return_type = "Promise<NativeEnvelope<Record<string, never>>>")]
pub async fn pointer(x: f64, y: f64, kind: String, input_id: Option<u32>, timeout_ms: Option<f64>, target: Option<PointerTarget>) -> Value {
    // No budget given: the call sends at once, as before `timeoutMs` was passed.
    let deadline = deadline(timeout_ms.unwrap_or(60_000.0));
    blocking(move || {
        let target = match target {
            Some(target) => {
                let sheet = match (target.sheet, target.sheet_id) {
                    (false, _) => Sheet::None,
                    (true, Some(key)) => Sheet::Key(key),
                    (true, None) => Sheet::Unnamed,
                };
                Some(actions::PointTarget { pid: target.pid, window: window_id(&target.window_id)?, sheet, content: target.content.unwrap_or(false) })
            }
            None => None,
        };
        actions::pointer_at(x, y, &kind, input_id, deadline, target)?;
        Ok(serde_json::json!({}))
    })
    .await
}

#[napi(object)]
pub struct ScreenshotOptions {
    pub window_id: String,
    pub path: String,
    pub timeout_ms: f64,
}

/// Captures a window into a PNG file; answers the display's scale.
#[napi(ts_return_type = "Promise<NativeEnvelope<{ scale_factor: number }>>")]
pub async fn screenshot(options: ScreenshotOptions) -> Value {
    let deadline = deadline(options.timeout_ms);
    blocking(move || {
        let scale = system::screenshot(window_id(&options.window_id)?, &options.path, deadline)?;
        Ok(serde_json::json!({ "scale_factor": scale }))
    })
    .await
}
