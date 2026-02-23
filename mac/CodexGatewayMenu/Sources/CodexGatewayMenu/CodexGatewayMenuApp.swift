import AppKit
import Combine
import SwiftUI

@MainActor
final class StatusItemController: NSObject {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let popover = NSPopover()
  private let manager: GatewayManager
  private let menuIcon: NSImage?
  private let minPopoverWidth: CGFloat = 360
  private let preferredPopoverWidth: CGFloat = 520
  private let minPopoverHeight: CGFloat = 240
  private let maxPopoverHeight: CGFloat = 760
  private var statusCancellable: AnyCancellable?

  init(manager: GatewayManager, menuIcon: NSImage?, onOpenSettings: @escaping () -> Void) {
    self.manager = manager
    self.menuIcon = menuIcon
    super.init()

    popover.behavior = .transient
    popover.animates = true
    popover.contentSize = NSSize(width: preferredPopoverWidth, height: 420)
    popover.contentViewController = NSHostingController(rootView: StatusMenuView(manager: manager, onOpenSettings: onOpenSettings))

    guard let button = statusItem.button else { return }
    button.title = ""
    updateStatusIndicator(isRunning: manager.isRunning)
    statusCancellable = manager.$isRunning
      .receive(on: RunLoop.main)
      .sink { [weak self] isRunning in
        self?.updateStatusIndicator(isRunning: isRunning)
      }
    button.target = self
    button.action = #selector(togglePopover(_:))
    button.sendAction(on: [.leftMouseUp, .rightMouseUp])
  }

  @objc private func togglePopover(_ sender: Any?) {
    guard statusItem.button != nil else { return }
    if popover.isShown {
      popover.performClose(sender)
      return
    }
    showPopover()
  }

  func showPopover() {
    guard let button = statusItem.button else { return }
    updatePopoverSize(for: button.window?.screen, relativeTo: button)
    NSApp.activate(ignoringOtherApps: true)
    popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    popover.contentViewController?.view.window?.makeKey()
    Task { await manager.refreshPairedDevices() }
  }

  private func updatePopoverSize(for screen: NSScreen?, relativeTo button: NSStatusBarButton?) {
    let visibleFrame = (screen ?? NSScreen.main)?.visibleFrame
    let widthLimit = (visibleFrame?.width ?? preferredPopoverWidth) - 24
    let width = max(minPopoverWidth, min(preferredPopoverWidth, widthLimit))

    guard let view = popover.contentViewController?.view else {
      popover.contentSize = NSSize(width: width, height: 420)
      return
    }
    _ = view.window
    view.layoutSubtreeIfNeeded()
    let fittingHeight = view.fittingSize.height + 4

    let screenHeightCap = maxPopoverHeight
    let visibleHeightCap: CGFloat
    if let visibleFrame, let buttonFrame = button?.window?.frame {
      // Cap to available room below/around status bar on the active screen.
      let topInset = max(visibleFrame.maxY - buttonFrame.minY, 0)
      visibleHeightCap = max(300, visibleFrame.height - topInset - 16)
    } else if let visibleFrame {
      visibleHeightCap = visibleFrame.height - 36
    } else {
      visibleHeightCap = maxPopoverHeight
    }
    let heightCap = min(screenHeightCap, visibleHeightCap)
    let height = max(minPopoverHeight, min(fittingHeight, heightCap))
    popover.contentSize = NSSize(width: width, height: height)
  }

  private func updateStatusIndicator(isRunning: Bool) {
    guard let button = statusItem.button else { return }
    button.title = ""
    button.contentTintColor = nil
    button.image = buildStatusImage(isRunning: isRunning)
  }

  private func buildStatusImage(isRunning: Bool) -> NSImage? {
    let baseSize = NSSize(width: 22, height: 22)
    let baseImage: NSImage
    if let menuIcon {
      baseImage = menuIcon.copy() as? NSImage ?? menuIcon
    } else if let symbol = NSImage(systemSymbolName: "bolt.horizontal.circle", accessibilityDescription: "CodexGateway") {
      baseImage = symbol
    } else {
      return nil
    }

    baseImage.isTemplate = true
    baseImage.size = baseSize

    guard !isRunning else {
      return baseImage
    }

    let composed = NSImage(size: baseSize)
    composed.lockFocus()
    baseImage.draw(in: NSRect(origin: .zero, size: baseSize))

    let dotDiameter = baseSize.width * 0.36
    let dotRect = NSRect(
      x: baseSize.width - dotDiameter - 0.5,
      y: 0.5,
      width: dotDiameter,
      height: dotDiameter
    )

    NSColor.black.setFill()
    NSBezierPath(ovalIn: dotRect.insetBy(dx: -1.0, dy: -1.0)).fill()
    NSColor.systemRed.setFill()
    NSBezierPath(ovalIn: dotRect).fill()
    composed.unlockFocus()
    composed.isTemplate = false
    return composed
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
  private let menuIconBundleNames = [
    "CodexGateway_CodexGateway",
    "CodexGatewayMenu_CodexGatewayMenu",
  ]

  func applicationDidFinishLaunching(_ notification: Notification) {
    manager.bootstrap()
    settingsWindowController = SettingsWindowController(manager: manager)
    let menuIcon = loadMenuIcon()
    statusItemController = StatusItemController(
      manager: manager,
      menuIcon: menuIcon,
      onOpenSettings: { [weak self] in
        self?.settingsWindowController?.show()
      }
    )
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    statusItemController?.showPopover()
    return true
  }

  private func loadMenuIcon() -> NSImage? {
    let directCandidates = [
      Bundle.main.url(forResource: "MenuBarIcon", withExtension: "png"),
      Bundle.main.resourceURL?.appendingPathComponent("MenuBarIcon.png"),
    ]

    for candidate in directCandidates {
      guard let candidate, let image = NSImage(contentsOf: candidate) else { continue }
      return image
    }

    for bundleName in menuIconBundleNames {
      guard let bundleURL = Bundle.main.url(forResource: bundleName, withExtension: "bundle") else {
        continue
      }

      if let bundle = Bundle(url: bundleURL),
         let iconURL = bundle.url(forResource: "MenuBarIcon", withExtension: "png"),
         let image = NSImage(contentsOf: iconURL) {
        return image
      }

      let legacyCandidates = [
        bundleURL.appendingPathComponent("MenuBarIcon.png"),
        bundleURL.appendingPathComponent("Contents/Resources/MenuBarIcon.png"),
      ]
      for candidate in legacyCandidates {
        if let image = NSImage(contentsOf: candidate) {
          return image
        }
      }
    }

    NSLog("CodexGateway: MenuBarIcon not found. Falling back to system symbol.")
    return nil
  }
}

@main
struct CodexGatewayApp: App {
  @NSApplicationDelegateAdaptor(CodexGatewayAppDelegate.self) private var appDelegate

  var body: some Scene {
    Settings { EmptyView() }
  }
}
