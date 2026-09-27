"use strict";

// Local static preview only. This does not load or execute the Electron backend.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ORIGINAL = path.join(ROOT, "upstream", "MotionBoardStudio-0.3.2", "renderer");
const FILES = Object.freeze({
  "/styles.css": [path.join(ORIGINAL, "styles.css"), "text/css; charset=utf-8"],
  "/app.js": [path.join(ORIGINAL, "app.js"), "text/javascript; charset=utf-8"],
  "/original-bridge.js": [path.join(ROOT, "preview", "original-bridge.js"), "text/javascript; charset=utf-8"],
  "/original.css": [path.join(ROOT, "preview", "original.css"), "text/css; charset=utf-8"]
});
const BANNER = "원본 0.3.2 화면 미리보기 · 로그인/생성은 Mac 연결 작업 중";

function previewHTML() {
  const original = fs.readFileSync(path.join(ORIGINAL, "index.html"), "utf8");
  if (!original.includes('<script src="app.js"></script>')) throw new Error("Original renderer script entry is missing.");
  return original
    .replace("</head>", '<link rel="stylesheet" href="/original.css">\n</head>')
    .replace("<body>", '<body>\n<aside id="original-preview-banner" role="status">' + BANNER + "</aside>")
    .replace('<script src="app.js"></script>', '<script src="/original-bridge.js"></script>\n  <script src="app.js"></script>');
}

function createPreviewServer() {
  const server = http.createServer(function (request, response) {
    const port = server.address().port;
    if (!["127.0.0.1:" + port, "localhost:" + port].includes(String(request.headers.host).toLowerCase())) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Local preview requests only.");
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    // Match the raw path exactly. No decoding, filesystem traversal, or listing.
    const route = String(request.url).split("?")[0];
    if (route === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    let content, type;
    try {
      if (route === "/" || route === "/index.html") {
        content = Buffer.from(previewHTML()); type = "text/html; charset=utf-8";
      } else if (Object.hasOwn(FILES, route)) {
        content = fs.readFileSync(FILES[route][0]); type = FILES[route][1];
      } else { response.writeHead(404); response.end("Not found."); return; }
      response.writeHead(200, { "Content-Type": type, "Content-Length": content.length });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("The original preview resources could not be loaded.");
    }
  });
  return server;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = args.length === 0 ? "0" : args.length === 1 ? args[0] : args.length === 2 && args[0] === "--port" ? args[1] : "invalid";
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("Usage: node scripts/preview-original.cjs [--port] [0..65535]");
    process.exitCode = 1;
  } else {
    const server = createPreviewServer();
    server.on("error", error => { console.error(error.message); process.exitCode = 1; });
    server.listen(port, "127.0.0.1", () => console.log("http://127.0.0.1:" + server.address().port + "/"));
  }
}

module.exports = { createPreviewServer, previewHTML, BANNER };
