//! Physical pointer input: the hit test that says where a click lands, and the checks of a point taken in a window.

use super::*;

/// What the pointer lands on at a point.
#[derive(Debug, PartialEq)]
pub(super) enum Aim {
    /// The element, or content inside it that takes no press of its own.
    Target,
    /// A control inside the element (a row's inline button): a click there presses it, not the element.
    Control,
    /// Something outside the element.
    Other,
}

/// Roles whose element takes a click of its own: a press, or the text a double-click selects.
pub(super) fn presses(ax_role: &str) -> bool {
    matches!(
        ax_role,
        "AXButton"
            | "AXCheckBox"
            | "AXSwitch"
            | "AXRadioButton"
            | "AXPopUpButton"
            | "AXMenuButton"
            | "AXLink"
            | "AXDisclosureTriangle"
            | "AXIncrementor"
            | "AXSlider"
            | "AXTextField"
            | "AXTextArea"
            | "AXComboBox"
    )
}

/// The most steps a walk up from the element under the pointer takes: deeper than any window a snapshot reads.
pub(super) const MAX_WALK: usize = 256;

/// Whether an element under the pointer takes a click of its own: by its role, or, for a role that may be decoration or
/// a control (an image, a group), by the press it offers.
pub(super) fn takes_click(ax_role: &str, actions: impl FnOnce() -> Result<Vec<String>, AXError>) -> Result<bool, AXError> {
    if presses(ax_role) {
        return Ok(true);
    }
    // A role that never takes input (a separator, a splitter) is content. Any other one (a text label, an image, a group
    // a custom control draws itself in) is a control of its own when it offers a press, as the snapshot gives it a ref for one.
    if roles::inert(roles::role(ax_role, None)) {
        return Ok(false);
    }
    match actions() {
        Ok(names) => Ok(names.iter().any(|name| matches!(name.as_str(), "AXPress" | "AXOpen" | "AXConfirm"))),
        Err(ax::AX_CANNOT_COMPLETE) => Err(ax::AX_CANNOT_COMPLETE),
        Err(_) => Ok(false),
    }
}

/// Folds the walk up from the element under the pointer: each step says whether it is the element, and else whether it
/// takes a click of its own. The walk ends (`None`) at the top, or after `MAX_WALK` steps, without reaching the element.
pub(super) fn aim_along(mut walk: impl FnMut() -> Option<Result<(bool, bool), AXError>>) -> Result<Aim, AXError> {
    let mut control = false;
    for _ in 0..MAX_WALK {
        match walk() {
            Some(Ok((true, _))) => return Ok(if control { Aim::Control } else { Aim::Target }),
            Some(Ok((false, clicks))) => control = control || clicks,
            Some(Err(error)) => return Err(error),
            None => return Ok(Aim::Other),
        }
    }
    Ok(Aim::Other)
}

/// What the pointer lands on at a point on screen, relative to `element`, asked of the whole system: a floating panel
/// of another app over the element is what a click there reaches. `Err` when the app did not answer.
pub(super) fn aim_at(element: &Element, x: f64, y: f64) -> Result<Aim, AXError> {
    let mut next = Element::system_wide().element_at(x, y)?;
    aim_along(|| {
        let hit = next.take()?;
        if &hit == element {
            return Some(Ok((true, false)));
        }
        let ax_role = match hit.attribute("AXRole") {
            Ok(value) => value.text().unwrap_or_default().to_owned(),
            Err(ax::AX_CANNOT_COMPLETE) => return Some(Err(ax::AX_CANNOT_COMPLETE)),
            Err(_) => String::new(),
        };
        let clicks = match takes_click(&ax_role, || hit.actions()) {
            Ok(clicks) => clicks,
            Err(error) => return Some(Err(error)),
        };
        next = match hit.attribute("AXParent") {
            Ok(Value::Element(parent)) => Some(parent),
            Err(ax::AX_CANNOT_COMPLETE) => return Some(Err(ax::AX_CANNOT_COMPLETE)),
            _ => None,
        };
        Some(Ok((false, clicks)))
    })
}

