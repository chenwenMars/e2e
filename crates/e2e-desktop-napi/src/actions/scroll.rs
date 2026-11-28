//! Scrolling a list or scroll area by its scroll bar, or by the page actions an element takes.

use super::*;

/// A scroll area's scroll bar for one axis. A SwiftUI `List` lists it only as a child, with no `AXVerticalScrollBar`.
pub fn scroll_bar(element: &Element, vertical: bool) -> Option<Element> {
    element.element(if vertical { "AXVerticalScrollBar" } else { "AXHorizontalScrollBar" }).or_else(|| {
        let orientation = if vertical { "AXVerticalOrientation" } else { "AXHorizontalOrientation" };
        element.elements("AXChildren", 16).ok()?.into_iter().find(|child| {
            child.text("AXRole").as_deref() == Some("AXScrollBar")
                && match child.text("AXOrientation") {
                    Some(shown) => shown == orientation,
                    // No orientation: a vertical bar is taller than it is wide.
                    None => child.frame().is_some_and(|(_, _, width, height)| (height > width) == vertical),
                }
        })
    })
}

/// Scrolls a scroll area by moving its scroll bar, `pages` of its visible size.
pub(super) fn scroll(element: &Element, direction: &str, pages: f64) -> Outcome<()> {
    let vertical = matches!(direction, "up" | "down");
    // A node that scrolls itself along the axis is the one moved; one that does not, a list or table, scrolls through the
    // scroll area that holds it. The enclosing pane comes last, so a swipe on a nested list never moves the pane around it.
    let (_, role) = role_of(element, "scroll")?;
    let own = scrolls_itself(role, scroll_bar(element, vertical).is_some(), &action_names(element, "scroll")?, direction);
    let target = if own { None } else { enclosing_scroll_area(element, vertical) };
    scroll_by(target.as_ref().unwrap_or(element), direction, pages).map_err(|failure| {
        // An element that takes none of the ways to scroll: say so, not which attribute it lacks. Like a window with
        // nothing to scroll, it is not actionable, not a capability the engine lacks.
        if failure.code == codes::ACTION_NOT_SUPPORTED && failure.delivery == Delivery::NotDelivered {
            Failure::refused(codes::ACTION_FAILED, format!("nothing here scrolls {direction}"))
        } else {
            failure
        }
    })
}

/// Whether a node scrolls itself along `direction`, by the rule the snapshot offers `Scroll` with: a scroll bar for the
/// axis, or, for any role but a scroll area, the page action for the direction. SwiftUI gives every scroll area the page
/// actions, also one whose content fits or that scrolls only along the other axis, and the action then moves nothing
/// while it answers success.
pub(super) fn scrolls_itself(role: &str, bar: bool, actions: &[String], direction: &str) -> bool {
    bar || (role != "scrollarea" && actions.iter().any(|name| name == page_action(direction)))
}

/// The nearest scroll area above `element`, a few levels up, with a scroll bar for the axis.
pub(super) fn enclosing_scroll_area(element: &Element, vertical: bool) -> Option<Element> {
    let mut current = element.element("AXParent")?;
    for _ in 0..4 {
        if current.text("AXRole").as_deref() == Some("AXScrollArea") && scroll_bar(&current, vertical).is_some() {
            return Some(current);
        }
        current = current.element("AXParent")?;
    }
    None
}

/// The accessibility action that scrolls an element a page in `direction`.
fn page_action(direction: &str) -> &'static str {
    match direction {
        "down" => "AXScrollDownByPage",
        "up" => "AXScrollUpByPage",
        "right" => "AXScrollRightByPage",
        _ => "AXScrollLeftByPage",
    }
}

/// About how many of a scroll bar's increments make a page.
pub(super) const LINES_PER_PAGE: f64 = 8.0;

/// Performs a scroll action `count` times. Each goes through the cancel check; a failure after the first follows a
/// scroll that landed.
pub(super) fn repeat(element: &Element, action: &str, count: usize) -> Outcome<()> {
    for sent in 0..count {
        perform(element, action, "scroll").map_err(|failure| if sent == 0 { failure } else { failure.delivered() })?;
    }
    Ok(())
}

pub(super) fn scroll_by(element: &Element, direction: &str, pages: f64) -> Outcome<()> {
    let vertical = matches!(direction, "up" | "down");
    let forward = matches!(direction, "down" | "right");
    if let Some(bar) = scroll_bar(element, vertical) {
        // A position the app did not answer is no position: one step from the top could move the view the wrong way.
        let current = match bar.attribute("AXValue") {
            Ok(Value::Number(number)) => Some(number),
            Err(ax::AX_CANNOT_COMPLETE) => return Err(unread(ax::AX_CANNOT_COMPLETE, "scroll")),
            _ => None,
        };
        let (_, _, width, height) = element.frame().unwrap_or((0.0, 0.0, 0.0, 0.0));
        let visible = if vertical { height } else { width };
        let content = element
            .element("AXContents")
            .or_else(|| element.elements("AXChildren", 16).ok()?.into_iter().find(|child| child.text("AXRole").as_deref() != Some("AXScrollBar")))
            .and_then(|contents| contents.frame())
            .map(|(_, _, width, height)| if vertical { height } else { width })
            .unwrap_or(0.0);
        let step = if content > visible && visible > 0.0 { pages * visible / (content - visible) } else { pages * 0.25 };
        if let Some(current) = current
            && settable(&bar, "AXValue", "scroll")?
        {
            let next = (current + if forward { step } else { -step }).clamp(0.0, 1.0);
            go("scroll")?;
            return bar.set_number("AXValue", next).map_err(|error| write_failed(error, "scroll"));
        }
        // A step is about a line: as many as make the pages asked for, so a fast swipe goes further than a slow one.
        return repeat(&bar, if forward { "AXIncrement" } else { "AXDecrement" }, ((pages * LINES_PER_PAGE).round() as usize).max(1));
    }
    let names = action_names(element, "scroll")?;
    let (_, role) = role_of(element, "scroll")?;
    if scrolls_itself(role, false, &names, direction) {
        return repeat(element, page_action(direction), (pages.round() as usize).max(1));
    }
    Err(Failure::refused(codes::ACTION_FAILED, format!("nothing here scrolls {direction}")))
}
