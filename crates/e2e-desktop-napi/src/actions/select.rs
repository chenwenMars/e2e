//! Choosing an option: a pop-up's menu, and a list's or table's rows, matched by the name the snapshot gives them.

use super::*;

/// The first of `options` (the items of one title) that is enabled, waited for within the action's budget, as
/// `enabled` waits for one control; refused, naming the option, when none is enabled in time.
pub(super) fn enabled_of(options: &[Element], deadline: Instant, label: &str) -> Outcome<Element> {
    let refuse_at = deadline.checked_sub(ANSWER_MARGIN).unwrap_or(deadline);
    loop {
        // An option the menu dropped since the scan is skipped: a live one of the title may still be enabled. With every
        // one gone, the menu changed under the select.
        let mut live = 0;
        for option in options {
            match option.attribute("AXEnabled") {
                Ok(value) if value.boolean() == Some(false) => live += 1,
                Err(ax::AX_INVALID_ELEMENT) => {}
                Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_API_DISABLED)) => return Err(unread(error, "select")),
                _ => return Ok(option.clone()),
            }
        }
        if live == 0 {
            return Err(unread(ax::AX_INVALID_ELEMENT, "select"));
        }
        if Instant::now() + POLL >= refuse_at {
            return Err(Failure::refused(codes::ACTION_FAILED, format!("the option \"{label}\" is disabled")));
        }
        go("select")?;
        sleep(POLL);
    }
}

/// How deep `row_label` reads into a row for its text: as deep as a snapshot may read (`desktop({ maxDepth })` allows up
/// to 50), so a row a locator names by its whole text is selected by that text too. A row deeper than this has a label it
/// cannot read whole, which counts as a read the app did not answer: never a match, and never proof the option is missing.
pub(super) const ROW_TEXT_DEPTH: usize = 50;

/// The name a list's row shows, as the snapshot names it: its own title or description (a text item's value), else,
/// with none, every text inside it in reading order, joined by spaces.
pub(super) fn row_label(element: &Element) -> Result<Option<String>, AXError> {
    if let Some(own) = own_label(element)? {
        return Ok(Some(own));
    }
    let mut texts = Vec::new();
    row_texts(element, 0, &mut texts)?;
    Ok(crate::snapshot::content_name(&texts))
}

/// An element's own name, as the snapshot gives it: its title, else the text of the element that labels it
/// (`AXTitleUIElement`), else its description, else, for a text, its value.
pub(super) fn own_label(element: &Element) -> Result<Option<String>, AXError> {
    let values = match element.attributes(&["AXRole", "AXTitle", "AXDescription", "AXValue", "AXTitleUIElement"]) {
        Ok(values) => values,
        Err(ax::AX_CANNOT_COMPLETE) => return Err(ax::AX_CANNOT_COMPLETE),
        Err(_) => return Ok(None),
    };
    let text = |index: usize| values[index].as_ref().and_then(Value::text).map(str::to_owned).filter(|text| !text.trim().is_empty());
    let role = values[0].as_ref().and_then(Value::text).unwrap_or_default();
    let labelled = match &values[4] {
        Some(Value::Element(label)) => crate::snapshot::label_of(label)?,
        _ => None,
    };
    Ok(text(1).or(labelled).or_else(|| text(2)).or_else(|| if roles::text(roles::role(role, None)) { text(3) } else { None }))
}

/// The texts inside an element, in reading order, as the snapshot gathers a row's name from them.
pub(super) fn row_texts(element: &Element, depth: usize, texts: &mut Vec<String>) -> Result<(), AXError> {
    // Every child is read, as the snapshot reads them: a label cut short could match a prefix of the one asked for.
    let children = |element: &Element| match element.elements("AXChildren", crate::snapshot::MAX_CHILDREN) {
        Ok(children) => Ok(children),
        Err(ax::AX_CANNOT_COMPLETE) => Err(ax::AX_CANNOT_COMPLETE),
        Err(_) => Ok(Vec::new()),
    };
    let role = |element: &Element| match element.attribute("AXRole") {
        Ok(value) => Ok(roles::role(value.text().unwrap_or_default(), None)),
        Err(ax::AX_CANNOT_COMPLETE) => Err(ax::AX_CANNOT_COMPLETE),
        Err(_) => Ok(roles::role("", None)),
    };
    gather_texts(element, depth, texts, &children, &role, &own_label)
}

