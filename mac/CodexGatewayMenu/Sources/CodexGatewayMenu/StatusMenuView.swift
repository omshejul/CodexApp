import SwiftUI

struct StatusMenuView: View {
  @ObservedObject var manager: GatewayManager
  let onOpenSettings: () -> Void
  private static let addedDateFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    return formatter
  }()
  private var appVersionText: String {
    let shortVersion = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "?"
    let build = (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? "?"
    return "Version \(shortVersion) (\(build))"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Circle()
          .fill(manager.isRunning ? .green : .orange)
          .frame(width: 10, height: 10)
        Text(manager.isRunning ? "Gateway Running" : "Gateway Stopped")
          .fontWeight(.semibold)
      }

      if !(manager.needsFullDiskAccess && manager.statusMessage == "Full Disk Access required") {
        Text(manager.statusMessage)
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      if manager.needsFullDiskAccess {
        VStack(alignment: .leading, spacing: 6) {
          Text("Full Disk Access is required for this app.")
            .font(.caption2)
            .foregroundStyle(.secondary)
          Button("Grant Full Disk Access") {
            manager.openFullDiskAccessSettings()
          }
          .font(.caption)
        }
      }

      if manager.statusMessage != "Running" && manager.statusMessage != "Ready" {
        Text("Click Start to verify Codex CLI, Tailscale auth, and route configuration.")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }

      Divider()

      HStack(spacing: 8) {
        Button("Start") {
          Task { await manager.start() }
        }
        .disabled(manager.needsFullDiskAccess || manager.isRunning || manager.isFixingSetup)

        Button("Stop") {
          manager.stop()
        }
        .disabled(!manager.isRunning || manager.isFixingSetup)
      }

      if let pid = manager.conflictingPID, !manager.isRunning {
        Button("Stop Other Process (PID \(pid))") {
          manager.stopConflictingProcess()
        }
      }

      Button("Open Pair Page") {
        manager.openPairPage()
      }
      .disabled(manager.needsFullDiskAccess)

      Button("Settings") {
        NSApp.activate(ignoringOtherApps: true)
        onOpenSettings()
      }

      Button("Help") {
        openHelpEmail()
      }

      Button("Copy Logs") {
        manager.copyLogsToClipboard()
      }
      .disabled(manager.outputLines.isEmpty)

      Divider()
      HStack {
        Text("Paired Devices")
          .font(.caption)
          .foregroundStyle(.white.opacity(0.85))
        Spacer()
        Button("Refresh") {
          Task { await manager.refreshPairedDevices() }
        }
        .font(.caption)
        .disabled(manager.isLoadingDevices)
      }

      if manager.isLoadingDevices {
        Text("Loading devices...")
          .font(.caption2)
          .foregroundStyle(.secondary)
      } else if manager.pairedDevices.isEmpty {
        Text("No active paired devices.")
          .font(.caption2)
          .foregroundStyle(.secondary)
      } else {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(manager.pairedDevices.prefix(4)) { device in
            HStack(alignment: .top, spacing: 8) {
              VStack(alignment: .leading, spacing: 2) {
                Text(device.deviceName)
                  .font(.caption)
                  .fontWeight(.semibold)
                Text(device.deviceId)
                  .font(.caption2)
                  .foregroundStyle(.secondary)
                  .lineLimit(1)
                Text("Added \(formatAddedDate(device.createdAt))")
                  .font(.caption2)
                  .foregroundStyle(.secondary)
              }
              Spacer()
              Button("Revoke") {
                Task { await manager.revokeDevice(device) }
              }
              .font(.caption)
            }
            .padding(8)
            .background(
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.white.opacity(0.06))
            )
          }
        }
      }

      if !manager.outputLines.isEmpty {
        Divider()
        HStack {
          Text("Recent Logs")
            .font(.caption)
            .foregroundStyle(.white.opacity(0.85))
          Spacer()
          Text("\(manager.outputLines.count) lines")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }

        ScrollView {
          Text(manager.recentLogsText)
            .font(.system(size: 12, weight: .regular, design: .monospaced))
            .foregroundStyle(.white.opacity(0.96))
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .textSelection(.enabled)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        }
        .frame(minHeight: 240, maxHeight: 280)
        .background(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(
              LinearGradient(
                colors: [Color.black.opacity(0.56), Color.black.opacity(0.44)],
                startPoint: .top,
                endPoint: .bottom
              )
            )
        )
        .overlay(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .stroke(Color.white.opacity(0.22), lineWidth: 1)
        )
      }

      Divider()
      Text(appVersionText)
        .font(.caption2)
        .foregroundStyle(.secondary)

      Button("Quit") {
        manager.quitApplication()
      }
    }
    .padding(12)
    .frame(width: 500)
    .onAppear {
      manager.refreshFullDiskAccessStatus()
    }
  }

  private func formatAddedDate(_ createdAtMillis: Int64) -> String {
    let date = Date(timeIntervalSince1970: TimeInterval(createdAtMillis) / 1000)
    return Self.addedDateFormatter.string(from: date)
  }

  private func openHelpEmail() {
    guard let emailURL = URL(string: "mailto:contact@omshejul.com") else { return }
    NSWorkspace.shared.open(emailURL)
  }
}
