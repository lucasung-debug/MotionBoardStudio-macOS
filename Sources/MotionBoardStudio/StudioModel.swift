import AppKit
import Combine
import Foundation
import MotionBoardCore
import UniformTypeIdentifiers

@MainActor
final class StudioModel: ObservableObject {
    @Published var project = MotionProject.example
    @Published var selectedID: UUID?
    @Published var time = 0.0
    @Published var isPlaying = false
    @Published var isExporting = false
    @Published var progress = 0.0
    @Published var message = "로컬 모션 보드 · 계정 연결 없이 편집하고 내보낼 수 있습니다."
    @Published var error: String?
    @Published var motionBlur = false
    @Published var exportLongEdge = 1280
    let renderer = BoardRenderer()
    private var updateTask: Task<Void, Never>?
    private var exportTask: Task<Void, Never>?
    private var seeking = false
    private var playbackAnchor = Date()
    private var savedProject: MotionProject?
    private let draftURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("MotionBoardStudioMac", isDirectory: true).appendingPathComponent("draft.json")

    init() {
        var recoveredDraft = false
        if let data = try? Data(contentsOf: draftURL), data.count <= 1_048_576,
           let draft = try? JSONDecoder().decode(MotionProject.self, from: data),
           draft.schemaVersion == 1, draft.duration.isFinite, (2...30).contains(draft.duration),
           [24, 30, 60].contains(draft.fps), (1...16).contains(draft.tiles.count),
           Set(draft.tiles.map(\.id)).count == draft.tiles.count {
            project = draft
            recoveredDraft = true
            message = "마지막 로컬 초안을 복원했습니다."
        }
        savedProject = recoveredDraft ? nil : project
        selectedID = project.tiles.first?.id
    }

    var selectedTile: MotionTile? { project.tiles.first { $0.id == selectedID } }

    func updateTile(_ change: (inout MotionTile) -> Void) {
        guard let index = project.tiles.firstIndex(where: { $0.id == selectedID }) else { return }
        change(&project.tiles[index])
    }

    func refreshPreview() {
        let draftSaved = persistDraft()
        updateTask?.cancel()
        let snapshot = project
        updateTask = Task {
            do {
                try await Task.sleep(for: .milliseconds(70))
                try Task.checkCancellation()
                try await renderer.configure(snapshot)
                try Task.checkCancellation()
                time = min(time, snapshot.duration)
                try await renderer.seek(time)
                try Task.checkCancellation()
                if draftSaved { error = nil }
            } catch is CancellationError {} catch { self.error = error.localizedDescription }
        }
    }

    func togglePlayback() {
        isPlaying.toggle()
        playbackAnchor = Date().addingTimeInterval(-time)
    }

    func scrub(to value: Double) {
        time = value
        playbackAnchor = Date().addingTimeInterval(-time)
        drawCurrentFrame()
    }

    func tick(_ date: Date) {
        guard isPlaying, !isExporting else { return }
        time = date.timeIntervalSince(playbackAnchor).truncatingRemainder(dividingBy: max(2, project.duration))
        drawCurrentFrame()
    }

    private func drawCurrentFrame() {
        guard !seeking, renderer.ready else { return }
        seeking = true
        let position = time
        Task {
            defer { seeking = false }
            do { try await renderer.seek(position) }
            catch { self.error = error.localizedDescription; isPlaying = false }
        }
    }

    func newProject() {
        guard !isExporting, confirmDiscard() else { return }
        project = .example
        savedProject = project
        selectedID = project.tiles.first?.id
        time = 0; isPlaying = false
        message = "새 예제 보드를 열었습니다. 변경한 보드는 JSON으로 저장할 수 있습니다."
        refreshPreview()
    }

    func addTile() {
        guard project.tiles.count < 16 else { return }
        let tile = MotionTile(title: "새 장면", detail: "모션의 시작과 끝을 정해 보세요.", effect: .reveal, accent: "#2F6553")
        project.tiles.append(tile)
        selectedID = tile.id
    }

    func removeTile() {
        guard project.tiles.count > 1, let selectedID else { return }
        project.tiles.removeAll { $0.id == selectedID }
        self.selectedID = project.tiles.first?.id
    }

    func moveTile(by offset: Int) {
        guard let index = project.tiles.firstIndex(where: { $0.id == selectedID }), project.tiles.indices.contains(index + offset) else { return }
        project.tiles.swapAt(index, index + offset)
    }

