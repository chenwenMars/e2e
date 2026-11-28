//! Actions on the element a ref names, through the accessibility API
//! unless they need the real pointer or keyboard. Each one says whether
//! anything reached the app when it fails, and checks its effect where the
//! element shows it (a box's state, a field's value, a list's choice).

use crate::ax::{self, AXError, Element, Value};
use crate::failure::{Delivery, Failure, Outcome, codes};
use crate::input::{self, Pointer, Route};
use crate::refs::{self, Entry};
use crate::roles;
use crate::windows;
use std::thread::sleep;
use std::time::{Duration, Instant};

mod pointer;
mod scroll;
mod select;
mod typing;
mod values;

use pointer::*;
pub use pointer::{PointTarget, Sheet, pointer_at};
pub use scroll::scroll_bar;
use scroll::*;
use select::*;
use typing::*;
use values::*;

/// How long an action that opens a menu or a modal waits for the app to answer before it counts as delivered.
const BLOCKING_ACTION_SECONDS: f32 = 0.5;

/// How long an effect is polled for before the action is reported unconfirmed.
const EFFECT_WAIT: Duration = Duration::from_millis(1_000);

/// How long an action that opens a menu waits for it to show.
const MENU_SHOW_WAIT: Duration = Duration::from_millis(1_000);

/// How often an effect is polled.
const POLL: Duration = Duration::from_millis(30);
/// How long before the deadline a wait that ends in a refusal gives up: the engine cuts the call off at that same
/// deadline, and a refusal that came after it would read as input that may have reached the app.
const ANSWER_MARGIN: Duration = Duration::from_millis(200);

/// What `act` does.
pub enum Action {
    Click,
    DoubleClick,
    RightClick,
    Focus,
    Clear,
    Check(bool),
    ScrollTo,
    Hover,
    SetValue(String),
    SelectAll,
    Select(String),
    Scroll { direction: String, pages: f64 },
    Type { text: String, physical: bool },
}

/// The failure for an AX error of a request that changed nothing.
fn refused(error: AXError, what: &str) -> Failure {
    match error {
        ax::AX_INVALID_ELEMENT => Failure::refused(codes::STALE_REF, format!("{what}: the element no longer exists")),
        ax::AX_ACTION_UNSUPPORTED | ax::AX_ATTRIBUTE_UNSUPPORTED | ax::AX_NOT_IMPLEMENTED => {
            Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("{what}: {}", ax::describe(error)))
        }
        ax::AX_API_DISABLED => Failure::refused(codes::PERM_DENIED, format!("{what}: {}", ax::describe(error))),
        ax::AX_ILLEGAL_ARGUMENT => Failure::refused(codes::ACTION_FAILED, format!("{what}: {}", ax::describe(error))),
        _ => Failure::unconfirmed(codes::ACTION_FAILED, format!("{what}: {}", ax::describe(error))),
    }
}

/// The failure of an AX attribute write: only a refusal says nothing was sent. Any other answer may follow a write
/// the app took, whose handler ran (one that replaced the element answers a gone element), so it counts as delivered.
fn write_failed(error: AXError, what: &str) -> Failure {
    if refuses(error) { refused(error, what) } else { refused(error, what).delivered() }
}

thread_local! {
    /// The action this thread runs: its input run, which a cancel marks, and its deadline.
    static CURRENT: std::cell::RefCell<Option<(input::TypingRun, Instant)>> = const { std::cell::RefCell::new(None) };
}

/// Refuses to send input once the caller gave up on the action: it was cancelled, or its deadline passed. The reads
/// before an input can take long on a slow app, and input sent after the caller moved on would land unasked.
fn go(what: &str) -> Outcome<()> {
    CURRENT.with(|current| match current.borrow().as_ref() {
        Some((run, _)) if run.cancelled() => Err(Failure::refused(codes::TIMEOUT, format!("{what}: the action was cancelled before its input was sent"))),
        Some((_, deadline)) if Instant::now() >= *deadline => {
            Err(Failure::refused(codes::TIMEOUT, format!("{what}: the action's time ran out before its input was sent")))
        }
        _ => Ok(()),
    })
}

/// Whether the caller cancelled the running action. Unlike `go`, a deadline that passed does not count: cleanup such as
/// closing a menu runs past it, but never past a cancel, after which the caller has moved on.
fn cancelled() -> bool {
    CURRENT.with(|current| current.borrow().as_ref().is_some_and(|(run, _)| run.cancelled()))
}

/// The failure for a read that failed before anything was sent: nothing reached the app. A read the app did not answer
/// in time is a stall, which a retry may get past.
pub(crate) fn unread(error: AXError, what: &str) -> Failure {
    match error {
        ax::AX_CANNOT_COMPLETE => {
            Failure::refused(codes::APP_UNRESPONSIVE, format!("{what}: the app did not answer in time")).with_details(serde_json::json!({ "retryable": true }))
        }
        ax::AX_INVALID_ELEMENT => Failure::refused(codes::STALE_REF, format!("{what}: the element no longer exists")),
        ax::AX_API_DISABLED => Failure::refused(codes::PERM_DENIED, format!("{what}: {}", ax::describe(error))),
        _ => Failure::refused(codes::ACTION_FAILED, format!("{what}: {}", ax::describe(error))),
    }
}

/// A read whose only failure that counts is a stall: the app did not answer in time, which says nothing about the
/// answer and passes up as `AX_CANNOT_COMPLETE`. Any other failure reads as no answer.
pub(crate) fn stalled<T>(read: Result<T, AXError>) -> Result<Option<T>, AXError> {
    match read {
        Ok(value) => Ok(Some(value)),
        Err(ax::AX_CANNOT_COMPLETE) => Err(ax::AX_CANNOT_COMPLETE),
        Err(_) => Ok(None),
    }
}

/// The element an attribute names, such as the app's focused element or key window. A read the app did not answer in
/// time fails as a stall, which a retry may get past, never as focus that moved; any other failure reads as none.
pub(crate) fn element_attribute(element: &Element, name: &str, what: &str) -> Outcome<Option<Element>> {
    Ok(stalled(element.attribute(name)).map_err(|error| unread(error, what))?.and_then(|value| value.element().cloned()))
}

/// Whether `focused`, the app's focused window, holds `window`'s focus (`windows::holds_focus`). A stall fails as one.
pub(crate) fn holds(focused: &Element, window: &Element, what: &str) -> Outcome<bool> {
    windows::holds_focus(focused, window).map_err(|error| unread(error, what))
}

/// Whether an attribute can be set. A stall fails, so a busy app does not read as one whose control takes no input;
/// any other failure reads as not settable.
fn settable(element: &Element, name: &str, what: &str) -> Outcome<bool> {
    match element.settable(name) {
        Ok(settable) => Ok(settable),
        Err(ax::AX_CANNOT_COMPLETE) => Err(unread(ax::AX_CANNOT_COMPLETE, what)),
        Err(_) => Ok(false),
    }
}

/// The actions an element takes. A stall, a gone element, or no permission fails; any other failure reads as none.
fn action_names(element: &Element, what: &str) -> Outcome<Vec<String>> {
    match element.actions() {
        Ok(names) => Ok(names),
        Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT | ax::AX_API_DISABLED)) => Err(unread(error, what)),
        Err(_) => Ok(Vec::new()),
    }
}

/// Every element of an array attribute, however many it holds. A read the app did not answer fails: a list read in
/// part cannot show an option is missing.
fn all(element: &Element, name: &str, what: &str) -> Outcome<Vec<Element>> {
    let count = match element.count(name) {
        Ok(count) => count.max(1),
        Err(ax::AX_CANNOT_COMPLETE) => return Err(unread(ax::AX_CANNOT_COMPLETE, what)),
        // A count the element does not give: read up to a generous cap instead.
        Err(_) => 4096,
    };
    match element.elements(name, count) {
        Ok(elements) => Ok(elements),
        Err(ax::AX_CANNOT_COMPLETE) => Err(unread(ax::AX_CANNOT_COMPLETE, what)),
        Err(_) => Ok(Vec::new()),
    }
}

