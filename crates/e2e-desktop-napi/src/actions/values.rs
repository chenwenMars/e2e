//! A control's state and value: a box checked or unchecked, a stepper stepped, a field's text set or selected.

use super::*;

/// Whether an uncheck asks a selected radio button to clear itself, which only selecting another does: a press would
/// run its handler and leave it selected.
pub(super) fn clears_only_by_another(role: &str, wanted: bool, shown: Option<u8>) -> bool {
    role == "radiobutton" && !wanted && shown == Some(1)
}

pub(super) fn check(element: &Element, wanted: bool, deadline: Instant) -> Outcome<()> {
    // A press on anything but a box would run its handler (a submit, a delete) before the check could fail.
    let (_, role) = role_of(element, "check")?;
    if !roles::toggleable(role) {
        return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("a {role} has no checked state to set")));
    }
    let target = wanted as u8;
    let what = if wanted { "check" } else { "uncheck" };
    let read = || match element.attribute("AXValue") {
        Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT)) => Err(unread(error, what)),
        value => Ok(crate::snapshot::parse_toggle(value.ok().as_ref())),
    };
    let mut shown = read()?;
    if shown != Some(target) {
        // A disabled AppKit box acknowledges a press and ignores it: wait for it to be enabled, then read it again, as
        // the app may have set it meanwhile. A box that already shows the state asked for is left alone, disabled or not.
        enabled(element, deadline, what)?;
        shown = read()?;
    }
    // A box whose state cannot be read may already show the one asked for: a press would turn it the other way. Both
    // refusals come before the scroll below, as a refusal says nothing reached the app.
    if shown.is_none() {
        return Err(Failure::refused(
            codes::ACTION_NOT_SUPPORTED,
            format!("the {role} shows no checked state the engine can read, so pressing it could undo the one asked for"),
        ));
    }
    if clears_only_by_another(role, wanted, shown) {
        return Err(Failure::refused(codes::ACTION_FAILED, "a selected radio button is cleared only by selecting another one; nothing was pressed"));
    }
    // A box a scroll area holds out of view is pressed all the same through accessibility, out of the user's reach.
    let scrolled = if shown != Some(target) { reveal(element, deadline, what)? } else { false };
    if scrolled {
        // The list moved: the app may have set the box as it came into view, and a press now could undo that.
        shown = after_scroll(true, read())?;
        match shown {
            Some(state) if state == target => return Ok(()),
            Some(_) => {}
            None => {
                return Err(Failure::unconfirmed(
                    codes::ACTION_FAILED,
                    format!("the {role}'s state could not be read once it was scrolled into view, so it was not pressed"),
                ));
            }
        }
    }
    let reached = after_scroll(
        scrolled,
        press_to_state(
            target,
            shown,
            || perform(element, "AXPress", what),
            || {
                let before = shown;
                until(deadline, || toggle_state(element) != before);
                shown = toggle_state(element);
                shown
            },
        ),
    )?;
    if reached {
        Ok(())
    } else {
        Err(Failure::unconfirmed(codes::ACTION_FAILED, format!("the box is still not {}", if wanted { "checked" } else { "unchecked" })))
    }
}

/// The states a box can show: off, on, and mixed.
pub(super) const BOX_STATES: usize = 3;

/// Presses a box until it shows `target`, at most once per state it can show: an AppKit box goes mixed, on, off, so
/// unchecking a mixed box takes two presses. `settle` waits for the state a press led to. It stops early when the state
/// cannot be read or a press changed nothing, so a box that does not answer is not pressed again and again. A failed
/// first press sent nothing; a failed later one follows a press that landed. A press that answered with an error but
/// may have landed is judged by the state it led to: a SwiftUI control in a sheet answers its first press so.
pub(super) fn press_to_state(target: u8, shown: Option<u8>, mut press: impl FnMut() -> Outcome<()>, mut settle: impl FnMut() -> Option<u8>) -> Outcome<bool> {
    if shown == Some(target) {
        return Ok(true);
    }
    let mut before = shown;
    for attempt in 0..BOX_STATES {
        let pressed = press().map_err(|failure| if attempt == 0 { failure } else { failure.delivered() });
        if let Err(failure) = &pressed
            && failure.delivery == Delivery::NotDelivered
        {
            return pressed.map(|()| false);
        }
        let now = settle();
        if now == Some(target) {
            return Ok(true);
        }
        if now.is_none() || now == before {
            return pressed.map(|()| false);
        }
        before = now;
    }
    Ok(false)
}

