import SwiftUI

@main
struct CodexGatewayMenuApp: App {
  @StateObject private var manager = GatewayManager()

  var body: some Scene {
    MenuBarExtra("Codex Gateway", systemImage: manager.isRunning ? "bolt.horizontal.circle.fill" : "bolt.horizontal.circle") {
      StatusMenuView(manager: manager)
    }
    .menuBarExtraStyle(.window)

    Window("Gateway Settings", id: "settings") {
      SettingsView(manager: manager)
    }
    .windowResizability(.contentSize)
  }
}