/// The element a ref names, checked to still exist.
fn resolve(reference: &str) -> Outcome<Entry> {
    let entry = refs::get(reference).ok_or_else(|| Failure::refused(codes::STALE_REF, format!("{reference} names no element of a recent snapshot")))?;
    match entry.element.attribute("AXRole") {
        Err(ax::AX_INVALID_ELEMENT) => Err(Failure::refused(codes::STALE_REF, format!("{reference}: the element no longer exists"))),
        Err(ax::AX_CANNOT_COMPLETE) => {
            Err(Failure::refused(codes::APP_UNRESPONSIVE, "the app did not answer in time").with_details(serde_json::json!({ "retryable": true })))
        }
        _ => Ok(entry),
    }
}

/// Polls `check` until it holds or the effect wait (bounded by the deadline) ends.
fn until(deadline: Instant, mut check: impl FnMut() -> bool) -> bool {
    let end = (Instant::now() + EFFECT_WAIT).min(deadline);
    loop {
        if check() {
            return true;
        }
        if Instant::now() + POLL >= end {
            return check();
        }
        sleep(POLL);
    }
}

/// How long an action that answered with an error is watched for its element going away, the sign that it landed.
const GONE_WAIT: Duration = Duration::from_millis(300);

/// When the watch for an element going away ends: after `GONE_WAIT`, and in time for the answer to reach the caller
/// before the action's deadline. An answer that comes after it is cut off, and reads as an action that may have
/// landed even when the app refused it.
fn gone_wait_end(now: Instant, deadline: Option<Instant>) -> Instant {
    let end = now + GONE_WAIT;
    match deadline {
        Some(deadline) => end.min(deadline.checked_sub(ANSWER_MARGIN).unwrap_or(deadline)),
        None => end,
    }
}

/// Performs an AX action. Once the action is sent, an error answer cannot show that nothing happened, so the element is
/// read again to tell (`answered`).
fn perform(element: &Element, action: &str, what: &str) -> Outcome<()> {
    go(what)?;
    element.set_timeout(BLOCKING_ACTION_SECONDS);
    let result = element.perform(action);
    let outcome = match result {
        Ok(()) => Ok(()),
        Err(error) => {
            let then = match error {
                // "No such attribute" is watched too: a SwiftUI alert's button answers it once its press closed the alert.
                _ if error != ax::AX_ATTRIBUTE_UNSUPPORTED && (refuses(error) || error == ax::AX_INVALID_ELEMENT) => None,
                // The app answers again or not: one read tells, and another would wait out the same stall.
                ax::AX_CANNOT_COMPLETE => element.attribute("AXRole").err(),
                // A press that closes what holds its element (a dismissed alert) can leave it readable a moment more.
                _ => {
                    let deadline = CURRENT.with(|current| current.borrow().as_ref().map(|(_, deadline)| *deadline));
                    let end = gone_wait_end(Instant::now(), deadline);
                    loop {
                        let then = element.attribute("AXRole").err();
                        if then == Some(ax::AX_INVALID_ELEMENT) || Instant::now() >= end {
                            break then;
                        }
                        sleep(POLL);
                    }
                }
            };
            answered(error, then, what)
        }
    };
    element.set_timeout(0.0);
    outcome
}

/// Errors with which the app refuses an action before taking it: no such action or attribute, no permission, a bad
/// argument.
fn refuses(error: AXError) -> bool {
    matches!(error, ax::AX_ACTION_UNSUPPORTED | ax::AX_ATTRIBUTE_UNSUPPORTED | ax::AX_NOT_IMPLEMENTED | ax::AX_API_DISABLED | ax::AX_ILLEGAL_ARGUMENT)
}

/// What an action's error answer means, from the error and a read of the element after it (`then`, its error, `None`
/// when the element still answers):
/// - refused outright: nothing reached the app;
/// - "no such attribute" with the element gone after: a SwiftUI alert's button answers so once its press closed the
///   alert, so it landed; with the element unread after (the button's handler keeps the app busy), it may have landed;
/// - the element gone as the action was sent: the action may have closed what held it, so it may have landed;
/// - gone after: the action closed what held it (an alert's button, a panel's), so it landed;
/// - a timeout while the app still answers: the action opened a menu or a modal and runs inside the app's handler;
/// - a timeout the app does not answer after: it may never have taken the action, delivered but unverified;
/// - any other error: it may have landed, delivered but unverified. The caller reads the effect where it can.
fn answered(error: AXError, then: Option<AXError>, what: &str) -> Outcome<()> {
    match (error, then) {
        (ax::AX_ATTRIBUTE_UNSUPPORTED, Some(ax::AX_INVALID_ELEMENT)) => Ok(()),
        (ax::AX_ATTRIBUTE_UNSUPPORTED, Some(_)) => Err(refused(error, what).delivered()),
        _ if refuses(error) => Err(refused(error, what)),
        (ax::AX_INVALID_ELEMENT, _) => Err(Failure::unconfirmed(codes::ACTION_FAILED, format!("{what}: the element went away as the action was sent"))),
        (_, Some(ax::AX_INVALID_ELEMENT)) => Ok(()),
        (ax::AX_CANNOT_COMPLETE, None) => Ok(()),
        (ax::AX_CANNOT_COMPLETE, Some(_)) => {
            Err(Failure::unconfirmed(codes::APP_UNRESPONSIVE, format!("{what}: the app did not answer the action, or anything after it")))
        }
        (error, _) => Err(refused(error, what).delivered()),
    }
}

/// The element's AX role and its role in the snapshot's vocabulary. A read the app did not answer in time fails as a
/// stall, and a gone element as a stale ref, so either is retried rather than read as a control without the role; any
/// other failure reads as none.
fn role_of(element: &Element, what: &str) -> Outcome<(String, &'static str)> {
    let values = match element.attributes(&["AXRole", "AXSubrole"]) {
        Ok(values) => values,
        // A stall is retried, and so is an element gone since it was resolved: the locator finds its replacement.
        Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT)) => return Err(unread(error, what)),
        Err(_) => vec![None, None],
    };
    let ax_role = values[0].as_ref().and_then(|value| value.text().map(str::to_owned)).unwrap_or_default();
    let subrole = values[1].as_ref().and_then(|value| value.text().map(str::to_owned));
    let role = roles::role(&ax_role, subrole.as_deref());
    Ok((ax_role, role))
}

/// The state a box shows, read as the snapshot reads it, so a check confirms the state an observation would report:
/// `1`, `true`, and `on` are checked, `0` and `off` unchecked, `2` and `mixed` mixed.
fn toggle_state(element: &Element) -> Option<u8> {
    crate::snapshot::parse_toggle(element.attribute("AXValue").ok().as_ref())
}

/// The text a value attribute holds now.
fn value_text(element: &Element) -> Option<String> {
    element.attribute("AXValue").ok().and_then(|value| value.display())
}

/// The element's center on screen.
fn center(element: &Element) -> Outcome<(f64, f64)> {
    let (x, y, width, height) = element.frame().ok_or_else(|| Failure::refused(codes::ACTION_FAILED, "the element has no frame on screen"))?;
    if width <= 0.0 || height <= 0.0 {
        return Err(Failure::refused(codes::ACTION_FAILED, "the element has no area on screen"));
    }
    Ok((x + width / 2.0, y + height / 2.0))
}

/// Brings the window forward and the app with it, for physical input. A sheet or an alert on it may take focus.
pub fn raise(pid: i32, window: &Element) -> Outcome<()> {
    let app = Element::application(pid);
    // Each write moves the focus: none goes once the caller gave up.
    go("bring the window forward")?;
    let _ = app.set_bool("AXFrontmost", true);
    go("bring the window forward")?;
    let _ = window.perform("AXRaise");
    go("bring the window forward")?;
    let _ = window.set_bool("AXMain", true);
    let deadline = Instant::now() + Duration::from_millis(1_500);
    let mut last = Ok(false);
    until(deadline, || {
        last = forward(&app, window);
        last == Ok(true)
    });
    match last {
        Ok(true) => Ok(()),
        // An app that did not answer in time may have come forward: no proof it did not, and a retry may get past it.
        Err(error) => Err(unread(error, "bring the window forward")),
        Ok(false) => Err(Failure::refused(codes::ACTION_FAILED, "the window could not be brought forward")),
    }
}

