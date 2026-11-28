//! One window's accessibility tree, read into the raw snapshot shape
//! `nodes.ts` projects: a node per element, a ref for every control, and the
//! tree cut where the depth limit, the node budget, or the deadline stops it.

use crate::ax::{self, Element, Value};
use crate::failure::{Failure, Outcome, codes};
use crate::refs::{self, Entry};
use crate::roles;
use crate::windows::{self, Rect};
use serde::Serialize;
use std::time::Instant;

/// The most nodes one snapshot reads; a window with more is read in part (`truncated`).
const MAX_NODES: usize = 8_000;

/// The most children read under one node; the rest are left out, and the node says so. As many as a snapshot reads in
/// all, so a long list costs only what the node budget already bounds, and a window cut short is one too large to read.
pub(crate) const MAX_CHILDREN: usize = MAX_NODES;

/// Every attribute one request reads of a node.
const ATTRIBUTES: [&str; 18] = [
    "AXRole",
    "AXSubrole",
    "AXTitle",
    "AXDescription",
    "AXValue",
    "AXIdentifier",
    "AXEnabled",
    "AXFocused",
    "AXSelected",
    "AXExpanded",
    "AXPosition",
    "AXSize",
    "AXPlaceholderValue",
    "AXHelp",
    "AXTitleUIElement",
    "AXVerticalScrollBar",
    "AXHorizontalScrollBar",
    "AXHeadingLevel",
];

#[derive(Serialize)]
pub struct NativeId {
    kind: &'static str,
    value: String,
}

/// One node of a snapshot, as `nodes.ts` reads it.
#[derive(Serialize)]
pub struct RawNode {
    #[serde(skip_serializing_if = "Option::is_none")]
    ref_id: Option<String>,
    role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<String>,
    /// A heading's level, 1-based, from `AXHeadingLevel` (macOS 26).
    #[serde(skip_serializing_if = "Option::is_none")]
    level: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_id: Option<NativeId>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    states: Vec<&'static str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    available_actions: Vec<&'static str>,
    /// The axes a node offered `Scroll` scrolls along: `vertical`, `horizontal`, or both.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    scroll_axes: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bounds: Option<Rect>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    subtree_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    children_count: Option<usize>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    children: Vec<RawNode>,
}

#[derive(Serialize)]
pub struct WindowRef {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

/// A snapshot, as `snapshot` answers.
#[derive(Serialize)]
pub struct RawSnapshot {
    snapshot_id: String,
    /// False when the read missed part of the window: the deadline stopped it, or the app did not answer for an
    /// element that still exists. What it did not reach may be there.
    complete: bool,
    /// True when the deadline stopped the read: it is incomplete because the caller's time ran out, not because the
    /// app stalled or a limit cut it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    timed_out: bool,
    /// True when the app did not answer for the window itself: the tree is a bare window, which is no window read yet.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    root_unread: bool,
    /// True when the node budget stopped the read.
    truncated: bool,
    ref_count: usize,
    tree: RawNode,
    window: WindowRef,
}

/// What a snapshot is asked for.
pub struct Request {
    pub pid: i32,
    pub window: u32,
    pub max_depth: usize,
    /// Keep only controls and the nodes that hold them.
    pub interactive: bool,
    pub deadline: Instant,
}

struct Walk {
    pid: i32,
    window: u32,
    snapshot: String,
    max_depth: usize,
    interactive: bool,
    deadline: Instant,
    focused: Option<Element>,
    /// The app did not answer which element holds its focus in time: no node reads as focused, and the read is
    /// incomplete, never filled in from each element's own `AXFocused` (a table's cells report the table's focus).
    focus_unknown: bool,
    /// The window's own title-bar buttons, as it names them (`AXCloseButton`, ...); `None` when it names none.
    chrome: Option<Vec<Element>>,
    nodes: usize,
    complete: bool,
    /// Whether the deadline stopped the read.
    timed_out: bool,
    /// Whether the app did not answer for the window itself.
    root_unread: bool,
    /// How many reads of an element that still exists failed; a parent whose subtree lost one is truncated.
    lost: usize,
    truncated: bool,
    refs: Vec<(String, Entry)>,
    /// The text of every text node read so far, in reading order, pruned ones too: a row or cell with no name of its
    /// own takes it from the text inside it.
    content: Vec<String>,
}

/// Whether a failed read leaves a hole: the app did not answer in time (it stalled), so an element that is there was
/// not read. Any other error is the element's own answer (gone, no such value, a SwiftUI element that answers
/// `kAXErrorFailure`), which a read of it again would give too, so it is left out as before.
fn missed(error: ax::AXError) -> bool {
    error == ax::AX_CANNOT_COMPLETE
}

fn label(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.trim().is_empty())
}

