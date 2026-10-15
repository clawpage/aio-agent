import UIKit
import WebKit
import SafariServices
import AuthenticationServices

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

// A marker, not an operation: the console sees it and saves files through the share sheet,
// because this shell declares the Photos permission behind its "Save Image" (Info.plist).
// WKWebView ignores download links, and an older shell would be closed by iOS on that tap.
private final class SaveFilesMarker: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {}
}

@objc(AIODeviceBrowser)
final class DeviceBrowser: NSObject {
    @objc(installDeviceBrowser:)
    static func install(_ webView: WKWebView) {
        webView.configuration.userContentController.add(DeviceBrowserHandler(webView), name: "aioDeviceBrowser")
        webView.configuration.userContentController.add(SaveFilesMarker(), name: "aioSaveFiles")
    }
}
