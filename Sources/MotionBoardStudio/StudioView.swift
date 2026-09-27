import AppKit
import Combine
import MotionBoardCore
import SwiftUI

struct StudioView: View {
    @ObservedObject var model: StudioModel
    private let clock = Timer.publish(every: 1.0 / 30.0, on: .main, in: .common).autoconnect()

    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                List(selection: $model.selectedID) {
                    ForEach(model.project.tiles) { tile in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(tile.title).lineLimit(1)
                            Text(tile.effect.label).font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 3)
                        .tag(tile.id)
                    }
                }
                HStack {
                    Button(action: model.addTile) { Image(systemName: "plus") }.help("장면 추가").disabled(model.project.tiles.count >= 16)
                    Button(action: model.removeTile) { Image(systemName: "minus") }.help("선택 장면 삭제").disabled(model.project.tiles.count <= 1)
                    Spacer()
                    Button { model.moveTile(by: -1) } label: { Image(systemName: "arrow.up") }.help("위로 이동")
                    Button { model.moveTile(by: 1) } label: { Image(systemName: "arrow.down") }.help("아래로 이동")
                }.buttonStyle(.borderless).padding(12)
            }
            .navigationTitle("장면")
            .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 270)
            .disabled(model.isExporting)
        } detail: {
            HSplitView {
                VStack(spacing: 0) {
                    GeometryReader { geometry in
                        let size = model.project.aspectRatio.size(longEdge: 1280)
                        let ratio = CGFloat(size.width) / CGFloat(size.height)
                        let availableWidth = max(1, geometry.size.width - 32)
                        let availableHeight = max(1, geometry.size.height - 32)
                        let width = min(availableWidth, availableHeight * ratio)
                        BoardPreview(renderer: model.renderer)
                            .frame(width: width, height: width / ratio)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    .background(Color(nsColor: .underPageBackgroundColor))
                    transport
                    Divider()
                    VStack(alignment: .leading, spacing: 7) {
                        if model.isExporting {
                            HStack {
                                ProgressView(value: model.progress)
                                Text(model.progress, format: .percent.precision(.fractionLength(0))).monospacedDigit().font(.caption)
                                Button("취소", action: model.cancelExport)
                            }
                        }
                        Text(model.error ?? model.message)
                            .font(.caption)
                            .foregroundStyle(model.error == nil ? Color.secondary : Color.red)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(12)
                }.frame(minWidth: 420)
                inspector.frame(minWidth: 250, idealWidth: 275, maxWidth: 330).disabled(model.isExporting)
            }
            .navigationTitle("MotionBoard Studio")
            .toolbar {
                ToolbarItemGroup {
                    Button("열기", systemImage: "folder", action: model.openProject)
                    Button("저장", systemImage: "square.and.arrow.down", action: model.saveProject)
                    Button("AI 프롬프트", systemImage: "doc.on.clipboard", action: model.copyPrompt)
                    Menu {
                        Button("HTML 보드…", action: model.exportHTML)
                        Button("현재 프레임 PNG…", action: model.exportPNG)
                        Button("무음 MP4 영상…", action: model.exportVideo)
                    } label: { Label("내보내기", systemImage: "square.and.arrow.up") }
                }
            }
        }
        .frame(minWidth: 960, minHeight: 660)
        .onAppear { model.refreshPreview() }
        .onChange(of: model.project) { _, _ in model.refreshPreview() }
        .onReceive(clock) { model.tick($0) }
    }

    private var transport: some View {
        HStack(spacing: 12) {
            Button(action: model.togglePlayback) { Image(systemName: model.isPlaying ? "pause.fill" : "play.fill").frame(width: 16) }
                .keyboardShortcut(.space, modifiers: [])
                .help(model.isPlaying ? "일시 정지" : "재생")
            Slider(value: Binding(get: { model.time }, set: { model.scrub(to: $0) }), in: 0...max(2, model.project.duration))
                .accessibilityLabel("공통 타임라인")
            Text(String(format: "%.2f / %.1f s", model.time, model.project.duration)).font(.system(.caption, design: .monospaced)).frame(width: 112)
        }.padding(12).disabled(model.isExporting)
    }

    private var inspector: some View {
        Form {
            Section("프로젝트") {
                TextField("보드 제목", text: $model.project.title)
                Picker("화면비", selection: $model.project.aspectRatio) {
                    ForEach(AspectRatio.allCases) { value in Text(value.label).tag(value) }
                }
                Stepper("반복 \(model.project.duration, specifier: "%.1f")초", value: $model.project.duration, in: 2...30, step: 0.5)
                Picker("출력 프레임", selection: $model.project.fps) {
                    ForEach([24, 30, 60], id: \.self) { Text("\($0) fps").tag($0) }
                }
            }
            if let tile = model.selectedTile {
                Section("선택한 장면") {
                    TextField("제목", text: Binding(get: { model.selectedTile?.title ?? "" }, set: { value in model.updateTile { $0.title = value } }))
                    TextField("설명", text: Binding(get: { model.selectedTile?.detail ?? "" }, set: { value in model.updateTile { $0.detail = value } }), axis: .vertical).lineLimit(2...4)
                    Picker("모션", selection: Binding(get: { model.selectedTile?.effect ?? .reveal }, set: { value in model.updateTile { $0.effect = value } })) {
                        ForEach(EffectKind.allCases) { effect in Text(effect.label).tag(effect) }
                    }
                    ColorPicker("강조 색상", selection: Binding(get: { Color(nsColor: NSColor(hex: tile.accent)) }, set: { value in
                        let hex = NSColor(value).hexString
                        model.updateTile { $0.accent = hex }
                    }), supportsOpacity: false)
                    Text(tile.accent).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                }
            }
            Section("내보내기") {
                Picker("긴 변 해상도", selection: $model.exportLongEdge) {
                    ForEach([720, 1280, 1920], id: \.self) { Text("\($0) px").tag($0) }
                }
                Toggle("모션 블러 · 4샘플", isOn: $model.motionBlur)
                Text("MP4는 무음으로 저장합니다. 음악·비트 분석과 계정 연결은 후속 버전에서 추가할 예정입니다.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped)
    }
}

extension NSColor {
    convenience init(hex: String) {
        let value = UInt32(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0x2F6553
        self.init(srgbRed: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
    }
    var hexString: String {
        let c = usingColorSpace(.sRGB) ?? self
        return String(format: "#%02X%02X%02X", Int((c.redComponent * 255).rounded()), Int((c.greenComponent * 255).rounded()), Int((c.blueComponent * 255).rounded()))
    }
}