/// What a node's attributes say, read in one request.
struct Read {
    role: &'static str,
    ax_role: String,
    subrole: Option<String>,
    title: Option<String>,
    description: Option<String>,
    value: Option<Value>,
    identifier: Option<String>,
    enabled: Option<bool>,
    focused: Option<bool>,
    selected: Option<bool>,
    expanded: Option<bool>,
    bounds: Option<Rect>,
    placeholder: Option<String>,
    help: Option<String>,
    title_element: Option<Element>,
    /// A vertical scroll bar, listed as an attribute.
    vertical_bar: bool,
    /// A horizontal scroll bar, listed as an attribute.
    horizontal_bar: bool,
    heading_level: Option<u32>,
}

fn read(element: &Element) -> Result<Read, ax::AXError> {
    let mut values = element.attributes(&ATTRIBUTES)?;
    let mut take = |index: usize| values[index].take();
    let ax_role = take(0).and_then(|value| value.text().map(str::to_owned)).unwrap_or_default();
    let subrole = take(1).and_then(|value| value.text().map(str::to_owned));
    let title = label(take(2).and_then(|value| value.text().map(str::to_owned)));
    let description = label(take(3).and_then(|value| value.text().map(str::to_owned)));
    let value = take(4);
    let identifier = label(take(5).and_then(|value| value.text().map(str::to_owned)));
    let enabled = take(6).and_then(|value| value.boolean());
    let focused = take(7).and_then(|value| value.boolean());
    let selected = take(8).and_then(|value| value.boolean());
    let expanded = take(9).and_then(|value| value.boolean());
    let bounds = match (take(10), take(11)) {
        (Some(Value::Point(x, y)), Some(Value::Size(width, height))) => Some(Rect { x, y, width, height }),
        _ => None,
    };
    let placeholder = label(take(12).and_then(|value| value.text().map(str::to_owned)));
    let help = label(take(13).and_then(|value| value.text().map(str::to_owned)));
    let title_element = take(14).and_then(|value| value.element().cloned());
    // Only an element is a scroll bar: macOS may answer an attribute the area does not support with null.
    let vertical_bar = matches!(take(15), Some(Value::Element(_)));
    let horizontal_bar = matches!(take(16), Some(Value::Element(_)));
    let heading_level = level_of(take(17));
    let role = roles::role(&ax_role, subrole.as_deref());
    Ok(Read {
        role,
        ax_role,
        subrole,
        title,
        description,
        value,
        identifier,
        enabled,
        focused,
        selected,
        expanded,
        bounds,
        placeholder,
        help,
        title_element,
        vertical_bar,
        horizontal_bar,
        heading_level,
    })
}

/// A heading level an app answered: a whole number from 1 up. Anything else is no level.
fn level_of(value: Option<Value>) -> Option<u32> {
    match value {
        Some(Value::Number(number)) if number.fract() == 0.0 && (1.0..=f64::from(u32::MAX)).contains(&number) => Some(number as u32),
        _ => None,
    }
}

/// The text of the element that labels another (`AXTitleUIElement`).
/// `Err` for a read the app did not answer in time: a name it may have had.
pub(crate) fn label_of(element: &Element) -> Result<Option<String>, ax::AXError> {
    let values = match element.attributes(&["AXValue", "AXTitle"]) {
        Ok(values) => values,
        Err(ax::AX_CANNOT_COMPLETE) => return Err(ax::AX_CANNOT_COMPLETE),
        Err(_) => return Ok(None),
    };
    Ok(values.into_iter().flatten().find_map(|value| label(value.text().map(str::to_owned))))
}

/// The part of the screen a node's children can show in, from the node's own `clip`. What a scroll area shows is its
/// own frame: its children outside it are scrolled out of view. An open menu and a popover float above the window, so
/// their items are not cut by the window's frame.
fn inner_clip(role: &str, bounds: Option<Rect>, clip: Option<Rect>) -> Option<Rect> {
    match (role, bounds) {
        ("scrollarea", Some(bounds)) => clip.map(|clip| intersect(clip, bounds)).or(Some(bounds)),
        _ if floats(role) => None,
        _ => clip,
    }
}

