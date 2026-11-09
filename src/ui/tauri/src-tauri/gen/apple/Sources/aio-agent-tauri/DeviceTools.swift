import UIKit
import WebKit
import Photos
import EventKit
import Security

// The iPhone's own abilities for the agent of the account signed in here: Photos, Reminders and
// Calendar (src/control/iosDevice.ts, aio_ios). The console (Settings → iPhone abilities) turns each one
// on, which is when iOS asks for the permission, and hands over a device token its account issued; the
// app then dials the control plane itself (the device-link socket the Mac app uses, kind `ios`) and answers
// the agent's calls while it is open. iOS suspends the socket in the background, so it closes there and
// opens again on return; the agent is told to ask the user to open the app.
//
// Only the console's main frame may talk to it (`aioDeviceTools`, JSON strings, answered with the
// state as JSON). The token is in the Keychain; the account it belongs to is kept beside it, and a
// console signed in as anyone else makes the app forget both and turn every ability off.

let consoleHost = "agent.clawpage.ai"
private let linkURL = URL(string: "wss://agent.clawpage.ai/api/device-link/connect")!
private let keychainService = "ai.clawpage.agent.device-tools"
private let defaultsPrefix = "aio.deviceTools."
private let maxPhotos = 5
private let maxPhotoSide = 1600
private let maxPhotoBytes = 4 * 1024 * 1024

private enum Ability: String, CaseIterable { case photos, reminders, calendar }

func trace(_ message: String) { NSLog("[aio-device-tools] %@", message) }

private func json(_ value: Any) -> String {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) else { return "{}" }
    return String(data: data, encoding: .utf8) ?? "{}"
}

// MARK: - What the person chose, and the token

private enum Store {
    static var defaults: UserDefaults { .standard }
    static var linkId: String? {
        get { defaults.string(forKey: defaultsPrefix + "linkId") }
        set { defaults.set(newValue, forKey: defaultsPrefix + "linkId") }
    }
    static var account: String? {
        get { defaults.string(forKey: defaultsPrefix + "account") }
        set { defaults.set(newValue, forKey: defaultsPrefix + "account") }
    }
    static func enabled(_ ability: Ability) -> Bool { defaults.bool(forKey: defaultsPrefix + "enabled." + ability.rawValue) }
    static func setEnabled(_ ability: Ability, _ on: Bool) { defaults.set(on, forKey: defaultsPrefix + "enabled." + ability.rawValue) }

    static var token: String? {
        get {
            var item: CFTypeRef?
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
                                        kSecAttrAccount as String: "token", kSecReturnData as String: true]
            guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
            return String(data: data, encoding: .utf8)
        }
        set {
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService, kSecAttrAccount as String: "token"]
            SecItemDelete(query as CFDictionary)
            guard let newValue, let data = newValue.data(using: .utf8) else { return }
            var add = query
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    /** Everything about the link goes, and every ability is off: the next account starts from nothing. */
    static func forget() {
        token = nil
        linkId = nil
        account = nil
        for ability in Ability.allCases { setEnabled(ability, false) }
    }
}

// MARK: - Permissions

private let eventStore = EKEventStore()

private enum Permission {
    /** "authorized", "limited" (photos), "denied", "writeOnly" (calendar on iOS 17) or "notDetermined". */
    static func state(_ ability: Ability) -> String {
        switch ability {
        case .photos:
            switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
            case .authorized: return "authorized"
            case .limited: return "limited"
            case .notDetermined: return "notDetermined"
            default: return "denied"
            }
        case .reminders, .calendar:
            // Raw values, so one switch covers iOS 15 (.authorized) and iOS 17 (.fullAccess, .writeOnly).
            let status = EKEventStore.authorizationStatus(for: ability == .reminders ? .reminder : .event).rawValue
            switch status {
            case 3: return "authorized"
            case 4: return "writeOnly"
            case 0: return "notDetermined"
            default: return "denied"
            }
        }
    }

    static func usable(_ ability: Ability) -> Bool { ["authorized", "limited"].contains(state(ability)) }

    /** The system prompt, only while iOS has not asked yet; answered on the main queue. */
    static func request(_ ability: Ability, _ done: @escaping () -> Void) {
        let finish = { DispatchQueue.main.async(execute: done) }
        guard state(ability) == "notDetermined" else { finish(); return }
        switch ability {
        case .photos:
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in finish() }
        case .reminders:
            if #available(iOS 17.0, *) { eventStore.requestFullAccessToReminders { _, _ in finish() } }
            else { eventStore.requestAccess(to: .reminder) { _, _ in finish() } }
        case .calendar:
            if #available(iOS 17.0, *) { eventStore.requestFullAccessToEvents { _, _ in finish() } }
            else { eventStore.requestAccess(to: .event) { _, _ in finish() } }
        }
    }
}