/// Whether the app is frontmost with `window` holding its focus. A stall fails as `AX_CANNOT_COMPLETE`.
fn forward(app: &Element, window: &Element) -> Result<bool, AXError> {
    if stalled(app.attribute("AXFrontmost"))?.and_then(|value| value.boolean()) != Some(true) {
        return Ok(false);
    }
    match stalled(app.attribute("AXFocusedWindow"))?.and_then(|value| value.element().cloned()) {
        Some(focused) => windows::holds_focus(&focused, window),
        None => Ok(false),
    }
}

/// Waits a moment for a menu an action opened to show, so the next read finds it; an action that opens none waits it out and is still done.
fn menu_shown(pid: i32, before: usize, deadline: Instant) {
    until(deadline.min(Instant::now() + MENU_SHOW_WAIT), || windows::open_menus(pid) > before);
}

/// Waits within the action's budget for a control to be enabled, as an actionability wait does, and refuses it if it
/// stays disabled: a disabled AppKit control may still offer AXPress and acknowledge it while ignoring it. A control
/// with no enabled state goes at once.
fn enabled(element: &Element, deadline: Instant, what: &str) -> Outcome<()> {
    let refuse_at = deadline.checked_sub(ANSWER_MARGIN).unwrap_or(deadline);
    loop {
        match element.attribute("AXEnabled") {
            Ok(value) if value.boolean() == Some(false) => {
                if Instant::now() + POLL >= refuse_at {
                    return Err(Failure::refused(codes::ACTION_FAILED, "the control is disabled"));
                }
                go(what)?;
                sleep(POLL);
            }
            Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT | ax::AX_API_DISABLED)) => return Err(unread(error, what)),
            _ => return Ok(()),
        }
    }
}

/// Brings an element a scroll area holds out of view into view (`AXScrollToVisible`), and waits for it to show. An
/// element already on screen gets nothing; one in a minimized window, one with no size, or one that cannot be scrolled, is refused, as an
/// action on it would reach a control the user cannot. `Ok(true)` when it scrolled the list.
fn reveal(element: &Element, deadline: Instant, what: &str) -> Outcome<bool> {
    use crate::snapshot::{Placement, placement};
    match placement(element).map_err(|error| unread(error, what))? {
        Placement::Shown => return Ok(false),
        Placement::Minimized => {
            return Err(Failure::refused(codes::ACTION_FAILED, "the element's window is minimized, so the user cannot reach it; restore the window first"));
        }
        Placement::Collapsed => return Err(Failure::refused(codes::ACTION_FAILED, "the element has no size on screen, so the user cannot reach it")),
        Placement::ScrolledOut => {}
    }
    if !action_names(element, what)?.iter().any(|name| name == "AXScrollToVisible") {
        return Err(Failure::refused(codes::ACTION_FAILED, "the element is off screen and cannot be scrolled into view; scroll its list first"));
    }
    perform(element, "AXScrollToVisible", "scroll into view")?;
    // A list can replace a row's element as it scrolls the row in: the element is gone then, and no wait shows it.
    let mut gone = false;
    let shown = until(deadline, || match placement(element) {
        Ok(Placement::Shown) => true,
        Err(ax::AX_INVALID_ELEMENT) => {
            gone = true;
            true
        }
        _ => false,
    });
    if gone {
        return Err(Failure::unconfirmed(codes::STALE_REF, "the list replaced the element as it scrolled it into view"));
    }
    if shown {
        return Ok(true);
    }
    Err(Failure::unconfirmed(codes::ACTION_FAILED, "the element is still off screen after it was scrolled into view"))
}

/// What an action did once `reveal` scrolled its list: the scroll moved the app's content, so a failure after it is no
/// longer "nothing sent".
fn after_scroll<T>(scrolled: bool, outcome: Outcome<T>) -> Outcome<T> {
    outcome.map_err(|failure| if scrolled { failure.delivered() } else { failure })
}

fn click(entry: &Entry, deadline: Instant) -> Outcome<()> {
    let element = &entry.element;
    enabled(element, deadline, "click")?;
    // The engine checked the node shows before the call; the wait above can outlast that, as the window minimizes or
    // a list scrolls meanwhile.
    let scrolled = reveal(element, deadline, "click")?;
    after_scroll(scrolled, click_shown(entry, deadline))
}

/// `click` on an element that shows.
fn click_shown(entry: &Entry, deadline: Instant) -> Outcome<()> {
    let element = &entry.element;
    let (ax_role, role) = role_of(element, "click")?;
    // A tap on a text field puts the keyboard there. AppKit's password field also offers AXConfirm, which the action
    // choice below would send in its place, leaving the keyboard in the field before.
    if role == "textfield" && settable(element, "AXFocused", "click")? {
        return focus(element, deadline);
    }
    let names = action_names(element, "click")?;
    if let Some(action) = ["AXPress", "AXOpen", "AXConfirm"].into_iter().find(|name| names.iter().any(|candidate| candidate == name)) {
        // Only a press that opens a menu waits for it, so only it counts the open menus, a read of every window there is.
        let before = (ax_role == "AXPopUpButton" || ax_role == "AXMenuButton").then(|| windows::open_menus(entry.pid));
        perform(element, action, "click")?;
        if let Some(before) = before {
            menu_shown(entry.pid, before, deadline);
        }
        return Ok(());
    }
    // An NSTableView's row is selected through its table (`AXSelectedRows`), and a cell in a row through that row: neither
    // takes a press, and the row's own `AXSelected` may not be writable.
    let row = match role {
        "row" | "treeitem" => Some(element.clone()),
        "cell" => element.element("AXParent").filter(|parent| matches!(parent.text("AXRole").as_deref(), Some("AXRow" | "AXOutlineRow"))),
        _ => None,
    };
    if let Some(row) = row {
        let list = row.element("AXParent");
        if choose_row(list.as_ref(), &row, deadline, "the row did not become selected")? {
            return Ok(());
        }
    }
    if matches!(role, "cell" | "option" | "tab") && settable(element, "AXSelected", "click")? {
        go("select")?;
        element.set_bool("AXSelected", true).map_err(|error| write_failed(error, "select"))?;
        if until(deadline, || element.boolean("AXSelected") == Some(true)) {
            return Ok(());
        }
        return Err(Failure::unconfirmed(codes::ACTION_FAILED, "the element did not become selected"));
    }
    if roles::takes_text(role) && settable(element, "AXFocused", "click")? {
        return focus(element, deadline);
    }
    Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("this {role} takes no click through accessibility")))
}

fn focus(element: &Element, deadline: Instant) -> Outcome<()> {
    // The app's focused element is the one source, as the snapshot reads it: a table's cell reports the table's focus as
    // its own `AXFocused`.
    let holds = || -> Result<bool, AXError> {
        Ok(match element.pid() {
            Some(pid) => {
                stalled(Element::application(pid).attribute("AXFocusedUIElement"))?.and_then(|value| value.element().cloned()).as_ref() == Some(element)
            }
            None => stalled(element.attribute("AXFocused"))?.and_then(|value| value.boolean()) == Some(true),
        })
    };
    // A stall before the write is no proof the element lacks focus: nothing is sent, and a retry may get past it.
    if holds().map_err(|error| unread(error, "focus"))? {
        return Ok(());
    }
    go("focus")?;
    // A focus write that failed after the app took it (a focus handler that replaced the element) may have run its
    // handlers: only a refusal shows nothing was sent, as for `set_value`.
    element.set_bool("AXFocused", true).map_err(|error| write_failed(error, "focus"))?;
    let mut last = Ok(false);
    until(deadline, || {
        last = holds();
        last == Ok(true)
    });
    match last {
        Ok(true) => Ok(()),
        Err(_) => Err(Failure::unconfirmed(codes::APP_UNRESPONSIVE, "focus: the app did not answer in time after the element was focused")),
        Ok(false) => Err(Failure::unconfirmed(codes::ACTION_FAILED, "focus: the element did not take keyboard focus")),
    }
}

/// Runs `work` as the action `input_id` names: until it returns, every input it sends first checks that the action was
/// not cancelled and is still in time (`go`).
fn guarded<T>(input_id: Option<u32>, deadline: Instant, work: impl FnOnce() -> Outcome<T>) -> Outcome<T> {
    CURRENT.with(|current| *current.borrow_mut() = Some((input::TypingRun::start(input_id), deadline)));
    let outcome = work();
    CURRENT.with(|current| current.borrow_mut().take());
    outcome
}