/// Whether the pointer may go where `aim` says it lands: `clicks` refuses a control inside the element, which a hover
/// does not press. A hit test the app did not answer is a stall, never a covering element.
pub(super) fn aimed(aim: Result<Aim, AXError>, clicks: bool, when: &str) -> Outcome<()> {
    match aim {
        Ok(Aim::Target) => Ok(()),
        Ok(Aim::Control) if !clicks => Ok(()),
        Ok(Aim::Control) => {
            Err(Failure::refused(codes::ACTION_FAILED, format!("{when}, a control inside this element is under the pointer, so the click would press it")))
        }
        Ok(Aim::Other) => Err(Failure::refused(codes::ACTION_FAILED, format!("{when}, another element is under the pointer, so no click was sent there"))),
        Err(error) => Err(unread(error, "find the element under the pointer")),
    }
}

/// Physical pointer input at the element's center, once its window is forward and nothing covers it.
pub(super) fn physical(entry: &Entry, action: Pointer) -> Outcome<()> {
    let window = windows::find(entry.pid, entry.window)?;
    go("pointer")?;
    raise(entry.pid, &window)?;
    let (x, y) = center(&entry.element)?;
    let clicks = matches!(action, Pointer::Click { .. });
    aimed(aim_at(&entry.element, x, y), clicks, "before the move")?;
    // Raising the window and the hit test can take a second on a slow app: the caller may have given up meanwhile. The
    // pointer's move can reveal a control over the element (a row's inline button): the first click checks the point
    // again. A double-click's second click follows at once, as part of the same gesture.
    input::pointer(x, y, action, &|click| if click == 1 { still_aimed(|| aim_at(&entry.element, x, y)) } else { go("pointer") })
}

/// Whether a click may go: the caller still wants it, the point still lands on the element, and the caller still
/// wants it after that check, which waits on the app.
pub(super) fn still_aimed(aim: impl FnOnce() -> Result<Aim, AXError>) -> Outcome<()> {
    go("pointer")?;
    aimed(aim(), true, "after the move")?;
    go("pointer")
}

/// The sheet on a window that held its focus when a point was taken.
#[derive(Clone, Debug, PartialEq)]
pub enum Sheet {
    None,
    /// A sheet, by its key (`Element::sheet_key`).
    Key(String),
    /// A sheet the caller could name no key for: no sheet now is known to be it.
    Unnamed,
}

/// Whether a click at a point taken in a window may go: the app is frontmost, the window holds its focus, and the sheet
/// on it (`now`) is the one that was there when the point was taken (`then`): none opened, none closed, and none took
/// another's place. A sheet with no key is never known to be the same one.
pub(super) fn takes_point(frontmost: bool, holds: bool, now: &Sheet, then: &Sheet) -> Outcome<()> {
    if !frontmost {
        return Err(Failure::refused(codes::ACTION_FAILED, "another app came forward over the window the point was taken in, so no click was sent"));
    }
    if !holds {
        return Err(Failure::refused(codes::ACTION_FAILED, "another window took focus from the one the point was taken in, so no click was sent"));
    }
    let message = match (now, then) {
        (Sheet::None, Sheet::None) => return Ok(()),
        (_, Sheet::None) => "a sheet opened over the window the point was taken in, so no click was sent",
        (Sheet::None, _) => "the sheet the point was taken on closed, so no click was sent to what was under it",
        (Sheet::Key(now), Sheet::Key(then)) if now == then => return Ok(()),
        _ => "another sheet took the place of the one the point was taken on, or it cannot be told apart from one, so no click was sent",
    };
    Err(Failure::refused(codes::ACTION_FAILED, message))
}

/// The window a point was taken in, which must still take a click at it.
#[derive(Clone, Debug)]
pub struct PointTarget {
    pub pid: i32,
    pub window: u32,
    pub sheet: Sheet,
    /// The point is on a node that takes no click of its own (one the snapshot gave no ref): no control may be under it.
    pub content: bool,
}

