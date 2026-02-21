import SwiftUI

struct SettingsView: View {
  @ObservedObject var manager: GatewayManager

  @State private var command = ""
  @State private var argsText = ""
  @State private var workingDirectory = ""
  @State private var envText = ""
  @State private var publicBaseURL = ""
  @State private var pairURL = ""
  @State private var autoStart = false

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Gateway Settings")
        .font(.title2)
        .fontWeight(.semibold)

      Group {
        LabeledField(label: "Magic DNS URL", text: $publicBaseURL, placeholder: "https://your-machine.tailnet.ts.net")
        LabeledField(label: "Command", text: $command, placeholder: "bun")
        LabeledField(label: "Arguments (one per line)", text: $argsText, placeholder: "run\nstart", axis: .vertical)
        LabeledField(label: "Working Directory", text: $workingDirectory, placeholder: "/Users/you/Code/CodexApp/gateway")
        LabeledField(label: "Environment (KEY=VALUE per line)", text: $envText, placeholder: "HOST=127.0.0.1\nPORT=8787", axis: .vertical)
        LabeledField(label: "Pair URL", text: $pairURL, placeholder: "http://127.0.0.1:8787/pair")
      }

      Toggle("Start gateway automatically on app launch", isOn: $autoStart)

      HStack {
        Spacer()

        Button("Load Current") {
          loadFromManager()
        }

        Button("Save") {
          manager.saveConfig(buildConfig())
        }
        .keyboardShortcut("s", modifiers: [.command])
      }
    }
    .padding(20)
    .frame(minWidth: 640, minHeight: 520)
    .onAppear {
      manager.prefillPublicBaseURLFromTailscaleIfNeeded()
      loadFromManager()
    }
  }

  private func loadFromManager() {
    command = manager.config.command
    argsText = manager.config.args.joined(separator: "\n")
    workingDirectory = manager.config.workingDirectory
    envText = manager.config.environment
      .map { "\($0.key)=\($0.value)" }
      .sorted()
      .joined(separator: "\n")
    publicBaseURL = manager.config.environment["PUBLIC_BASE_URL"] ?? ""
    pairURL = manager.config.pairURL
    autoStart = manager.config.autoStart
  }

  private func buildConfig() -> AppConfig {
    let args = argsText
      .split(whereSeparator: \.isNewline)
      .map(String.init)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }

    let envPairs = envText
      .split(whereSeparator: \.isNewline)
      .map(String.init)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }

    var env: [String: String] = [:]
    for pair in envPairs {
      let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
      if parts.count == 2 {
        env[parts[0]] = parts[1]
      }
    }

    let trimmedPublicBase = publicBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmedPublicBase.isEmpty {
      env.removeValue(forKey: "PUBLIC_BASE_URL")
    } else {
      env["PUBLIC_BASE_URL"] = trimmedPublicBase
    }

    return AppConfig(
      command: command.trimmingCharacters(in: .whitespacesAndNewlines),
      args: args,
      workingDirectory: workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines),
      environment: env,
      pairURL: pairURL.trimmingCharacters(in: .whitespacesAndNewlines),
      autoStart: autoStart
    )
  }
}

private struct LabeledField: View {
  let label: String
  @Binding var text: String
  let placeholder: String
  var axis: Axis = .horizontal

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label)
        .font(.subheadline)
        .foregroundStyle(.secondary)

      TextField(placeholder, text: $text, axis: axis)
        .textFieldStyle(.roundedBorder)
        .lineLimit(axis == .vertical ? 8 : 1)
        .font(.system(.body, design: .monospaced))
    }
  }
}