/// Runs one action on the element `reference` names.
pub fn act(reference: &str, action: Action, input_id: Option<u32>, deadline: Instant) -> Outcome<()> {
    guarded(input_id, deadline, || run(reference, action, deadline))
}

fn run(reference: &str, action: Action, deadline: Instant) -> Outcome<()> {
    let entry = resolve(reference)?;
    let element = &entry.element;
    match action {
        Action::Click => click(&entry, deadline),
        // A press on a disabled control is acknowledged and ignored: each wait for it to be enabled, as a tap does. A
        // hover presses nothing, so it goes to a disabled control too.
        Action::DoubleClick => {
            enabled(element, deadline, "double click")?;
            physical(&entry, Pointer::Click { right: false, count: 2 })
        }
        Action::Hover => physical(&entry, Pointer::Move),
        Action::RightClick => {
            enabled(element, deadline, "right click")?;
            // Refused before the scroll below, which would move the list for nothing.
            if !action_names(element, "right click")?.iter().any(|name| name == "AXShowMenu") {
                return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, "this element has no context menu"));
            }
            let scrolled = reveal(element, deadline, "right click")?;
            let before = windows::open_menus(entry.pid);
            after_scroll(scrolled, perform(element, "AXShowMenu", "right click"))?;
            menu_shown(entry.pid, before, deadline);
            Ok(())
        }
        Action::Focus => focus(element, deadline),
        Action::Clear => set_value(element, "", deadline),
        Action::Check(wanted) => check(element, wanted, deadline),
        Action::ScrollTo => reveal(element, deadline, "scroll into view").map(|_| ()),
        Action::SetValue(text) => set_value(element, &text, deadline),
        Action::SelectAll => select_all(element, deadline),
        Action::Select(label) => select(&entry, &label, deadline),
        Action::Scroll { direction, pages } => scroll(element, &direction, pages),
        Action::Type { text, physical } => type_text(&entry, &text, physical, deadline),
    }
}

/// Presses a key combo into a window of `pid`. Without physical input the
/// key goes to the process, which hands it to its key window: the window
/// must be that one. With it, the window comes forward first. No key goes
/// out once `input_id` was cancelled or `deadline` passed.
/// With `focused`, the key goes only while the element that ref names holds the app's focus: a window that came forward
/// can open a sheet that takes it, and a locator's key must reach its own control.
pub fn press(pid: i32, window: u32, combo: &str, physical: bool, focused: Option<&str>, input_id: Option<u32>, deadline: Instant) -> Outcome<()> {
    let combo = input::parse_combo(combo)?;
    guarded(input_id, deadline, || {
        let element = windows::find(pid, window)?;
        let route = if physical {
            raise(pid, &element)?;
            Route::Physical
        } else {
            key_window(pid, &element)?;
            Route::Process(pid)
        };
        let control = match focused {
            Some(reference) => {
                Some(refs::get(reference).ok_or_else(|| Failure::refused(codes::STALE_REF, format!("{reference} names no element of a recent snapshot")))?)
            }
            None => None,
        };
        // A key sent as physical input goes to whatever app is frontmost: the user may have switched apps since the raise,
        // while the app still names its own focused control. The window check waits on the app, so it comes first.
        if physical {
            key_window(pid, &element)?;
        }
        // The control a locator's key is for must hold the app's focus, read after the window check: a sheet that opened
        // during it took the focus, and its default button would take the key.
        if let Some(entry) = &control
            && element_attribute(&Element::application(pid), "AXFocusedUIElement", "press")?.as_ref() != Some(&entry.element)
        {
            return Err(Failure::refused(codes::ACTION_FAILED, "the control lost keyboard focus before the key was sent, so nothing was sent"));
        }
        // The frontmost check is the last read before a physical key, so a switch to another app is still caught.
        if physical && !frontmost(pid)? {
            return Err(Failure::refused(codes::ACTION_FAILED, "another app came forward before the key was sent, so nothing was sent"));
        }
        go("press")?;
        input::press(&combo, route).map_err(Failure::delivered)
    })
}

/// Whether the app is the frontmost one. A read the app did not answer in time is a stall.
fn frontmost(pid: i32) -> Outcome<bool> {
    match Element::application(pid).attribute("AXFrontmost") {
        Ok(value) => Ok(value.boolean() == Some(true)),
        Err(error) if error == ax::AX_CANNOT_COMPLETE => Err(unread(error, "read whether the app is frontmost")),
        Err(_) => Ok(false),
    }
}

/// Refuses unless `window` is the app's key window, or holds the focused sheet or alert: a key or text sent to the app
/// goes to its key window, and would land in another one.
fn key_window(pid: i32, window: &Element) -> Outcome<()> {
    if let Some(focused) = element_attribute(&Element::application(pid), "AXFocusedWindow", "read the app's key window")?
        && holds(&focused, window, "read the app's key window")?
    {
        return Ok(());
    }
    Err(Failure::refused(codes::ACTION_FAILED, "the window is not the app's key window, so a key sent to the app would land elsewhere")
        .with_details(serde_json::json!({ "cause": "exact_window_focus_unconfirmed" })))
}

/// Brings a window of `pid` forward, only while `input_id` is not cancelled and `deadline` has not passed: finding the
/// window can wait on the app, and the caller may have moved on by then.
pub fn focus_window(pid: i32, window: u32, input_id: Option<u32>, deadline: Instant) -> Outcome<()> {
    guarded(input_id, deadline, || {
        // A call given up on before it began reads nothing either.
        go("bring the window forward")?;
        let element = windows::find(pid, window)?;
        raise(pid, &element)
    })
}

/// Closes a window of `pid` as its close button does, and waits for it to leave the app's windows. A window that asks
/// before it closes (unsaved changes) stays open: the press landed, and the failure says so.
pub fn close_window(pid: i32, window: u32, input_id: Option<u32>, deadline: Instant) -> Outcome<()> {
    guarded(input_id, deadline, || {
        // A call given up on before it began reads nothing either.
        go("close the window")?;
        let element = windows::find(pid, window)?;
        let Some(button) = element.element("AXCloseButton") else {
            return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, "the window has no close button"));
        };
        if button.boolean("AXEnabled") == Some(false) {
            return Err(Failure::refused(codes::ACTION_FAILED, "the window's close button is disabled, as it is while a sheet is open on the window"));
        }
        // A press that closes its own window may answer with an error: the window lists tell whether it closed.
        let pressed = perform(&button, "AXPress", "close the window");
        if until(deadline, || windows::closed(pid, window)) {
            return Ok(());
        }
        pressed?;
        Err(Failure::unconfirmed(codes::ACTION_FAILED, "the window stayed open after its close button was pressed; it may be asking to save its changes"))
    })
}

#[cfg(test)]
mod tests {
    use super::{press_to_state, step_to};
    use crate::failure::Outcome;
    use std::cell::Cell;
    use std::time::{Duration, Instant};

    /// An AppKit box with mixed state: each press moves it mixed, on, off, mixed.
    fn appkit_box(start: u8) -> (Cell<u8>, Cell<usize>) {
        (Cell::new(start), Cell::new(0))
    }

    fn drive(target: u8, start: u8) -> (Outcome<bool>, u8, usize) {
        let (state, presses) = appkit_box(start);
        let outcome = press_to_state(
            target,
            Some(state.get()),
            || {
                presses.set(presses.get() + 1);
                state.set(match state.get() {
                    2 => 1,
                    1 => 0,
                    _ => 2,
                });
                Ok(())
            },
            || Some(state.get()),
        );
        (outcome, state.get(), presses.get())
    }

    #[test]
    fn unchecks_a_mixed_box_in_two_presses() {
        let (outcome, state, presses) = drive(0, 2);
        assert!(outcome.unwrap());
        assert_eq!((state, presses), (0, 2));
    }

    #[test]
    fn checks_a_mixed_box_in_one_press_and_leaves_a_checked_box_alone() {
        assert_eq!(drive(1, 2).1, 1);
        assert_eq!(drive(1, 2).2, 1);
        assert_eq!(drive(1, 1).2, 0);
    }