/// The texts under `node`, gathered as the snapshot's walk gathers them for a name from content: every level is read,
/// a text's own children before the text itself, so a row holding "Invoice" and an untitled heading over "Paid" is
/// "Invoice Paid" here as it is in the snapshot. A scroll bar's parts are not read, as the snapshot reads none. A node
/// deeper than `ROW_TEXT_DEPTH` with children counts as a read the app did not answer.
pub(super) fn gather_texts<T>(
    node: &T,
    depth: usize,
    texts: &mut Vec<String>,
    children: &dyn Fn(&T) -> Result<Vec<T>, AXError>,
    role: &dyn Fn(&T) -> Result<&'static str, AXError>,
    label: &dyn Fn(&T) -> Result<Option<String>, AXError>,
) -> Result<(), AXError> {
    let below = children(node)?;
    if !below.is_empty() && depth >= ROW_TEXT_DEPTH {
        return Err(ax::AX_CANNOT_COMPLETE);
    }
    for child in below {
        let kind = role(&child)?;
        if kind != "scrollbar" {
            gather_texts(&child, depth + 1, texts, children, role, label)?;
        }
        if roles::text(kind)
            && let Some(text) = label(&child)?
        {
            texts.push(text);
        }
    }
    Ok(())
}

/// The pop-up button's menu, if it is already open.
/// `Err` when the app did not answer in time: a stall is no proof the menu is closed.
pub(super) fn current_menu(button: &Element) -> Result<Option<Element>, AXError> {
    let children = match button.elements("AXChildren", 4) {
        Ok(children) => children,
        Err(ax::AX_CANNOT_COMPLETE) => return Err(ax::AX_CANNOT_COMPLETE),
        Err(_) => return Ok(None),
    };
    for child in children {
        match child.attribute("AXRole") {
            Ok(role) if role.text() == Some("AXMenu") => return Ok(Some(child)),
            Err(ax::AX_CANNOT_COMPLETE) => return Err(ax::AX_CANNOT_COMPLETE),
            _ => {}
        }
    }
    Ok(None)
}

/// The open menu of a pop-up button, once it shows.
pub(super) fn open_menu(button: &Element, deadline: Instant) -> Option<Element> {
    let mut menu = None;
    until(deadline, || {
        menu = current_menu(button).ok().flatten();
        menu.is_some()
    });
    menu
}

/// How long each way of closing a menu nothing was chosen from waits for it, past the action's deadline too: an open
/// menu covers the window.
pub(super) const MENU_CLOSE_WAIT: Duration = Duration::from_millis(500);

/// How long a menu that refused `AXCancel` is watched before Escape: the refusal may still have closed it.
pub(super) const MENU_CLOSE_GLANCE: Duration = Duration::from_millis(100);

/// Closes a menu nothing was chosen from, and answers whether it closed. It runs after the action's deadline too: each
/// way of closing gets a wait of its own, so an `AXCancel` that used its wait still leaves Escape time to be seen.
pub(super) fn close_menu(pid: i32, menu: &Element) -> bool {
    close_menu_with(
        cancelled,
        || windows::open_menus(pid) == 0,
        || menu.perform("AXCancel").is_ok(),
        || {
            // Escape goes to the process, which may have closed this menu and opened another: it is sent only while this
            // menu is still there, and a menu left open then makes the failure delivered.
            // The read waits on the app, and the caller may cancel meanwhile: it is checked again just before the key.
            if menu.attribute("AXRole").is_ok() && !cancelled() {
                let _ = input::parse_combo("escape").and_then(|combo| input::press(&combo, Route::Process(pid)));
            }
        },
    )
}

