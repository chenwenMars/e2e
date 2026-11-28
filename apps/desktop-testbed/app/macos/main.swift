// The desktop testbed's sign-in form: AppKit controls with accessibility
// identifiers. Sign in writes what it read into the status line, so a test
// can check every control reached the app. "Controls…" opens a second
// window with one control per engine capability the form does not reach
// (a scrolling list, a key handler, a context menu, a slider, a disabled
// button, a SwiftUI alert, and double-click and hover targets for physical
// input), each writing what happened into that window's status line.

import AppKit
import SwiftUI

final class Controller: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  let username = NSTextField()
  let password = NSSecureTextField()
  let remember = NSButton(checkboxWithTitle: "Remember me", target: nil, action: nil)
  let plan = NSPopUpButton()
  let status = NSTextField(labelWithString: "Not signed in")

  func applicationDidFinishLaunching(_ note: Notification) {
    window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 420, height: 320),
                      styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    window.title = "Sign In"
    let heading = NSTextField(labelWithString: "Sign in to the testbed")
    heading.font = .boldSystemFont(ofSize: 16)
    username.placeholderString = "Username"
    username.setAccessibilityIdentifier("username")
    username.setAccessibilityLabel("Username")
    password.placeholderString = "Password"
    password.setAccessibilityIdentifier("password")
    password.setAccessibilityLabel("Password")
    remember.setAccessibilityIdentifier("remember")
    plan.addItems(withTitles: ["Free", "Pro", "Team", "Enterprise", "Enterprise (new)", "Legacy"])
    plan.autoenablesItems = false
    // Two Enterprise items, the disabled one first (a pop-up keeps titles unique, so the second is renamed after it is
    // added): a select of Enterprise must choose the enabled one.
    plan.item(withTitle: "Enterprise")?.isEnabled = false
    plan.item(withTitle: "Enterprise (new)")?.title = "Enterprise"
    // Legacy stays disabled: a select of it must wait, then refuse it as disabled, not as missing.
    plan.item(withTitle: "Legacy")?.isEnabled = false
    plan.selectItem(withTitle: "Pro")
    plan.setAccessibilityIdentifier("plan")
    plan.setAccessibilityLabel("Plan")
    status.setAccessibilityIdentifier("status")
    let signIn = NSButton(title: "Sign in", target: self, action: #selector(signIn(_:)))
    signIn.setAccessibilityIdentifier("sign-in")
    let more = NSButton(title: "Controls…", target: self, action: #selector(openControls(_:)))
    more.setAccessibilityIdentifier("open-controls")
    let stack = NSStackView(views: [heading, username, password, remember, plan, signIn, status, more])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
    username.widthAnchor.constraint(equalToConstant: 260).isActive = true
    password.widthAnchor.constraint(equalToConstant: 260).isActive = true
    status.widthAnchor.constraint(equalToConstant: 360).isActive = true
    window.contentView = stack
    // No activation: the engine launches the app in the background unless the run is headed or allows physical input, and the suites drive it there.
    window.makeKeyAndOrderFront(nil)
  }

  @objc func signIn(_ sender: NSButton) {
    if password.stringValue.isEmpty {
      status.stringValue = "Password is required"
      return
    }
    // The password's length, never the password: a test proves the secret reached the field without the app showing it.
    let remembered = remember.state == .on ? ", remembered" : ""
    status.stringValue = "Signed in as \(username.stringValue) on \(plan.titleOfSelectedItem ?? "?")\(remembered) (password: \(password.stringValue.count) characters)"
  }

  let controls = ControlsWindow()

  @objc func openControls(_ sender: NSButton) {
    controls.show()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}

/// A SwiftUI button whose alert holds two more: a press on either closes the alert, and SwiftUI then answers that
/// press with an error though it ran, unlike AppKit's alert.
struct DraftAlert: View {
  let report: (String) -> Void
  @State private var asking = false

  var body: some View {
    Button("Delete draft…") { asking = true }
      .alert("Delete draft?", isPresented: $asking) {
        Button("Cancel", role: .cancel) { report("Kept the draft") }
        Button("Delete", role: .destructive) { report("Deleted the draft") }
      }
  }
}

/// A view that reports the pointer entering it, for `hover`.
final class HoverTarget: NSView {
  var onHover: () -> Void = {}

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for area in trackingAreas { removeTrackingArea(area) }
    addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
  }

  override func mouseEntered(with event: NSEvent) { onHover() }

  override func draw(_ dirtyRect: NSRect) {
    NSColor.systemTeal.setFill()
    bounds.fill()
  }
}

/// A button that reports a double click, which only the real pointer sends.
final class DoubleClickButton: NSButton {
  var onDoubleClick: () -> Void = {}

  override func mouseDown(with event: NSEvent) {
    if event.clickCount == 2 { onDoubleClick() }
    super.mouseDown(with: event)
  }
}

/// A field that grows as it takes the keyboard, as a search field does: its box when focused is not the one it was read with.
final class GrowingField: NSTextField {
  lazy var width = widthAnchor.constraint(equalToConstant: 80)