    #[test]
    fn steps_a_stepper_up_and_down_to_the_value() {
        for (start, target, presses) in [(1.0, 3.0, 2), (5.0, 2.0, 3), (4.0, 4.0, 0)] {
            let value = Cell::new(start);
            let count = Cell::new(0);
            let reached = step_to(
                target,
                Some(start),
                later(),
                |up| {
                    count.set(count.get() + 1);
                    value.set(value.get() + if up { 1.0 } else { -1.0 });
                    Ok(())
                },
                || Some(value.get()),
            );
            assert!(reached.unwrap());
            assert_eq!((value.get(), count.get()), (target, presses));
        }
    }

    #[test]
    fn stops_a_stepper_that_steps_past_the_value_or_does_not_move() {
        let value = Cell::new(0.0);
        let past = step_to(
            3.0,
            Some(0.0),
            later(),
            |up| {
                value.set(value.get() + if up { 2.0 } else { -2.0 });
                Ok(())
            },
            || Some(value.get()),
        );
        let failure = past.expect_err("2 does not divide 3");
        assert_eq!(failure.delivery, crate::failure::Delivery::Unknown);
        assert!(failure.message.contains("stepped back to where it started"), "{}", failure.message);
        assert!(!failure.message.contains('3'), "names no value: {}", failure.message);
        assert_eq!(value.get(), 0.0);
        let count = Cell::new(0);
        let stuck = step_to(
            3.0,
            Some(0.0),
            later(),
            |_| {
                count.set(count.get() + 1);
                Ok(())
            },
            || Some(0.0),
        );
        assert!(!stuck.unwrap());
        assert_eq!(count.get(), 1);
    }

    /// A deadline the test never reaches.
    fn later() -> Instant {
        Instant::now() + Duration::from_secs(60)
    }

    #[test]
    fn counts_a_write_the_app_answered_with_anything_but_a_refusal_as_delivered() {
        use super::write_failed;
        use crate::failure::Delivery;
        assert_eq!(write_failed(crate::ax::AX_INVALID_ELEMENT, "set value").delivery, Delivery::Unknown, "a handler replaced the element");
        assert_eq!(write_failed(crate::ax::AX_ATTRIBUTE_UNSUPPORTED, "set value").delivery, Delivery::NotDelivered);
        assert_eq!(write_failed(crate::ax::AX_API_DISABLED, "set value").delivery, Delivery::NotDelivered);
    }

    #[test]
    fn counts_a_failure_after_a_scroll_into_view_as_delivered() {
        use super::after_scroll;
        use crate::failure::{Delivery, Failure, codes};
        let refused = || Err::<(), _>(Failure::refused(codes::ACTION_NOT_SUPPORTED, "no press"));
        assert_eq!(after_scroll(false, refused()).expect_err("refused").delivery, Delivery::NotDelivered);
        assert_eq!(after_scroll(true, refused()).expect_err("refused").delivery, Delivery::Unknown, "the list moved");
        assert!(after_scroll(true, Ok(())).is_ok());
    }

    #[test]
    fn stops_stepping_at_the_deadline_and_says_the_steps_landed() {
        let value = Cell::new(0.0);
        let steps = Cell::new(0);
        let deadline = Instant::now() + Duration::from_millis(30);
        let outcome = step_to(
            400.0,
            Some(0.0),
            deadline,
            |_| {
                steps.set(steps.get() + 1);
                std::thread::sleep(Duration::from_millis(10));
                value.set(value.get() + 1.0);
                Ok(())
            },
            || Some(value.get()),
        );
        let failure = outcome.expect_err("it ran out of time");
        assert_eq!(failure.code, crate::failure::codes::TIMEOUT);
        assert_eq!(failure.delivery, crate::failure::Delivery::Unknown);
        assert!(steps.get() < 10, "{} steps", steps.get());
        let none = step_to(3.0, Some(0.0), Instant::now(), |_| panic!("no step past the deadline"), || Some(0.0));
        assert_eq!(none.expect_err("out of time").delivery, crate::failure::Delivery::NotDelivered);
    }

    #[test]
    fn sends_no_input_once_the_action_was_cancelled_or_ran_out_of_time() {
        // Ids near the input tests' ids: tests share one registry, and a run 4096 ids past another drops that one's mark.
        let set =
            |id: u32, deadline: Instant| super::CURRENT.with(|current| *current.borrow_mut() = Some((crate::input::TypingRun::start(Some(id)), deadline)));
        crate::input::cancel_input(1_000_031);
        set(1_000_031, later());
        assert!(super::go("press").is_err());
        set(1_000_032, Instant::now());
        assert!(super::go("press").is_err());
        set(1_000_033, later());
        assert!(super::go("press").is_ok());
        super::CURRENT.with(|current| current.borrow_mut().take());
    }

    #[test]
    fn sends_nothing_to_close_a_menu_once_the_caller_cancelled() {
        use super::close_menu_with;
        let sent = Cell::new(0);
        // Cancelled before the cleanup: neither AXCancel nor Escape, and the menu is reported as it is.
        let open = close_menu_with(
            || true,
            || false,
            || {
                sent.set(sent.get() + 1);
                true
            },
            || sent.set(sent.get() + 1),
        );
        assert_eq!((open, sent.get()), (false, 0));
        // Cancelled while the menu was watched after AXCancel: no Escape follows.
        let calls = Cell::new(0);
        let stopped = || {
            calls.set(calls.get() + 1);
            calls.get() > 1
        };
        let escaped = Cell::new(false);
        assert!(!close_menu_with(stopped, || false, || false, || escaped.set(true)));
        assert!(!escaped.get());
        // Not cancelled: a menu that ignored AXCancel gets Escape, and is closed by it.
        let menu_open = Cell::new(true);
        assert!(close_menu_with(|| false, || !menu_open.get(), || false, || menu_open.set(false)));
    }

    #[test]
    fn brings_no_window_forward_once_the_call_was_cancelled() {
        crate::input::cancel_input(1_000_039);
        // No such process: past the guard, the window lookup would answer APP_NOT_FOUND or WINDOW_NOT_FOUND instead.
        let failure = super::focus_window(-1, 1, Some(1_000_039), later()).expect_err("cancelled first");
        assert_eq!((failure.code, failure.delivery), (crate::failure::codes::TIMEOUT, crate::failure::Delivery::NotDelivered));
        let late = super::focus_window(-1, 1, Some(1_000_040), Instant::now()).expect_err("out of time");
        assert_eq!(late.code, crate::failure::codes::TIMEOUT);
    }

    #[test]
    fn stops_scanning_a_list_once_the_caller_cancelled() {
        use super::scan;
        let read = Cell::new(0);
        let outcome = super::guarded(Some(1_000_051), later(), || {
            scan(vec![1, 2, 3], "read the list's rows", 1, |_| {
                read.set(read.get() + 1);
                crate::input::cancel_input(1_000_051);
                Ok(false)
            })
        });
        assert_eq!(outcome.expect_err("cancelled during the scan").code, crate::failure::codes::TIMEOUT);
        assert_eq!(read.get(), 1, "no row read after the cancel");
        // Not cancelled: the first matches up to the limit, and a stall on the way is reported with a miss.
        let found = super::guarded(Some(1_000_052), later(), || scan(vec![1, 2, 3], "scan", 1, |item| Ok(*item >= 2))).expect("scanned");
        assert_eq!(found, (vec![2], false));
        let both = super::guarded(Some(1_000_054), later(), || scan(vec![1, 2, 3, 4], "scan", 2, |item| Ok(*item >= 2))).expect("scanned");
        assert_eq!(both, (vec![2, 3], false), "a second match is found, and the scan stops there");
        let missed = super::guarded(Some(1_000_053), later(), || {
            scan(vec![1, 2], "scan", 1, |item| if *item == 1 { Err(crate::ax::AX_CANNOT_COMPLETE) } else { Ok(false) })
        })
        .expect("scanned");
        assert_eq!(missed, (vec![], true));
    }

    #[test]
    fn refuses_to_uncheck_a_selected_radio_button_before_pressing_it() {
        use super::clears_only_by_another;
        assert!(clears_only_by_another("radiobutton", false, Some(1)));
        assert!(!clears_only_by_another("radiobutton", false, Some(0)), "already clear: nothing to press");
        assert!(!clears_only_by_another("radiobutton", true, Some(0)), "a check selects it");
        assert!(!clears_only_by_another("checkbox", false, Some(1)), "a box unchecks itself");
    }