// MARK: - The tools

private struct ToolError: Error { let code: String; let message: String }

private enum Dates {
    static let output: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = .current
        return f
    }()
    static let day: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /** An ISO 8601 date (dateOnly) or date-time; without an offset, this iPhone's time zone. */
    static func parse(_ raw: Any?, field: String) throws -> (date: Date, dateOnly: Bool)? {
        guard let text = (raw as? String)?.trimmingCharacters(in: .whitespaces), !text.isEmpty else { return nil }
        if let date = day.date(from: text), text.count == 10 { return (date, true) }
        for options: ISO8601DateFormatter.Options in [[.withInternetDateTime, .withFractionalSeconds], [.withInternetDateTime]] {
            let f = ISO8601DateFormatter()
            f.formatOptions = options
            if let date = f.date(from: text) { return (date, false) }
        }
        let local = DateFormatter()
        local.locale = Locale(identifier: "en_US_POSIX")
        local.timeZone = .current
        for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm"] {
            local.dateFormat = format
            if let date = local.date(from: text) { return (date, false) }
        }
        throw ToolError(code: "invalid", message: "\(field) is not an ISO 8601 date or date-time: \(text)")
    }

    /** The end of a range: a date alone means the end of that day. */
    static func end(_ parsed: (date: Date, dateOnly: Bool)) -> Date {
        parsed.dateOnly ? Calendar.current.date(byAdding: .day, value: 1, to: parsed.date)! : parsed.date
    }

    static func string(_ date: Date?) -> Any { date.map { output.string(from: $0) } ?? NSNull() }
}

private func int(_ raw: Any?, default value: Int, max: Int) -> Int {
    guard let number = raw as? NSNumber else { return value }
    return Swift.max(0, Swift.min(number.intValue, max))
}

private func clip(_ text: String?, _ length: Int) -> Any {
    guard let text, !text.isEmpty else { return NSNull() }
    return text.count > length ? String(text.prefix(length)) + "…" : text
}

private enum Tools {
    static let ability: [String: Ability] = [
        "photos_albums": .photos, "photos_list": .photos, "photos_get": .photos,
        "reminders_lists": .reminders, "reminders_list": .reminders, "reminders_create": .reminders, "reminders_complete": .reminders,
        "calendar_calendars": .calendar, "calendar_events": .calendar, "calendar_create_event": .calendar,
    ]

    static func status() -> [String: Any] {
        var abilities: [String: Any] = [:]
        for ability in Ability.allCases { abilities[ability.rawValue] = ["enabled": Store.enabled(ability), "permission": Permission.state(ability)] }
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        return ["abilities": abilities, "timeZone": TimeZone.current.identifier, "app": version]
    }

    /** One call; runs off the main queue (PhotoKit and EventKit block). */
    static func run(_ tool: String, _ args: [String: Any]) -> [String: Any] {
        do {
            if tool == "iphone_status" { return ["ok": true, "result": status()] }
            guard let ability = ability[tool] else { throw ToolError(code: "unknown_tool", message: tool) }
            guard Store.enabled(ability) else { throw ToolError(code: "off", message: "\(ability.rawValue) is off") }
            guard Permission.usable(ability) else { throw ToolError(code: "denied", message: Permission.state(ability)) }
            let result: Any
            switch tool {
            case "photos_albums": result = albums()
            case "photos_list": result = try photos(args)
            case "photos_get": result = try fetch(args)
            case "reminders_lists": result = lists(.reminder)
            case "reminders_list": result = try reminders(args)
            case "reminders_create": result = try createReminder(args)
            case "reminders_complete": result = try completeReminder(args)
            case "calendar_calendars": result = lists(.event)
            case "calendar_events": result = try events(args)
            default: result = try createEvent(args)
            }
            return ["ok": true, "result": result]
        } catch let error as ToolError {
            return ["ok": false, "code": error.code, "message": error.message]
        } catch {
            return ["ok": false, "code": "failed", "message": error.localizedDescription]
        }
    }

    // Photos