/// Roles that float above their window: an open menu and a popover.
fn floats(role: &str) -> bool {
    matches!(role, "menu" | "popover")
}

/// Whether a node shows as expanded. A disclosure triangle shows its state as its value, and has no `AXExpanded`.
fn expanded(role: &str, expanded: Option<bool>, toggle: Option<u8>) -> bool {
    expanded == Some(true) || (role == "disclosure" && toggle == Some(1))
}

/// Whether a node shows as selected. A menu reports its highlighted item as selected: that is where the pointer is, not
/// a choice.
fn selected(role: &str, selected: Option<bool>, toggle: Option<u8>) -> bool {
    // An AppKit tab (an AXRadioButton with the AXTabButton subrole) says it is the active one by its value, as a radio
    // button says it is checked.
    (selected == Some(true) && role != "menuitem") || (role == "tab" && toggle == Some(1))
}

/// The state a box's value shows: off, on, or mixed, from a number, a boolean, or the words toolkits use.
pub(crate) fn parse_toggle(value: Option<&Value>) -> Option<u8> {
    match value? {
        Value::Number(number) => Some(*number as u8),
        Value::Bool(value) => Some(*value as u8),
        Value::Text(text) => match text.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "on" | "checked" => Some(1),
            "0" | "false" | "off" | "unchecked" => Some(0),
            "2" | "mixed" | "indeterminate" => Some(2),
            _ => None,
        },
        _ => None,
    }
}

/// The overlap of two rectangles, empty when they do not meet.
fn intersect(a: Rect, b: Rect) -> Rect {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let right = (a.x + a.width).min(b.x + b.width);
    let bottom = (a.y + a.height).min(b.y + b.height);
    Rect { x, y, width: (right - x).max(0.0), height: (bottom - y).max(0.0) }
}

/// The most ancestors `placement` walks up from an element to its window.
const MAX_ANCESTORS: usize = 256;

/// Where an element is, as far as showing it goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Placement {
    /// In its window and every scroll area it is in.
    Shown,
    /// Outside a scroll area it is in, or its window: a scroll into view can bring it back.
    ScrolledOut,
    /// In a minimized window: no scroll shows it.
    Minimized,
    /// A control with no width or height and nothing inside it: it draws nothing, wherever it is.
    Collapsed,
}

/// Where an element is now, by the test the snapshot reads `offscreen` with: its frame against the window and every
/// scroll area it is in, up to a menu or popover, which floats above the window. A minimized window shows nothing,
/// whatever its frames say. An element with no frame has no place to judge, and shows. `Err` when the app did not
/// answer in time, or with `AX_INVALID_ELEMENT` when the element or an ancestor is gone: a gone element shows nowhere.
pub(crate) fn placement(element: &Element) -> Result<Placement, ax::AXError> {
    // Every frame is read so that a stall fails the placement: a frame the app did not answer is no proof it shows.
    let frame = element.read_frame()?;
    if let Some((_, _, width, height)) = frame
        && (width <= 0.0 || height <= 0.0)
    {
        // A count the app did not answer in time is no proof the control holds nothing.
        let empty = match element.count("AXChildren") {
            Ok(count) => count == 0,
            Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT)) => return Err(error),
            Err(_) => true,
        };
        if empty {
            return Ok(Placement::Collapsed);
        }
    }
    let mut clip: Option<Rect> = None;
    // A parent the app did not answer in time may be a scroll area that hides the element: a stall fails, never ends
    // the walk as if the window were reached.
    let parent_of = |element: &Element| match element.attribute("AXParent") {
        Ok(Value::Element(parent)) => Ok(Some(parent)),
        Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT)) => Err(error),
        _ => Ok(None),
    };
    let mut next = parent_of(element)?;
    for _ in 0..MAX_ANCESTORS {
        let Some(parent) = next else { break };
        let role = match parent.attribute("AXRole") {
            Ok(value) => value.text().unwrap_or_default().to_owned(),
            Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT)) => return Err(error),
            Err(_) => String::new(),
        };
        if floats(roles::role(&role, None)) {
            break;
        }
        if role == "AXWindow" {
            match parent.attribute("AXMinimized") {
                Ok(Value::Bool(true)) => return Ok(Placement::Minimized),
                Err(ax::AX_CANNOT_COMPLETE) => return Err(ax::AX_CANNOT_COMPLETE),
                _ => {}
            }
        }
        if matches!(role.as_str(), "AXScrollArea" | "AXWindow")
            && let Some((x, y, width, height)) = parent.read_frame()?
        {
            let frame = Rect { x, y, width, height };
            clip = Some(clip.map_or(frame, |clip| intersect(clip, frame)));
        }
        if role == "AXWindow" {
            break;
        }
        next = parent_of(&parent)?;
    }
    let outside_clip = match (frame, clip) {
        (Some((x, y, width, height)), Some(clip)) => outside(Rect { x, y, width, height }, clip),
        _ => false,
    };
    Ok(if outside_clip { Placement::ScrolledOut } else { Placement::Shown })
}