/// `takes_point` for a window of `pid`, read now, and the point on top of that window, not of another app's or
/// window's over it. A read the app did not answer in time is a stall.
pub(super) fn window_takes_point(target: &PointTarget, x: f64, y: f64) -> Outcome<()> {
    let PointTarget { pid, window: id, ref sheet, content } = *target;
    let window = windows::find(pid, id)?;
    let app = Element::application(pid);
    let frontmost = frontmost(pid)?;
    let focused = match app.attribute("AXFocusedWindow") {
        Ok(Value::Element(focused)) => Some(focused),
        Err(error) if error == ax::AX_CANNOT_COMPLETE => return Err(unread(error, "read the app's focused window")),
        _ => None,
    };
    let holds = match &focused {
        Some(focused) => super::holds(focused, &window, "read the app's focused window")?,
        None => false,
    };
    let now = match focused.filter(|focused| *focused != window) {
        None => Sheet::None,
        Some(on) => Sheet::Key(on.sheet_key()),
    };
    takes_point(frontmost, holds, &now, sheet)?;
    point_lands(aim_at(&window, x, y), content)
}

/// For a hover: the point is on the window it was taken in, not on another app's or window's over it, which the move
/// would reach. A hover presses nothing, so a control under the point, focus, and sheets are not checked.
pub(super) fn window_on_point(target: &PointTarget, x: f64, y: f64) -> Outcome<()> {
    let window = windows::find(target.pid, target.window)?;
    match aim_at(&window, x, y) {
        Ok(Aim::Target | Aim::Control) => Ok(()),
        Ok(Aim::Other) => Err(Failure::refused(codes::ACTION_FAILED, "another window or app is on top at the point, so the pointer was not moved")),
        Err(error) => Err(unread(error, "find the element under the pointer")),
    }
}

/// Whether a click at a point may go where the hit test (relative to the window) says it lands. A tap at a point names
/// no element, so any control of the window may be there, unless the point was taken on `content`, a node that takes
/// no click of its own: a control there now (one coming forward revealed) would take the click.
pub(super) fn point_lands(aim: Result<Aim, AXError>, content: bool) -> Outcome<()> {
    match aim {
        Ok(Aim::Target) => Ok(()),
        Ok(Aim::Control) if !content => Ok(()),
        Ok(Aim::Control) => Err(Failure::refused(
            codes::ACTION_FAILED,
            "a control is under the pointer at the node the point was taken on (over it, or one it is in), so no click was sent",
        )),
        Ok(Aim::Other) => Err(Failure::refused(codes::ACTION_FAILED, "another window or app is on top at the point, so no click was sent")),
        Err(error) => Err(unread(error, "find the element under the pointer")),
    }
}

/// Physical pointer input at a point on screen, sent only while `input_id` is not cancelled and `deadline` has not
/// passed. With `target` (the app, the window the point was taken in, the sheet on it then, and whether the point is on
/// a node that takes no click of its own), the first click goes only while that window still takes it, checked after
/// the move.
pub fn pointer_at(x: f64, y: f64, kind: &str, input_id: Option<u32>, deadline: Instant, target: Option<PointTarget>) -> Outcome<()> {
    let action = match kind {
        "hover" => Pointer::Move,
        "tap" => Pointer::Click { right: false, count: 1 },
        "doubleTap" => Pointer::Click { right: false, count: 2 },
        "secondaryTap" => Pointer::Click { right: true, count: 1 },
        other => return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("no pointer action {other}"))),
    };
    guarded(input_id, deadline, || {
        // A point another window or app already covers is refused before the move, which would reach that window: nothing
        // is sent. The check after the move is for one that opens meanwhile, before a click. A hover presses nothing, so
        // it is checked only for a window or app over the point, which the move alone would reach.
        if let Some(target) = target.as_ref() {
            go("pointer")?;
            match action {
                Pointer::Click { .. } => window_takes_point(target, x, y)?,
                Pointer::Move => window_on_point(target, x, y)?,
            }
        }
        input::pointer(x, y, action, &|click| {
            go("pointer")?;
            match &target {
                // A sheet or window that opened during the move would take the click: the first one checks, and the
                // caller once more after that check, which waits on the app.
                Some(target) if click == 1 => {
                    window_takes_point(target, x, y)?;
                    go("pointer")
                }
                _ => Ok(()),
            }
        })
    })
}