    static func albums() -> [String: Any] {
        var out: [[String: Any]] = []
        let add = { (collection: PHAssetCollection, kind: String) in
            let count = PHAsset.fetchAssets(in: collection, options: nil).count
            if count > 0 || kind == "album" { out.append(["id": collection.localIdentifier, "title": collection.localizedTitle ?? "", "count": count, "kind": kind]) }
        }
        let smart: [PHAssetCollectionSubtype] = [.smartAlbumUserLibrary, .smartAlbumFavorites, .smartAlbumRecentlyAdded, .smartAlbumScreenshots, .smartAlbumSelfPortraits, .smartAlbumVideos, .smartAlbumLivePhotos, .smartAlbumPanoramas]
        for subtype in smart { PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: subtype, options: nil).enumerateObjects { c, _, _ in add(c, "smart") } }
        PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil).enumerateObjects { c, index, stop in
            add(c, "album")
            if index >= 199 { stop.pointee = true }
        }
        return ["albums": out]
    }

    static func photos(_ args: [String: Any]) throws -> [String: Any] {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        var predicates: [NSPredicate] = []
        switch args["media"] as? String ?? "image" {
        case "video": predicates.append(NSPredicate(format: "mediaType == %d", PHAssetMediaType.video.rawValue))
        case "any": predicates.append(NSPredicate(format: "mediaType == %d || mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue))
        default: predicates.append(NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue))
        }
        if let from = try Dates.parse(args["from"], field: "from") { predicates.append(NSPredicate(format: "creationDate >= %@", from.date as NSDate)) }
        if let to = try Dates.parse(args["to"], field: "to") { predicates.append(NSPredicate(format: "creationDate < %@", Dates.end(to) as NSDate)) }
        if args["favorites"] as? Bool == true { predicates.append(NSPredicate(format: "favorite == YES")) }
        options.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
        let assets: PHFetchResult<PHAsset>
        if let album = args["album_id"] as? String, !album.isEmpty {
            guard let collection = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [album], options: nil).firstObject else { throw ToolError(code: "not_found", message: "no album \(album)") }
            assets = PHAsset.fetchAssets(in: collection, options: options)
        } else {
            assets = PHAsset.fetchAssets(with: options)
        }
        let offset = int(args["offset"], default: 0, max: 1_000_000)
        let limit = int(args["limit"], default: 20, max: 100)
        var out: [[String: Any]] = []
        if offset < assets.count {
            assets.enumerateObjects(at: IndexSet(offset..<min(assets.count, offset + limit)), options: []) { asset, _, _ in out.append(describe(asset)) }
        }
        return ["photos": out, "total": assets.count, "offset": offset]
    }

    static func describe(_ asset: PHAsset) -> [String: Any] {
        var item: [String: Any] = ["id": asset.localIdentifier, "created": Dates.string(asset.creationDate), "width": asset.pixelWidth, "height": asset.pixelHeight,
                                   "mediaType": asset.mediaType == .video ? "video" : "image", "favorite": asset.isFavorite]
        if asset.mediaType == .video { item["duration"] = (asset.duration * 10).rounded() / 10 }
        // About 100 m: enough to say where, not the doorstep.
        if let place = asset.location?.coordinate { item["location"] = ["lat": NSDecimalNumber(string: String(format: "%.3f", place.latitude)), "lon": NSDecimalNumber(string: String(format: "%.3f", place.longitude))] }
        return item
    }

    static func fetch(_ args: [String: Any]) throws -> [String: Any] {
        let ids = (args["ids"] as? [String] ?? []).filter { !$0.isEmpty }
        guard !ids.isEmpty, ids.count <= maxPhotos else { throw ToolError(code: "invalid", message: "ids: 1 to \(maxPhotos) photo ids") }
        let side = CGFloat(min(max(int(args["max_size"], default: maxPhotoSide, max: maxPhotoSide), 64), maxPhotoSide))
        let found = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        var byId: [String: PHAsset] = [:]
        found.enumerateObjects { asset, _, _ in byId[asset.localIdentifier] = asset }
        let options = PHImageRequestOptions()
        options.isSynchronous = true
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .exact
        options.isNetworkAccessAllowed = true
        var photos: [[String: Any]] = []
        var missing: [String] = []
        for id in ids {
            guard let asset = byId[id] else { missing.append(id); continue }
            // Never larger than the original.
            let scale = min(1, side / CGFloat(max(asset.pixelWidth, asset.pixelHeight, 1)))
            let target = CGSize(width: (CGFloat(asset.pixelWidth) * scale).rounded(), height: (CGFloat(asset.pixelHeight) * scale).rounded())
            var picture: UIImage?
            PHImageManager.default().requestImage(for: asset, targetSize: target, contentMode: .aspectFit, options: options) { image, _ in picture = image }
            var data = picture?.jpegData(compressionQuality: 0.8)
            if let big = data, big.count > maxPhotoBytes { data = picture?.jpegData(compressionQuality: 0.5) }
            guard let data, data.count <= maxPhotoBytes else { missing.append(id); continue }
            var item = describe(asset)
            item["jpeg"] = data.base64EncodedString()
            photos.append(item)
        }
        return ["photos": photos, "missing": missing]
    }

    // Reminders and calendars

    static func lists(_ type: EKEntityType) -> [String: Any] {
        let fallback = type == .reminder ? eventStore.defaultCalendarForNewReminders() : eventStore.defaultCalendarForNewEvents
        let lists = eventStore.calendars(for: type).map { c -> [String: Any] in
            ["id": c.calendarIdentifier, "title": c.title, "account": c.source?.title ?? "", "writable": c.allowsContentModifications, "default": c.calendarIdentifier == fallback?.calendarIdentifier]
        }
        return [type == .reminder ? "lists" : "calendars": lists]
    }

    static func calendar(_ raw: Any?, _ type: EKEntityType) throws -> EKCalendar? {
        guard let id = raw as? String, !id.isEmpty else { return nil }
        guard let found = eventStore.calendar(withIdentifier: id), found.allowedEntityTypes.contains(type == .reminder ? .reminder : .event) else {
            throw ToolError(code: "not_found", message: "no \(type == .reminder ? "list" : "calendar") \(id)")
        }
        return found
    }

    static func dueString(_ components: DateComponents?) -> Any {
        guard let components, let date = Calendar.current.date(from: components) else { return NSNull() }
        return components.hour == nil ? Dates.day.string(from: date) : Dates.output.string(from: date)
    }

    static func priority(_ value: Int) -> String {
        switch value { case 1...4: return "high"; case 5: return "medium"; case 6...9: return "low"; default: return "none" }
    }

    static func describe(_ reminder: EKReminder) -> [String: Any] {
        ["id": reminder.calendarItemIdentifier, "title": reminder.title ?? "", "notes": clip(reminder.notes, 500), "due": dueString(reminder.dueDateComponents),
         "priority": priority(reminder.priority), "completed": reminder.isCompleted, "completedAt": Dates.string(reminder.completionDate),
         "list": reminder.calendar?.title ?? "", "list_id": reminder.calendar?.calendarIdentifier ?? ""]
    }

    static func reminders(_ args: [String: Any]) throws -> [String: Any] {
        let lists = try calendar(args["list_id"], .reminder).map { [$0] }
        let status = args["status"] as? String ?? "open"
        let predicate: NSPredicate
        switch status {
        case "completed": predicate = eventStore.predicateForCompletedReminders(withCompletionDateStarting: nil, ending: nil, calendars: lists)
        case "all": predicate = eventStore.predicateForReminders(in: lists)
        default: predicate = eventStore.predicateForIncompleteReminders(withDueDateStarting: nil, ending: try Dates.parse(args["due_before"], field: "due_before").map { Dates.end($0) }, calendars: lists)
        }
        let done = DispatchSemaphore(value: 0)
        var found: [EKReminder] = []
        eventStore.fetchReminders(matching: predicate) { reminders in found = reminders ?? []; done.signal() }
        done.wait()
        let due = { (r: EKReminder) in r.dueDateComponents.flatMap { Calendar.current.date(from: $0) } ?? .distantFuture }
        found.sort { status == "completed" ? ($0.completionDate ?? .distantPast) > ($1.completionDate ?? .distantPast) : due($0) < due($1) }
        let limit = int(args["limit"], default: 50, max: 200)
        return ["reminders": found.prefix(limit).map(describe), "total": found.count]
    }

    static func createReminder(_ args: [String: Any]) throws -> [String: Any] {
        guard let title = (args["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else { throw ToolError(code: "invalid", message: "title is required") }
        guard let list = try calendar(args["list_id"], .reminder) ?? eventStore.defaultCalendarForNewReminders() else { throw ToolError(code: "not_found", message: "no reminder list") }
        let reminder = EKReminder(eventStore: eventStore)
        reminder.title = title
        reminder.notes = args["notes"] as? String
        reminder.calendar = list
        if let due = try Dates.parse(args["due"], field: "due") {
            var components = Calendar.current.dateComponents(due.dateOnly ? [.year, .month, .day] : [.year, .month, .day, .hour, .minute], from: due.date)
            components.timeZone = due.dateOnly ? nil : .current
            reminder.dueDateComponents = components
            // A reminder with a time says so at that time.
            if !due.dateOnly { reminder.addAlarm(EKAlarm(absoluteDate: due.date)) }
        }
        switch args["priority"] as? String { case "high": reminder.priority = 1; case "medium": reminder.priority = 5; case "low": reminder.priority = 9; default: break }
        try eventStore.save(reminder, commit: true)
        return describe(reminder)
    }

    static func completeReminder(_ args: [String: Any]) throws -> [String: Any] {
        guard let id = args["id"] as? String, let reminder = eventStore.calendarItem(withIdentifier: id) as? EKReminder else { throw ToolError(code: "not_found", message: "no reminder \(args["id"] ?? "")") }
        reminder.isCompleted = args["completed"] as? Bool ?? true
        try eventStore.save(reminder, commit: true)
        return describe(reminder)
    }

    static func describe(_ event: EKEvent) -> [String: Any] {
        ["id": event.eventIdentifier ?? "", "title": event.title ?? "", "start": Dates.string(event.startDate), "end": Dates.string(event.endDate), "all_day": event.isAllDay,
         "location": clip(event.location, 200), "notes": clip(event.notes, 500), "calendar": event.calendar?.title ?? "", "calendar_id": event.calendar?.calendarIdentifier ?? ""]
    }

    static func events(_ args: [String: Any]) throws -> [String: Any] {
        guard let from = try Dates.parse(args["from"], field: "from"), let to = try Dates.parse(args["to"], field: "to") else { throw ToolError(code: "invalid", message: "from and to are required") }
        let end = Dates.end(to)
        guard end > from.date, end.timeIntervalSince(from.date) <= 366 * 86_400 else { throw ToolError(code: "invalid", message: "the range must be positive and at most 366 days") }
        let calendars = try calendar(args["calendar_id"], .event).map { [$0] }
        let found = eventStore.events(matching: eventStore.predicateForEvents(withStart: from.date, end: end, calendars: calendars)).sorted { $0.startDate < $1.startDate }
        let limit = int(args["limit"], default: 100, max: 300)
        return ["events": found.prefix(limit).map(describe), "total": found.count]
    }

    static func createEvent(_ args: [String: Any]) throws -> [String: Any] {
        guard let title = (args["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else { throw ToolError(code: "invalid", message: "title is required") }
        guard let start = try Dates.parse(args["start"], field: "start") else { throw ToolError(code: "invalid", message: "start is required") }
        guard let calendar = try calendar(args["calendar_id"], .event) ?? eventStore.defaultCalendarForNewEvents else { throw ToolError(code: "not_found", message: "no calendar") }
        guard calendar.allowsContentModifications else { throw ToolError(code: "invalid", message: "calendar \(calendar.title) is read-only") }
        let allDay = args["all_day"] as? Bool ?? start.dateOnly
        let event = EKEvent(eventStore: eventStore)
        event.title = title
        event.calendar = calendar
        event.isAllDay = allDay
        event.startDate = start.date
        if let end = try Dates.parse(args["end"], field: "end") {
            event.endDate = allDay && end.dateOnly ? Dates.end(end).addingTimeInterval(-1) : end.date
        } else {
            event.endDate = allDay ? Dates.end((start.date, true)).addingTimeInterval(-1) : start.date.addingTimeInterval(3600)
        }
        guard event.endDate >= event.startDate else { throw ToolError(code: "invalid", message: "end is before start") }
        event.location = args["location"] as? String
        event.notes = args["notes"] as? String
        try eventStore.save(event, span: .thisEvent, commit: true)
        return describe(event)
    }
}

// MARK: - This iPhone as an execution environment (docs/EXEC-ENVS.md, protocol 1)

/**
 * What the agent may do here and how a call reaches it: the app's own browser (AIBrowser.swift) and folder
 * (DeviceFiles.swift) whenever the iPhone is linked, and the abilities the person turned on and iOS allows.
 * Answered at `/env/manifest` and `/env/call`; a change is told at once as a `manifest` event.
 */
private enum Environment {
    static let deviceId = UIDevice.current.identifierForVendor?.uuidString ?? "iphone"

    static func manifest() -> [String: Any] {
        let onScreen: Bool = Thread.isMainThread ? UIApplication.shared.applicationState == .active : DispatchQueue.main.sync { UIApplication.shared.applicationState == .active }
        let abilities = Ability.allCases.filter { Store.enabled($0) && Permission.usable($0) }.map(\.rawValue)
        return ["protocol": 1, "envs": [["deviceId": deviceId, "kind": "ios", "name": UIDevice.current.name, "capabilities": ["browser", "files"] + abilities, "foreground": onScreen]]]
    }

    /** One call (off the main queue); the browser's tools run on the main queue and are waited for here. */
    static func call(_ body: [String: Any]) -> [String: Any] {
        guard body["env"] as? String == deviceId, let tool = body["tool"] as? String else { return ["ok": false, "code": "not_found", "message": "not this iPhone"] }
        let args = body["arguments"] as? [String: Any] ?? [:]
        if tool.hasPrefix("files_") {
            do {
                switch tool {
                case "files_list": return ["ok": true, "result": try DeviceFiles.list(args)]
                case "files_pull": return ["ok": true, "result": try DeviceFiles.pull(args)]
                case "files_push": return ["ok": true, "result": try DeviceFiles.push(args)]
                default: return ["ok": false, "code": "unknown_tool"]
                }
            } catch let error as FilesError {
                return ["ok": false, "code": error.code, "message": error.message]
            } catch {
                return ["ok": false, "code": "failed", "message": error.localizedDescription]
            }
        }
        guard tool.hasPrefix("browser_") else { return Tools.run(tool, args) }
        let semaphore = DispatchSemaphore(value: 0)
        var answer: [String: Any] = ["ok": false, "code": "failed", "message": "no answer"]
        let done = { (result: Result<[String: Any], BrowserError>) in
            switch result {
            case .success(let value): answer = ["ok": true, "result": value]
            case .failure(let error): answer = ["ok": false, "code": error.code, "message": error.message]
            }
            semaphore.signal()
        }
        DispatchQueue.main.async {
            let browser = AIBrowser.shared
            switch tool {
            case "browser_open": browser.open(args["url"] as? String ?? "", done)
            case "browser_read": browser.read(done)
            case "browser_click": browser.click(args["ref"] as? String ?? "", done)
            case "browser_type": browser.type(args["ref"] as? String ?? "", args["text"] as? String ?? "", submit: args["submit"] as? Bool ?? false, done)
            case "browser_scroll": browser.scroll(args["direction"] as? String ?? "down", done)
            case "browser_back": browser.back(done)
            case "browser_screenshot": browser.screenshot(done)
            case "browser_request_human": browser.requestHuman(args["reason"] as? String ?? "", done)
            default: done(.failure(BrowserError(code: "unknown_tool", message: tool)))
            }
        }
        // A person asked to act gets ten minutes; anything else is a page, which answers well within two.
        _ = semaphore.wait(timeout: .now() + (tool == "browser_request_human" ? 610 : 120))
        return answer
    }
}

// MARK: - The socket to the control plane

/** One WebSocket to the device-link endpoint, answering its `req` frames (deviceLink.ts). */
private final class Link: NSObject, URLSessionWebSocketDelegate {
    private(set) var state = "off"
    var onState: (() -> Void)?
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
    private var task: URLSessionWebSocketTask?
    private var retry: TimeInterval = 1
    private var ping: Timer?
    private var inflight = 0
    private var background: UIBackgroundTaskIdentifier = .invalid
    /** Whether the console here is signed in as the link's account (nothing connects before it says so). */
    var wanted = false { didSet { wanted ? connect() : disconnect("off") } }

    override init() {
        super.init()
        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.suspend() }
        // Not willEnterForeground: the app still counts as in the background there, and connect() waits for it.
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, self.wanted else { return }
            // Back on screen while still connected: the agent's brief should say so now.
            if self.task != nil { self.event("manifest", Environment.manifest()); return }
            self.retry = 1
            self.connect()
        }
    }

    private var url: URL {
        #if DEBUG
        // Testing against a local control plane from the simulator.
        if let local = UserDefaults.standard.string(forKey: "AIODeviceToolsLinkURL"), let url = URL(string: local) { return url }
        #endif
        return linkURL
    }

    func connect() {
        guard wanted, task == nil, let token = Store.token, UIApplication.shared.applicationState != .background else { return }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(UIDevice.current.name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "iPhone", forHTTPHeaderField: "x-aio-device-name")
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = 32 * 1024 * 1024
        self.task = task
        set("connecting")
        task.resume()
        receive(task)
    }

    private func set(_ next: String) {
        guard state != next else { return }
        state = next
        trace("link \(next)")
        onState?()
    }

    /** Something the server should know unasked (`manifest`: what this iPhone offers changed). */
    func event(_ name: String, _ data: [String: Any]) {
        guard state == "online", let task else { return }
        task.send(.string(json(["t": "event", "name": name, "data": data]))) { _ in }
    }

    func disconnect(_ next: String) {
        ping?.invalidate()
        ping = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        set(next)
    }

    /** In the background iOS suspends the socket: close it, after the calls in flight are answered, so the server says "open the app" at once. */
    private func suspend() {
        guard task != nil else { return }
        background = UIApplication.shared.beginBackgroundTask { [weak self] in self?.finishBackground() }
        if inflight == 0 { finishBackground() }
        else { DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.finishBackground() } }
    }

    private func finishBackground() {
        guard UIApplication.shared.applicationState == .background else { return }
        if task != nil { disconnect(wanted ? "offline" : "off") }
        if background != .invalid { UIApplication.shared.endBackgroundTask(background); background = .invalid }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard webSocketTask === task else { return }
        retry = 1
        set("online")
        ping?.invalidate()
        // The server pings too; this notices a connection that died without a close.
        ping = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { [weak self, weak webSocketTask] _ in
            webSocketTask?.sendPing { error in if error != nil { DispatchQueue.main.async { self?.failed(webSocketTask) } } }
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === task else { return }
        // 4001: the console removed this iPhone.
        if closeCode.rawValue == 4001 { revoked(); return }
        failed(webSocketTask)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard task === self.task else { return }
        // A token the server no longer knows (removed while this app was away).
        if (task.response as? HTTPURLResponse)?.statusCode == 401 { revoked(); return }
        failed(self.task)
    }

    private func revoked() {
        Store.forget()
        disconnect("revoked")
    }

    private func failed(_ which: URLSessionWebSocketTask?) {
        guard let which, which === task else { return }
        disconnect(wanted ? "offline" : "off")
        guard wanted, UIApplication.shared.applicationState != .background else { return }
        let wait = retry
        retry = min(retry * 2, 30)
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in self?.connect() }
    }

    private func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, task === self.task else { return }
                switch result {
                case .failure: self.failed(task)
                case .success(let message):
                    if case .string(let text) = message { self.handle(text, on: task) }
                    self.receive(task)
                }
            }
        }
    }

    private func handle(_ text: String, on task: URLSessionWebSocketTask) {
        guard let data = text.data(using: .utf8), let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        // This app offers no channels (no live screen): any that is asked for closes at once.
        if frame["t"] as? String == "open", let ch = frame["ch"] as? Int {
            task.send(.string(json(["t": "closed", "ch": ch, "code": 1011]))) { _ in }
            return
        }
        guard frame["t"] as? String == "req", let id = frame["id"] as? Int else { return }
        let method = frame["method"] as? String ?? ""
        let path = frame["path"] as? String ?? ""
        let body = (frame["body"] as? String).flatMap { Data(base64Encoded: $0) } ?? Data()
        inflight += 1
        DispatchQueue.global(qos: .userInitiated).async {
            let (status, answer) = Link.answer(method, path, body)
            DispatchQueue.main.async {
                self.inflight -= 1
                let reply = json(["t": "res", "id": id, "status": status, "headers": ["content-type": "application/json"], "body": Data(json(answer).utf8).base64EncodedString()])
                task.send(.string(reply)) { _ in }
                if self.inflight == 0, UIApplication.shared.applicationState == .background { self.finishBackground() }
            }
        }
    }

    /** The endpoints this app has (protocol 1, and the two it had before); anything else is not found. */
    static func answer(_ method: String, _ path: String, _ body: Data) -> (Int, [String: Any]) {
        if method == "GET", path == "/env/manifest" { return (200, Environment.manifest()) }
        if method == "POST", path == "/env/call", let call = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            let started = Date()
            let answer = Environment.call(call)
            trace("env call \(call["tool"] as? String ?? "-") ok=\(answer["ok"] as? Bool ?? false) code=\(answer["code"] as? String ?? "-") ms=\(Int(Date().timeIntervalSince(started) * 1000))")
            return (200, answer)
        }
        if method == "GET", path == "/ios/status" { return (200, Tools.status()) }
        guard method == "POST", path == "/ios/call",
              let call = try? JSONSerialization.jsonObject(with: body) as? [String: Any], let tool = call["tool"] as? String else { return (404, [:]) }
        let started = Date()
        let answer = Tools.run(tool, call["arguments"] as? [String: Any] ?? [:])
        // The tool and how it went, never what it returned.
        trace("call \(tool) ok=\(answer["ok"] as? Bool ?? false) code=\(answer["code"] as? String ?? "-") ms=\(Int(Date().timeIntervalSince(started) * 1000))")
        return (200, answer)
    }
}