    #[test]
    fn counts_a_cancel_but_not_a_deadline_as_the_caller_moving_on() {
        assert!(!super::cancelled(), "no action runs");
        let during = |id: u32, deadline: Instant| super::guarded(Some(id), deadline, || Ok(super::cancelled())).expect("the check fails nothing");
        assert!(!during(1_000_037, Instant::now()), "a deadline that passed is no cancel");
        crate::input::cancel_input(1_000_038);
        assert!(during(1_000_038, later()));
    }

    #[test]
    fn sends_no_click_when_the_action_is_cancelled_during_the_hit_test() {
        use super::Aim;
        let outcome = super::guarded(Some(1_000_034), later(), || {
            super::still_aimed(|| {
                crate::input::cancel_input(1_000_034);
                Ok(Aim::Target)
            })
        });
        let failure = outcome.expect_err("cancelled while the hit test waited on the app");
        assert_eq!((failure.code, failure.delivery), (crate::failure::codes::TIMEOUT, crate::failure::Delivery::NotDelivered));
        let missed = super::guarded(Some(1_000_035), later(), || super::still_aimed(|| Ok(Aim::Other))).expect_err("the point hits another element");
        assert_eq!(missed.code, crate::failure::codes::ACTION_FAILED);
        assert!(super::guarded(Some(1_000_036), later(), || super::still_aimed(|| Ok(Aim::Target))).is_ok());
    }

    #[test]
    fn takes_a_control_at_a_point_unless_the_point_is_on_a_node_with_no_click_of_its_own() {
        use super::{Aim, point_lands};
        assert!(point_lands(Ok(Aim::Control), false).is_ok());
        assert!(point_lands(Ok(Aim::Target), true).is_ok());
        let revealed = point_lands(Ok(Aim::Control), true).expect_err("a control came over the node");
        assert_eq!((revealed.code, revealed.delivery), (crate::failure::codes::ACTION_FAILED, crate::failure::Delivery::NotDelivered));
        assert!(point_lands(Ok(Aim::Other), false).is_err());
        assert_eq!(point_lands(Err(crate::ax::AX_CANNOT_COMPLETE), false).expect_err("a stall").code, crate::failure::codes::APP_UNRESPONSIVE);
    }

    #[test]
    fn sends_a_coordinate_click_only_while_its_window_takes_it() {
        use super::{Sheet, takes_point};
        let key = |text: &str| Sheet::Key(text.to_owned());
        assert!(takes_point(true, true, &Sheet::None, &Sheet::None).is_ok());
        // A sheet that held the focus when the point was taken is where the point was taken, by window id or element.
        assert!(takes_point(true, true, &key("7"), &key("7")).is_ok());
        assert!(takes_point(true, true, &key("ax-1f"), &key("ax-1f")).is_ok());
        for (frontmost, holds, now, then) in [
            (false, true, Sheet::None, Sheet::None),
            (true, false, Sheet::None, Sheet::None),
            (true, true, key("7"), Sheet::None),
            (true, true, Sheet::None, key("7")),
            (true, true, key("8"), key("7")),
            (true, true, key("ax-2a"), key("7")),
            // A sheet the caller could name no key for is never known to be the same one.
            (true, true, key("7"), Sheet::Unnamed),
        ] {
            let refused = takes_point(frontmost, holds, &now, &then).expect_err("another window, sheet, or app would take the click");
            assert_eq!((refused.code, refused.delivery), (crate::failure::codes::ACTION_FAILED, crate::failure::Delivery::NotDelivered));
        }
    }

    #[test]
    fn tells_a_stalled_hit_test_and_a_control_inside_the_element_from_a_covering_element() {
        use super::{Aim, aim_along, aimed};
        use crate::failure::codes;
        let walk = |steps: Vec<Result<(bool, &str), crate::ax::AXError>>| {
            let mut steps = steps.into_iter();
            aim_along(move || steps.next().map(|step| step.map(|(target, role)| (target, super::presses(role)))))
        };
        // A row's text cell is content of the row; its inline button is a control of its own.
        assert_eq!(walk(vec![Ok((false, "AXStaticText")), Ok((false, "AXCell")), Ok((true, ""))]), Ok(Aim::Target));
        assert_eq!(walk(vec![Ok((false, "AXStaticText")), Ok((false, "AXButton")), Ok((true, ""))]), Ok(Aim::Control));
        assert_eq!(walk(vec![Ok((false, "AXButton")), Ok((false, "AXWindow"))]), Ok(Aim::Other));
        // An image is decoration unless it offers a press: then it is a button of its own.
        let image = |actions: Result<Vec<String>, crate::ax::AXError>| super::takes_click("AXImage", move || actions);
        assert_eq!(image(Ok(vec!["AXPress".into()])), Ok(true));
        assert_eq!(image(Ok(vec!["AXShowMenu".into()])), Ok(false));
        assert_eq!(image(Err(crate::ax::AX_ACTION_UNSUPPORTED)), Ok(false));
        assert_eq!(image(Err(crate::ax::AX_CANNOT_COMPLETE)), Err(crate::ax::AX_CANNOT_COMPLETE));
        assert_eq!(super::takes_click("AXSeparator", || panic!("no action read for a role that tells")), Ok(false));
        // A text label is content unless the app made it a button of its own.
        assert_eq!(super::takes_click("AXStaticText", || Ok(vec![])), Ok(false));
        assert_eq!(super::takes_click("AXStaticText", || Ok(vec!["AXPress".into()])), Ok(true));
        // A custom control drawn in a group, which offers a press, is a control of its own too.
        assert_eq!(super::takes_click("AXGroup", || Ok(vec!["AXPress".into()])), Ok(true));
        // An open or a confirm takes a click as a press does.
        assert_eq!(super::takes_click("AXGroup", || Ok(vec!["AXOpen".into()])), Ok(true));
        assert_eq!(super::takes_click("AXGroup", || Ok(vec!["AXConfirm".into()])), Ok(true));
        assert_eq!(super::takes_click("AXGroup", || Ok(vec!["AXScrollToVisible".into()])), Ok(false));
        // An inline editor of a row takes a double-click of its own.
        for editor in ["AXTextField", "AXComboBox", "AXTextArea"] {
            assert_eq!(walk(vec![Ok((false, editor)), Ok((false, "AXCell")), Ok((true, ""))]), Ok(Aim::Control), "{editor}");
        }
        assert_eq!(walk(vec![Ok((false, "AXStaticText")), Err(crate::ax::AX_CANNOT_COMPLETE)]), Err(crate::ax::AX_CANNOT_COMPLETE));
        // A click refuses the control, a hover does not; a stall is a retryable stall, not a covering element.
        assert_eq!(aimed(Ok(Aim::Control), true, "after the move").expect_err("the click would press the button").code, codes::ACTION_FAILED);
        assert!(aimed(Ok(Aim::Control), false, "before the move").is_ok());
        let stall = aimed(Err(crate::ax::AX_CANNOT_COMPLETE), true, "after the move").expect_err("the app did not answer");
        assert_eq!((stall.code, stall.delivery), (codes::APP_UNRESPONSIVE, crate::failure::Delivery::NotDelivered));
    }

    #[test]
    fn says_a_select_menu_that_stayed_open_reached_the_app() {
        use crate::failure::{Delivery, Failure, codes};
        let stall = || super::unread(crate::ax::AX_CANNOT_COMPLETE, "read the list's options");
        let closed = super::unclosed(stall(), true);
        assert_eq!((closed.delivery, closed.details.as_ref().and_then(|details| details.get("menu"))), (Delivery::NotDelivered, None));
        let open = super::unclosed(stall(), false);
        assert_eq!(open.delivery, Delivery::Unknown);
        assert_eq!(open.details.and_then(|details| details.get("menu").cloned()), Some(serde_json::json!("open")));
        let missing = super::unclosed(Failure::refused(codes::ELEMENT_NOT_FOUND, "no option"), false);
        assert_eq!((missing.code, missing.delivery), (codes::ELEMENT_NOT_FOUND, Delivery::Unknown));
    }

