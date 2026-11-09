import Foundation

// The agent's folder on this iPhone (docs/EXEC-ENVS.md, capability `files`): `AI Files` in the app's
// Documents, which the Files app shows under the app's name (UIFileSharingEnabled,
// LSSupportsOpeningDocumentsInPlace). The agent lists it, copies files from it into its workspace and puts
// files there for the person to open; nothing outside this folder is reachable.

struct FilesError: Error { let code: String; let message: String }

enum DeviceFiles {
    static let maxBytes = 20 * 1024 * 1024

    static var root: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let folder = docs.appendingPathComponent("AI Files", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    /** A path the agent gave, inside the folder; nothing that climbs out of it. */
    static func inside(_ relative: String) throws -> URL {
        let clean = relative.split(separator: "/").filter { !$0.isEmpty && $0 != "." }
        guard !clean.contains("..") else { throw FilesError(code: "invalid", message: "paths stay inside the folder") }
        let url = clean.reduce(root) { $0.appendingPathComponent(String($1)) }.standardizedFileURL
        guard url.path.hasPrefix(root.standardizedFileURL.path) else { throw FilesError(code: "invalid", message: "paths stay inside the folder") }
        return url
    }

    static func list(_ args: [String: Any]) throws -> [String: Any] {
        let folder = try inside(args["folder"] as? String ?? "")
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isDirectoryKey]
        let items = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles])) ?? []
        let formatter = ISO8601DateFormatter()
        let files: [[String: Any]] = items.prefix(500).map { url in
            let values = try? url.resourceValues(forKeys: Set(keys))
            return ["name": url.lastPathComponent, "folder": values?.isDirectory == true, "size": values?.fileSize ?? 0,
                    "modified": values?.contentModificationDate.map(formatter.string(from:)) ?? NSNull()]
        }
        return ["folder": args["folder"] as? String ?? "", "files": files]
    }

    static func pull(_ args: [String: Any]) throws -> [String: Any] {
        guard let name = args["name"] as? String, !name.isEmpty else { throw FilesError(code: "invalid", message: "name is required") }
        let url = try inside(name)
        guard let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize else { throw FilesError(code: "not_found", message: name) }
        guard size <= maxBytes else { throw FilesError(code: "invalid", message: "larger than 20 MB") }
        let data = try Data(contentsOf: url)
        return ["name": url.lastPathComponent, "data": data.base64EncodedString()]
    }

    /** Saved under its name; a name already there gets " (2)", " (3)", … rather than replacing what the person has. */
    static func push(_ args: [String: Any]) throws -> [String: Any] {
        guard let name = (args["name"] as? String).map({ ($0 as NSString).lastPathComponent }), !name.isEmpty, name != "..",
              let encoded = args["data"] as? String, let data = Data(base64Encoded: encoded) else { throw FilesError(code: "invalid", message: "name and data are required") }
        guard data.count <= maxBytes else { throw FilesError(code: "invalid", message: "larger than 20 MB") }
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var target = root.appendingPathComponent(name)
        var n = 2
        while FileManager.default.fileExists(atPath: target.path) {
            target = root.appendingPathComponent(ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)")
            n += 1
        }
        try data.write(to: target, options: .atomic)
        return ["saved": target.lastPathComponent, "size": data.count]
    }
}
