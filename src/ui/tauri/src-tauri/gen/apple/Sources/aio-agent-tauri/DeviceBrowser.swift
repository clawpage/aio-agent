import UIKit
import WebKit
import SafariServices

// This bridge grants one operation to the main console frame, not Tauri IPC.
private final class DeviceBrowserHandler: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    init(_ webView: WKWebView) { self.webView = webView }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "https",
              origin.host == "agent.clawpage.ai", origin.port == 443 || origin.port == 0,
              let address = message.body as? String, let url = URL(string: address),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
              var presenter = webView?.window?.rootViewController else { return }
        while let next = presenter.presentedViewController { presenter = next }
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
}

@objc(AIODeviceBrowser)
final class DeviceBrowser: NSObject {
    @objc(installDeviceBrowser:)
    static func install(_ webView: WKWebView) {
        webView.configuration.userContentController.add(DeviceBrowserHandler(webView), name: "aioDeviceBrowser")
    }
}
