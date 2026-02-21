import AppKit
import SwiftUI

@MainActor
final class StatusItemController: NSObject {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let popover = NSPopover()

  init(manager: GatewayManager, menuIcon: NSImage?, onOpenSettings: @escaping () -> Void) {
    super.init()

    popover.behavior = .transient
    popover.animates = true
    popover.contentSize = NSSize(width: 520, height: 760)
    popover.contentViewController = NSHostingController(rootView: StatusMenuView(manager: manager, onOpenSettings: onOpenSettings))

    guard let button = statusItem.button else { return }
    if let menuIcon {
      menuIcon.isTemplate = true
      button.image = menuIcon
      button.image?.size = NSSize(width: 24, height: 24)
    } else {
      button.image = NSImage(systemSymbolName: "bolt.horizontal.circle", accessibilityDescription: "CodexGateway")
      button.image?.isTemplate = true
    }
    button.target = self
    button.action = #selector(togglePopover(_:))
    button.sendAction(on: [.leftMouseUp, .rightMouseUp])
  }

  @objc private func togglePopover(_ sender: Any?) {
    guard let button = statusItem.button else { return }
    if popover.isShown {
      popover.performClose(sender)
      return
    }
    NSApp.activate(ignoringOtherApps: true)
    popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    popover.contentViewController?.view.window?.makeKey()
  }
}

@MainActor
final class SettingsWindowController: NSObject {
  private var window: NSWindow?
  private let manager: GatewayManager

  init(manager: GatewayManager) {
    self.manager = manager
    super.init()
  }

  func show() {
    if let existingWindow = window {
      NSApp.activate(ignoringOtherApps: true)
      existingWindow.makeKeyAndOrderFront(nil)
      return
    }

    let contentView = SettingsView(manager: manager)
    let hostingController = NSHostingController(rootView: contentView)
    let newWindow = NSWindow(contentViewController: hostingController)
    newWindow.title = "Gateway Settings"
    newWindow.setContentSize(NSSize(width: 640, height: 420))
    newWindow.styleMask = [.titled, .closable, .miniaturizable, .resizable]
    newWindow.isReleasedWhenClosed = false
    newWindow.center()
    newWindow.delegate = self

    window = newWindow
    NSApp.activate(ignoringOtherApps: true)
    newWindow.makeKeyAndOrderFront(nil)
  }
}

extension SettingsWindowController: NSWindowDelegate {
  func windowWillClose(_ notification: Notification) {
    window = nil
  }
}

@MainActor
final class CodexGatewayAppDelegate: NSObject, NSApplicationDelegate {
  let manager = GatewayManager()
  private var statusItemController: StatusItemController?
  private var settingsWindowController: SettingsWindowController?

  func applicationDidFinishLaunching(_ notification: Notification) {
    manager.bootstrap()
    settingsWindowController = SettingsWindowController(manager: manager)
    let menuIcon = Bundle.module.url(forResource: "MenuBarIcon", withExtension: "png")
      .flatMap { NSImage(contentsOf: $0) }
    statusItemController = StatusItemController(
      manager: manager,
      menuIcon: menuIcon,
      onOpenSettings: { [weak self] in
        self?.settingsWindowController?.show()
      }
    )
  }
}

@main
struct CodexGatewayApp: App {
  @NSApplicationDelegateAdaptor(CodexGatewayAppDelegate.self) private var appDelegate

  var body: some Scene {
    Settings { EmptyView() }
  }
}