  override func becomeFirstResponder() -> Bool {
    width.constant = 160
    return super.becomeFirstResponder()
  }
}

/// A field that gives the keyboard to another control as soon as it takes it: a key meant for it must not follow.
final class HandoffField: NSTextField {
  weak var heir: NSView?

  override func becomeFirstResponder() -> Bool {
    DispatchQueue.main.async { [weak self] in self?.window?.makeFirstResponder(self?.heir) }
    return super.becomeFirstResponder()
  }
}

/// The second window: one control per capability, and a status line.
final class ControlsWindow: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSMenuDelegate, NSTextFieldDelegate {
  var window: NSWindow?
  var popup: NSWindow?
  let opener = NSTextField()
  let popupField = NSTextField()
  let status = NSTextField(labelWithString: "Nothing yet")
  // The hover target reports to a label of its own: a pointer left over it (by the physical-input suite) enters it again when a
  // menu closes, and must not overwrite what another test reads from the status line.
  let hoverStatus = NSTextField(labelWithString: "Not hovered")
  let items = (1...40).map { "Item \($0)" }
  let table = NSTableView()
  // A table whose rows show two cells each, two of them alike: a row is named by all its text.
  let accounts = [("Checking", "USD"), ("Savings", "EUR"), ("Savings", "EUR")]
  let accountTable = NSTableView()
  let note = NSTextField()
  let volume = NSSlider(value: 50, minValue: 0, maxValue: 100, target: nil, action: nil)
  let size = NSPopUpButton()
  let agree = NSButton(checkboxWithTitle: "Agree", target: nil, action: nil)

  func show() {
    if let window { window.makeKeyAndOrderFront(nil); return }
    let window = NSWindow(contentRect: NSRect(x: 660, y: 200, width: 360, height: 930),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Controls"
    window.isReleasedWhenClosed = false
    status.setAccessibilityIdentifier("controls-status")

    let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("item"))
    column.width = 280
    table.addTableColumn(column)
    table.headerView = nil
    table.dataSource = self
    table.delegate = self
    table.setAccessibilityLabel("Items")
    table.setAccessibilityIdentifier("items")
    for (name, width) in [("name", 140.0), ("currency", 80.0)] {
      let accountColumn = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(name))
      accountColumn.width = width
      accountTable.addTableColumn(accountColumn)
    }
    accountTable.headerView = nil
    accountTable.dataSource = self
    accountTable.delegate = self
    accountTable.setAccessibilityLabel("Accounts")
    accountTable.setAccessibilityIdentifier("accounts")
    let accountScroll = NSScrollView()
    accountScroll.documentView = accountTable
    accountScroll.heightAnchor.constraint(equalToConstant: 70).isActive = true
    accountScroll.widthAnchor.constraint(equalToConstant: 260).isActive = true

    let scroll = NSScrollView()
    scroll.documentView = table
    scroll.hasVerticalScroller = true
    scroll.setAccessibilityIdentifier("items-scroll")
    scroll.heightAnchor.constraint(equalToConstant: 120).isActive = true
    scroll.widthAnchor.constraint(equalToConstant: 300).isActive = true

    note.placeholderString = "Note"
    note.setAccessibilityLabel("Note")
    note.setAccessibilityIdentifier("note")
    note.target = self
    note.action = #selector(submit(_:))
    note.widthAnchor.constraint(equalToConstant: 260).isActive = true

    // Its first character opens another window and moves the keyboard there: the rest of a typed text must not follow.
    opener.placeholderString = "Opens a window"
    opener.setAccessibilityLabel("Opener")
    opener.setAccessibilityIdentifier("opener")
    opener.delegate = self
    opener.widthAnchor.constraint(equalToConstant: 260).isActive = true

    // Two fields no name or identifier tells apart, each growing as it takes the keyboard: a key for one must reach it.
    let tags = NSStackView(views: (1...2).map { _ in
      let tag = GrowingField()
      tag.setAccessibilityLabel("Tag")
      tag.target = self
      tag.action = #selector(submit(_:))
      tag.width.isActive = true
      return tag
    })

    let handoff = HandoffField()
    handoff.setAccessibilityLabel("Hands off")
    handoff.heir = note
    handoff.widthAnchor.constraint(equalToConstant: 260).isActive = true

    // An NSTabView's items are AXRadioButtons with the AXTabButton subrole: they read as tabs, the active one selected.
    let tabs = NSTabView()
    for title in ["First", "Second"] {
      let item = NSTabViewItem(identifier: title)
      item.label = title
      item.view = NSView()
      tabs.addTabViewItem(item)
    }
    tabs.setAccessibilityIdentifier("tabs")
    tabs.widthAnchor.constraint(equalToConstant: 260).isActive = true
    tabs.heightAnchor.constraint(equalToConstant: 60).isActive = true

