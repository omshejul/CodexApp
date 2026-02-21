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
  private var pairedDevicesTitleText: String {
    let deviceCount = manager.pairedDevices.count
    let suffix = deviceCount == 1 ? "1 device" : "\(deviceCount) devices"
    return "Paired Devices (\(suffix))"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        HStack {
          Circle()
            .fill(manager.isRunning ? .green : .orange)
            .frame(width: 10, height: 10)
          Text(manager.isRunning ? "Gateway Running" : "Gateway Stopped")
            .fontWeight(.semibold)
        }
        Spacer()
        Button {
          manager.quitApplication()
        } label: {
          Label("Quit", systemImage: "power")
        }
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

      VStack(spacing: 8) {
        HStack(spacing: 8) {
          Button {
            Task { await manager.start() }
          } label: {
            Label("Start", systemImage: "play.fill")
              .frame(maxWidth: .infinity, alignment: .center)
          }
          .disabled(manager.needsFullDiskAccess || manager.isRunning || manager.isFixingSetup || manager.isStarting)

          Button {
            manager.stop()
          } label: {
            Label("Stop", systemImage: "stop.fill")
              .frame(maxWidth: .infinity, alignment: .center)
          }
          .disabled(!manager.isRunning || manager.isFixingSetup || manager.isStarting)
        }

        HStack(spacing: 8) {
          Button {
            manager.openPairPage()
          } label: {
            Label("Open Pair Page", systemImage: "link")
              .frame(maxWidth: .infinity, alignment: .center)
          }
          .disabled(manager.needsFullDiskAccess)

          Button {
            NSApp.activate(ignoringOtherApps: true)
            onOpenSettings()
          } label: {
            Label("Settings", systemImage: "gearshape.fill")
              .frame(maxWidth: .infinity, alignment: .center)
          }

          Button {
            openHelpEmail()
          } label: {
            Label("Help", systemImage: "questionmark.circle.fill")
              .frame(maxWidth: .infinity, alignment: .center)
          }
        }

        if let pid = manager.conflictingPID, !manager.isRunning {
          Button {
            manager.stopConflictingProcess()
          } label: {
            Label("Stop Other Process (PID \(pid))", systemImage: "exclamationmark.triangle.fill")
              .frame(maxWidth: .infinity, alignment: .center)
          }
        }
      }

      Divider()
      HStack {
        Label {
          Text(pairedDevicesTitleText)
            .font(.caption)
        } icon: {
          Image(systemName: "desktopcomputer.and.iphone")
        }
        .foregroundStyle(.white.opacity(0.85))
          Spacer()
          Button {
            Task { await manager.refreshPairedDevices() }
          } label: {
            Label("Refresh", systemImage: "arrow.clockwise")
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
          ScrollView {
            VStack(alignment: .leading, spacing: 8) {
              ForEach(manager.pairedDevices) { device in
                HStack(alignment: .top, spacing: 8) {
                  Image(systemName: "iphone.gen3")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
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
                  Button {
                    Task { await manager.revokeDevice(device) }
                  } label: {
                    Label("Revoke", systemImage: "xmark.bin.fill")
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
          .scrollIndicators(.never)
          .frame(maxHeight: 260)
        }

        if !manager.outputLines.isEmpty {
          Divider()
          HStack {
            Label {
              Text("Recent Logs")
                .font(.caption)
            } icon: {
              Image(systemName: "doc.text.magnifyingglass")
            }
            .foregroundStyle(.white.opacity(0.85))
            Spacer()
            Button {
              manager.copyLogsToClipboard()
            } label: {
              Label("Copy Logs", systemImage: "doc.on.doc")
            }
            .font(.caption)
            .disabled(manager.recentLogsLineCount == 0)
            Text("\(manager.recentLogsLineCount) lines")
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
          .scrollIndicators(.never)
          .frame(minHeight: 120, maxHeight: 220)
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

    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .frame(maxWidth: .infinity)
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
