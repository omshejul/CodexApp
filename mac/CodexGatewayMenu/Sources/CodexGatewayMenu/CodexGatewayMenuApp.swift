import AppKit
import SwiftUI

@main
struct CodexGatewayMenuApp: App {
  @StateObject private var manager = GatewayManager()
  private let menuIcon: NSImage? = {
    guard let url = Bundle.module.url(forResource: "MenuBarIcon", withExtension: "png") else {
      return nil
    }
    return NSImage(contentsOf: url)
  }()

  var body: some Scene {
    MenuBarExtra {
      StatusMenuView(manager: manager)
    } label: {
      if let menuIcon {
        Image(nsImage: menuIcon)
          .resizable()
          .interpolation(.high)
          .frame(width: 16, height: 16)
      } else {
        Image(systemName: manager.isRunning ? "bolt.horizontal.circle.fill" : "bolt.horizontal.circle")
      }
    }
    .menuBarExtraStyle(.window)

    Window("Gateway Settings", id: "settings") {
      SettingsView(manager: manager)
    }
    .windowResizability(.contentSize)
  }
}
