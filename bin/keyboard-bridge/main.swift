// AIO Keyboard: types text at the cursor on this Mac, for the voice gadget's dictation page.
//
// A background app (no Dock icon) so that macOS asks for, and remembers, the Accessibility
// permission for this app alone rather than for whatever launched it. bin/keyboard-bridge.mjs
// builds it and keeps it running; the control plane reaches it on loopback with the bridge token.
//
//   GET  /status  {"trusted": bool}: whether it may type yet
//   POST /type    {"text": "..."}: pastes the text where the cursor is (the clipboard is put back after)
//   POST /quit    exits
//
// Usage: AIO Keyboard --port 4904 --secrets <file holding KEYBOARD_BRIDGE_TOKEN=...>

import AppKit
import ApplicationServices
import CryptoKit
import Network

let args = CommandLine.arguments
func arg(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func log(_ msg: String) {
    FileHandle.standardError.write("[aio-keyboard] \(msg)\n".data(using: .utf8)!)
}

let port = UInt16(arg("--port") ?? "4904") ?? 4904
guard let secretsPath = arg("--secrets"),
      let secrets = try? String(contentsOfFile: (secretsPath as NSString).expandingTildeInPath, encoding: .utf8),
      let token = secrets.split(separator: "\n").first(where: { $0.hasPrefix("KEYBOARD_BRIDGE_TOKEN=") })
        .map({ String($0.dropFirst("KEYBOARD_BRIDGE_TOKEN=".count)).trimmingCharacters(in: .whitespaces) }),
      !token.isEmpty
else {
    log("fatal: KEYBOARD_BRIDGE_TOKEN missing (--secrets)")
    exit(1)
}

func authorized(_ header: String?) -> Bool {
    guard let header, header.hasPrefix("Bearer ") else { return false }
    let given = SHA256.hash(data: Data(header.dropFirst(7).utf8))
    let want = SHA256.hash(data: Data(token.utf8))
    return given == want
}

/// Pastes `text` into the focused app, then puts the clipboard back as it was.
func paste(_ text: String) {
    let pb = NSPasteboard.general
    let saved: [NSPasteboardItem] = (pb.pasteboardItems ?? []).map { item in
        let copy = NSPasteboardItem()
        for type in item.types {
            if let data = item.data(forType: type) { copy.setData(data, forType: type) }
        }
        return copy
    }
    pb.clearContents()
    pb.setString(text, forType: .string)
    // Clipboard managers skip transient items, so the dictation doesn't land in their history.
    pb.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
    let ours = pb.changeCount

    let source = CGEventSource(stateID: .combinedSessionState)
    let v: CGKeyCode = 0x09
    let down = CGEvent(keyboardEventSource: source, virtualKey: v, keyDown: true)
    let up = CGEvent(keyboardEventSource: source, virtualKey: v, keyDown: false)
    down?.flags = .maskCommand
    up?.flags = .maskCommand
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)

    // The target app reads the clipboard when it handles the paste; give it time first.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
        guard pb.changeCount == ours else { return }   // something else wrote it since: leave that
        pb.clearContents()
        if !saved.isEmpty { pb.writeObjects(saved) }
    }
}

struct Response {
    var status: Int
    var body: [String: Any]
}

func handle(method: String, path: String, headers: [String: String], body: Data) -> Response {
    guard authorized(headers["authorization"]) else { return Response(status: 401, body: ["error": "unauthenticated"]) }
    switch (method, path) {
    case ("GET", "/status"):
        return Response(status: 200, body: ["trusted": AXIsProcessTrusted()])
    case ("POST", "/type"):
        guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let text = json["text"] as? String, !text.isEmpty
        else { return Response(status: 400, body: ["error": "bad_request"]) }
        guard AXIsProcessTrusted() else {
            // Shows the system prompt (once per launch) pointing at this app.
            AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            return Response(status: 403, body: ["error": "not_trusted"])
        }
        DispatchQueue.main.sync { paste(text) }
        log("typed \(text.count) chars")
        return Response(status: 200, body: ["ok": true])
    case ("POST", "/quit"):
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { exit(0) }
        return Response(status: 200, body: ["ok": true])
    default:
        return Response(status: 404, body: ["error": "not_found"])
    }
}

let maxRequest = 64 * 1024
let reasons = [200: "OK", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 413: "Payload Too Large"]

func serve(_ conn: NWConnection) {
    var buffer = Data()
    let queue = DispatchQueue(label: "aio-keyboard.conn")
    func reply(_ r: Response) {
        let body = (try? JSONSerialization.data(withJSONObject: r.body)) ?? Data()
        var head = "HTTP/1.1 \(r.status) \(reasons[r.status] ?? "Error")\r\n"
        head += "Content-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        conn.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in conn.cancel() })
    }
    func read() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { data, _, done, error in
            if let data { buffer.append(data) }
            if buffer.count > maxRequest { reply(Response(status: 413, body: ["error": "too_large"])); return }
            if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let lines = String(decoding: buffer[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
                let parts = (lines.first ?? "").split(separator: " ")
                var headers: [String: String] = [:]
                for line in lines.dropFirst() {
                    if let colon = line.firstIndex(of: ":") {
                        headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                    }
                }
                let length = Int(headers["content-length"] ?? "0") ?? 0
                let body = buffer[end.upperBound...]
                if body.count >= length, parts.count >= 2 {
                    let path = String(parts[1]).split(separator: "?").first.map(String.init) ?? ""
                    reply(handle(method: String(parts[0]), path: path, headers: headers, body: Data(body.prefix(length))))
                    return
                }
            }
            if done || error != nil { conn.cancel(); return }
            read()
        }
    }
    conn.start(queue: queue)
    read()
}

let params = NWParameters.tcp
params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
params.allowLocalEndpointReuse = true
let listener: NWListener
do {
    listener = try NWListener(using: params)
} catch {
    log("fatal: can't listen on 127.0.0.1:\(port): \(error)")
    exit(1)
}
listener.newConnectionHandler = serve
listener.stateUpdateHandler = { state in
    switch state {
    case .ready: log("listening on 127.0.0.1:\(port); trusted=\(AXIsProcessTrusted())")
    case .failed(let error): log("fatal: listener failed: \(error)"); exit(1)
    default: break
    }
}
listener.start(queue: DispatchQueue(label: "aio-keyboard.listener"))

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.run()