/// Whether `inner` lies wholly outside `outer`.
fn outside(inner: Rect, outer: Rect) -> bool {
    // A node with no size has no place to judge: an open menu reports a zero frame while its items have real ones.
    if inner.width <= 0.0 || inner.height <= 0.0 {
        return false;
    }
    outer.width <= 0.0
        || outer.height <= 0.0
        || inner.x + inner.width <= outer.x
        || inner.x >= outer.x + outer.width
        || inner.y + inner.height <= outer.y
        || inner.y >= outer.y + outer.height
}

fn push(actions: &mut Vec<&'static str>, action: &'static str) {
    if !actions.contains(&action) {
        actions.push(action);
    }
}

impl Walk {
    fn expired(&self) -> bool {
        Instant::now() >= self.deadline
    }

    /// Notes a read of an element that still exists and did not answer: the snapshot is no longer complete.
    fn lose(&mut self) {
        self.complete = false;
        self.lost += 1;
    }

    /// Whether an attribute can be set. A stall leaves a hole in the read: a field the app did not answer about is not
    /// read-only.
    fn settable(&mut self, element: &Element, name: &str) -> bool {
        element.settable(name).unwrap_or_else(|error| {
            if missed(error) {
                self.lose();
            }
            false
        })
    }

    /// The actions a control takes, in the raw vocabulary, and the axes it scrolls along when it takes `Scroll`.
    fn actions(&mut self, element: &Element, read: &Read) -> (Vec<&'static str>, Vec<&'static str>) {
        let mut out = Vec::new();
        let role = read.role;
        let names = if roles::inert(role) {
            Vec::new()
        } else {
            element.actions().unwrap_or_else(|error| {
                if missed(error) {
                    self.lose();
                }
                Vec::new()
            })
        };
        let has = |name: &str| names.iter().any(|candidate| candidate == name);
        if has("AXPress")
            || has("AXOpen")
            || has("AXConfirm")
            || (matches!(role, "row" | "cell" | "treeitem" | "option" | "tab") && self.settable(element, "AXSelected"))
        {
            push(&mut out, "Click");
            if roles::toggleable(role) {
                push(&mut out, "Toggle");
            }
        }
        if has("AXShowMenu") && !matches!(role, "window" | "sheet" | "dialog" | "application") {
            push(&mut out, "RightClick");
        }
        if has("AXScrollToVisible") {
            push(&mut out, "ScrollTo");
        }
        // SwiftUI gives every scroll area the page actions, also one whose content fits: only a scroll bar says a scroll
        // area scrolls. A viewport swipe goes to the first node offered Scroll, so one that cannot scroll must not be.
        let (vertical, horizontal) = if role == "scrollarea" {
            (
                read.vertical_bar || crate::actions::scroll_bar(element, true).is_some(),
                read.horizontal_bar || crate::actions::scroll_bar(element, false).is_some(),
            )
        } else {
            (has("AXScrollDownByPage") || has("AXScrollUpByPage"), has("AXScrollLeftByPage") || has("AXScrollRightByPage"))
        };
        // A viewport swipe goes to the first node that scrolls along its axis: a carousel does not take a swipe down.
        let mut axes = Vec::new();
        if vertical {
            axes.push("vertical");
        }
        if horizontal {
            axes.push("horizontal");
        }
        if !axes.is_empty() {
            push(&mut out, "Scroll");
        }
        let value_settable = roles::bears_value(role) && self.settable(element, "AXValue");
        // A stepper steps toward a number only when it shows one.
        let steps = (has("AXIncrement") || has("AXDecrement")) && matches!(read.value, Some(Value::Number(_)));
        if steps || value_settable {
            push(&mut out, "SetValue");
        }
        if (role == "combobox" && (value_settable || read.ax_role == "AXPopUpButton")) || roles::collection(role) {
            push(&mut out, "Select");
        }
        if (roles::interactive(role) || roles::collection(role)) && self.settable(element, "AXFocused") {
            push(&mut out, "SetFocus");
        }
        // An AppKit password field takes keystrokes but restricts AXSelectedText: a value it lets be set says it takes text.
        let secure = read.subrole.as_deref() == Some("AXSecureTextField") || read.ax_role == "AXSecureTextField";
        if roles::takes_text(role) && ((secure && value_settable) || self.settable(element, "AXSelectedText")) {
            push(&mut out, "TypeText");
        }
        if (roles::expandable(role) && self.settable(element, "AXExpanded")) || (has("AXPress") && roles::expandable(role)) {
            push(&mut out, "Expand");
            push(&mut out, "Collapse");
        }
        (out, axes)
    }