// MARK: - The console's bridge

private final class DeviceToolsHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var webView: WKWebView?
    let link = Link()
    init(_ webView: WKWebView) {
        self.webView = webView
        super.init()
        link.onState = { [weak self] in self?.publish() }
    }

    private func status() -> [String: Any] {
        var out = Tools.status()
        out["linked"] = Store.token != nil
        out["linkId"] = Store.linkId ?? NSNull()
        out["state"] = Store.token == nil ? (link.state == "revoked" ? "revoked" : "off") : link.state
        out["name"] = UIDevice.current.name
        return out
    }

    /** The state as it changes, for a settings page that is open. */
    private func publish() {
        guard let webView, webView.url?.host == consoleHost, webView.url?.scheme == "https" else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('aio-device-tools',{detail:\(json(status()))}));")
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "https", origin.host == consoleHost, origin.port == 443 || origin.port == 0,
              let text = message.body as? String, let data = text.data(using: .utf8),
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = body["type"] as? String else {
            replyHandler(nil, "refused")
            return
        }
        let reply = { replyHandler(json(self.status()), nil) }
        switch type {
        case "status": reply()
        case "account":
            // The console says who is signed in (nobody: null). Another account makes this iPhone forget the link.
            let account = body["account"] as? String
            if DeviceTools.testLink { reply(); return }
            if let stored = Store.account, let account, stored != account {
                link.wanted = false
                Store.forget()
            }
            link.wanted = account != nil && account == Store.account && Store.token != nil
            reply()
        case "link":
            guard let token = body["token"] as? String, token.range(of: "^dl_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
                  let linkId = body["linkId"] as? String, let account = body["account"] as? String, !account.isEmpty else { replyHandler(nil, "invalid"); return }
            link.wanted = false
            Store.token = token
            Store.linkId = linkId
            Store.account = account
            link.wanted = true
            reply()
        case "unlink":
            link.wanted = false
            Store.forget()
            reply()
        case "enable":
            guard let ability = Ability(rawValue: body["ability"] as? String ?? "") else { replyHandler(nil, "invalid"); return }
            Permission.request(ability) {
                Store.setEnabled(ability, Permission.usable(ability))
                self.link.event("manifest", Environment.manifest())
                reply()
            }
        case "disable":
            guard let ability = Ability(rawValue: body["ability"] as? String ?? "") else { replyHandler(nil, "invalid"); return }
            Store.setEnabled(ability, false)
            link.event("manifest", Environment.manifest())
            reply()
        case "settings":
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            reply()
        default: replyHandler(nil, "unknown")
        }
    }
}