    let options = NSButton(title: "Options", target: nil, action: nil)
    options.setAccessibilityIdentifier("options")
    let menu = NSMenu(title: "Options")
    menu.delegate = self
    menu.addItem(withTitle: "Copy", action: #selector(chose(_:)), keyEquivalent: "").target = self
    menu.addItem(withTitle: "Delete", action: #selector(chose(_:)), keyEquivalent: "").target = self
    options.menu = menu

    volume.setAccessibilityLabel("Volume")
    volume.setAccessibilityIdentifier("volume")
    volume.target = self
    volume.action = #selector(slid(_:))
    volume.widthAnchor.constraint(equalToConstant: 200).isActive = true

    let disabled = NSButton(title: "Disabled", target: nil, action: nil)
    disabled.isEnabled = false
    disabled.setAccessibilityIdentifier("disabled")

    // A list and a box that start disabled, and a button that enables them a moment later: a select or a check must
    // wait for them.
    size.addItems(withTitles: ["Small", "Large"])
    size.isEnabled = false
    size.setAccessibilityLabel("Size")
    size.setAccessibilityIdentifier("size")
    agree.isEnabled = false
    agree.setAccessibilityIdentifier("agree")
    let enableLater = NSButton(title: "Enable later", target: self, action: #selector(enableLater(_:)))
    enableLater.setAccessibilityIdentifier("enable-later")

    // A button of the app's content with the close-button subrole, as a tab's close button has: it is the app's, not
    // window chrome, and must stay in the tree.
    let closeTab = NSButton(title: "Close tab", target: nil, action: nil)
    closeTab.setAccessibilitySubrole(.closeButton)
    closeTab.setAccessibilityIdentifier("close-tab")

    let double = DoubleClickButton(title: "Double-click me", target: nil, action: nil)
    double.setAccessibilityIdentifier("double")
    double.onDoubleClick = { [weak self] in self?.status.stringValue = "Double-clicked" }

    let hover = HoverTarget()
    hover.setAccessibilityElement(true)
    hover.setAccessibilityRole(.group)
    hover.setAccessibilityLabel("Hover target")
    hover.setAccessibilityIdentifier("hover")
    hover.onHover = { [weak self] in self?.hoverStatus.stringValue = "Hovered" }
    hoverStatus.setAccessibilityIdentifier("hover-status")
    hover.widthAnchor.constraint(equalToConstant: 120).isActive = true
    hover.heightAnchor.constraint(equalToConstant: 30).isActive = true

    let draft = NSHostingView(rootView: DraftAlert { [weak self] text in self?.status.stringValue = text })

    let stack = NSStackView(views: [scroll, accountScroll, note, opener, tags, handoff, tabs, options, volume, disabled, enableLater, size, agree, closeTab, draft, double, hover, hoverStatus, status])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
    status.widthAnchor.constraint(equalToConstant: 320).isActive = true
    window.contentView = stack
    self.window = window
    window.makeKeyAndOrderFront(nil)
  }

  @objc func enableLater(_ sender: NSButton) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
      self?.size.isEnabled = true
      self?.agree.isEnabled = true
    }
  }

  func numberOfRows(in tableView: NSTableView) -> Int { tableView === accountTable ? accounts.count : items.count }

  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    if tableView === accountTable {
      let account = accounts[row]
      return NSTextField(labelWithString: tableColumn?.identifier.rawValue == "currency" ? account.1 : account.0)
    }
    let cell = NSTextField(labelWithString: items[row])
    cell.identifier = NSUserInterfaceItemIdentifier("cell")
    return cell
  }

  func tableViewSelectionDidChange(_ notification: Notification) {
    if (notification.object as? NSTableView) === accountTable {
      guard accountTable.selectedRow >= 0 else { return }
      let account = accounts[accountTable.selectedRow]
      status.stringValue = "Selected account \(accountTable.selectedRow + 1): \(account.0) \(account.1)"
      return
    }
    guard table.selectedRow >= 0 else { return }
    status.stringValue = "Selected \(items[table.selectedRow])"
  }

  func menuWillOpen(_ menu: NSMenu) { status.stringValue = "Context menu opened" }

  @objc func chose(_ sender: NSMenuItem) { status.stringValue = "Chose \(sender.title)" }

  @objc func submit(_ sender: NSTextField) { status.stringValue = "Submitted: \(sender.stringValue)" }

  func controlTextDidChange(_ notification: Notification) {
    guard (notification.object as? NSTextField) === opener, popup == nil else { return }
    let popup = NSWindow(contentRect: NSRect(x: 1040, y: 200, width: 300, height: 100),
                         styleMask: [.titled, .closable], backing: .buffered, defer: false)
    popup.title = "Popup"
    popup.isReleasedWhenClosed = false
    popupField.setAccessibilityLabel("Popup field")
    popupField.setAccessibilityIdentifier("popup-field")
    popupField.frame = NSRect(x: 20, y: 40, width: 260, height: 24)
    let content = NSView()
    content.addSubview(popupField)
    popup.contentView = content
    self.popup = popup
    popup.makeKeyAndOrderFront(nil)
    popup.makeFirstResponder(popupField)
  }

  @objc func slid(_ sender: NSSlider) { status.stringValue = "Volume \(Int(sender.doubleValue))" }

}

let app = NSApplication.shared
let controller = Controller()
app.delegate = controller
app.setActivationPolicy(.regular)
app.run()
