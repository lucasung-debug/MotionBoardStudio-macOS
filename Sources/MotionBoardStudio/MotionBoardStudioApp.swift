import AppKit
import SwiftUI

@main
enum MotionBoardMain {
    @MainActor
    static func main() {
        if CommandLine.arguments.contains("--verify-render") {
            NSApplication.shared.setActivationPolicy(.prohibited)
            Task { @MainActor in
                let code = await RenderVerification.run(arguments: CommandLine.arguments)
                fflush(stdout); fflush(stderr)
                exit(code)
            }
            NSApplication.shared.run()
        } else {
            MotionBoardStudioApp.main()
        }
    }
}

struct MotionBoardStudioApp: App {
    @NSApplicationDelegateAdaptor(StudioApplicationDelegate.self) private var delegate
    @StateObject private var model = StudioModel()
    var body: some Scene {
        WindowGroup {
            StudioView(model: model)
                .onAppear {
                    delegate.model = model
                    NSApplication.shared.activate(ignoringOtherApps: true)
                }
        }
        .defaultSize(width: 1380, height: 860)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("새 보드", action: model.newProject).keyboardShortcut("n")
                Button("프로젝트 열기…", action: model.openProject).keyboardShortcut("o")
                Button("프로젝트 저장…", action: model.saveProject).keyboardShortcut("s")
            }
            CommandMenu("내보내기") {
                Button("HTML 보드…", action: model.exportHTML)
                Button("현재 프레임 PNG…", action: model.exportPNG)
                Button("무음 MP4 영상…", action: model.exportVideo)
            }
        }
    }
}

@MainActor
final class StudioApplicationDelegate: NSObject, NSApplicationDelegate {
    weak var model: StudioModel?
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        (model?.mayTerminate() ?? true) ? .terminateNow : .terminateCancel
    }
}
