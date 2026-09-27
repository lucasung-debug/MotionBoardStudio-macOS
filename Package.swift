// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MotionBoardStudio",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "MotionBoardCore", targets: ["MotionBoardCore"]),
        .executable(name: "MotionBoardStudio", targets: ["MotionBoardOriginal"]),
        .executable(name: "MotionBoardPrototype", targets: ["MotionBoardStudio"])
    ],
    targets: [
        .target(name: "MotionBoardCore"),
        .executableTarget(
            name: "MotionBoardOriginal",
            path: ".",
            exclude: [".git", ".gitignore", ".local", "reference", "dist", "docs", "examples", "preview", "scripts", "Tests", "Sources/MotionBoardCore", "Sources/MotionBoardStudio", "README.md", "LICENSE"],
            sources: ["Sources/MotionBoardOriginal"],
            resources: [.copy("upstream/MotionBoardStudio-0.3.2"), .copy("Runtime"), .copy("StudioUI")]
        ),
        .executableTarget(
            name: "MotionBoardStudio",
            dependencies: ["MotionBoardCore"],
            resources: [.process("Resources")]
        ),
        .testTarget(name: "MotionBoardCoreTests", dependencies: ["MotionBoardCore"])
    ]
)
