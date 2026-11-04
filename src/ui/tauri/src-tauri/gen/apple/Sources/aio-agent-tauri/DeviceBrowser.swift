import UIKit
import WebKit
import SafariServices
import AuthenticationServices
import UserNotifications
import ObjectiveC

// This bridge grants one operation to the main console frame, not Tauri IPC.
private final class DeviceBrowserHandler: NSObject, WKScriptMessageHandler, ASWebAuthenticationPresentationContextProviding {
    weak var webView: WKWebView?
    private var authSession: ASWebAuthenticationSession?
    init(_ webView: WKWebView) { self.webView = webView }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "https",
              origin.host == "agent.clawpage.ai", origin.port == 443 || origin.port == 0,
              let address = message.body as? String, let url = URL(string: address),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
              var presenter = webView?.window?.rootViewController else { return }
        while let next = presenter.presentedViewController { presenter = next }
        if url.scheme == "https", url.host == "agent.clawpage.ai", url.path == "/api/auth/google/authorize" {
            // AuthenticationServices uses the system's authentication browser and returns
            // the one-use callback to this app, rather than signing in inside WKWebView.
            authSession = ASWebAuthenticationSession(url: url, callbackURLScheme: "aioagent") { [weak self] callback, _ in
                DispatchQueue.main.async {
                    guard let self, let webView = self.webView,
                          webView.url?.host == "agent.clawpage.ai", webView.url?.scheme == "https" else { return }
                    let ticket = callback.flatMap { url -> String? in
                        guard url.scheme == "aioagent", url.host == "auth", url.path.isEmpty,
                              let value = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "ticket" })?.value,
                              value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { return nil }
                        return value
                    }
                    let detail = ticket.map { ["ticket": $0] } ?? ["error": "failed"]
                    guard let data = try? JSONSerialization.data(withJSONObject: detail), let json = String(data: data, encoding: .utf8) else { return }
                    webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('aio-google-return',{detail:\(json)}));")
                    self.authSession = nil
                }
            }
            authSession?.presentationContextProvider = self
            authSession?.start()
            return
        }
        // SafariServices supplies real browser navigation and system safe areas.
        let browser = SFSafariViewController(url: url)
        browser.modalPresentationStyle = .pageSheet
        if #available(iOS 16.0, *), let sheet = browser.sheetPresentationController {
            sheet.detents = [.custom(identifier: .init("nineTenths")) { context in context.maximumDetentValue * 0.9 }]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = 20
        }
        presenter.present(browser, animated: true)
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        webView?.window ?? ASPresentationAnchor()
    }
}

// Sign in with Apple through the system sheet (App Store rule 4.8). The console sends the
// server's nonce; the identity token Apple signs goes back to the page, which hands it to
// the server to check. Only the console's own main frame may ask.
private final class AppleSignInHandler: NSObject, WKScriptMessageHandler, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    weak var webView: WKWebView?
    private var controller: ASAuthorizationController?
    init(_ webView: WKWebView) { self.webView = webView }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "https",
              origin.host == "agent.clawpage.ai", origin.port == 443 || origin.port == 0,
              let nonce = message.body as? String,
              nonce.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil else { return }
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.email]
        request.nonce = nonce
        let authorization = ASAuthorizationController(authorizationRequests: [request])
        authorization.delegate = self
        authorization.presentationContextProvider = self
        self.controller = authorization
        authorization.performRequests()
    }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let data = credential.identityToken, let token = String(data: data, encoding: .utf8) else { reply(["error": "failed"]); return }
        reply(["identityToken": token])
    }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        reply(["error": (error as? ASAuthorizationError)?.code == .canceled ? "canceled" : "failed"])
    }
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        webView?.window ?? ASPresentationAnchor()
    }
    private func reply(_ detail: [String: String]) {
        DispatchQueue.main.async {
            self.controller = nil
            guard let webView = self.webView, webView.url?.host == "agent.clawpage.ai", webView.url?.scheme == "https",
                  let data = try? JSONSerialization.data(withJSONObject: detail), let json = String(data: data, encoding: .utf8) else { return }
            webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('aio-apple-return',{detail:\(json)}));")
        }
    }
}

