// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MotionBoardStudio",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "MotionBoardCore", targets: ["MotionBoardCore"]),
        .executable(name: "MotionBoardStudio", targets: ["MotionBoardStudio"])
    ],
    targets: [
        .target(name: "MotionBoardCore"),
        .executableTarget(
            name: "MotionBoardStudio",
            dependencies: ["MotionBoardCore"],
            resources: [.process("Resources")]
        ),
        .testTarget(name: "MotionBoardCoreTests", dependencies: ["MotionBoardCore"])
    ]
)