/// `close_menu`'s steps, over `stopped` (the caller cancelled), `closed` (no menu is open), `cancel` (sends `AXCancel`,
/// and says whether the menu took it), and `escape` (sends Escape).
pub(super) fn close_menu_with(stopped: impl Fn() -> bool, closed: impl Fn() -> bool, cancel: impl FnOnce() -> bool, escape: impl FnOnce()) -> bool {
    // A cancelled action's caller has moved on, and may be working with this menu or another: nothing more is sent, and
    // the menu may be open.
    if stopped() {
        return closed();
    }
    // A menu that answered the action with an error gets only a glance: an Escape sent once the menu closed would reach
    // the window under it (a sheet it cancels), so even then the driver looks before it sends one.
    let wait = if cancel() { MENU_CLOSE_WAIT } else { MENU_CLOSE_GLANCE };
    if until(Instant::now() + wait, &closed) {
        return true;
    }
    // A cancel that came while the menu was watched: an Escape now could close a menu the caller's next action opened.
    if stopped() {
        return false;
    }
    escape();
    until(Instant::now() + MENU_CLOSE_WAIT, closed)
}

/// The first `limit` items `matches` takes, and whether a read of one the app did not answer in time left an item
/// unread: that item may be the one asked for. Each read waits on the app, and a list can hold thousands of items: the
/// scan stops with the cut-off once the caller gave up or ran out of time.
pub(super) fn scan<T>(items: Vec<T>, what: &str, limit: usize, mut matches: impl FnMut(&T) -> Result<bool, AXError>) -> Outcome<(Vec<T>, bool)> {
    let mut found = Vec::new();
    let mut stalled = false;
    for item in items {
        go(what)?;
        match matches(&item) {
            Ok(true) => {
                found.push(item);
                if found.len() >= limit {
                    break;
                }
            }
            Ok(false) => {}
            Err(error) => stalled |= error == ax::AX_CANNOT_COMPLETE,
        }
    }
    Ok((found, stalled))
}

/// A select's failure before anything was chosen, once its menu was closed or failed to close. A menu that stayed open
/// changed the screen, and covers the window for the next action, so the failure is no longer "nothing sent".
pub(super) fn unclosed(failure: Failure, closed: bool) -> Failure {
    if closed { failure } else { failure.delivered().with_details(serde_json::json!({ "menu": "open" })) }
}