    #[test]
    fn stops_a_stepper_that_wraps_around_its_range() {
        // 0 to 10, and one step up from 10 goes to 0: 11 is never reached.
        let value = Cell::new(10.0);
        let presses = Cell::new(0);
        let wrapped = step_to(
            11.0,
            Some(10.0),
            later(),
            |up| {
                presses.set(presses.get() + 1);
                value.set(if up { if value.get() >= 10.0 { 0.0 } else { value.get() + 1.0 } } else { value.get() - 1.0 });
                Ok(())
            },
            || Some(value.get()),
        );
        assert_eq!(wrapped.expect_err("wraps").delivery, crate::failure::Delivery::Unknown);
        assert_eq!(presses.get(), 1);
    }

    #[test]
    fn steps_by_a_fraction_to_a_value_it_reaches_only_up_to_rounding() {
        let value = Cell::new(0.0);
        let reached = step_to(
            0.3,
            Some(0.0),
            later(),
            |up| {
                value.set(value.get() + if up { 0.1 } else { -0.1 });
                Ok(())
            },
            || Some(value.get()),
        );
        assert!(reached.unwrap());
    }

    #[test]
    fn refuses_a_stepper_target_outside_the_range_it_reports() {
        use super::outside;
        assert!(outside(11.0, Some(0.0), Some(10.0)));
        assert!(outside(-1.0, Some(0.0), Some(10.0)));
        // The bounds themselves are in range.
        assert!(!outside(10.0, Some(0.0), Some(10.0)));
        assert!(!outside(0.0, Some(0.0), Some(10.0)));
        // A bound the stepper does not report limits nothing.
        assert!(!outside(1e9, Some(0.0), None));
        assert!(!outside(-1e9, None, Some(10.0)));
    }

    #[test]
    fn tells_a_large_value_from_the_next_step_after_it() {
        assert!(!super::same(1_800_000_000.0, 1_800_000_001.0, None));
        // Whole numbers past the reach of a relative tolerance (a Unix time in microseconds) still differ by one.
        assert!(!super::same(1_800_000_000_000_000.0, 1_800_000_000_000_001.0, None));
        assert!(super::same(0.1 + 0.1 + 0.1, 0.3, None));
        // A step smaller than the rounding allowance of a large value is still a step, once a press showed its size.
        assert!(super::same(1_800_000_000.0, 1_800_000_000.000_01, None));
        assert!(!super::same(1_800_000_000.0, 1_800_000_000.000_01, Some(0.000_01)));
        let value = Cell::new(1_800_000_000.0);
        let reached = step_to(
            1_800_000_001.0,
            Some(value.get()),
            later(),
            |up| {
                value.set(value.get() + if up { 1.0 } else { -1.0 });
                Ok(())
            },
            || Some(value.get()),
        );
        assert!(reached.unwrap());
        assert_eq!(value.get(), 1_800_000_001.0);
    }

    #[test]
    fn steps_a_large_value_by_a_step_smaller_than_its_rounding_allowance() {
        let small = 0.000_01;
        let value = Cell::new(1_800_000_000.0);
        let target = 1_800_000_000.0 + small;
        let presses = Cell::new(0);
        let reached = step_to(
            target,
            Some(value.get()),
            later(),
            |up| {
                presses.set(presses.get() + 1);
                value.set(value.get() + if up { small } else { -small });
                Ok(())
            },
            || Some(value.get()),
        );
        assert!(reached.unwrap());
        assert_eq!((value.get(), presses.get()), (target, 1));
    }

    #[test]
    fn leaves_a_value_that_differs_from_the_target_only_by_rounding_as_it_was() {
        let summed = 0.1 + 0.1 + 0.1;
        let value = Cell::new(summed);
        let presses = Cell::new(0);
        let reached = step_to(
            0.3,
            Some(value.get()),
            later(),
            |up| {
                presses.set(presses.get() + 1);
                value.set(value.get() + if up { 0.1 } else { -0.1 });
                Ok(())
            },
            || Some(value.get()),
        );
        assert!(reached.unwrap());
        // One step to learn the step's size, one back.
        assert_eq!(presses.get(), 2);
        assert!(super::same(value.get(), summed, Some(0.1)));
        // A stepper already at the exact value gets no press.
        assert!(step_to(0.3, Some(0.3), later(), |_| panic!("no press"), || Some(0.3)).unwrap());
    }

    /// A failure that answered after the input was sent.
    fn landed_with_an_error() -> crate::failure::Failure {
        crate::failure::Failure::unconfirmed(crate::failure::codes::ACTION_FAILED, "the app's accessibility answered with a failure")
    }

    #[test]
    fn judges_a_press_that_answered_with_an_error_by_the_state_it_led_to() {
        let state = Cell::new(0);
        let toggled = press_to_state(
            1,
            Some(0),
            || {
                state.set(1);
                Err(landed_with_an_error())
            },
            || Some(state.get()),
        );
        assert!(toggled.unwrap());
        let unchanged = press_to_state(1, Some(0), || Err(landed_with_an_error()), || Some(0));
        assert_eq!(unchanged.expect_err("nothing changed").delivery, crate::failure::Delivery::Unknown);
        let value = Cell::new(1.0);
        let stepped = step_to(
            3.0,
            Some(1.0),
            later(),
            |_| {
                value.set(value.get() + 1.0);
                if value.get() == 2.0 { Err(landed_with_an_error()) } else { Ok(()) }
            },
            || Some(value.get()),
        );
        assert!(stepped.unwrap());
    }

    #[test]
    fn reads_an_action_answer_by_whether_the_element_stayed() {
        use crate::ax::{AX_ACTION_UNSUPPORTED, AX_ATTRIBUTE_UNSUPPORTED, AX_CANNOT_COMPLETE, AX_FAILURE, AX_INVALID_ELEMENT};
        use crate::failure::{Delivery, codes};
        let answer = |error, then| super::answered(error, then, "press");
        for refused in [AX_ACTION_UNSUPPORTED, AX_ATTRIBUTE_UNSUPPORTED] {
            assert_eq!(answer(refused, None).expect_err("refused").delivery, Delivery::NotDelivered);
        }
        assert!(answer(AX_FAILURE, Some(AX_INVALID_ELEMENT)).is_ok(), "gone after the press: it closed its alert");
        assert!(answer(AX_ATTRIBUTE_UNSUPPORTED, Some(AX_INVALID_ELEMENT)).is_ok(), "a SwiftUI alert's button, gone after the press");
        for unread in [AX_CANNOT_COMPLETE, AX_FAILURE] {
            let busy = answer(AX_ATTRIBUTE_UNSUPPORTED, Some(unread)).expect_err("unread after: no proof the element stayed");
            assert_eq!(busy.delivery, Delivery::Unknown);
        }
        assert_eq!(answer(AX_ACTION_UNSUPPORTED, Some(AX_INVALID_ELEMENT)).expect_err("no such action").delivery, Delivery::NotDelivered);
        assert!(answer(AX_CANNOT_COMPLETE, None).is_ok(), "a modal runs in the press's handler");
        let stalled = answer(AX_CANNOT_COMPLETE, Some(AX_CANNOT_COMPLETE)).expect_err("no answer after");
        assert_eq!((stalled.code, stalled.delivery), (codes::APP_UNRESPONSIVE, Delivery::Unknown));
        let failed = answer(AX_FAILURE, None).expect_err("still there");
        assert_eq!((failed.code, failed.delivery), (codes::ACTION_FAILED, Delivery::Unknown));
        let gone = answer(AX_INVALID_ELEMENT, None).expect_err("went away as it was sent");
        assert_eq!(gone.delivery, Delivery::Unknown);
    }

    #[test]
    fn stops_watching_for_a_gone_element_in_time_to_answer() {
        use super::{ANSWER_MARGIN, GONE_WAIT, gone_wait_end};
        let now = Instant::now();
        assert_eq!(gone_wait_end(now, None), now + GONE_WAIT);
        assert_eq!(gone_wait_end(now, Some(now + Duration::from_secs(5))), now + GONE_WAIT);
        let soon = now + ANSWER_MARGIN + Duration::from_millis(40);
        assert_eq!(gone_wait_end(now, Some(soon)), now + Duration::from_millis(40));
    }