    /// The children of an element, at most `MAX_CHILDREN`, and how many it has.
    fn children(&mut self, element: &Element, role: &str) -> (Vec<Element>, usize) {
        if roles::large(role) {
            let count = match element.count("AXChildren") {
                Ok(count) => count,
                Err(error) => {
                    if missed(error) {
                        self.lose();
                    }
                    0
                }
            };
            let children = if count == 0 {
                Vec::new()
            } else {
                element.elements("AXChildren", MAX_CHILDREN).unwrap_or_else(|error| {
                    if missed(error) {
                        self.lose();
                    }
                    Vec::new()
                })
            };
            return (children, count);
        }
        let children = match element.attribute("AXChildren") {
            Ok(Value::Array(items)) => {
                items.into_iter().filter_map(|item| if let Value::Element(element) = item { Some(element) } else { None }).collect::<Vec<_>>()
            }
            Err(error) if missed(error) => {
                self.lose();
                Vec::new()
            }
            _ => Vec::new(),
        };
        let count = children.len();
        (children.into_iter().take(MAX_CHILDREN).collect(), count)
    }

    /// Reads one node and the levels under it. `None` for a node an interactive read leaves out, or one that is gone.
    /// `clip` is the part of the screen the node can show in: the window, cut by every scroll area above it.
    fn node(&mut self, element: &Element, level: usize, root: bool, clip: Option<Rect>) -> Option<RawNode> {
        if self.nodes >= MAX_NODES {
            self.truncated = true;
            return None;
        }
        self.nodes += 1;
        let read = match read(element) {
            Ok(read) => read,
            // Still there, but the app did not answer: the read has a hole.
            Err(error) if !root && missed(error) => {
                self.lose();
                return None;
            }
            // Gone since its parent listed it, or an element that refuses reads: nothing a later read would find.
            Err(_) if !root => return None,
            // The window closed after it was found: no tree, rather than an empty one that reads as complete.
            Err(ax::AX_INVALID_ELEMENT) => return None,
            Err(error) => {
                if missed(error) {
                    self.lose();
                    self.root_unread = true;
                }
                Read {
                    role: "window",
                    ax_role: "AXWindow".into(),
                    subrole: None,
                    title: None,
                    description: None,
                    value: None,
                    identifier: None,
                    enabled: None,
                    focused: None,
                    selected: None,
                    expanded: None,
                    bounds: None,
                    placeholder: None,
                    help: None,
                    title_element: None,
                    vertical_bar: false,
                    horizontal_bar: false,
                    heading_level: None,
                }
            }
        };
        // The window's own title-bar buttons are window chrome, never the app's controls: the window names them
        // (`chrome`), so a button of the app's content with the same subrole (a tab's close button) stays. A window that
        // names none falls back to the subrole.
        let chrome = match &self.chrome {
            Some(chrome) => chrome.contains(element),
            None => roles::window_control_name(read.subrole.as_deref()).is_some(),
        };
        if !root && chrome {
            return None;
        }
        let role = if root && read.role == "unknown" { "window" } else { read.role };
        let secure = read.subrole.as_deref() == Some("AXSecureTextField") || read.ax_role == "AXSecureTextField";
        let (actions, scroll_axes) = self.actions(element, &read);

        // The name a control takes from its label element: a stall reading it leaves the name unknown, a hole in the read,
        // so a locator cannot take the control's absence by that name as proof.
        let labelled = match read.title_element.as_ref().map(label_of) {
            Some(Ok(text)) => text,
            Some(Err(_)) => {
                self.lose();
                None
            }
            None => None,
        };
        let text_value = if secure { None } else { read.value.as_ref().and_then(Value::display) };
        let name = read
            .title
            .clone()
            .or(labelled)
            .or_else(|| read.description.clone())
            .or_else(|| if roles::text(role) { label(text_value.clone()) } else { None })
            .or_else(|| if roles::takes_text(role) { read.placeholder.clone() } else { None });
        let description = read.description.clone().filter(|description| Some(description) != name.as_ref());

        let mut states = Vec::new();
        // The app's focused element is the one source: a table's cells report the table's focus as their own.
        let focused = match &self.focused {
            Some(focused) => focused == element,
            None if self.focus_unknown => false,
            None => read.focused == Some(true),
        };
        if focused {
            states.push("focused");
        }
        if read.enabled == Some(false) {
            states.push("disabled");
        }
        if secure {
            states.push("secure");
        }
        let toggle = parse_toggle(read.value.as_ref());
        if expanded(role, read.expanded, toggle) {
            states.push("expanded");
        }
        if roles::toggleable(role) {
            match toggle {
                Some(1) => states.push("checked"),
                Some(2) => states.push("indeterminate"),
                _ => {}
            }
        }
        if selected(role, read.selected, toggle) {
            states.push("selected");
        }
        if role == "button" && toggle == Some(1) && read.subrole.as_deref() == Some("AXToggleButton") {
            states.push("pressed");
        }
        if matches!(role, "textfield" | "combobox") && !actions.contains(&"SetValue") {
            states.push("readonly");
        }
        // A menu or a popover floats above the window, so the window's frame does not hide it.
        if let (false, Some(bounds), Some(clip)) = (root || floats(role), read.bounds, clip)
            && outside(bounds, clip)
        {
            states.push("offscreen");
        }

        // A table's row gets a ref whatever it offers: an NSTableView selects it through the table's AXSelectedRows,
        // which a tap uses, not an action of the row. So does an element whose one action scrolls it into view.
        let ref_id = if !root
            && (roles::interactive(role)
                || role == "row"
                || actions
                    .iter()
                    .any(|action| matches!(*action, "Click" | "SetValue" | "Select" | "Scroll" | "RightClick" | "TypeText" | "Expand" | "ScrollTo")))
        {
            let reference = format!("@{}:e{}", self.snapshot, self.refs.len() + 1);
            self.refs.push((reference.clone(), Entry { element: element.clone(), pid: self.pid, window: self.window }));
            Some(reference)
        } else {
            None
        };

        let mut node = RawNode {
            ref_id,
            role,
            name,
            value: text_value,
            description,
            hint: read.help.clone(),
            level: if role == "heading" { read.heading_level } else { None },
            placeholder: read.placeholder.clone(),
            native_id: read.identifier.clone().map(|value| NativeId { kind: "ax_identifier", value }),
            states,
            available_actions: actions,
            scroll_axes,
            bounds: read.bounds,
            subtree_truncated: false,
            children_count: None,
            children: Vec::new(),
        };

        let inner = inner_clip(role, read.bounds, clip);
        let content_from = self.content.len();
        if role == "scrollbar" {
            // A scroll bar's arrows and page areas are its parts, not controls of their own.
        } else if level >= self.max_depth {
            let count = match element.count("AXChildren") {
                Ok(count) => count,
                Err(error) => {
                    // A stalled count could hide children past the depth limit: the read has a hole.
                    if missed(error) {
                        self.lose();
                        node.subtree_truncated = true;
                    }
                    0
                }
            };
            if count > 0 {
                node.children_count = Some(count);
            }
        } else if self.expired() {
            self.complete = false;
            self.timed_out = true;
            node.subtree_truncated = element.count("AXChildren").unwrap_or(0) > 0;
        } else {
            let lost = self.lost;
            let (children, count) = self.children(element, role);
            if count > children.len() {
                node.subtree_truncated = true;
            }
            for child in &children {
                if self.expired() {
                    self.complete = false;
                    self.timed_out = true;
                    node.subtree_truncated = true;
                    break;
                }
                if self.nodes >= MAX_NODES {
                    self.truncated = true;
                    node.subtree_truncated = true;
                    break;
                }
                if let Some(child) = self.node(child, level + 1, false, inner) {
                    node.children.push(child);
                }
            }
            if self.lost > lost {
                node.subtree_truncated = true;
            }
        }
        if node.name.is_none() && roles::named_by_content(role) {
            node.name = content_name(&self.content[content_from..]);
        }
        if roles::text(role)
            && let Some(name) = &node.name
        {
            self.content.push(name.clone());
        }

        if self.interactive
            && !root
            && node.ref_id.is_none()
            && node.children.is_empty()
            && !node.subtree_truncated
            && node.children_count.is_none()
            && !node.states.contains(&"secure")
        {
            return None;
        }
        Some(node)
    }
}