// A marker, not an operation: the console sees it and saves files through the share sheet,
// because this shell declares the Photos permission behind its "Save Image" (Info.plist).
// WKWebView ignores download links, and an older shell would be closed by iOS on that tap.
private final class SaveFilesMarker: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {}
}

// Notifications through APNs, because WKWebView has no Web Push. The console sends "status",
// "enable" (the system prompt, then registering with APNs) or "settings" (this app's page in
// Settings, where a refusal is undone). Each answer is an `aio-push` event with the permission
// and, once granted, the device token and its APNs environment, for the console to hand to the server.
private final class PushHandler: NSObject, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    static weak var shared: PushHandler?
    weak var webView: WKWebView?
    init(_ webView: WKWebView) {
        self.webView = webView
        super.init()
        PushHandler.shared = self
        UNUserNotificationCenter.current().delegate = self
        PushHandler.hookAppDelegate()
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "https",
              origin.host == "agent.clawpage.ai", origin.port == 443 || origin.port == 0,
              let action = message.body as? String else { return }
        switch action {
        case "status": report()
        case "enable":
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
                DispatchQueue.main.async { self.report() }
            }
        case "settings":
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        default: return
        }
    }

    // With the permission granted, registering again is how the token is learned: iOS answers at once with the current one.
    private func report() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                switch settings.authorizationStatus {
                case .authorized, .provisional, .ephemeral: UIApplication.shared.registerForRemoteNotifications()
                case .denied: self.send(["permission": "denied"])
                default: self.send(["permission": "default"])
                }
            }
        }
    }

    fileprivate func registered(_ token: Data?) {
        var detail = ["permission": "granted", "environment": PushHandler.environment]
        if let token { detail["token"] = token.map { String(format: "%02x", $0) }.joined() } else { detail["error"] = "register" }
        send(detail)
    }

    private func send(_ detail: [String: String]) {
        guard let webView, webView.url?.host == "agent.clawpage.ai", webView.url?.scheme == "https",
              let data = try? JSONSerialization.data(withJSONObject: detail), let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('aio-push',{detail:\(json)}));")
    }

    // Shown while the app is open too: the server already skips a device whose console is on screen.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    // A tap opens the app on the console; a notification naming another console page opens that page.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        defer { completionHandler() }
        guard let path = response.notification.request.content.userInfo["url"] as? String, path.hasPrefix("/"), !path.hasPrefix("//"), path != "/",
              let url = URL(string: "https://agent.clawpage.ai" + path), let webView else { return }
        webView.load(URLRequest(url: url))
    }

    // TestFlight and App Store installs carry no provisioning profile and use APNs production;
    // a development build's profile names its environment; the simulator uses the sandbox.
    static let environment: String = {
        #if targetEnvironment(simulator)
        return "development"
        #else
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let raw = try? Data(contentsOf: url), let text = String(data: raw, encoding: .isoLatin1) else { return "production" }
        guard let start = text.range(of: "<?xml"), let end = text.range(of: "</plist>"),
              let plist = try? PropertyListSerialization.propertyList(from: Data(text[start.lowerBound..<end.upperBound].utf8), format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any],
              let value = entitlements["aps-environment"] as? String else { return "development" }
        return value == "production" ? "production" : "development"
        #endif
    }()

    // The device token reaches the application delegate, which belongs to Tauri: add the two
    // callbacks to its class, then set the delegate again so UIKit sees them (it caches what the
    // delegate answers to when the delegate is set). UIApplication does not retain a delegate set
    // later, so the one UIApplicationMain created is kept here.
    private static var delegate: UIApplicationDelegate?
    private static func hookAppDelegate() {
        let app = UIApplication.shared
        guard PushHandler.delegate == nil, let delegate = app.delegate else { return }
        PushHandler.delegate = delegate
        let cls: AnyClass = type(of: delegate)
        let ok: @convention(block) (AnyObject, UIApplication, Data) -> Void = { _, _, token in PushHandler.shared?.registered(token) }
        let failed: @convention(block) (AnyObject, UIApplication, NSError) -> Void = { _, _, _ in PushHandler.shared?.registered(nil) }
        class_addMethod(cls, #selector(UIApplicationDelegate.application(_:didRegisterForRemoteNotificationsWithDeviceToken:)), imp_implementationWithBlock(ok), "v@:@@")
        class_addMethod(cls, #selector(UIApplicationDelegate.application(_:didFailToRegisterForRemoteNotificationsWithError:)), imp_implementationWithBlock(failed), "v@:@@")
        app.delegate = nil
        app.delegate = delegate
    }
}

// WebKit scrolled the page to reveal the focused box while the console put it back at the top
// (useKeyboardViewport), and the page sprang up and down; resizing the web view instead left the page
// blank while WebKit repainted, moved the content in one step ahead of the keyboard, and stranded menus
// opened from the composer; sending the keyboard's height on every frame made the page lay itself out
// on every frame, which a long conversation could not keep up with. So the web view keeps its size and
// is held at the top while a keyboard is up or moving, and the page is told once, as the keyboard starts
// to move, where it will end, whether it animates and when it started (`aio-keyboard` with `height`,
// `duration` and `start`); the page moves its content with the keyboard's own curve on the compositor,
// in step with it, and settles its layout at the end. WebKit keeps its own keyboard handling (it swaps
// the keyboard for the attachment menu, for one).
final class KeyboardFit: NSObject, WKScriptMessageHandler {
    private weak var webView: WKWebView?
    private var height: CGFloat = 0
    private var movingUntil = Date.distantPast
    /** The console asked to be held at the top for good (it never scrolls as a document); a new page load ends it. */
    private var hold = false
    static var shared: KeyboardFit?

    init(_ webView: WKWebView) {
        self.webView = webView
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(change(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        webView.scrollView.addObserver(self, forKeyPath: "contentOffset", options: [.new], context: nil)
        webView.addObserver(self, forKeyPath: "loading", options: [.new], context: nil)
        // A marker: the console follows `aio-keyboard` only when the app sends it. It also says "hold" once
        // it is up: WebKit scrolls to a focused box as soon as it is tapped, before the keyboard is announced.
        webView.configuration.userContentController.add(self, name: "aioKeyboard")
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        if message.body as? String == "hold" { hold = true }
        if message.body as? String == "release" { hold = false }
    }

    override func observeValue(forKeyPath keyPath: String?, of object: Any?, change: [NSKeyValueChangeKey: Any]?, context: UnsafeMutableRawPointer?) {
        if keyPath == "loading" {
            if webView?.isLoading == true { hold = false }
            return
        }
        guard hold || height > 0 || Date() < movingUntil, let scroll = webView?.scrollView, scroll.contentOffset != .zero else { return }
        scroll.contentOffset = .zero
    }

    @objc private func change(_ note: Notification) {
        guard let webView, let info = note.userInfo,
              let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let target = max(0, webView.bounds.height - webView.convert(end, from: nil).minY)
        let duration = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0
        let value = (target * 2).rounded() / 2
        movingUntil = Date().addingTimeInterval(max(duration, 0.6))
        guard value != height else { return }
        height = value
        // When the motion started (the page's clock), so a page that hears of it a frame or two late keeps pace.
        let start = Int(Date().timeIntervalSince1970 * 1000)
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('aio-keyboard',{detail:{height:\(value),duration:\(duration),start:\(start)}}))")
    }
}

@objc(AIODeviceBrowser)
final class DeviceBrowser: NSObject {
    @objc(installDeviceBrowser:)
    static func install(_ webView: WKWebView) {
        webView.configuration.userContentController.add(DeviceBrowserHandler(webView), name: "aioDeviceBrowser")
        webView.configuration.userContentController.add(SaveFilesMarker(), name: "aioSaveFiles")
        webView.configuration.userContentController.add(AppleSignInHandler(webView), name: "aioAppleSignIn")
        webView.configuration.userContentController.add(PushHandler(webView), name: "aioPush")
        KeyboardFit.shared = KeyboardFit(webView)
        // In the app the console does not zoom as a whole page (WKWebView, unlike Safari, honours the
        // limit); its image and remote-screen views handle pinching themselves. Run now as well, for a
        // page that loaded before the script was added.
        let noZoom = "document.querySelector('meta[name=viewport]')?.setAttribute('content','width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover')"
        webView.configuration.userContentController.addUserScript(WKUserScript(source: noZoom, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        webView.evaluateJavaScript(noZoom)
    }
}
