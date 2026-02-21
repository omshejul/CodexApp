import Foundation

struct AppConfig: Codable, Equatable {
  var command: String
  var args: [String]
  var workingDirectory: String
  var environment: [String: String]
  var pairURL: String
  var autoStart: Bool

  static let `default` = AppConfig(
    command: "node",
    args: ["dist/server.js"],
    workingDirectory: "",
    environment: [
      "HOST": "127.0.0.1",
      "PORT": "8787"
    ],
    pairURL: "http://127.0.0.1:8787/pair",
    autoStart: false
  )
}

enum ConfigStore {
  static func configURL() -> URL {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return home
      .appendingPathComponent(".codex-gateway-menu", isDirectory: true)
      .appendingPathComponent("config.json", isDirectory: false)
  }

  static func load() throws -> AppConfig {
    let url = configURL()
    if !FileManager.default.fileExists(atPath: url.path) {
      try save(AppConfig.default)
      return .default
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