/// The name a row or cell takes from the text inside it, as an accessible name comes from content: every text, in
/// reading order, joined by spaces.
pub(crate) fn content_name(texts: &[String]) -> Option<String> {
    label(Some(texts.iter().map(|text| text.trim()).filter(|text| !text.is_empty()).collect::<Vec<_>>().join(" ")))
}

/// The title-bar buttons a window names as its own; `None` when it names none, so the walk falls back to their subrole.
fn window_chrome(window: &Element) -> Option<Vec<Element>> {
    let buttons: Vec<Element> =
        ["AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"].iter().filter_map(|name| window.element(name)).collect();
    (!buttons.is_empty()).then_some(buttons)
}

/// Reads one window of a process.
pub fn snapshot(request: Request) -> Outcome<RawSnapshot> {
    let window = windows::find(request.pid, request.window)?;
    let app = Element::application(request.pid);
    let (focused, focus_unknown) = match app.attribute("AXFocusedUIElement") {
        Ok(Value::Element(focused)) => (Some(focused), false),
        Err(ax::AX_CANNOT_COMPLETE) => (None, true),
        _ => (None, false),
    };
    let window_bounds = window.frame().map(|(x, y, width, height)| Rect { x, y, width, height });
    let title = window.text("AXTitle");
    let mut walk = Walk {
        pid: request.pid,
        window: request.window,
        snapshot: refs::snapshot_id(),
        max_depth: request.max_depth.max(1),
        interactive: request.interactive,
        deadline: request.deadline,
        focused,
        focus_unknown,
        chrome: window_chrome(&window),
        nodes: 0,
        complete: !focus_unknown,
        timed_out: false,
        root_unread: false,
        lost: 0,
        truncated: false,
        refs: Vec::new(),
        content: Vec::new(),
    };
    // The window must answer: one that does not is gone, or its app is.
    match window.attribute("AXRole") {
        Ok(_) => {}
        Err(ax::AX_INVALID_ELEMENT) => return Err(Failure::refused(codes::WINDOW_NOT_FOUND, format!("window {} closed", request.window))),
        Err(ax::AX_CANNOT_COMPLETE) => {
            return Err(Failure::refused(codes::APP_UNRESPONSIVE, "the app did not answer in time").with_details(serde_json::json!({ "retryable": true })));
        }
        Err(ax::AX_API_DISABLED) => return Err(Failure::refused(codes::PERM_DENIED, "this process has no Accessibility permission")),
        Err(_) => {}
    }
    let tree = walk
        .node(&window, 1, true, window_bounds)
        .ok_or_else(|| Failure::refused(codes::WINDOW_NOT_FOUND, format!("window {} could not be read", request.window)));
    // Accessibility permission taken away during the walk answers every read with an error the walk takes for an
    // element's own answer, and leaves it out: the tree would read as complete, and empty where it was not read.
    if !ax::trusted() {
        return Err(Failure::refused(codes::PERM_DENIED, "this process lost its Accessibility permission while it read the window"));
    }
    let tree = tree?;
    let ref_count = walk.refs.len();
    refs::insert_all(std::mem::take(&mut walk.refs));
    Ok(RawSnapshot {
        snapshot_id: walk.snapshot,
        complete: walk.complete,
        timed_out: walk.timed_out,
        root_unread: walk.root_unread,
        truncated: walk.truncated,
        ref_count,
        tree,
        window: WindowRef { id: request.window.to_string(), title },
    })
}