/// The most presses a stepper gets to reach a value.
pub(super) const MAX_STEPS: usize = 500;

/// Whether two stepper values are the same number: a step of 0.1 sums to 0.30000000000000004, not 0.3. `step`, once
/// a press showed it, bounds the tolerance to half a step, so no rounding allowance hides a whole step.
pub(super) fn same(a: f64, b: f64, step: Option<f64>) -> bool {
    // Whole numbers a float holds exactly compare exactly: a step of 1 apart is a step, however large the value (a Unix
    // time in microseconds). Others compare up to a few hundred float epsilons of the larger, the error of summing
    // fractional steps such as 0.1.
    const EXACT: f64 = 9_007_199_254_740_992.0;
    if a.fract() == 0.0 && b.fract() == 0.0 && a.abs() <= EXACT && b.abs() <= EXACT {
        return a == b;
    }
    let rounding = f64::EPSILON * 256.0 * a.abs().max(b.abs()).max(1.0);
    (a - b).abs() <= step.map_or(rounding, |step| rounding.min(step.abs() / 2.0))
}

/// Steps a value toward `target`, one increment or decrement at a time, until it shows it. It stops when the value
/// cannot be read or a step changed nothing. When a step goes past the target (the step does not divide the distance),
/// it steps back to the value it started from, so a value the stepper cannot take leaves it as it was. It never steps past `deadline`: the steps
/// sent by then stay sent, delivered but unverified. A failed first step sent nothing; a failed later one follows steps
/// that landed. A step that answered with an error but may have landed is judged by the value it led to.
///
/// A start within rounding of the target, but not equal to it, may be the target summed by earlier steps or a value a
/// small step away from it: one step tells which, and when it was the target, a step back puts it as it was.
///
/// Its failures name no value: the target may be a secret, and the ledger that redacts one does not match it re-parsed as
/// a number (`0042` as `42`), nor the stepper's values a step from it.
pub(super) fn step_to(
    target: f64,
    shown: Option<f64>,
    deadline: Instant,
    mut step: impl FnMut(bool) -> Outcome<()>,
    mut settle: impl FnMut() -> Option<f64>,
) -> Outcome<bool> {
    let Some(start) = shown else { return Ok(false) };
    if start == target {
        return Ok(true);
    }
    let probing = same(start, target, None);
    let mut size = None;
    let mut now = start;
    for attempt in 0..MAX_STEPS {
        if !(probing && attempt == 0) && same(now, target, size) {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            let failure = Failure::refused(codes::TIMEOUT, "the stepper ran out of time before it reached the value");
            return Err(if attempt == 0 { failure } else { failure.delivered() });
        }
        let up = now < target;
        let stepped = step(up).map_err(|failure| if attempt == 0 { failure } else { failure.delivered() });
        if let Err(failure) = &stepped
            && failure.delivery == Delivery::NotDelivered
        {
            return stepped.map(|()| false);
        }
        let Some(next) = settle() else { return stepped.map(|()| false) };
        // A press that changed nothing leaves the very number it found: any difference is a step, however small.
        if next == now {
            return stepped.map(|()| false);
        }
        // A step that went the other way wrapped around the stepper's range: stepping on would only cycle through it.
        if (up && next < now) || (!up && next > now) {
            return Err(Failure::unconfirmed(
                codes::ACTION_FAILED,
                "the stepper went the other way on a step toward the value: it wraps, and cannot reach the value",
            ));
        }
        size = Some((next - now).abs());
        let start_was_target = probing && attempt == 0 && same(start, target, size);
        if start_was_target || (!same(next, target, size) && ((up && next > target) || (!up && next < target))) {
            // Put back the value it had before the fill, a step at a time: a fill the stepper cannot take must not leave
            // it changed. As many steps back as went forward, and none more once a step changes nothing.
            let mut value = next;
            for _ in 0..=attempt {
                if same(value, start, size) || step(!up).is_err() {
                    break;
                }
                match settle() {
                    Some(back) if !same(back, value, size) => value = back,
                    _ => break,
                }
            }
            if start_was_target {
                return if same(value, start, size) {
                    Ok(true)
                } else {
                    Err(Failure::unconfirmed(
                        codes::ACTION_FAILED,
                        "the stepper already showed about the value; a step to tell it from the value left it changed",
                    ))
                };
            }
            let failure = Failure::unconfirmed(codes::ACTION_FAILED, "the stepper's step goes past the value");
            return Err(if same(value, start, size) {
                Failure { message: format!("{}; it was stepped back to where it started", failure.message), ..failure }
            } else {
                Failure { message: format!("{}, and could not be stepped back to where it started", failure.message), ..failure }
            });
        }
        now = next;
    }
    Ok(same(now, target, size))
}

