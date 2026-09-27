import Foundation
import WebKit

@MainActor
final class StudioAssetHandler: NSObject, WKURLSchemeHandler {
    private let userData: URL
    init(userData: URL) { self.userData = userData }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        do {
            guard let url = urlSchemeTask.request.url, url.host == "local",
                  let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let relative = components.percentEncodedPath.removingPercentEncoding,
                  !relative.contains("\0") else { throw StudioError("잘못된 미디어 주소입니다.") }
            let folder = url.scheme == "studio-image" ? "images" : "videos"
            let root = userData.appendingPathComponent("motion-board/\(folder)", isDirectory: true)
            let file = root.appendingPathComponent(relative.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
            guard StudioPaths.isInside(file, roots: [root]) else { throw StudioError("미디어 경로가 허용 범위를 벗어났습니다.") }
            let types = ["png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "mp4": "video/mp4", "html": "text/plain; charset=utf-8"]
            guard let mime = types[file.pathExtension.lowercased()] else { throw StudioError("지원하지 않는 미디어 형식입니다.") }
            let data = try Data(contentsOf: file, options: .mappedIfSafe)
            var status = 200
            var start = 0, end = data.count - 1
            var headers = ["Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"]
            if let range = urlSchemeTask.request.value(forHTTPHeaderField: "Range"), !data.isEmpty {
                guard let parsed = Self.parseRange(range, size: data.count) else {
                    let response = HTTPURLResponse(url: url, statusCode: 416, httpVersion: "HTTP/1.1", headerFields: ["Content-Range": "bytes */\(data.count)"])!
                    urlSchemeTask.didReceive(response); urlSchemeTask.didFinish(); return
                }
                start = parsed.lowerBound; end = parsed.upperBound; status = 206
                headers["Content-Range"] = "bytes \(start)-\(end)/\(data.count)"
            }
            let body = data.isEmpty ? Data() : data.subdata(in: start..<(end + 1))
            headers["Content-Length"] = String(body.count)
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            urlSchemeTask.didReceive(response)
            if urlSchemeTask.request.httpMethod != "HEAD" { urlSchemeTask.didReceive(body) }
            urlSchemeTask.didFinish()
        } catch { urlSchemeTask.didFailWithError(error) }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}

    static func parseRange(_ value: String, size: Int) -> ClosedRange<Int>? {
        guard size > 0, value.hasPrefix("bytes="), !value.contains(",") else { return nil }
        let pieces = value.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
        guard pieces.count == 2 else { return nil }
        if pieces[0].isEmpty {
            guard let suffix = Int(pieces[1]), suffix > 0 else { return nil }
            return max(0, size - suffix)...(size - 1)
        }
        guard let lower = Int(pieces[0]), lower >= 0, lower < size else { return nil }
        let upper: Int
        if pieces[1].isEmpty { upper = size - 1 }
        else { guard let parsed = Int(pieces[1]) else { return nil }; upper = min(size - 1, parsed) }
        guard upper >= lower else { return nil }
        return lower...upper
    }
}