pub(super) fn select(entry: &Entry, label: &str, deadline: Instant) -> Outcome<()> {
    let element = &entry.element;
    let (ax_role, role) = role_of(element, "select")?;
    // A pull-down keeps its own title, so a choice cannot be read back from it: tap it and the menu item instead.
    if ax_role == "AXMenuButton" {
        return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, "a pull-down menu shows no selected option; tap it, then tap the menu item"));
    }
    // A disabled pop-up ignores the press that would open its list.
    enabled(element, deadline, "select")?;
    if ax_role == "AXPopUpButton" {
        // A menu the user or a tap already opened on this button is the list: a press would close it. With it open, the
        // option shown is chosen from it too, so the menu does not stay open over the window.
        let already_open = current_menu(element).map_err(|error| unread(error, "read the list's menu"))?;
        if already_open.is_none() && value_text(element).as_deref() == Some(label) {
            return Ok(());
        }
        let menu = if let Some(menu) = already_open {
            menu
        } else {
            // A menu still closing (the last select's) would take the press.
            until(deadline, || windows::open_menus(entry.pid) == 0);
            perform(element, "AXPress", "open the list")?;
            open_menu(element, deadline).ok_or_else(|| Failure::unconfirmed(codes::ACTION_FAILED, "the list's menu did not open"))?
        };
        // Until the item is pressed nothing is chosen: a failure closes the menu again, and says when it stayed open,
        // since an open menu covers the window for the next action.
        let unchosen = |failure: Failure| unclosed(failure, close_menu(entry.pid, &menu));
        let items = all(&menu, "AXChildren", "read the list's options").map_err(unchosen)?;
        // A title the app did not answer in time may be the option asked for: that is no proof it is missing.
        let (found, stalled) =
            scan(items, "read the list's options", usize::MAX, |candidate| candidate.attribute("AXTitle").map(|title| title.text() == Some(label)))
                .map_err(unchosen)?;
        if found.is_empty() {
            return Err(unchosen(if stalled {
                unread(ax::AX_CANNOT_COMPLETE, "read the list's options")
            } else {
                Failure::refused(codes::ELEMENT_NOT_FOUND, format!("the list has no option \"{label}\""))
            }));
        }
        // An enabled option of that title is the one; a disabled one that comes first must not hide it. A disabled option
        // takes the press and ignores it: every one of that title is waited for, and the select refused as disabled, not
        // as missing, only when none is enabled in time.
        let item = enabled_of(&found, deadline, label).map_err(unchosen)?;
        perform(&item, "AXPress", "choose the option").map_err(|failure| match failure.delivery {
            // Refused before the press (out of time, cancelled, the item gone): nothing was chosen.
            Delivery::NotDelivered => unchosen(failure),
            Delivery::Unknown => failure,
        })?;
        if until(deadline, || value_text(element).as_deref() == Some(label)) {
            // The menu fades out after the choice; the next action must not land on it.
            until(deadline, || windows::open_menus(entry.pid) == 0);
            return Ok(());
        }
        return Err(Failure::unconfirmed(codes::ACTION_FAILED, format!("the list does not show \"{label}\" after it was chosen")));
    }
    // An editable combo box is refused before this (a fill sets it); one that takes no typed value shows its list only
    // when opened.
    if ax_role == "AXComboBox" {
        return Err(Failure::refused(
            codes::ACTION_NOT_SUPPORTED,
            "a combo box that takes no typed value cannot be selected by label yet; tap it, then tap the option",
        ));
    }
    if roles::collection(role) {
        let rows = match all(element, "AXRows", "read the list's rows")? {
            rows if rows.is_empty() => all(element, "AXChildren", "read the list's rows")?,
            rows => rows,
        };
        // A row the app did not answer in time may be the option asked for: that is no proof it is missing.
        // Two rows that show the label leave the choice open: neither is selected, as no handler of the wrong one may run.
        let (found, stalled) = scan(rows, "read the list's rows", 2, |candidate| row_label(candidate).map(|text| text.as_deref() == Some(label)))?;
        if found.len() > 1 {
            return Err(Failure::refused(codes::ACTION_FAILED, format!("more than one option of the list is \"{label}\"; select it another way")));
        }
        // A row whose label could not be read may show the label too: one match is no proof it is the only one.
        if stalled {
            return Err(unread(ax::AX_CANNOT_COMPLETE, "read the list's rows"));
        }
        let Some(row) = found.into_iter().next() else {
            return Err(Failure::refused(codes::ELEMENT_NOT_FOUND, format!("the list has no option \"{label}\"")));
        };
        let (_, row_role) = role_of(&row, "select")?;
        if matches!(row_role, "radiobutton" | "tab") {
            // An app can refuse the choice (an NSTabViewDelegate's shouldSelect) while the press itself succeeds: the
            // option must show it is the selected one.
            let selected = || row.boolean("AXSelected") == Some(true) || toggle_state(&row) == Some(1);
            if !selected() {
                // A disabled option takes the press and ignores it.
                enabled(&row, deadline, "select")?;
                perform(&row, "AXPress", "choose the option")?;
                if !until(deadline, selected) {
                    return Err(Failure::unconfirmed(codes::ACTION_FAILED, format!("\"{label}\" did not become selected")));
                }
            }
            return Ok(());
        }
        if choose_row(Some(element), &row, deadline, &format!("\"{label}\" did not become selected"))? {
            return Ok(());
        }
        return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, "the list takes no selection through accessibility"));
    }
    Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("a {role} has no options to select")))
}

/// Selects `row`, through `list`'s `AXSelectedRows` when the list takes it, else through the row's own `AXSelected`, and
/// waits for the row to show it is selected (`unselected` when it does not). `Ok(false)` when neither can be written:
/// nothing was sent.
pub(super) fn choose_row(list: Option<&Element>, row: &Element, deadline: Instant, unselected: &str) -> Outcome<bool> {
    let by_rows = match list {
        Some(list) => settable(list, "AXSelectedRows", "select")?,
        None => false,
    };
    if !by_rows && !settable(row, "AXSelected", "select")? {
        return Ok(false);
    }
    // The reads before can take long on a slow app; the caller may have given up since.
    go("select")?;
    let written = match list {
        Some(list) if by_rows => list.set_elements("AXSelectedRows", std::slice::from_ref(row)),
        _ => row.set_bool("AXSelected", true),
    };
    written.map_err(|error| write_failed(error, "select the row"))?;
    if until(deadline, || row.boolean("AXSelected") == Some(true)) {
        return Ok(true);
    }
    Err(Failure::unconfirmed(codes::ACTION_FAILED, unselected))
}