/// The number a stepper shows, from its `AXValue` read. A read the app did not answer in time, or of an element that
/// is gone, is no proof the stepper shows no number: it fails before anything is sent, a stall as one a retry may get
/// past. A value that is no number is `None`.
pub(super) fn shown_number(read: Result<Value, AXError>, what: &str) -> Outcome<Option<f64>> {
    match read {
        Ok(Value::Number(number)) => Ok(Some(number)),
        Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT)) => Err(unread(error, what)),
        _ => Ok(None),
    }
}

/// Whether a stepper's target lies outside the range it reports: below `min` or above `max`. A bound it does not report
/// limits nothing.
pub(super) fn outside(target: f64, min: Option<f64>, max: Option<f64>) -> bool {
    min.is_some_and(|min| target < min) || max.is_some_and(|max| target > max)
}

/// The number a text names, when it names a finite one: `NaN` or `inf` is no value a control can take.
pub(super) fn finite(text: &str) -> Result<f64, ()> {
    text.trim().parse::<f64>().ok().filter(|number| number.is_finite()).ok_or(())
}

pub(super) fn set_value(element: &Element, text: &str, deadline: Instant) -> Outcome<()> {
    // A disabled field takes no value: wait for it to be enabled, as a fill's actionability wait does.
    enabled(element, deadline, "set value")?;
    let (ax_role, role) = role_of(element, "set value")?;
    let secure = ax_role == "AXSecureTextField" || element.text("AXSubrole").as_deref() == Some("AXSecureTextField");
    if !settable(element, "AXValue", "set value")? {
        // A stepper whose value cannot be written still steps toward a number.
        let names = action_names(element, "set value")?;
        let steps = names.iter().any(|name| name == "AXIncrement" || name == "AXDecrement");
        let current = if steps { shown_number(element.attribute("AXValue"), "set value")? } else { None };
        if let (Some(first), Ok(target)) = (current, finite(text)) {
            // A value outside the range the stepper reports is one no step reaches: refused before any press.
            let bound = |name: &str| match element.attribute(name) {
                Ok(Value::Number(number)) => Some(number),
                _ => None,
            };
            if outside(target, bound("AXMinValue"), bound("AXMaxValue")) {
                return Err(Failure::refused(codes::ACTION_FAILED, format!("the value is outside the range of this {role}")));
            }
            let number = || match element.attribute("AXValue") {
                Ok(Value::Number(number)) => Some(number),
                _ => None,
            };
            // The number read above, not a second read, which a stall would turn into no number and a fill that stops
            // short without a step.
            let mut shown = Some(first);
            let reached = step_to(
                target,
                shown,
                deadline,
                |up| perform(element, if up { "AXIncrement" } else { "AXDecrement" }, "step the value"),
                || {
                    let before = shown;
                    until(deadline, || number() != before);
                    shown = number();
                    shown
                },
            )?;
            return if reached { Ok(()) } else { Err(Failure::unconfirmed(codes::ACTION_FAILED, format!("the {role} stopped short of the value"))) };
        }
        return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("the value of this {role} cannot be set")));
    }
    // Whether the value is a number (a slider's), read before anything is sent: a read the app did not answer in time is
    // no proof it is text, and writing text to a number fails.
    let numeric = match element.attribute("AXValue") {
        Ok(Value::Number(_)) => true,
        Err(ax::AX_CANNOT_COMPLETE) => return Err(unread(ax::AX_CANNOT_COMPLETE, "set value")),
        _ => false,
    };
    // A field that holds focus commits its text the way typing does; one that cannot take focus still takes the value.
    // Focus moved by this call has reached the app (its handlers may have run), so a later failure is no longer "nothing sent".
    // A focus write that failed after the app took it (a focus handler that replaced the field) may still have run its
    // handlers: only a refusal shows it did not.
    let moved_focus = roles::takes_text(role) && settable(element, "AXFocused", "set value")? && element.boolean("AXFocused") != Some(true) && {
        go("set value")?;
        element.set_bool("AXFocused", true).map_or_else(|error| !refuses(error), |()| true)
    };
    // The reads above can take long on a slow app; the caller may have given up since.
    go("set value").map_err(|failure| if moved_focus { failure.delivered() } else { failure })?;
    let written = match (numeric, finite(text)) {
        (true, Ok(number)) => element.set_number("AXValue", number),
        _ => element.set_text("AXValue", text),
    };
    // A write the app answered with anything but a refusal may have run its change handler (one that replaced the
    // field answers a gone element): only a refusal says nothing was sent.
    written.map_err(|error| if moved_focus { refused(error, "set value").delivered() } else { write_failed(error, "set value") })?;
    if secure {
        // A secure field shows no value, but counts its characters: the count says the text landed whole (one a
        // formatter cut short does not), with no secret read. A field that counts none is taken at the write's word.
        let count = || secure_count(element.attribute("AXNumberOfCharacters"));
        let wanted = text.encode_utf16().count();
        if count() == Ok(None) || until(deadline, || count() == Ok(Some(wanted))) {
            return Ok(());
        }
        return Err(Failure::unconfirmed(codes::ACTION_FAILED, "the secure field did not take the whole text set"));
    }
    let expected = if numeric { finite(text).map(ax::format_number).unwrap_or_else(|_| text.to_owned()) } else { text.to_owned() };
    // An empty AppKit text field may answer no value at all, which reads as empty, as the projection reads it.
    let shown = || match element.attribute("AXValue") {
        Ok(value) => value.display().as_deref() == Some(expected.as_str()),
        Err(ax::AX_NO_VALUE) if roles::takes_text(role) => expected.is_empty(),
        Err(_) => false,
    };
    if until(deadline, shown) { Ok(()) } else { Err(Failure::unconfirmed(codes::ACTION_FAILED, "the value did not change to the text set")) }
}