    #[test]
    fn fails_a_stepper_value_read_that_stalled_or_went_away_before_any_step() {
        use super::shown_number;
        use crate::ax::{AX_CANNOT_COMPLETE, AX_FAILURE, AX_INVALID_ELEMENT, Value};
        use crate::failure::{Delivery, codes};
        assert_eq!(shown_number(Ok(Value::Number(4.0)), "set value").unwrap(), Some(4.0));
        assert_eq!(shown_number(Ok(Value::Text("four".into())), "set value").unwrap(), None);
        assert_eq!(shown_number(Err(AX_FAILURE), "set value").unwrap(), None);
        let stall = shown_number(Err(AX_CANNOT_COMPLETE), "set value").expect_err("a stall");
        assert_eq!((stall.code, stall.delivery), (codes::APP_UNRESPONSIVE, Delivery::NotDelivered));
        let gone = shown_number(Err(AX_INVALID_ELEMENT), "set value").expect_err("gone");
        assert_eq!((gone.code, gone.delivery), (codes::STALE_REF, Delivery::NotDelivered));
    }

    #[test]
    fn reads_a_stall_as_one_and_any_other_failure_as_no_answer() {
        use super::stalled;
        use crate::ax::{AX_CANNOT_COMPLETE, AX_FAILURE, AX_INVALID_ELEMENT, AX_NO_VALUE};
        assert_eq!(stalled(Ok(3)), Ok(Some(3)));
        assert_eq!(stalled::<i32>(Err(AX_CANNOT_COMPLETE)), Err(AX_CANNOT_COMPLETE));
        for none in [AX_FAILURE, AX_INVALID_ELEMENT, AX_NO_VALUE] {
            assert_eq!(stalled::<i32>(Err(none)), Ok(None), "{none}");
        }
        // The stall reaches the engine as one it may retry.
        let failure = super::unread(AX_CANNOT_COMPLETE, "type");
        assert_eq!((failure.code, failure.delivery), (crate::failure::codes::APP_UNRESPONSIVE, crate::failure::Delivery::NotDelivered));
        assert_eq!(failure.details, Some(serde_json::json!({ "retryable": true })));
    }

    #[test]
    fn names_no_value_in_any_stepper_failure() {
        let digitless = |failure: crate::failure::Failure| {
            assert!(!failure.message.chars().any(|c| c.is_ascii_digit()), "names a value: {}", failure.message);
        };
        // Wraps: one step up from 42 goes to 0.
        let value = Cell::new(42.0);
        digitless(
            step_to(
                43.0,
                Some(42.0),
                later(),
                |_| {
                    value.set(0.0);
                    Ok(())
                },
                || Some(value.get()),
            )
            .expect_err("wraps"),
        );
        // Steps past and back: 40, 42, 44 past 43, then back to 40.
        let value = Cell::new(40.0);
        digitless(
            step_to(
                43.0,
                Some(40.0),
                later(),
                |up| {
                    value.set(value.get() + if up { 2.0 } else { -2.0 });
                    Ok(())
                },
                || Some(value.get()),
            )
            .expect_err("past"),
        );
        // Steps past and cannot go back.
        let value = Cell::new(40.0);
        digitless(
            step_to(
                43.0,
                Some(40.0),
                later(),
                |up| {
                    if up {
                        value.set(value.get() + 2.0)
                    }
                    Ok(())
                },
                || Some(value.get()),
            )
            .expect_err("stuck past"),
        );
        // Already showed the target up to rounding, and the step to tell it left it changed.
        let summed = 0.1 + 0.1 + 0.1;
        let value = Cell::new(summed);
        digitless(
            step_to(
                0.3,
                Some(summed),
                later(),
                |up| {
                    if !up {
                        value.set(value.get() - 0.1)
                    }
                    Ok(())
                },
                || Some(value.get()),
            )
            .expect_err("left changed"),
        );
        // Out of time before the first step.
        digitless(step_to(43.0, Some(40.0), Instant::now(), |_| Ok(()), || Some(40.0)).expect_err("no time"));
    }

    #[test]
    fn takes_only_a_finite_number() {
        assert_eq!(super::finite(" 3 "), Ok(3.0));
        for text in ["NaN", "inf", "-infinity", "three"] {
            assert!(super::finite(text).is_err(), "{text}");
        }
    }

    #[test]
    fn stops_when_a_press_changes_nothing_or_the_state_cannot_be_read() {
        let presses = Cell::new(0);
        let stuck = press_to_state(
            1,
            Some(0),
            || {
                presses.set(presses.get() + 1);
                Ok(())
            },
            || Some(0),
        );
        assert!(!stuck.unwrap());
        assert_eq!(presses.get(), 1);
        let unreadable = press_to_state(1, None, || Ok(()), || None);
        assert!(!unreadable.unwrap());
    }

    #[test]
    fn lets_a_scroll_area_scroll_itself_only_with_a_scroll_bar_for_the_axis() {
        let pages = |names: &[&str]| names.iter().map(|name| (*name).to_owned()).collect::<Vec<_>>();
        let swiftui = pages(&["AXScrollDownByPage", "AXScrollUpByPage", "AXScrollLeftByPage", "AXScrollRightByPage"]);
        // A SwiftUI scroll area offers every page action: only its scroll bar for the axis says it scrolls along it.
        assert!(!super::scroll::scrolls_itself("scrollarea", false, &swiftui, "down"));
        assert!(super::scroll::scrolls_itself("scrollarea", true, &swiftui, "down"));
        assert!(super::scroll::scrolls_itself("scrollarea", true, &[], "left"));
        // Any other role scrolls itself by the page action for the direction.
        assert!(super::scroll::scrolls_itself("list", false, &pages(&["AXScrollDownByPage"]), "down"));
        assert!(!super::scroll::scrolls_itself("list", false, &pages(&["AXScrollDownByPage"]), "right"));
        assert!(!super::scroll::scrolls_itself("list", false, &[], "up"));
    }

    #[test]
    fn confirms_no_secure_fill_by_a_field_that_went_away_or_did_not_answer() {
        use crate::ax::{AX_ATTRIBUTE_UNSUPPORTED, AX_CANNOT_COMPLETE, AX_INVALID_ELEMENT, Value};
        assert_eq!(super::secure_count(Ok(Value::Number(8.0))), Ok(Some(8)));
        // A field that counts none is taken at the write's word.
        assert_eq!(super::secure_count(Err(AX_ATTRIBUTE_UNSUPPORTED)), Ok(None));
        assert_eq!(super::secure_count(Err(AX_CANNOT_COMPLETE)), Err(()));
        assert_eq!(super::secure_count(Err(AX_INVALID_ELEMENT)), Err(()));
    }

    /// A node of a fake accessibility tree, for the text gathering that names a row.
    #[derive(Clone)]
    struct Fake {
        role: &'static str,
        label: Option<&'static str>,
        children: Vec<Fake>,
    }

    fn fake(role: &'static str, label: Option<&'static str>, children: Vec<Fake>) -> Fake {
        Fake { role, label, children }
    }

    fn gathered(row: &Fake) -> Option<String> {
        let mut texts = Vec::new();
        super::gather_texts(row, 0, &mut texts, &|node: &Fake| Ok(node.children.clone()), &|node: &Fake| Ok(node.role), &|node: &Fake| {
            Ok(node.label.map(str::to_owned))
        })
        .expect("read");
        crate::snapshot::content_name(&texts)
    }

    #[test]
    fn names_a_row_from_the_texts_under_its_texts_as_the_snapshot_does() {
        // An untitled heading over "Paid": the snapshot walks into it, and so does the row's name.
        let row = fake("row", None, vec![fake("statictext", Some("Invoice"), vec![]), fake("heading", None, vec![fake("statictext", Some("Paid"), vec![])])]);
        assert_eq!(gathered(&row).as_deref(), Some("Invoice Paid"));
        // A titled text comes after the texts inside it, in the snapshot's order.
        let titled = fake("row", None, vec![fake("heading", Some("Total"), vec![fake("statictext", Some("42"), vec![])])]);
        assert_eq!(gathered(&titled).as_deref(), Some("42 Total"));
        // A scroll bar's parts are not read.
        let scrolled =
            fake("row", None, vec![fake("statictext", Some("Notes"), vec![]), fake("scrollbar", None, vec![fake("statictext", Some("50%"), vec![])])]);
        assert_eq!(gathered(&scrolled).as_deref(), Some("Notes"));
    }
}
