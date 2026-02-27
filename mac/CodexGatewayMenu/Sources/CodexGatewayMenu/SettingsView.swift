import SwiftUI

struct SettingsView: View {
  @ObservedObject var manager: GatewayManager

  @State private var publicBaseURL = ""
  @State private var portText = ""
  @State private var codexBinaryPath = ""
  @State private var tailscaleBinaryPath = ""
  @State private var autoStart = false

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Gateway Settings")
        .font(.title2)
        .fontWeight(.semibold)

      Group {
        LabeledField(label: "Magic DNS URL", text: $publicBaseURL, placeholder: "https://your-machine.tailnet.ts.net")
        LabeledField(label: "Gateway Port", text: $portText, placeholder: "8787")
        LabeledField(label: "Codex CLI Path (optional)", text: $codexBinaryPath, placeholder: "/opt/homebrew/bin/codex")
        LabeledField(label: "Tailscale CLI Path (optional)", text: $tailscaleBinaryPath, placeholder: "/opt/homebrew/bin/tailscale")
      }

      Toggle("Keep gateway running in background", isOn: $autoStart)

      Divider()
      Text("Runtime command and gateway bundle are managed automatically by this app.")
        .font(.caption)
        .foregroundStyle(.secondary)

      HStack {
        Spacer()

        Button("Reload") {
          loadFromManager()
        }

        Button("Save Settings") {
          manager.saveConfig(buildConfig())
        }
        .keyboardShortcut("s", modifiers: [.command])
      }
    }
    .padding(20)
    .frame(minWidth: 640, minHeight: 420)
    .onAppear {
      loadFromManager()
    }
  }

  private func loadFromManager() {
    publicBaseURL = manager.config.environment["PUBLIC_BASE_URL"] ?? ""
    portText = "\(manager.config.port)"
    codexBinaryPath = manager.config.codexBinaryPath ?? ""
    tailscaleBinaryPath = manager.config.tailscaleBinaryPath ?? ""
    autoStart = manager.config.autoStart
  }

  private func buildConfig() -> AppConfig {
    var env = manager.config.environment

    let trimmedPublicBase = publicBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmedPublicBase.isEmpty {
      env.removeValue(forKey: "PUBLIC_BASE_URL")
    } else {
      env["PUBLIC_BASE_URL"] = trimmedPublicBase
    }

    let parsedPort = Int(portText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? manager.config.port

    return AppConfig(
      port: parsedPort,
      environment: env,
      pairURL: "http://127.0.0.1:\(parsedPort)/pair",
      codexBinaryPath: codexBinaryPath.trimmingCharacters(in: .whitespacesAndNewlines),
      tailscaleBinaryPath: tailscaleBinaryPath.trimmingCharacters(in: .whitespacesAndNewlines),
      autoStart: autoStart
    )
  }
}

private struct LabeledField: View {
  let label: String
  @Binding var text: String
  let placeholder: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label)
        .font(.subheadline)
        .foregroundStyle(.secondary)

      TextField(placeholder, text: $text)
        .textFieldStyle(.roundedBorder)
        .font(.system(.body, design: .monospaced))
    }
  }
}
