// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "CodexGatewayMenu",
  platforms: [
    .macOS(.v13)
  ],
  products: [
    .executable(name: "CodexGatewayMenu", targets: ["CodexGatewayMenu"])
  ],
  targets: [
    .executableTarget(
      name: "CodexGatewayMenu",
      path: "Sources/CodexGatewayMenu"
    )
  ]
)
