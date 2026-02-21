import AppKit
import Foundation

private let tailscaleServiceName = "codexgateway"
private let launchAgentLabel = "com.codex.gateway"

@MainActor
final class GatewayManager: ObservableObject {
  struct PairedDevice: Codable, Identifiable {
    let id: String
    let deviceId: String
    let deviceName: String
    let createdAt: Int64
    let expiresAt: Int64
  }

  private struct DevicesResponse: Codable {
    let devices: [PairedDevice]
  }

  private struct PortListener {
    let pid: Int32
    let command: String
    let isManagedGateway: Bool
  }

  private struct SetupDiagnostics {
    let bundledNodeReady: Bool
    let bundledGatewayReady: Bool
    let codexReady: Bool
    let tailscaleAvailable: Bool
    let tailscaleAuthenticated: Bool
    let serveConfigured: Bool
    let portListener: PortListener?
  }

  @Published var config: AppConfig = .default
  @Published var isRunning = false
  @Published var isFixingSetup = false
  @Published var isLoadingDevices = false
  @Published var conflictingPID: Int32?
  @Published var statusMessage = "Idle"
  @Published var outputLines: [String] = []
  @Published var pairedDevices: [PairedDevice] = []
  @Published var needsFullDiskAccess = false

  private static let filesAndFoldersPrimeDefaultsKey = "codexgateway.files-and-folders-primed.v1"
  private static let filesAndFoldersPrimePendingDefaultsKey = "codexgateway.files-and-folders-prime-pending.v1"
  private var process: Process?
  private var didBootstrap = false
  private var didShowFullDiskAccessPrompt = false
  private var didConfigureServeRouteThisSession = false
  private var didConfigureLegacyServeRouteThisSession = false
  private var willTerminateObserver: NSObjectProtocol?

