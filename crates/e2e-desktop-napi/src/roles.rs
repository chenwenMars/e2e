//! macOS accessibility roles in the engine's raw role vocabulary, which
//! `nodes.ts` maps onto ARIA names. The vocabulary is agent-desktop's
//! (Apache-2.0), kept so the snapshots it was tested on still project.

/// The raw role of an element, from its AX role and subrole.
pub fn role(ax_role: &str, subrole: Option<&str>) -> &'static str {
    match subrole {
        // An NSTabView item is an AXRadioButton that says by its subrole that it is a tab.
        Some("AXTabButton") => return "tab",
        Some("AXApplicationAlert") => return "alert",
        Some("AXApplicationAlertDialog") => return "alertdialog",
        Some("AXApplicationDialog" | "AXDialog" | "AXSystemDialog") => return "dialog",
        Some("AXApplicationLog") => return "log",
        Some("AXApplicationMarquee") => return "marquee",
        Some("AXApplicationStatus") => return "status",
        Some("AXApplicationTimer") => return "timer",
        Some("AXDocumentArticle") => return "article",
        Some("AXDocumentMath") => return "math",
        Some("AXDocumentNote") => return "note",
        Some("AXDocumentRegion") => return "region",
        Some("AXLandmarkBanner") => return "banner",
        Some("AXLandmarkComplementary") => return "complementary",
        Some("AXLandmarkContentInfo") => return "contentinfo",
        Some("AXLandmarkForm") => return "form",
        Some("AXLandmarkMain") => return "main",
        Some("AXLandmarkNavigation") => return "navigation",
        Some("AXLandmarkSearch") => return "search",
        Some("AXDefinition") => return "definition",
        Some("AXTerm") => return "term",
        Some("AXTabPanel") => return "tabpanel",
        Some("AXUserInterfaceTooltip") => return "tooltip",
        Some("AXToggleButton") => {
            let primary = base(ax_role);
            return if matches!(primary, "checkbox" | "switch" | "radiobutton") { primary } else { "button" };
        }
        Some("AXOutlineRow") => return "treeitem",
        Some("AXTableRow") => return "row",
        Some("AXSecureTextField" | "AXSearchField") => return "textfield",
        Some("AXCloseButton" | "AXMinimizeButton" | "AXZoomButton" | "AXToolbarButton" | "AXFullScreenButton" | "AXSortButton") => return "button",
        Some("AXToggle" | "AXSwitch") => return "switch",
        Some("AXContentList" | "AXDefinitionList" | "AXDescriptionList") => return "list",
        _ => {}
    }
    base(ax_role)
}

fn base(ax_role: &str) -> &'static str {
    match ax_role {
        "AXApplication" => "application",
        "AXButton" => "button",
        "AXMenuButton" => "menubutton",
        "AXTextField" | "AXTextArea" | "AXSearchField" | "AXSecureTextField" => "textfield",
        "AXCheckBox" => "checkbox",
        "AXSwitch" | "AXToggle" => "switch",
        "AXLink" => "link",
        "AXMenuItem" | "AXMenuBarItem" => "menuitem",
        "AXRadioButton" => "radiobutton",
        "AXTab" => "tab",
        "AXTabGroup" => "tablist",
        "AXSlider" => "slider",
        "AXValueIndicator" | "AXHandle" => "handle",
        "AXComboBox" | "AXPopUpButton" => "combobox",
        "AXOutlineRow" => "treeitem",
        "AXRow" => "row",
        "AXCell" => "cell",
        "AXColumn" => "column",
        "AXWindow" => "window",
        "AXSheet" => "sheet",
        "AXDialog" => "dialog",
        "AXGroup" | "AXGenericElement" | "AXSplitGroup" => "group",
        "AXRadioGroup" => "radiogroup",
        "AXToolbar" => "toolbar",
        "AXStaticText" => "statictext",
        "AXImage" => "image",
        "AXTable" => "table",
        "AXList" => "list",
        "AXOutline" => "outline",
        "AXScrollArea" => "scrollarea",
        "AXScrollBar" => "scrollbar",
        "AXSplitter" => "splitter",
        "AXSeparator" => "separator",
        "AXMenu" | "AXMenuBar" => "menu",
        "AXIncrementor" | "AXStepper" => "incrementor",
        "AXDisclosureTriangle" => "disclosure",
        "AXProgressIndicator" | "AXBusyIndicator" => "progressbar",
        "AXColorWell" => "colorwell",
        "AXWebArea" => "webarea",
        "AXBrowser" => "browser",
        "AXGrid" => "grid",
        "AXPopover" => "popover",
        "AXTimeField" => "timefield",
        "AXDateField" => "datefield",
        "AXHelpTag" => "helptag",
        "AXMatte" => "matte",
        "AXDrawer" => "drawer",
        "AXLayoutArea" | "AXLayoutItem" => "layoutitem",
        "AXLevelIndicator" => "levelindicator",
        "AXRelevanceIndicator" => "relevanceindicator",
        "AXDocument" => "document",
        "AXHeading" => "heading",
        "AXParagraph" => "paragraph",
        "AXStatus" => "status",
        "AXToolTip" => "tooltip",
        _ => "unknown",
    }
}