#[cfg(test)]
mod tests {
    use super::{content_name, expanded, inner_clip, level_of, missed, outside, selected};
    use crate::ax;
    use crate::windows::Rect;

    #[test]
    fn names_a_row_from_the_text_inside_it() {
        let texts = |items: &[&str]| items.iter().map(|text| (*text).to_owned()).collect::<Vec<_>>();
        assert_eq!(content_name(&texts(&["Item 1"])).as_deref(), Some("Item 1"));
        assert_eq!(content_name(&texts(&["Invoice 42", " ", "Paid "])).as_deref(), Some("Invoice 42 Paid"));
        assert_eq!(content_name(&texts(&[])), None);
        assert_eq!(content_name(&texts(&["  "])), None);
    }

    const WINDOW: Rect = Rect { x: 0.0, y: 0.0, width: 800.0, height: 600.0 };

    #[test]
    fn reads_a_heading_level_only_from_a_whole_number_from_one() {
        assert_eq!(level_of(Some(ax::Value::Number(2.0))), Some(2));
        for value in [Some(ax::Value::Number(0.0)), Some(ax::Value::Number(1.5)), Some(ax::Value::Number(-1.0)), Some(ax::Value::Bool(true)), None] {
            assert_eq!(level_of(value), None);
        }
    }