@objc(AIODeviceTools)
final class DeviceTools: NSObject {
    private static var handler: DeviceToolsHandler?

    /** A debug build linked from its launch arguments: the console's account does not turn that link off. */
    fileprivate static var testLink = false

    @objc(installDeviceTools:)
    static func install(_ webView: WKWebView) {
        let handler = DeviceToolsHandler(webView)
        DeviceTools.handler = handler
        webView.configuration.userContentController.addScriptMessageHandler(handler, contentWorld: .page, name: "aioDeviceTools")
        trace("installed")
        #if DEBUG
        // A link without the console, for testing against a local control plane (AIODeviceToolsLinkURL).
        if let token = UserDefaults.standard.string(forKey: "AIODeviceToolsLinkToken") {
            Store.token = token
            Store.linkId = "debug"
            Store.account = "debug"
            testLink = true
            for ability in Ability.allCases { Store.setEnabled(ability, Permission.usable(ability)) }
            handler.link.wanted = true
        }
        selfTest()
        #endif
    }

    #if DEBUG
    /**
     * `-AIODeviceToolsSelfTest YES` on a debug build: turn every ability on (the permission granted
     * beforehand with `simctl privacy`) and run each tool here, logging what came back
     * (`log stream --predicate 'eventMessage CONTAINS "aio-device-tools"'`).
     */
    private static func selfTest() {
        guard UserDefaults.standard.bool(forKey: "AIODeviceToolsSelfTest") else { return }
        trace("selftest start")
        let summary = { (value: Any) -> String in
            var text = json(value)
            // A photo's bytes are reported by size only.
            text = text.replacingOccurrences(of: "\"jpeg\":\"[A-Za-z0-9+/=]+\"", with: "\"jpeg\":\"<bytes>\"", options: .regularExpression)
            return String(text.prefix(1500))
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
            let group = DispatchGroup()
            for ability in Ability.allCases {
                group.enter()
                DispatchQueue.main.async { Permission.request(ability) { Store.setEnabled(ability, Permission.usable(ability)); group.leave() } }
            }
            group.wait()
            let step = { (tool: String, args: [String: Any]) -> [String: Any] in
                let answer = Tools.run(tool, args)
                trace("selftest \(tool) \(summary(answer))")
                return answer
            }
            _ = step("iphone_status", [:])
            _ = step("photos_albums", [:])
            let listed = step("photos_list", ["limit": 3, "media": "any"])
            let first = ((listed["result"] as? [String: Any])?["photos"] as? [[String: Any]])?.first?["id"] as? String
            let fetched = step("photos_get", ["ids": [first ?? "none", "missing-id"], "max_size": 800])
            if let photo = ((fetched["result"] as? [String: Any])?["photos"] as? [[String: Any]])?.first, let jpeg = photo["jpeg"] as? String,
               let data = Data(base64Encoded: jpeg), let image = UIImage(data: data) {
                trace("selftest photos_get jpeg bytes=\(data.count) size=\(Int(image.size.width * image.scale))x\(Int(image.size.height * image.scale))")
            }
            _ = step("reminders_lists", [:])
            let created = step("reminders_create", ["title": "AIO self-test", "due": Dates.output.string(from: Date().addingTimeInterval(3600)), "priority": "high"])
            _ = step("reminders_list", ["status": "open"])
            if let id = (created["result"] as? [String: Any])?["id"] as? String { _ = step("reminders_complete", ["id": id]) }
            _ = step("reminders_list", ["status": "completed", "limit": 3])
            _ = step("calendar_calendars", [:])
            let today = Dates.day.string(from: Date())
            _ = step("calendar_create_event", ["title": "AIO self-test", "start": "\(today)T15:00", "location": "Home"])
            _ = step("calendar_create_event", ["title": "AIO all-day", "start": today])
            _ = step("calendar_events", ["from": today, "to": today])
            _ = step("calendar_events", ["from": today, "to": "2099-01-01"])
            _ = step("photos_get", ["ids": ["a", "b", "c", "d", "e", "f"]])
            trace("selftest done")
        }
    }
    #endif
}