    func openProject() {
        guard !isExporting else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let values = try url.resourceValues(forKeys: [.fileSizeKey])
            guard (values.fileSize ?? Int.max) <= 1_048_576 else { throw StudioError.message("Project JSON must be smaller than 1 MB.") }
            let imported = try ProjectCodec.decode(Data(contentsOf: url))
            guard confirmDiscard() else { return }
            project = imported
            savedProject = project
            selectedID = project.tiles.first?.id
            time = 0; isPlaying = false; error = nil
            message = "열림: \(url.lastPathComponent)"
            refreshPreview()
        } catch { self.error = error.localizedDescription }
    }

    func saveProject() {
        guard let url = saveURL(type: .json, name: "motion-board.json") else { return }
        do {
            try ProjectCodec.encode(project).write(to: url, options: .atomic)
            savedProject = project
            message = "저장됨: \(url.lastPathComponent)"; error = nil
        } catch { self.error = error.localizedDescription }
    }

    func exportHTML() {
        guard let url = saveURL(type: .html, name: "motion-board.html") else { return }
        do {
            let html = try BoardDocument.html(project: project, longEdge: exportLongEdge, controls: true)
            try html.write(to: url, atomically: true, encoding: .utf8)
            message = "HTML 저장 완료 · 인터넷 없이 브라우저에서 재생할 수 있습니다."; error = nil
        } catch { self.error = error.localizedDescription }
    }

    func exportPNG() {
        guard !isExporting, let url = saveURL(type: .png, name: "motion-board.png") else { return }
        let snapshot = project, position = time, edge = exportLongEdge
        isExporting = true; isPlaying = false; progress = 0
        exportTask = Task {
            defer { isExporting = false }
            do {
                let exporter = BoardRenderer()
                try await exporter.configure(snapshot, longEdge: edge)
                let data = try await exporter.png(at: position)
                try Task.checkCancellation()
                try data.write(to: url, options: .atomic)
                message = "PNG 저장 완료: \(url.lastPathComponent)"; error = nil
            } catch is CancellationError { message = "내보내기를 취소했습니다." }
            catch { self.error = error.localizedDescription }
        }
    }

    func exportVideo() {
        guard !isExporting, let url = saveURL(type: .mpeg4Movie, name: "motion-board.mp4") else { return }
        let snapshot = project, edge = exportLongEdge, samples = motionBlur ? 4 : 1
        isExporting = true; isPlaying = false; progress = 0; error = nil
        message = "MP4 렌더링 중 · 현재 버전은 무음 영상으로 저장합니다."
        exportTask = Task {
            defer { isExporting = false }
            do {
                try await VideoExporter.export(project: snapshot, to: url, longEdge: edge, samples: samples) { self.progress = $0 }
                message = "MP4 저장 완료: \(url.lastPathComponent)"
            } catch is CancellationError { message = "내보내기를 취소했습니다. 미완성 영상은 저장하지 않았습니다." }
            catch { self.error = error.localizedDescription }
        }
    }

    func cancelExport() { exportTask?.cancel() }

    func copyPrompt() {
        let example = (try? BoardDocument.javascriptJSON(project)) ?? "{}"
        let prompt = """
        Create an editable motion board as JSON. Return only a JSON object following the example below.
        Keep schemaVersion=1, duration between 2 and 30, fps one of 24/30/60, and aspectRatio one of landscape/square/portrait.
        Include 1–16 tiles with unique UUID id strings, title (1–60 characters), detail (up to 500 characters), accent (#RRGGBB), and effect.
        Supported effects: \(EffectKind.allCases.map(\.rawValue).joined(separator: ", ")).
        Choose clear motion states and a coherent palette. Describe the intended use in each tile detail. Do not invent business statistics.
        All tiles share one exact looping timeline. Do not include HTML, JavaScript, remote assets, credentials, or extra fields.
        Use the current board as the starting brief:
        \(example)
        """
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(prompt, forType: .string)
        message = "프롬프트를 복사했습니다. 원하는 AI 도구에서 JSON을 만든 뒤 파일로 열 수 있습니다."
    }

    private func saveURL(type: UTType, name: String) -> URL? {
        guard !isExporting else { return nil }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [type]
        panel.nameFieldStringValue = name
        panel.canCreateDirectories = true
        return panel.runModal() == .OK ? panel.url : nil
    }

    private func confirmDiscard() -> Bool {
        guard savedProject.map({ project != $0 }) ?? true else { return true }
        let alert = NSAlert()
        alert.messageText = "저장하지 않은 변경사항이 있습니다."
        alert.informativeText = "현재 보드를 보관하려면 취소한 뒤 프로젝트를 저장해 주세요."
        alert.addButton(withTitle: "취소")
        alert.addButton(withTitle: "변경사항 버리기")
        return alert.runModal() == .alertSecondButtonReturn
    }

    /// Preserve even an incomplete text edit; publishing/export still validates the full schema.
    @discardableResult
    func persistDraft() -> Bool {
        do {
            let data = try JSONEncoder().encode(project)
            try FileManager.default.createDirectory(at: draftURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: draftURL, options: .atomic)
            return true
        } catch {
            self.error = "로컬 초안을 저장하지 못했습니다: \(error.localizedDescription)"
            return false
        }
    }

    func mayTerminate() -> Bool {
        if isExporting {
            let alert = NSAlert()
            alert.messageText = "영상 내보내기가 진행 중입니다."
            alert.informativeText = "내보내기를 취소하고 끝날 때까지 기다린 뒤 종료해 주세요."
            alert.runModal()
            return false
        }
        return persistDraft() || confirmDiscard()
    }
}
