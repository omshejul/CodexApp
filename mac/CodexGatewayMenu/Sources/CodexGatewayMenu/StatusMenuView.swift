import SwiftUI

struct StatusMenuView: View {
  @ObservedObject var manager: GatewayManager
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Circle()
          .fill(manager.isRunning ? .green : .orange)
          .frame(width: 10, height: 10)
        Text(manager.isRunning ? "Gateway Running" : "Gateway Stopped")
          .fontWeight(.semibold)
      }

      Text(manager.statusMessage)
        .font(.caption)
        .foregroundStyle(.secondary)

      Divider()

      HStack(spacing: 8) {
        Button("Start") {
          Task { await manager.start() }
        }
        .disabled(manager.isRunning || manager.isFixingSetup)

        Button("Stop") {
          manager.stop()
        }
        .disabled(!manager.isRunning || manager.isFixingSetup)
      }

      Button(manager.isFixingSetup ? "Fixing..." : "Fix Setup") {
        Task { await manager.fixSetup() }
      }
      .disabled(manager.isFixingSetup || manager.isRunning)

      if let pid = manager.conflictingPID, !manager.isRunning {
        Button("Stop Other Process (PID \(pid))") {
          manager.stopConflictingProcess()
        }
      }

      Button("Open Pair Page") {
        manager.openPairPage()
      }

      Button("Settings") {
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: "settings")
      }

      Button("Copy Logs") {
        manager.copyLogsToClipboard()
      }
      .disabled(manager.outputLines.isEmpty)

      if !manager.outputLines.isEmpty {
        Divider()
        Text("Recent Logs")
          .font(.caption)
          .foregroundStyle(.white.opacity(0.85))

        TextEditor(text: .constant(manager.recentLogsText))
          .font(.system(size: 12, weight: .medium, design: .monospaced))
          .foregroundStyle(.white.opacity(0.96))
          .scrollContentBackground(.hidden)
          .frame(minHeight: 240, maxHeight: 280)
        .background(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(Color.black.opacity(0.38))
        )
        .overlay(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .stroke(Color.white.opacity(0.15), lineWidth: 1)
        )
      }

      Divider()

      Button("Quit") {
        manager.quitApplication()
      }
    }
    .padding(12)
    .frame(width: 500)
    .onAppear {
      manager.bootstrap()
    }
  }
}
