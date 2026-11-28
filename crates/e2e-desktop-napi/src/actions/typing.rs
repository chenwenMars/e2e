//! Typing a text key by key into a field, each key only while the keyboard is still where typing began.

use super::*;

/// How often the wait for a typed key reads the field.
pub(super) const KEY_POLL: Duration = Duration::from_millis(2);

/// The longest wait for the app to take a typed key before the next one goes.
pub(super) const KEY_SETTLE: Duration = Duration::from_millis(250);

/// The wait after a typed key when the field's length cannot be read, so its effect cannot be seen.
pub(super) const KEY_SETTLE_UNREAD: Duration = Duration::from_millis(30);

pub(super) fn type_text(entry: &Entry, text: &str, physical: bool, deadline: Instant) -> Outcome<()> {
    let window = windows::find(entry.pid, entry.window)?;
    // Text sent to the app goes to its key window, which must be the one the field is in, as for `press`.
    if !physical {
        key_window(entry.pid, &window)?;
    }
    // The app owns focus: typing goes into the field that holds it, which the engine read, and never moves focus back
    // to it (a delete's handler, or a window coming forward, may have moved it on).
    let route = if physical {
        raise(entry.pid, &window)?;
        Route::Physical
    } else {
        Route::Process(entry.pid)
    };
    // Each key goes only while the window that held the keyboard when typing began still does: a Return that opened another
    // window, a sheet on this one included, or another app must not take the rest of the text with it. A field in a sheet
    // that was there from the start keeps its sheet. Read before the field's own check, so a window a focus handler opens
    // after it shows as a change at the first key, and one it opened before fails that check.
    let typing_in = element_attribute(&Element::application(entry.pid), "AXFocusedWindow", "type")?;
    if let Some(start) = &typing_in
        && !holds(start, &window, "type")?
    {
        return Err(Failure::refused(codes::ACTION_FAILED, "another window took the keyboard before typing began, so nothing was typed"));
    }
    // Coming forward can run a handler that opens a sheet or another window, and the app can move focus on: the keys
    // would then go there. The field itself must hold the app's focus before the first key.
    if element_attribute(&Element::application(entry.pid), "AXFocusedUIElement", "type")?.as_ref() != Some(&entry.element) {
        return Err(Failure::refused(codes::ACTION_FAILED, "the field lost keyboard focus before typing began, so nothing was typed"));
    }
    // What an element holds, in characters, as the app answers it: a change says the app took the key sent last.
    let length = |element: &Element| match element.attribute("AXNumberOfCharacters") {
        Ok(Value::Number(count)) => Some(count),
        _ => None,
    };
    let focused_element = || Element::application(entry.pid).element("AXFocusedUIElement");
    // The same read for a check a key waits on: a stall fails it, as a retry may get past it, never as focus that moved.
    let focused_checked = || element_attribute(&Element::application(entry.pid), "AXFocusedUIElement", "type");
    // The element that held the keyboard when the last key went, and its length then; unset before the first key. It is
    // the field typing began in until a Tab, or a code field's next box, takes the keys within the window.
    let sent_to: std::cell::RefCell<Option<(Option<Element>, Option<f64>)>> = std::cell::RefCell::new(None);
    // Set once a key showed no change in its whole wait: a field that drops or caps characters would spend the wait on
    // every key after it, so the rest get the short one.
    let quiet = std::cell::Cell::new(false);
    let still = || -> Outcome<()> {
        // A key posted to the app is in its queue, not yet handled: wait until the element it went to shows it, or focus
        // moved, so a window the key opened (a handler on the text, a Return) holds the keyboard by the time the check
        // below reads it.
        let last = sent_to.borrow().clone();
        if let Some((target, before)) = &last {
            let settle = deadline.min(Instant::now() + if quiet.get() { KEY_SETTLE_UNREAD } else { KEY_SETTLE });
            match (target, *before) {
                (Some(target), Some(count)) => {
                    // A fine poll of its own: the app takes a key within a millisecond or two, and `until`'s coarse one
                    // would add its whole interval to every key.
                    let taken = || length(target) != Some(count) || focused_element().as_ref() != Some(target);
                    let mut seen = taken();
                    while !seen && Instant::now() < settle {
                        sleep(KEY_POLL);
                        seen = taken();
                    }
                    if !seen {
                        quiet.set(true);
                    }
                }
                _ => sleep(KEY_SETTLE_UNREAD.min(settle.saturating_duration_since(Instant::now()))),
            }
        }
        // The element the key will reach, read before the checks below, so nothing reads the app between them and the
        // key: focus that moves while they run is caught by them, not followed. The first key goes only to the field.
        // Past the first key, an unanswered read only shortens the wait for the next key's effect.
        let target = if last.is_none() { focused_checked()? } else { focused_element() };
        let count = target.as_ref().and_then(&length);
        if last.is_none() && target.as_ref() != Some(&entry.element) {
            return Err(Failure::refused(codes::ACTION_FAILED, "the field lost keyboard focus before typing began, so nothing was typed"));
        }
        let focused = element_attribute(&Element::application(entry.pid), "AXFocusedWindow", "type")?;
        let held = match &typing_in {
            Some(start) => focused.as_ref() == Some(start),
            None => match &focused {
                Some(focused) => holds(focused, &window, "type")?,
                None => false,
            },
        };
        let forward = !physical || frontmost(entry.pid)?;
        if held && forward {
            if last.is_none() {
                // The first key goes only to the field, read once more: the reads above wait on the app, and a handler that
                // moved focus to another field of the window meanwhile would take the key.
                if focused_checked()?.as_ref() != Some(&entry.element) {
                    return Err(Failure::refused(codes::ACTION_FAILED, "the field lost keyboard focus before typing began, so nothing was typed"));
                }
                // That read waits on the app too, and a physical key goes to whatever app is frontmost: the frontmost check
                // is the last read before it, as for `press`, so another app that came forward meanwhile is still caught.
                if physical && !frontmost(entry.pid)? {
                    return Err(Failure::refused(codes::ACTION_FAILED, "another app came forward before typing began, so nothing was typed"));
                }
            }
            sent_to.replace(Some((target, count)));
            Ok(())
        } else {
            Err(Failure::refused(codes::ACTION_FAILED, "typing stopped: the field's window lost the keyboard to another window or app"))
        }
    };
    CURRENT.with(|current| match current.borrow().as_ref() {
        Some((run, _)) => input::type_text(text, route, run, deadline, &still),
        None => Err(Failure::refused(codes::INTERNAL, "type ran outside an action")),
    })
}