/// What a secure field's character count answers: `Ok(None)` for a field that counts none, which is taken at the write's
/// word. `Err` for a read the app did not answer in time, or for a field gone since the write (a change handler that
/// replaced it): neither is proof the field counts none, so the fill is not confirmed by it, as a plain field's is not.
pub(super) fn secure_count(answer: Result<Value, AXError>) -> Result<Option<usize>, ()> {
    match answer {
        Ok(Value::Number(count)) => Ok(Some(count as usize)),
        Err(ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT) => Err(()),
        _ => Ok(None),
    }
}

/// Selects all the text of a field through accessibility. A select-all key (Cmd+A) sent to an app in the background
/// goes to its menu bar, not the field, so the delete after it would remove one character.
pub(super) fn select_all(element: &Element, deadline: Instant) -> Outcome<()> {
    if !settable(element, "AXSelectedTextRange", "select all")? {
        return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, "select all: the field's selection cannot be set"));
    }
    // A secure field shows no value, but still counts its characters. A field with neither cannot be shown to be
    // selected whole: a range of 0 would read as done and leave its text in place.
    let length = match element.attribute("AXNumberOfCharacters") {
        Ok(Value::Number(count)) if count >= 0.0 => count as usize,
        Err(ax::AX_CANNOT_COMPLETE) => return Err(unread(ax::AX_CANNOT_COMPLETE, "select all")),
        _ => match value_text(element) {
            Some(text) => text.encode_utf16().count(),
            None => return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, "select all: the field's length cannot be read")),
        },
    };
    go("select all")?;
    element.set_range("AXSelectedTextRange", 0, length).map_err(|error| write_failed(error, "select all"))?;
    if until(deadline, || matches!(element.attribute("AXSelectedTextRange"), Ok(Value::Range(0, selected)) if selected == length)) {
        Ok(())
    } else {
        Err(Failure::unconfirmed(codes::ACTION_FAILED, "select all: the field's text did not become selected"))
    }
}
