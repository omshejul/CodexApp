import Foundation

struct AppConfig: Codable, Equatable {
  var port: Int
  var environment: [String: String]
  var pairURL: String
  var codexBinaryPath: String?
  var autoStart: Bool

  static let `default` = AppConfig(
    port: 8787,
    environment: [
      "HOST": "127.0.0.1"
    ],
    pairURL: "http://127.0.0.1:8787/pair",
    codexBinaryPath: nil,
    autoStart: true
  )

  private enum CodingKeys: String, CodingKey {
    case port
    case environment
    case pairURL
    case codexBinaryPath
    case autoStart

    // Legacy keys kept for migration-only decode.
    case command
    case args
    case workingDirectory
  }

  init(
    port: Int,
    environment: [String: String],
    pairURL: String,
    codexBinaryPath: String?,
    autoStart: Bool
  ) {
    let sanitizedPort = port > 0 ? port : 8787
    self.port = sanitizedPort
    self.environment = environment
    self.environment["HOST"] = "127.0.0.1"
    self.environment["PORT"] = "\(sanitizedPort)"
    self.pairURL = pairURL
    self.codexBinaryPath = codexBinaryPath?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true
      ? nil
      : codexBinaryPath?.trimmingCharacters(in: .whitespacesAndNewlines)
    self.autoStart = autoStart
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)

    let decodedEnvironment = try container.decodeIfPresent([String: String].self, forKey: .environment) ?? [:]
    let decodedPairURL = try container.decodeIfPresent(String.self, forKey: .pairURL)
    let decodedAutoStart = try container.decodeIfPresent(Bool.self, forKey: .autoStart) ?? true
    let decodedCodexPath = try container.decodeIfPresent(String.self, forKey: .codexBinaryPath)

    let explicitPort = try container.decodeIfPresent(Int.self, forKey: .port)
    let envPort = Int(decodedEnvironment["PORT"] ?? "")
    let migratedPort = explicitPort ?? envPort ?? 8787

    self.init(
      port: migratedPort,
      environment: decodedEnvironment,
      pairURL: decodedPairURL ?? "http://127.0.0.1:\(migratedPort)/pair",
      codexBinaryPath: decodedCodexPath,
      autoStart: decodedAutoStart
    )
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(port, forKey: .port)
    try container.encode(environment, forKey: .environment)
    try container.encode(pairURL, forKey: .pairURL)
    try container.encodeIfPresent(codexBinaryPath, forKey: .codexBinaryPath)
    try container.encode(autoStart, forKey: .autoStart)
  }
}

enum ConfigStore {
  static func configURL() -> URL {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return home
      .appendingPathComponent(".codex-gateway", isDirectory: true)
      .appendingPathComponent("config.json", isDirectory: false)
  }

  private static func legacyConfigURL() -> URL {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return home
      .appendingPathComponent(".codex-gateway-menu", isDirectory: true)
      .appendingPathComponent("config.json", isDirectory: false)
  }

  static func load() throws -> AppConfig {
    let url = configURL()
    if !FileManager.default.fileExists(atPath: url.path) {
      let legacyURL = legacyConfigURL()
      if FileManager.default.fileExists(atPath: legacyURL.path) {
        let legacyData = try Data(contentsOf: legacyURL)
        let migrated = try JSONDecoder().decode(AppConfig.self, from: legacyData)
        try save(migrated)
        return migrated
      } else {
        try save(AppConfig.default)
        return .default
      }
    }

    let data = try Data(contentsOf: url)
    return try JSONDecoder().decode(AppConfig.self, from: data)
  }

  static func save(_ config: AppConfig) throws {
    let url = configURL()
    let dir = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try encoder.encode(config)
    try data.write(to: url, options: .atomic)
  }
}
