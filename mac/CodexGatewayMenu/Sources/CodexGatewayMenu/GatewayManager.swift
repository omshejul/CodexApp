import AppKit
import Foundation

private let tailscaleServiceName = "codex-gateway"

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

  @Published var config: AppConfig = .default
  @Published var isRunning = false
  @Published var isFixingSetup = false
  @Published var isLoadingDevices = false
  @Published var conflictingPID: Int32?
  @Published var statusMessage = "Idle"
  @Published var outputLines: [String] = []
  @Published var pairedDevices: [PairedDevice] = []

  private var process: Process?
  private var didBootstrap = false
  private var didConfigureServeRouteThisSession = false
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
      config = try ConfigStore.load()
      if config.workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
         let discovered = discoverGatewayDirectory()
      {
          config.workingDirectory = discovered
        try? ConfigStore.save(config)
      }
      migrateLegacyBunRuntimeIfNeeded()
      prefillPublicBaseURLFromTailscaleIfNeeded()
      statusMessage = "Ready"
    } catch {
      statusMessage = "Config load failed: \(error.localizedDescription)"
      config = .default
      if let discovered = discoverGatewayDirectory() {
        config.workingDirectory = discovered
      }
      migrateLegacyBunRuntimeIfNeeded()
      prefillPublicBaseURLFromTailscaleIfNeeded()
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

    if config.autoStart {
      Task { await start() }
    }
    Task { await refreshPairedDevices() }
  }

  func start() async {
    guard !isRunning else { return }
    migrateLegacyBunRuntimeIfNeeded()
    ensureRuntimePathConfigured()
    ensureCodexBinaryConfigured()

    let listenPort = configuredPort()
    _ = ensureTailscaleServeRoutesToGateway(port: listenPort)
    if let pid = listenerPID(forPort: listenPort) {
      conflictingPID = pid
      statusMessage = "Port \(listenPort) is already in use."
      appendOutput("Another process is already using 127.0.0.1:\(listenPort) (PID \(pid)).")
      appendOutput("Action: stop the other process in this app, or use Open Pair Page if gateway is already running.")
      return
    }
    conflictingPID = nil

    let process = Process()
    let workingDirectory = resolvedWorkingDirectory()
    process.currentDirectoryURL = workingDirectory.map { URL(fileURLWithPath: $0) }

    var mergedEnv = ProcessInfo.processInfo.environment
    for (key, value) in config.environment {
      mergedEnv[key] = value
    }
    process.environment = mergedEnv

    guard let executablePath = resolveExecutablePath(for: config.command, environment: mergedEnv) else {
      let message = "Command not found: \(config.command). Set an absolute path in Settings (example: /opt/homebrew/bin/node)."
      statusMessage = message
      appendOutput(message)
      return
    }

    process.executableURL = URL(fileURLWithPath: executablePath)
    process.arguments = config.args

    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe

    stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      guard let self else { return }
      let data = handle.availableData
      guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
      Task { @MainActor in
        self.appendOutput(text)
      }
    }

    stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      guard let self else { return }
      let data = handle.availableData
      guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
      Task { @MainActor in
        self.appendOutput(text)
      }
    }

    process.terminationHandler = { [weak self] terminatedProcess in
      guard let self else { return }
      Task { @MainActor in
        self.isRunning = false
        self.process = nil
        self.statusMessage = "Stopped (exit \(terminatedProcess.terminationStatus))"
      }
    }

    do {
      try process.run()
      self.process = process
      self.isRunning = true
      self.statusMessage = "Running"
      appendOutput("Started: \(executablePath) \(config.args.joined(separator: " "))")
      if let workingDirectory {
        appendOutput("CWD: \(workingDirectory)")
      }
      Task { await refreshPairedDevices() }
    } catch {
      self.isRunning = false
      self.process = nil
      self.statusMessage = "Start failed: \(error.localizedDescription)"
      appendOutput("Start failed: \(error.localizedDescription)")
    }
  }

  private func migrateLegacyBunRuntimeIfNeeded() {
    let command = config.command.trimmingCharacters(in: .whitespacesAndNewlines)
    let isLegacyBunStart =
      command == "bun" ||
      command.hasSuffix("/bun") ||
      (config.args.count >= 2 && config.args[0] == "run" && config.args[1] == "start")

    guard isLegacyBunStart else { return }

    let mergedEnv = ProcessInfo.processInfo.environment.merging(config.environment) { _, new in new }
    guard let nodePath = resolveExecutablePath(for: "node", environment: mergedEnv) else { return }

    config.command = nodePath
    config.args = ["dist/server.js"]
    try? ConfigStore.save(config)
    appendOutput("Auto-fix: switched runtime from Bun to Node.js for gateway compatibility.")
  }

  func fixSetup() async {
    guard !isFixingSetup else { return }
    isFixingSetup = true
    defer { isFixingSetup = false }

    appendOutput("Running guided setup and repair...")

    var nextConfig = config

    if let gatewayDir = discoverGatewayDirectory() {
      nextConfig.workingDirectory = gatewayDir
    }

    if nextConfig.environment["HOST"] == nil {
      nextConfig.environment["HOST"] = "127.0.0.1"
    }
    if nextConfig.environment["PORT"] == nil {
      nextConfig.environment["PORT"] = "8787"
    }
    let port = Int(nextConfig.environment["PORT"] ?? "") ?? 8787
    nextConfig.pairURL = localhostPairURL(port: port)

    nextConfig.environment["PATH"] = buildRuntimePATH(existing: nextConfig.environment["PATH"])

    let currentPublicBase = nextConfig.environment["PUBLIC_BASE_URL"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !currentPublicBase.isEmpty {
      appendOutput("Using configured Public Base URL: \(currentPublicBase)")
    } else if let magicBaseURL = discoverTailscaleMagicBaseURL(environment: nextConfig.environment) {
      nextConfig.environment["PUBLIC_BASE_URL"] = magicBaseURL
      appendOutput("Configured Tailscale Magic URL: \(magicBaseURL)")
    } else {
      appendOutput("Tailscale Magic URL not found; keeping existing PUBLIC_BASE_URL/pairURL values.")
    }
    if nextConfig.environment["CODEX_APP_SERVER_BIN"] == nil,
       let codexPath = resolveExecutablePath(for: "codex", environment: ProcessInfo.processInfo.environment)
    {
      nextConfig.environment["CODEX_APP_SERVER_BIN"] = codexPath
      appendOutput("Configured Codex CLI path: \(codexPath)")
    }

    _ = ensureTailscaleServeRoutesToGateway(port: port)

    let mergedEnv = ProcessInfo.processInfo.environment.merging(nextConfig.environment) { _, new in new }
    guard let nodePath = resolveExecutablePath(for: "node", environment: mergedEnv) else {
      statusMessage = "Setup needs Node.js installed. Install Node.js, then click Fix Setup again."
      appendOutput("Repair failed: could not find Node executable.")
      return
    }
    nextConfig.command = nodePath
    nextConfig.args = ["dist/server.js"]

    let configuredGatewayDir = nextConfig.workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
    let gatewayDir = configuredGatewayDir.isEmpty ? (discoverGatewayDirectory() ?? "") : configuredGatewayDir
    guard isGatewayDirectory(gatewayDir) else {
      statusMessage = "Setup needs the project folder. Open Settings and set Working Directory to the gateway folder."
      appendOutput("Repair failed: gateway folder not found.")
      return
    }

    let bunPath = resolveExecutablePath(for: "bun", environment: mergedEnv)
    if let repoRoot = discoverRepoRoot(fromGatewayDirectory: gatewayDir), let bunPath {
      appendOutput("Checking and repairing dependencies...")
      let installResult = runSync(
        executablePath: bunPath,
        arguments: ["install"],
        workingDirectory: repoRoot,
        environment: nextConfig.environment
      )
      appendOutput(installResult.output)
      if installResult.exitCode != 0 {
        statusMessage = "Setup could not install dependencies. Check logs."
        appendOutput("Repair failed during dependency install (exit \(installResult.exitCode)).")
        return
      }
    } else if discoverRepoRoot(fromGatewayDirectory: gatewayDir) != nil {
      appendOutput("Bun not found. Skipping dependency repair and using existing node_modules.")
    } else {
      appendOutput("Could not detect monorepo root; skipping dependency repair step.")
    }

    let distServer = URL(fileURLWithPath: gatewayDir).appendingPathComponent("dist/server.js").path
    if !FileManager.default.fileExists(atPath: distServer) {
      appendOutput("Gateway build artifacts missing. Building now...")
    } else {
      appendOutput("Rebuilding gateway to ensure native modules are aligned...")
    }

    if let bunPath {
      let buildResult = runSync(
        executablePath: bunPath,
        arguments: ["run", "build"],
        workingDirectory: gatewayDir,
        environment: nextConfig.environment
      )
      appendOutput(buildResult.output)
      if buildResult.exitCode != 0 {
        statusMessage = "Setup could not build gateway. Check logs."
        appendOutput("Repair failed during build (exit \(buildResult.exitCode)).")
        return
      }
    } else if !FileManager.default.fileExists(atPath: distServer) {
      statusMessage = "Bun is required to build gateway the first time."
      appendOutput("Repair failed: Bun not found and dist/server.js is missing.")
      return
    }

    saveConfig(nextConfig)
    statusMessage = "Setup complete. Click Start."
    appendOutput("Setup complete. Runtime is now set to Node.js.")
  }

  func stop() {
    cleanupManagedProcess()
    statusMessage = "Stopping..."
    appendOutput("Stopping gateway process")
    Task { await refreshPairedDevices() }
  }

  func quitApplication() {
    performShutdownCleanup()
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
    let pairURL = localhostPairURL(port: configuredPort())
    guard let url = URL(string: pairURL) else {
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
      try ConfigStore.save(newConfig)
      config = newConfig
      statusMessage = isRunning ? "Running (config saved)" : "Config saved"
    } catch {
      statusMessage = "Config save failed: \(error.localizedDescription)"
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
    }
  }

  private func appendOutput(_ raw: String) {
    let lines = raw
      .split(whereSeparator: \.isNewline)
      .map(String.init)
      .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    guard !lines.isEmpty else { return }

    for line in lines {
      if line.contains("Script not found") {
        outputLines.append("Fix: click \"Fix Setup\" to auto-configure working directory and command.")
      }
      if line.contains("No such file or directory") && line.contains("bun") {
        outputLines.append("Fix: click \"Fix Setup\" to auto-detect Bun path.")
      }
      if line.contains("ERR_DLOPEN_FAILED") || line.contains("better-sqlite3") {
        outputLines.append("Fix: click \"Fix Setup\" to switch runtime to Node.js and rebuild dependencies.")
      }
      if line.contains("not yet supported in Bun") {
        outputLines.append("Fix: click \"Fix Setup\" to switch runtime from Bun to Node.js.")
      }
      if line.contains("spawn codex ENOENT") {
        outputLines.append("Fix: click \"Fix Setup\" to auto-configure the Codex CLI path.")
      }
      if line.contains("env: node: No such file or directory") {
        outputLines.append("Fix: click \"Fix Setup\" to auto-configure PATH for Node and Codex.")
      }
      if line.contains("PUBLIC_BASE_URL") && line.contains("not configured") {
        outputLines.append("Fix: click \"Fix Setup\" to auto-configure Tailscale Magic URL.")
      }
    }

    outputLines.append(contentsOf: lines)
    if outputLines.count > 200 {
      outputLines = Array(outputLines.suffix(200))
    }
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

  private func ensureCodexBinaryConfigured() {
    if let current = config.environment["CODEX_APP_SERVER_BIN"],
       !current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    {
      return
    }

    if let codexPath = resolveExecutablePath(for: "codex", environment: ProcessInfo.processInfo.environment) {
      config.environment["CODEX_APP_SERVER_BIN"] = codexPath
      try? ConfigStore.save(config)
      appendOutput("Auto-fix: configured Codex CLI path to \(codexPath).")
    }
  }

  private func ensureRuntimePathConfigured() {
    let existing = config.environment["PATH"]
    let nextPATH = buildRuntimePATH(existing: existing)
    if existing != nextPATH {
      config.environment["PATH"] = nextPATH
      try? ConfigStore.save(config)
      appendOutput("Auto-fix: configured PATH for GUI runtime.")
    }
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
      .appendingPathComponent("codex-gateway-menu-\(UUID().uuidString).log")
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
    if let raw = config.environment["PORT"], let parsed = Int(raw), parsed > 0 {
      return parsed
    }
    return 8787
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
      appendOutput("Tailscale CLI not found; skipping serve route setup.")
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
      appendOutput("Configured Tailscale Serve route to 127.0.0.1:\(port).")
      return true
    }

    appendOutput("Failed to configure Tailscale Serve route. Run: tailscale serve --bg http://127.0.0.1:\(port)")
    if !configureResult.output.isEmpty {
      appendOutput(configureResult.output)
    }
    return false
  }

  private func disableTailscaleServeIfManagedByApp() {
    guard didConfigureServeRouteThisSession else { return }
    let environment = config.environment
    guard let tailscalePath = resolveExecutablePath(for: "tailscale", environment: environment) else { return }

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
    didConfigureServeRouteThisSession = false
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
    cleanupManagedProcess()
    disableTailscaleServeIfManagedByApp()
  }

  private func resolvedWorkingDirectory() -> String? {
    let configured = config.workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
    if !configured.isEmpty {
      return configured
    }
    return discoverGatewayDirectory()
  }

  private func discoverGatewayDirectory() -> String? {
    let fileManager = FileManager.default
    let home = fileManager.homeDirectoryForCurrentUser.path
    var candidates: [String] = [
      fileManager.currentDirectoryPath,
      URL(fileURLWithPath: fileManager.currentDirectoryPath).appendingPathComponent("gateway").path,
      "\(home)/Code/CodexApp/gateway",
      "\(home)/CodexApp/gateway"
    ]

    if let bundlePath = Bundle.main.bundleURL.path.removingPercentEncoding {
      var cursor = URL(fileURLWithPath: bundlePath)
      for _ in 0..<8 {
        cursor.deleteLastPathComponent()
        candidates.append(cursor.appendingPathComponent("gateway").path)
      }
    }

    for candidate in candidates {
      if isGatewayDirectory(candidate) {
        return candidate
      }
    }
    return nil
  }

  private func discoverRepoRoot(fromGatewayDirectory gatewayDir: String) -> String? {
    let gatewayURL = URL(fileURLWithPath: gatewayDir)
    let candidate = gatewayURL.deletingLastPathComponent()
    let packageJSON = candidate.appendingPathComponent("package.json")
    guard let data = try? Data(contentsOf: packageJSON),
          let text = String(data: data, encoding: .utf8)
    else {
      return nil
    }
    return text.contains("\"workspaces\"") ? candidate.path : nil
  }

  private func isGatewayDirectory(_ path: String) -> Bool {
    let packageJSON = URL(fileURLWithPath: path).appendingPathComponent("package.json")
    guard let data = try? Data(contentsOf: packageJSON),
          let text = String(data: data, encoding: .utf8)
    else {
      return false
    }
    return text.contains("\"name\": \"@codex-phone/gateway\"") && text.contains("\"start\":")
  }
}