/// The name macOS draws for a window's title-bar button, which has no title of its own.
pub fn window_control_name(subrole: Option<&str>) -> Option<&'static str> {
    match subrole {
        Some("AXCloseButton") => Some("Close"),
        Some("AXMinimizeButton") => Some("Minimize"),
        Some("AXZoomButton") => Some("Zoom"),
        Some("AXFullScreenButton") => Some("Full Screen"),
        _ => None,
    }
}

/// Roles that are controls, and so get a ref whatever actions they list.
pub fn interactive(role: &str) -> bool {
    matches!(
        role,
        "button"
            | "cell"
            | "checkbox"
            | "colorwell"
            | "combobox"
            | "incrementor"
            | "link"
            | "listbox"
            | "menubutton"
            | "menuitem"
            | "option"
            | "radiobutton"
            | "slider"
            | "switch"
            | "tab"
            | "textfield"
            | "treeitem"
            | "disclosure"
            | "datefield"
            | "timefield"
    )
}

/// Roles whose checked state their value carries.
pub fn toggleable(role: &str) -> bool {
    matches!(role, "checkbox" | "switch" | "radiobutton")
}

/// Roles with an expanded or collapsed state.
pub fn expandable(role: &str) -> bool {
    matches!(role, "combobox" | "menubutton" | "treeitem" | "disclosure")
}

/// Roles whose value a write can set.
pub fn bears_value(role: &str) -> bool {
    matches!(
        role,
        "textfield"
            | "combobox"
            | "slider"
            | "incrementor"
            | "checkbox"
            | "radiobutton"
            | "switch"
            | "colorwell"
            | "scrollbar"
            | "handle"
            | "datefield"
            | "timefield"
    )
}

/// Roles that take typed text.
pub fn takes_text(role: &str) -> bool {
    matches!(role, "textfield" | "combobox" | "datefield" | "timefield")
}

/// Roles that select one of their items.
pub fn collection(role: &str) -> bool {
    matches!(role, "list" | "listbox" | "table" | "outline" | "browser" | "radiogroup" | "tablist")
}

/// Roles whose text is their value.
pub fn text(role: &str) -> bool {
    matches!(role, "statictext" | "heading")
}

/// Roles that take their name from the text inside them when they have none of their own: a table's row and cell, an
/// outline's item, a list's option.
pub fn named_by_content(role: &str) -> bool {
    matches!(role, "row" | "cell" | "treeitem" | "option" | "listitem")
}

/// Roles that never take an action, so no action names are read for them. An image, a text label, or a heading is not
/// one: an app can make any of them a button of its own (`AXPress`), which needs a ref to be tapped.
pub fn inert(role: &str) -> bool {
    matches!(
        role,
        "separator" | "splitter" | "layoutitem" | "matte" | "paragraph" | "progressbar" | "levelindicator" | "relevanceindicator" | "helptag" | "tooltip"
    )
}

/// Roles that can hold many children, read a page at a time.
pub fn large(role: &str) -> bool {
    matches!(role, "table" | "outline" | "list" | "browser" | "grid" | "column")
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_an_appkit_tab_as_a_tab_not_a_radio_button() {
        assert_eq!(super::role("AXRadioButton", Some("AXTabButton")), "tab");
        assert_eq!(super::role("AXRadioButton", None), "radiobutton");
    }

    #[test]
    fn reads_the_actions_of_a_label_an_image_and_a_heading() {
        // Any of them can be a button of its own, which needs a ref to be tapped.
        for role in ["statictext", "image", "heading"] {
            assert!(!super::inert(role), "{role}");
        }
        assert!(super::inert("separator"));
    }
}