    #[test]
    fn reads_a_node_past_the_clip_as_outside() {
        assert!(outside(Rect { x: 0.0, y: 700.0, width: 100.0, height: 20.0 }, WINDOW));
        assert!(!outside(Rect { x: 10.0, y: 10.0, width: 100.0, height: 20.0 }, WINDOW));
    }

    #[test]
    fn counts_only_a_stall_as_a_hole_in_the_read() {
        assert!(missed(ax::AX_CANNOT_COMPLETE));
        for error in [ax::AX_INVALID_ELEMENT, ax::AX_NO_VALUE, ax::AX_ATTRIBUTE_UNSUPPORTED, ax::AX_FAILURE, ax::AX_NOT_IMPLEMENTED] {
            assert!(!missed(error), "{error}");
        }
    }

    #[test]
    fn reads_a_disclosure_triangle_by_its_value_and_no_menu_item_as_selected() {
        assert!(expanded("disclosure", None, Some(1)));
        assert!(!expanded("disclosure", None, Some(0)));
        assert!(!expanded("checkbox", None, Some(1)));
        assert!(expanded("treeitem", Some(true), None));
        assert!(!selected("menuitem", Some(true), None));
        assert!(selected("row", Some(true), None));
        // An AppKit tab is the active one by its value, and no other role is selected by it.
        assert!(selected("tab", None, Some(1)));
        assert!(!selected("tab", None, Some(0)));
        assert!(!selected("radiobutton", None, Some(1)));
    }

    #[test]
    fn leaves_a_popover_or_menu_past_the_window_unclipped() {
        // A SwiftUI popover hangs off its window: its text sits above the window's top edge.
        let above = Rect { x: 10.0, y: -37.0, width: 100.0, height: 20.0 };
        assert!(outside(above, inner_clip("group", None, Some(WINDOW)).expect("the window's clip")));
        assert_eq!(inner_clip("popover", None, Some(WINDOW)), None);
        assert_eq!(inner_clip("menu", None, Some(WINDOW)), None);
    }

    #[test]
    fn reads_a_box_state_from_a_number_a_boolean_or_a_word() {
        use super::parse_toggle;
        use crate::ax::Value;
        assert_eq!(parse_toggle(Some(&Value::Text("on".into()))), Some(1));
        assert_eq!(parse_toggle(Some(&Value::Text("off".into()))), Some(0));
        assert_eq!(parse_toggle(Some(&Value::Text("mixed".into()))), Some(2));
        assert_eq!(parse_toggle(Some(&Value::Number(1.0))), Some(1));
        assert_eq!(parse_toggle(Some(&Value::Bool(false))), Some(0));
        assert_eq!(parse_toggle(Some(&Value::Text("maybe".into()))), None);
    }

    #[test]
    fn never_reads_a_zero_size_node_as_outside() {
        // An open context menu on macOS 27: its `AXMenu` is 0x0 at the screen's corner, its items are in the window.
        assert!(!outside(Rect { x: 0.0, y: 1080.0, width: 0.0, height: 0.0 }, WINDOW));
    }
}
