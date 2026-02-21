// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "CodexGateway",
  platforms: [
    .macOS(.v13)
  ],
  products: [
    .executable(name: "CodexGateway", targets: ["CodexGateway"])
  ],
  targets: [
    .executableTarget(
      name: "CodexGateway",
      path: "Sources/CodexGatewayMenu",
      resources: [
        .process("Resources")
      ]
    )
  ]
)
