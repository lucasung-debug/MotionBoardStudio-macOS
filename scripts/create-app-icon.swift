import AppKit
import Foundation

// The existing MB wordmark, rendered at the standard macOS icon sizes.
guard CommandLine.arguments.count == 2 else { fatalError("Usage: create-app-icon.swift <output.icns>") }
let output = URL(fileURLWithPath: CommandLine.arguments[1])
let manager = FileManager.default
guard !manager.fileExists(atPath: output.path) else { fatalError("Icon output already exists.") }
let directory = manager.temporaryDirectory.appendingPathComponent("MotionBoard-\(UUID().uuidString).iconset")
try manager.createDirectory(at: directory, withIntermediateDirectories: false)
defer { try? manager.removeItem(at: directory) }
for base in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = base * scale
        let size = CGFloat(pixels)
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        bitmap.size = NSSize(width: pixels, height: pixels)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        NSColor.clear.setFill()
        NSRect(x: 0, y: 0, width: size, height: size).fill()
        NSColor(srgbRed: 0.51, green: 0.32, blue: 0.98, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: size * 0.085, y: size * 0.085, width: size * 0.83, height: size * 0.83),
            xRadius: size * 0.18, yRadius: size * 0.18).fill()
        let text = NSAttributedString(string: "MB", attributes: [
            .font: NSFont.systemFont(ofSize: size * 0.37, weight: .heavy),
            .foregroundColor: NSColor.white, .kern: -size * 0.015
        ])
        let measured = text.size()
        text.draw(at: NSPoint(x: (size - measured.width) / 2, y: (size - measured.height) / 2))
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        try bitmap.representation(using: .png, properties: [:])!.write(to:
            directory.appendingPathComponent("icon_\(base)x\(base)\(suffix).png"), options: .withoutOverwriting)
    }
}
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", directory.path, "-o", output.path]
try process.run()
process.waitUntilExit()
guard process.terminationStatus == 0 else { fatalError("iconutil failed.") }