  init() {
    willTerminateObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.willTerminateNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor in
        self?.performShutdownCleanup()
      }
    }

    do {
      config = normalizeConfig(try ConfigStore.load())
      try? ConfigStore.save(config)
      refreshSetupStatus()
    } catch {
      config = .default
      statusMessage = "Config load failed. Using defaults."
      appendOutput("Config load failed: \(error.localizedDescription)")
    }
  }

  deinit {
    if let willTerminateObserver {
      NotificationCenter.default.removeObserver(willTerminateObserver)
    }
  }

  var recentLogsText: String {
    outputLines.suffix(300).joined(separator: "\n")
  }

  func bootstrap() {
    guard !didBootstrap else { return }
    didBootstrap = true

    refreshFullDiskAccessStatus()
    if needsFullDiskAccess {
      UserDefaults.standard.set(true, forKey: Self.filesAndFoldersPrimePendingDefaultsKey)
      guard enforceFullDiskAccessRequirement() else { return }
    } else {
      guard ensureFilesAndFoldersAccessIfNeeded() else { return }
    }
    refreshSetupStatus()
    Task {
      if config.autoStart {
        await start()
      }
      await refreshPairedDevices()
    }
  }

  func refreshFullDiskAccessStatus() {
    needsFullDiskAccess = !hasFullDiskAccess()
  }

  func openFullDiskAccessSettings() {
    let deepLink = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
    let fallback = URL(fileURLWithPath: "/System/Library/PreferencePanes/Security.prefPane")
    if let deepLink {
      NSWorkspace.shared.open(deepLink)
    } else {
      NSWorkspace.shared.open(fallback)
    }
  }

  @discardableResult
  private func enforceFullDiskAccessRequirement() -> Bool {
    refreshFullDiskAccessStatus()
    guard needsFullDiskAccess else { return true }
    statusMessage = "Full Disk Access required"
    showFullDiskAccessPromptIfNeeded()
    return false
  }

  func showFullDiskAccessPromptIfNeeded() {
    guard needsFullDiskAccess, !didShowFullDiskAccessPrompt else { return }
    didShowFullDiskAccessPrompt = true

    let alert = NSAlert()
    alert.messageText = "Allow Full Disk Access"
    alert.informativeText =
      "Codex Gateway requires Full Disk Access to run. Enable it for this app and its helper in \nPrivacy & Security > Full Disk Access, then relaunch the app."
    alert.addButton(withTitle: "Open Settings")
    alert.addButton(withTitle: "Close")
    alert.alertStyle = .informational

    NSApp.activate(ignoringOtherApps: true)
    let response = alert.runModal()
    if response == .alertFirstButtonReturn {
      openFullDiskAccessSettings()
    }
  }

  func start() async {
    guard !isRunning else { return }
    guard enforceFullDiskAccessRequirement() else { return }
    guard ensureFilesAndFoldersAccessIfNeeded() else { return }

    let diagnostics = diagnoseSetup(includeNetworkChecks: true)
    conflictingPID = nil

    guard diagnostics.bundledNodeReady, diagnostics.bundledGatewayReady else {
      statusMessage = "App bundle is incomplete. Rebuild the mac app."
      appendOutput("Bundled gateway runtime is missing.")
      return
    }

    guard diagnostics.codexReady else {
      statusMessage = "Missing Codex CLI."
      appendOutput("Codex CLI not found. Install Codex and retry Start.")
      return
    }

    guard diagnostics.tailscaleAvailable else {
      statusMessage = "Missing Tailscale."
      appendOutput("Tailscale CLI not found. Install Tailscale and retry Start.")
      return
    }

    guard diagnostics.tailscaleAuthenticated else {
      statusMessage = "Tailscale not authenticated."
      appendOutput("Tailscale is not authenticated. Sign in and retry Start.")
      return
    }

    let port = configuredPort()
    if let listener = diagnostics.portListener {
      if listener.isManagedGateway {
        isRunning = true
        statusMessage = "Running"
        appendOutput("Gateway is already running on 127.0.0.1:\(port) (PID \(listener.pid)).")
        Task { await refreshPairedDevices() }
        return
      }
      conflictingPID = listener.pid
      statusMessage = "Port \(port) is already in use."
      appendOutput("Another process is already using 127.0.0.1:\(port) (PID \(listener.pid)).")
      appendOutput("Command: \(listener.command)")
      appendOutput("Action: stop the other process in this app, or change the gateway port in Settings.")
      return
    }

    _ = ensureTailscaleServeRoutesToGateway(port: port)

    guard upsertAndStartLaunchAgent(port: port) else {
      statusMessage = "Start failed. Check details."
      return
    }

    let started = await waitForGatewayReachable(port: port, timeoutSeconds: 8)
    if started {
      isRunning = true
      statusMessage = "Running"
      appendOutput("Gateway service is running under launchd.")
      Task { await refreshPairedDevices() }
    } else {
      isRunning = false
      statusMessage = "Start timed out. Check details."
      appendOutput("launchd started the gateway service, but /health was not reachable on 127.0.0.1:\(port).")
    }
  }

  func fixSetup(autoTriggered: Bool = false) async {
    guard !isFixingSetup else { return }
    guard enforceFullDiskAccessRequirement() else { return }
    isFixingSetup = true
    defer { isFixingSetup = false }

    appendOutput(autoTriggered ? "Running automatic setup checks..." : "Running setup checks...")

    var nextConfig = normalizeConfig(config)
    nextConfig.environment["PATH"] = buildRuntimePATH(existing: nextConfig.environment["PATH"])

    let trimmedPublicBase = nextConfig.environment["PUBLIC_BASE_URL"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if trimmedPublicBase.isEmpty {
      if let detected = discoverTailscaleMagicBaseURL(environment: nextConfig.environment) {
        nextConfig.environment["PUBLIC_BASE_URL"] = detected
        appendOutput("Auto-filled Public Base URL from Tailscale: \(detected)")
      } else {
        appendOutput("Could not auto-detect Tailscale Magic DNS URL.")
      }
    }

    if nextConfig.codexBinaryPath?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false,
       let codexPath = resolveExecutablePath(for: "codex", environment: nextConfig.environment)
    {
      nextConfig.codexBinaryPath = codexPath
      appendOutput("Configured Codex CLI path: \(codexPath)")
    }

    if ensureTailscaleServeRoutesToGateway(port: nextConfig.port) {
      appendOutput("Tailscale service route '\(tailscaleServiceName)' is configured.")
    }

    saveConfig(nextConfig)

    let diagnostics = diagnoseSetup(includeNetworkChecks: true)
    conflictingPID = diagnostics.portListener?.isManagedGateway == false ? diagnostics.portListener?.pid : nil
    if diagnostics.bundledNodeReady && diagnostics.bundledGatewayReady && diagnostics.codexReady {
      statusMessage = autoTriggered ? "Ready" : "Setup complete. Click Start."
      appendOutput(autoTriggered ? "Automatic setup check complete." : "Setup complete.")
    } else {
      refreshSetupStatus()
      appendOutput(autoTriggered ? "Automatic setup check finished with remaining checks." : "Setup finished with remaining checks. See status above.")
    }
  }

  func stop() {
    _ = stopLaunchAgent(removePlist: true)
    cleanupManagedProcess()
    isRunning = false
    conflictingPID = nil
    disableTailscaleServeIfManagedByApp()
    statusMessage = "Stopping..."
    appendOutput("Stopping gateway process")
    Task { await refreshPairedDevices() }
  }

  func quitApplication() {
    NSApplication.shared.terminate(nil)
  }

  func stopConflictingProcess() {
    guard let pid = conflictingPID else { return }
    let result = runSync(
      executablePath: "/bin/kill",
      arguments: ["-TERM", String(pid)],
      workingDirectory: nil,
      environment: [:]
    )
    if result.exitCode == 0 {
      statusMessage = "Stopped conflicting process (PID \(pid))."
      appendOutput("Stopped conflicting process (PID \(pid)).")
      conflictingPID = nil
    } else {
      statusMessage = "Could not stop conflicting process (PID \(pid))."
      appendOutput(result.output)
    }
  }

  func openPairPage() {
    guard enforceFullDiskAccessRequirement() else { return }
    guard let url = URL(string: localhostPairURL(port: configuredPort())) else {
      statusMessage = "Invalid pair URL"
      return
    }
    NSWorkspace.shared.open(url)
  }

  func refreshPairedDevices() async {
    isLoadingDevices = true
    defer { isLoadingDevices = false }

    guard let url = URL(string: "http://127.0.0.1:\(configuredPort())/devices") else {
      return
    }

    do {
      let (data, response) = try await URLSession.shared.data(from: url)
      guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
        pairedDevices = []
        return
      }
      let decoded = try JSONDecoder().decode(DevicesResponse.self, from: data)
      pairedDevices = decoded.devices
    } catch {
      pairedDevices = []
    }
  }

  func revokeDevice(_ device: PairedDevice) async {
    guard let url = URL(string: "http://127.0.0.1:\(configuredPort())/devices/\(device.id)/revoke") else {
      statusMessage = "Invalid revoke URL."
      return
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"

    do {
      let (_, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
        statusMessage = "Failed to revoke device."
        return
      }
      statusMessage = "Revoked \(device.deviceName)."
      appendOutput("Revoked device access: \(device.deviceName) (\(device.deviceId))")
      await refreshPairedDevices()
    } catch {
      statusMessage = "Failed to revoke device."
    }
  }

  func saveConfig(_ newConfig: AppConfig) {
    do {
      let normalized = normalizeConfig(newConfig)
      try ConfigStore.save(normalized)
      config = normalized
      if isRunning {
        _ = upsertAndStartLaunchAgent(port: normalized.port)
      } else if normalized.autoStart {
        _ = upsertAndStartLaunchAgent(port: normalized.port)
      } else {
        _ = stopLaunchAgent(removePlist: true)
      }
      statusMessage = isRunning ? "Running (settings saved)" : "Settings saved"
      refreshSetupStatus()
    } catch {
      statusMessage = "Settings save failed."
      appendOutput("Settings save failed: \(error.localizedDescription)")
    }
  }

  func copyLogsToClipboard() {
    let text = outputLines.joined(separator: "\n")
    guard !text.isEmpty else {
      statusMessage = "No logs to copy yet."
      return
    }

    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(text, forType: .string)
    statusMessage = "Logs copied to clipboard."
  }

  func prefillPublicBaseURLFromTailscaleIfNeeded() {
    let current = config.environment["PUBLIC_BASE_URL"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard current.isEmpty else { return }

    if let detected = discoverTailscaleMagicBaseURL(environment: config.environment) {
      config.environment["PUBLIC_BASE_URL"] = detected
      try? ConfigStore.save(config)
      appendOutput("Auto-filled Public Base URL from Tailscale: \(detected)")
      refreshSetupStatus()
    }
  }

  private func refreshSetupStatus() {
    let diagnostics = diagnoseSetup(includeNetworkChecks: false)

    if !diagnostics.bundledNodeReady || !diagnostics.bundledGatewayReady {
      isRunning = false
      conflictingPID = nil
      statusMessage = "Needs setup: app bundle is incomplete."
      return
    }
    if !diagnostics.codexReady {
      isRunning = false
      conflictingPID = nil
      statusMessage = "Missing Codex CLI"
      return
    }
    if let listener = diagnostics.portListener {
      if listener.isManagedGateway {
        isRunning = true
        conflictingPID = nil
        statusMessage = "Running"
        return
      }
      isRunning = false
      conflictingPID = listener.pid
      statusMessage = "Port \(configuredPort()) is already in use (PID \(listener.pid))."
      return
    }
    isRunning = false
    conflictingPID = nil
    statusMessage = "Ready"
  }

  private func diagnoseSetup(includeNetworkChecks: Bool) -> SetupDiagnostics {
    let port = configuredPort()
    let env = config.environment
    let tailscalePath = resolveExecutablePath(for: "tailscale", environment: env)
    let tailscaleAuthenticated = includeNetworkChecks && tailscalePath != nil ? isTailscaleAuthenticated(environment: env) : false
    let serveConfigured = includeNetworkChecks && tailscalePath != nil ? isServeRouteConfigured(port: port, environment: env) : false

    return SetupDiagnostics(
      bundledNodeReady: bundledNodePath() != nil,
      bundledGatewayReady: bundledGatewayEntryPath() != nil,
      codexReady: resolvedCodexBinaryPath(environment: env) != nil,
      tailscaleAvailable: tailscalePath != nil,
      tailscaleAuthenticated: tailscaleAuthenticated,
      serveConfigured: serveConfigured,
      portListener: listenerInfo(forPort: port)
    )
  }

  private func normalizeConfig(_ config: AppConfig) -> AppConfig {
    var normalizedEnvironment = config.environment
    normalizedEnvironment["HOST"] = "127.0.0.1"
    normalizedEnvironment["PORT"] = "\(max(config.port, 1))"
    let pairURL = localhostPairURL(port: max(config.port, 1))
    return AppConfig(
      port: max(config.port, 1),
      environment: normalizedEnvironment,
      pairURL: pairURL,
      codexBinaryPath: config.codexBinaryPath,
      autoStart: config.autoStart
    )
  }

  private func appendOutput(_ raw: String) {
    let lines = raw
      .split(whereSeparator: \.isNewline)
      .map { sanitizeLogLine(String($0)) }
      .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    guard !lines.isEmpty else { return }

    for line in lines {
      if line.contains("spawn codex ENOENT") {
        outputLines.append("Fix: install Codex CLI, then click Start.")
      }
      if line.contains("Failed to configure Tailscale Serve route") {
        outputLines.append("Fix: sign in to Tailscale and click Start.")
      }
      if line.contains("EADDRINUSE") {
        outputLines.append("Fix: click \"Stop Other Process\" or change the port in Settings.")
      }
    }

    outputLines.append(contentsOf: lines)
    if outputLines.count > 240 {
      outputLines = Array(outputLines.suffix(240))
    }
  }

  private func sanitizeLogLine(_ line: String) -> String {
    var cleaned = line

    // Remove ANSI terminal color/style escapes so logs render cleanly in SwiftUI.
    if let ansiRegex = try? NSRegularExpression(pattern: #"\u{001B}\[[0-9;]*[A-Za-z]"#, options: []) {
      let range = NSRange(cleaned.startIndex..<cleaned.endIndex, in: cleaned)
      cleaned = ansiRegex.stringByReplacingMatches(in: cleaned, options: [], range: range, withTemplate: "")
    }

    // Some streams may drop ESC while leaving trailing "[35m" style fragments.
    if let danglingCodeRegex = try? NSRegularExpression(pattern: #"\[(?:\d{1,3};?)+m"#, options: []) {
      let range = NSRange(cleaned.startIndex..<cleaned.endIndex, in: cleaned)
      cleaned = danglingCodeRegex.stringByReplacingMatches(in: cleaned, options: [], range: range, withTemplate: "")
    }

    return cleaned.replacingOccurrences(of: "\t", with: "  ")
  }

  private func resolveExecutablePath(for command: String, environment: [String: String]) -> String? {
    let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }

    if trimmed.contains("/") {
      return FileManager.default.isExecutableFile(atPath: trimmed) ? trimmed : nil
    }

    var pathEntries: [String] = []
    if let envPath = environment["PATH"], !envPath.isEmpty {
      pathEntries.append(contentsOf: envPath.split(separator: ":").map(String.init))
    }

    let home = FileManager.default.homeDirectoryForCurrentUser.path
    pathEntries.append(contentsOf: [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "\(home)/.bun/bin"
    ])

    for entry in pathEntries {
      let candidate = URL(fileURLWithPath: entry).appendingPathComponent(trimmed).path
      if FileManager.default.isExecutableFile(atPath: candidate) {
        return candidate
      }
    }
    return nil
  }

  private func resolvedCodexBinaryPath(environment: [String: String]) -> String? {
    if let configured = config.codexBinaryPath?.trimmingCharacters(in: .whitespacesAndNewlines), !configured.isEmpty {
      return resolveExecutablePath(for: configured, environment: environment) ?? (FileManager.default.isExecutableFile(atPath: configured) ? configured : nil)
    }
    if let envPath = config.environment["CODEX_APP_SERVER_BIN"]?.trimmingCharacters(in: .whitespacesAndNewlines), !envPath.isEmpty {
      return resolveExecutablePath(for: envPath, environment: environment) ?? (FileManager.default.isExecutableFile(atPath: envPath) ? envPath : nil)
    }
    return resolveExecutablePath(for: "codex", environment: environment)
  }

  private func buildRuntimePATH(existing: String?) -> String {
    var entries: [String] = []
    if let existing, !existing.isEmpty {
      entries.append(contentsOf: existing.split(separator: ":").map(String.init))
    }
    if let processPath = ProcessInfo.processInfo.environment["PATH"], !processPath.isEmpty {
      entries.append(contentsOf: processPath.split(separator: ":").map(String.init))
    }

    let home = FileManager.default.homeDirectoryForCurrentUser.path
    entries.append(contentsOf: [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "\(home)/.bun/bin"
    ])

    var unique: [String] = []
    for entry in entries {
      if !unique.contains(entry) {
        unique.append(entry)
      }
    }
    return unique.joined(separator: ":")
  }

  private func localhostPairURL(port: Int) -> String {
    return "http://127.0.0.1:\(port)/pair"
  }

  private func launchAgentPlistURL() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/LaunchAgents", isDirectory: true)
      .appendingPathComponent("\(launchAgentLabel).plist", isDirectory: false)
  }

  private func launchAgentTarget() -> String {
    "gui/\(getuid())/\(launchAgentLabel)"
  }

  private func runtimeEnvironment(port: Int) -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    for (key, value) in config.environment {
      env[key] = value
    }
    env["HOST"] = "127.0.0.1"
    env["PORT"] = "\(port)"
    env["PATH"] = buildRuntimePATH(existing: env["PATH"])

    let appSupport = appSupportDirectory()
    let logsDir = appSupport.appendingPathComponent("logs", isDirectory: true)
    try? FileManager.default.createDirectory(at: logsDir, withIntermediateDirectories: true)
    env["DB_PATH"] = appSupport.appendingPathComponent("gateway.sqlite").path
    env["EVENTS_LOG_PATH"] = logsDir.appendingPathComponent("events.log").path
    env["ERRORS_LOG_PATH"] = logsDir.appendingPathComponent("errors.log").path

    if let codexPath = resolvedCodexBinaryPath(environment: env) {
      env["CODEX_APP_SERVER_BIN"] = codexPath
    }
    return env
  }

  @discardableResult
  private func upsertAndStartLaunchAgent(port: Int) -> Bool {
    guard let bundledNode = bundledNodePath(),
          let gatewayEntry = bundledGatewayEntryPath(),
          let gatewayRoot = bundledGatewayRoot()
    else {
      appendOutput("Bundled Node or gateway entrypoint is missing.")
      return false
    }

    let env = runtimeEnvironment(port: port)
    let logsDir = appSupportDirectory().appendingPathComponent("logs", isDirectory: true)
    let stdoutPath = logsDir.appendingPathComponent("launchd-stdout.log").path
    let stderrPath = logsDir.appendingPathComponent("launchd-stderr.log").path
    let plistPath = launchAgentPlistURL()

    try? FileManager.default.createDirectory(
      at: plistPath.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )

    let plist: [String: Any] = [
      "Label": launchAgentLabel,
      "ProgramArguments": [bundledNode, gatewayEntry],
      "WorkingDirectory": gatewayRoot,
      "EnvironmentVariables": env,
      "RunAtLoad": true,
      "KeepAlive": true,
      "ThrottleInterval": 5,
      "StandardOutPath": stdoutPath,
      "StandardErrorPath": stderrPath
    ]

    do {
      let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
      try data.write(to: plistPath, options: .atomic)
    } catch {
      appendOutput("Failed to write launch agent plist: \(error.localizedDescription)")
      return false
    }

    _ = runSync(executablePath: "/bin/launchctl", arguments: ["bootout", launchAgentTarget()], workingDirectory: nil, environment: [:])
    let bootstrap = runSync(
      executablePath: "/bin/launchctl",
      arguments: ["bootstrap", "gui/\(getuid())", plistPath.path],
      workingDirectory: nil,
      environment: [:]
    )
    if bootstrap.exitCode != 0 {
      appendOutput("Failed to bootstrap launch agent '\(launchAgentLabel)'.")
      if !bootstrap.output.isEmpty {
        appendOutput(bootstrap.output)
      }
      return false
    }

    _ = runSync(
      executablePath: "/bin/launchctl",
      arguments: ["enable", launchAgentTarget()],
      workingDirectory: nil,
      environment: [:]
    )

    let kickstart = runSync(
      executablePath: "/bin/launchctl",
      arguments: ["kickstart", "-k", launchAgentTarget()],
      workingDirectory: nil,
      environment: [:]
    )
    if kickstart.exitCode != 0 {
      appendOutput("Failed to start launch agent '\(launchAgentLabel)'.")
      if !kickstart.output.isEmpty {
        appendOutput(kickstart.output)
      }
      return false
    }

    appendOutput("LaunchAgent '\(launchAgentLabel)' is active.")
    return true
  }

  @discardableResult
  private func stopLaunchAgent(removePlist: Bool) -> Bool {
    let bootout = runSync(
      executablePath: "/bin/launchctl",
      arguments: ["bootout", launchAgentTarget()],
      workingDirectory: nil,
      environment: [:]
    )

    if removePlist {
      try? FileManager.default.removeItem(at: launchAgentPlistURL())
    }

    if bootout.exitCode == 0 {
      appendOutput("Stopped launch agent '\(launchAgentLabel)'.")
      return true
    }

    if !bootout.output.isEmpty && !bootout.output.contains("No such process") {
      appendOutput(bootout.output)
    }
    return false
  }

  private func listenerInfo(forPort port: Int) -> PortListener? {
    guard let pid = listenerPID(forPort: port) else { return nil }
    let command = processCommand(forPID: pid)
    return PortListener(
      pid: pid,
      command: command,
      isManagedGateway: isManagedGatewayCommand(command)
    )
  }

  private func processCommand(forPID pid: Int32) -> String {
    let result = runSync(
      executablePath: "/bin/ps",
      arguments: ["-p", String(pid), "-o", "command="],
      workingDirectory: nil,
      environment: [:]
    )
    return result.output
      .split(whereSeparator: \.isNewline)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first ?? ""
  }

  private func isManagedGatewayCommand(_ command: String) -> Bool {
    guard !command.isEmpty else { return false }
    if command.contains("/GatewayRuntime/dist/server.js") { return true }
    if command.contains("codex-gateway-runtime") && command.contains("server.js") { return true }
    if let resourcePath = Bundle.main.resourcePath,
       command.contains(resourcePath),
       command.contains("server.js")
    {
      return true
    }
    return false
  }

  private func waitForGatewayReachable(port: Int, timeoutSeconds: TimeInterval) async -> Bool {
    guard let healthURL = URL(string: "http://127.0.0.1:\(port)/health") else { return false }
    let timeoutTime = Date().addingTimeInterval(timeoutSeconds)

    while Date() < timeoutTime {
      do {
        let (_, response) = try await URLSession.shared.data(from: healthURL)
        if let http = response as? HTTPURLResponse, http.statusCode == 200 {
          return true
        }
      } catch {
        // Retry until timeout.
      }
      try? await Task.sleep(nanoseconds: 300_000_000)
    }

    return false
  }

  private func bundledNodePath() -> String? {
    guard let base = Bundle.main.resourcePath else { return nil }
    let candidate = URL(fileURLWithPath: base).appendingPathComponent("Node/bin/node").path
    return FileManager.default.isExecutableFile(atPath: candidate) ? candidate : nil
  }

  private func bundledGatewayRoot() -> String? {
    guard let base = Bundle.main.resourcePath else { return nil }
    let candidate = URL(fileURLWithPath: base).appendingPathComponent("GatewayRuntime").path
    var isDir: ObjCBool = false
    let exists = FileManager.default.fileExists(atPath: candidate, isDirectory: &isDir)
    return exists && isDir.boolValue ? candidate : nil
  }

  private func bundledGatewayEntryPath() -> String? {
    guard let root = bundledGatewayRoot() else { return nil }
    let candidate = URL(fileURLWithPath: root).appendingPathComponent("dist/server.js").path
    return FileManager.default.fileExists(atPath: candidate) ? candidate : nil
  }

  private func appSupportDirectory() -> URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support", isDirectory: true)
    let appDir = base.appendingPathComponent("CodexGateway", isDirectory: true)
    let legacyDir = base.appendingPathComponent("CodexGatewayMenu", isDirectory: true)
    if !FileManager.default.fileExists(atPath: appDir.path), FileManager.default.fileExists(atPath: legacyDir.path) {
      try? FileManager.default.moveItem(at: legacyDir, to: appDir)
    }
    try? FileManager.default.createDirectory(at: appDir, withIntermediateDirectories: true)
    return appDir
  }

  private func hasFullDiskAccess() -> Bool {
    let protectedDirectory = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/com.apple.TCC", isDirectory: true)
    do {
      _ = try FileManager.default.contentsOfDirectory(atPath: protectedDirectory.path)
      return true
    } catch {
      return false
    }
  }

  @discardableResult
  private func ensureFilesAndFoldersAccessIfNeeded() -> Bool {
    let defaults = UserDefaults.standard
    let shouldPrimeAfterRestart = defaults.bool(forKey: Self.filesAndFoldersPrimePendingDefaultsKey)
    let alreadyPrimed = defaults.bool(forKey: Self.filesAndFoldersPrimeDefaultsKey)

    // If this is the first launch after granting Full Disk Access, or if never primed,
    // trigger Files & Folders consent before the gateway starts.
    guard shouldPrimeAfterRestart || !alreadyPrimed else { return true }

    let home = FileManager.default.homeDirectoryForCurrentUser
    let protectedFolders = [
      home.appendingPathComponent("Desktop", isDirectory: true),
      home.appendingPathComponent("Documents", isDirectory: true),
      home.appendingPathComponent("Downloads", isDirectory: true)
    ]

    var deniedFolders: [String] = []
    for folder in protectedFolders where FileManager.default.fileExists(atPath: folder.path) {
      do {
        _ = try FileManager.default.contentsOfDirectory(atPath: folder.path)
      } catch {
        deniedFolders.append(folder.lastPathComponent)
      }
    }

    guard deniedFolders.isEmpty else {
      defaults.set(false, forKey: Self.filesAndFoldersPrimeDefaultsKey)
      defaults.set(true, forKey: Self.filesAndFoldersPrimePendingDefaultsKey)
      statusMessage = "Folder access required"
      appendOutput("Folder access denied for: \(deniedFolders.joined(separator: ", ")). Allow access and try again.")
      return false
    }

    defaults.set(true, forKey: Self.filesAndFoldersPrimeDefaultsKey)
    defaults.set(false, forKey: Self.filesAndFoldersPrimePendingDefaultsKey)
    appendOutput("Ran one-time macOS folder-access onboarding check.")
    return true
  }

  private func discoverTailscaleMagicBaseURL(environment: [String: String]) -> String? {
    guard let tailscalePath = resolveExecutablePath(for: "tailscale", environment: environment) else {
      return nil
    }

    let result = runSync(
      executablePath: tailscalePath,
      arguments: ["status", "--json"],
      workingDirectory: nil,
      environment: environment
    )
    guard result.exitCode == 0 else { return nil }
    guard let data = result.output.data(using: .utf8) else { return nil }

    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let selfNode = json["Self"] as? [String: Any],
          let rawDNSName = selfNode["DNSName"] as? String
    else {
      return nil
    }

    let dnsName = rawDNSName.trimmingCharacters(in: CharacterSet(charactersIn: "."))
    guard !dnsName.isEmpty else { return nil }
    return "https://\(dnsName)"
  }

  private func isTailscaleAuthenticated(environment: [String: String]) -> Bool {
    guard let tailscalePath = resolveExecutablePath(for: "tailscale", environment: environment) else {
      return false
    }
    let result = runSync(
      executablePath: tailscalePath,
      arguments: ["status", "--json"],
      workingDirectory: nil,
      environment: environment
    )
    guard result.exitCode == 0, let data = result.output.data(using: .utf8) else { return false }
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
    let backendState = json["BackendState"] as? String
    let hasSelfNode = (json["Self"] as? [String: Any]) != nil
    return hasSelfNode && backendState != "NeedsLogin"
  }

  private func isServeRouteConfigured(port: Int, environment: [String: String]) -> Bool {
    guard let tailscalePath = resolveExecutablePath(for: "tailscale", environment: environment) else {
      return false
    }
    let result = runSync(
      executablePath: tailscalePath,
      arguments: ["serve", "status", "--json"],
      workingDirectory: nil,
      environment: environment
    )
    guard result.exitCode == 0 else { return false }
    let hasEndpoint = result.output.contains("127.0.0.1:\(port)")
    let hasService = result.output.contains(tailscaleServiceName)
    return hasEndpoint && (hasService || result.output.contains("\"Web\""))
  }

  private func runSync(
    executablePath: String,
    arguments: [String],
    workingDirectory: String?,
    environment: [String: String]
  ) -> (exitCode: Int32, output: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executablePath)
    process.arguments = arguments
    process.currentDirectoryURL = workingDirectory.map { URL(fileURLWithPath: $0) }

    var mergedEnv = ProcessInfo.processInfo.environment
    for (key, value) in environment {
      mergedEnv[key] = value
    }
    process.environment = mergedEnv

    let tempURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("codex-gateway-\(UUID().uuidString).log")
    FileManager.default.createFile(atPath: tempURL.path, contents: nil)
    guard let fileHandle = try? FileHandle(forWritingTo: tempURL) else {
      return (1, "Process execution failed: could not open temporary log file.")
    }
    process.standardOutput = fileHandle
    process.standardError = fileHandle

    do {
      try process.run()
      process.waitUntilExit()
    } catch {
      try? fileHandle.close()
      return (1, "Process execution failed: \(error.localizedDescription)")
    }
    try? fileHandle.close()

    let output = (try? String(contentsOf: tempURL, encoding: .utf8)) ?? ""
    try? FileManager.default.removeItem(at: tempURL)
    return (process.terminationStatus, output)
  }

  private func configuredPort() -> Int {
    return config.port > 0 ? config.port : 8787
  }

  private func listenerPID(forPort port: Int) -> Int32? {
    let output = runSync(
      executablePath: "/usr/sbin/lsof",
      arguments: ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-t"],
      workingDirectory: nil,
      environment: [:]
    ).output

    let lines = output
      .split(whereSeparator: \.isNewline)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }

    for line in lines {
      if let pid = Int32(line), pid > 0 {
        return pid
      }
    }
    return nil
  }

  @discardableResult
  private func ensureTailscaleServeRoutesToGateway(port: Int) -> Bool {
    let environment = config.environment
    guard let tailscalePath = resolveExecutablePath(for: "tailscale", environment: environment) else {
      appendOutput("Tailscale CLI not found; skipping route setup.")
      return false
    }
    guard isTailscaleAuthenticated(environment: environment) else {
      appendOutput("Tailscale is not authenticated. Sign in and click Start.")
      return false
    }

    let configureResult = runSync(
      executablePath: tailscalePath,
      arguments: ["serve", "--service", tailscaleServiceName, "--bg", "http://127.0.0.1:\(port)"],
      workingDirectory: nil,
      environment: environment
    )

    if configureResult.exitCode == 0 {
      didConfigureServeRouteThisSession = true
      didConfigureLegacyServeRouteThisSession = false
      appendOutput("Configured Tailscale Serve route to 127.0.0.1:\(port).")
      return true
    }

    // Older/newer Tailscale variants may reject service names; fall back to node-level serve.
    if configureResult.output.contains("invalid service name") || configureResult.output.contains("flag -service") {
      let legacyResult = runSync(
        executablePath: tailscalePath,
        arguments: ["serve", "--bg", "http://127.0.0.1:\(port)"],
        workingDirectory: nil,
        environment: environment
      )
      if legacyResult.exitCode == 0 {
        didConfigureServeRouteThisSession = false
        didConfigureLegacyServeRouteThisSession = true
        appendOutput("Configured Tailscale route in node mode (service mode unsupported by this Tailscale CLI).")
        return true
      }
      appendOutput("Failed to configure Tailscale route in fallback mode.")
      if !legacyResult.output.isEmpty {
        appendOutput(legacyResult.output)
      }
      return false
    }

    appendOutput("Failed to configure Tailscale route. Sign in to Tailscale and click Start again.")
    if !configureResult.output.isEmpty {
      appendOutput(configureResult.output)
    }
    return false
  }

  private func disableTailscaleServeIfManagedByApp() {
    if !didConfigureServeRouteThisSession && !didConfigureLegacyServeRouteThisSession {
      return
    }

    let environment = config.environment
    guard let tailscalePath = resolveExecutablePath(for: "tailscale", environment: environment) else { return }

    if didConfigureServeRouteThisSession {
      let clearResult = runSync(
        executablePath: tailscalePath,
        arguments: ["serve", "clear", tailscaleServiceName],
        workingDirectory: nil,
        environment: environment
      )

      if clearResult.exitCode == 0 {
        appendOutput("Removed Tailscale service route '\(tailscaleServiceName)' configured by this app.")
      } else if !clearResult.output.isEmpty {
        appendOutput("Could not clear Tailscale service route '\(tailscaleServiceName)' on quit.")
        appendOutput(clearResult.output)
      }
    } else if didConfigureLegacyServeRouteThisSession {
      appendOutput("Tailscale service-scoped clear is unavailable on this CLI; leaving existing node-level serve config unchanged.")
    }

    didConfigureServeRouteThisSession = false
    didConfigureLegacyServeRouteThisSession = false
  }

  private func cleanupManagedProcess() {
    guard let process else { return }
    guard process.isRunning else {
      self.process = nil
      self.isRunning = false
      return
    }

    process.terminate()
    usleep(250_000)
    if process.isRunning {
      process.interrupt()
      usleep(250_000)
    }
    if process.isRunning {
      process.terminate()
    }

    self.process = nil
    self.isRunning = false
  }

  private func performShutdownCleanup() {
    // If launchd manages the gateway, the service should remain alive when this UI exits.
    if FileManager.default.fileExists(atPath: launchAgentPlistURL().path) {
      return
    }
    cleanupManagedProcess()
    disableTailscaleServeIfManagedByApp()
  }
}
