import Foundation
import MotionBoardCore

enum BoardDocument {
    static func resource(_ name: String, extension suffix: String) throws -> String {
        guard let url = Bundle.module.url(forResource: name, withExtension: suffix) else {
            throw StudioError.message("Bundled renderer resource is missing: \(name).\(suffix)")
        }
        return try String(contentsOf: url, encoding: .utf8)
    }

    static func javascriptJSON(_ project: MotionProject) throws -> String {
        let data = try ProjectCodec.encode(project)
        return String(decoding: data, as: UTF8.self)
            .replacingOccurrences(of: "<", with: "\\u003c")
            .replacingOccurrences(of: ">", with: "\\u003e")
            .replacingOccurrences(of: "&", with: "\\u0026")
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    static func html(project: MotionProject? = nil, longEdge: Int = 1280, controls: Bool = false) throws -> String {
        let script = try resource("board", extension: "js")
            .replacingOccurrences(of: "</script", with: "<\\/script", options: .caseInsensitive)
        let style = try resource("board", extension: "css")
        let setup: String
        if let project {
            let project = try project.validated()
            let size = project.aspectRatio.size(longEdge: longEdge)
            setup = "window.MotionBoard.configure(\(try javascriptJSON(project)), \(size.width), \(size.height));"
        } else {
            setup = ""
        }
        let transport = controls ? """
        <nav aria-label="Playback controls">
          <button id="toggle" type="button">Play</button>
          <input id="time" type="range" min="0" max="\(project?.duration ?? 8)" step="0.001" value="0" aria-label="Timeline">
          <output id="position">0.00 s</output>
        </nav>
        <script>
        (() => {
          const slider = document.getElementById('time');
          const toggle = document.getElementById('toggle');
          const output = document.getElementById('position');
          const duration = Number(slider.max);
          let playing = false, anchor = 0, current = 0;
          function show(t) {
            current = t; slider.value = String(t); output.textContent = t.toFixed(2) + ' s';
            MotionBoard.seek(t);
          }
          toggle.addEventListener('click', () => {
            playing = !playing;
            anchor = performance.now() - current * 1000;
            toggle.textContent = playing ? 'Pause' : 'Play';
          });
          slider.addEventListener('input', () => {
            show(Number(slider.value)); anchor = performance.now() - current * 1000;
          });
          function frame(now) {
            if (playing) show(((now - anchor) / 1000) % duration);
            requestAnimationFrame(frame);
          }
          requestAnimationFrame(frame);
          show(0);
        })();
        </script>
        """ : ""
        return """
        <!doctype html>
        <html lang="en"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'">
        <title>MotionBoard Studio</title>
        <style>\(style)
        nav{display:flex;gap:12px;align-items:center;padding:16px;font:14px system-ui}
        nav input{flex:1}nav button{font:inherit;padding:6px 14px}nav output{min-width:70px}
        </style></head><body>
        <main data-board-host><canvas id="board" aria-label="Editable motion board"></canvas></main>
        <script>\(script)</script><script>\(setup)</script>
        \(transport)
        </body></html>
        """
    }
}

enum StudioError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let text): text }
    }
}
