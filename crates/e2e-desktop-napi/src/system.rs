//! The machine around the app: permissions, whether the screen is locked,
//! whether a process runs, and window captures.

use crate::failure::{Failure, Outcome, codes};
use crate::windows;
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use core_foundation_sys::base::CFTypeRef;
use core_foundation_sys::dictionary::{CFDictionaryGetValue, CFDictionaryRef};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
    fn CGGetDisplaysWithRect(rect: CGRectRaw, max: u32, displays: *mut u32, count: *mut u32) -> i32;
    fn CGDisplayCopyDisplayMode(display: u32) -> CFTypeRef;
    fn CGDisplayModeGetPixelWidth(mode: CFTypeRef) -> usize;
    fn CGDisplayModeGetWidth(mode: CFTypeRef) -> usize;
    fn CGDisplayModeRelease(mode: CFTypeRef);
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGRectRaw {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Whether this process may capture the screen; asks no question of the user.
pub fn screen_recording() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// Whether the console session's screen is locked; `None` when that cannot be told.
pub fn screen_locked() -> Option<bool> {
    let session = unsafe { CGSessionCopyCurrentDictionary() };
    if session.is_null() {
        return None;
    }
    let dictionary: CFDictionary = unsafe { CFDictionary::wrap_under_create_rule(session) };
    let key = CFString::from_static_string("CGSSessionScreenIsLocked");
    let value = unsafe { CFDictionaryGetValue(dictionary.as_concrete_TypeRef(), key.as_concrete_TypeRef() as *const _) };
    if value.is_null() {
        // The key is there only while the screen is locked.
        return Some(false);
    }
    Some(unsafe { CFBoolean::wrap_under_get_rule(value as _) }.into())
}

/// The backing scale of the display a window is on: image pixels per point.
fn scale_of(bounds: windows::Rect) -> f64 {
    let rect = CGRectRaw { x: bounds.x, y: bounds.y, width: bounds.width.max(1.0), height: bounds.height.max(1.0) };
    let mut display: u32 = 0;
    let mut count: u32 = 0;
    if unsafe { CGGetDisplaysWithRect(rect, 1, &mut display, &mut count) } != 0 || count == 0 {
        return 1.0;
    }
    let mode = unsafe { CGDisplayCopyDisplayMode(display) };
    if mode.is_null() {
        return 1.0;
    }
    let (pixels, points) = unsafe { (CGDisplayModeGetPixelWidth(mode), CGDisplayModeGetWidth(mode)) };
    unsafe { CGDisplayModeRelease(mode) };
    if points == 0 { 1.0 } else { pixels as f64 / points as f64 }
}

/// Captures one window, without its shadow, into a PNG at `path`; answers the display's scale.
pub fn screenshot(window: u32, path: &str, deadline: Instant) -> Outcome<f64> {
    let bounds = windows::server_bounds(window).ok_or_else(|| Failure::refused(codes::WINDOW_NOT_FOUND, format!("window {window} is not on screen")))?;
    let mut child = Command::new("/usr/sbin/screencapture")
        .args(["-x", "-o", "-t", "png", "-l", &window.to_string(), path])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| Failure::refused(codes::INTERNAL, format!("could not run screencapture: {error}")))?;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => {
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stderr.take() {
                    let _ = std::io::Read::read_to_string(&mut pipe, &mut stderr);
                }
                return Err(capture_failed(window, stderr.trim()));
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Failure::timeout("the window capture"));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(error) => return Err(Failure::refused(codes::INTERNAL, format!("screencapture failed: {error}"))),
        }
    }
    if !Path::new(path).exists() {
        return Err(capture_failed(window, "it wrote no image"));
    }
    Ok(scale_of(bounds))
}

/// Why a capture failed: no Screen Recording permission, a window that closed meanwhile, or what `screencapture` said.
fn capture_failed(window: u32, said: &str) -> Failure {
    if !screen_recording() {
        return Failure::refused(codes::PERM_DENIED, "screencapture could not capture the window; it needs Screen Recording permission");
    }
    if windows::server_bounds(window).is_none() {
        return Failure::refused(codes::WINDOW_NOT_FOUND, format!("window {window} closed before it could be captured"));
    }
    let detail = if said.is_empty() { "it gave no reason".to_owned() } else { said.to_owned() };
    Failure::refused(codes::INTERNAL, format!("screencapture could not capture window {window}: {detail}"))
}
