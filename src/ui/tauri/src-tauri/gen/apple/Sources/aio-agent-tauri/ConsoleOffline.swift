import Network
import UIKit
import WebKit

// Opening the app without a network. The console is a remote page, so with no connection the web view
// has nothing to show: this puts a native card over it that says so (the device is offline, or the
// server cannot be reached) and opens the console by itself as soon as it can. It replaces the service
// worker that kept the last console page: WKWebView runs service workers only with App-Bound Domains,
// which stop the agent's browser (AIBrowser.swift) from reading pages on other sites.

private func words(_ key: String) -> String {
    let lang = Locale.preferredLanguages.first ?? "en"
    let table: [String: [String]] = [
        // key: [en, zh-Hans, zh-Hant, ja, es], as auth.offline in the console's locales
        "title": ["Can't reach Clawpage Agent", "现在连不上一站", "現在連不上一站", "Clawpage Agent に接続できません", "No se puede conectar con Clawpage Agent"],
        "noNetwork": ["This device is offline. The app opens by itself once you're back online.", "这台设备没有联网。联网后会自动打开。", "這台裝置沒有連上網路。連上後會自動開啟。", "このデバイスはオフラインです。ネットワークにつながると自動で開きます。", "Este dispositivo no tiene conexión. La app se abrirá sola cuando vuelvas a estar en línea."],
        "unreachable": ["The server can't be reached right now. The app opens by itself once it's back.", "暂时连不上服务器，恢复后会自动打开。", "暫時連不上伺服器，恢復後會自動開啟。", "現在サーバーに接続できません。復旧すると自動で開きます。", "No se puede conectar con el servidor ahora. La app se abrirá sola cuando vuelva."],
        "retry": ["Try again", "重试", "重試", "再試行", "Reintentar"],
    ]
    let index = lang.hasPrefix("zh-Hant") || lang.hasPrefix("zh-TW") || lang.hasPrefix("zh-HK") ? 2 : lang.hasPrefix("zh") ? 1 : lang.hasPrefix("ja") ? 3 : lang.hasPrefix("es") ? 4 : 0
    return table[key]?[index] ?? key
}

@objc(AIOConsoleOffline)
final class ConsoleOffline: NSObject {
    private static var shared: ConsoleOffline?
    /** How often the console is tried again while the card shows and the device has a network. */
    private static let retrySeconds: TimeInterval = 8

    private weak var webView: WKWebView?
    private let home = URL(string: "https://\(consoleHost)")!
    private let monitor = NWPathMonitor()
    private var connected = true
    private var loading: NSKeyValueObservation?
    private var card: UIView?
    private let detail = UILabel()
    private var retry: Timer?

    @objc(installConsoleOffline:)
    static func install(_ webView: WKWebView) { shared = ConsoleOffline(webView) }

    private init(_ webView: WKWebView) {
        self.webView = webView
        super.init()
        // A load that ends with no page in the web view failed before anything arrived.
        loading = webView.observe(\.isLoading, options: [.old, .new]) { [weak self] _, change in
            if change.oldValue == true, change.newValue == false { DispatchQueue.main.async { self?.check() } }
        }
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                guard let self else { return }
                let was = self.connected
                self.connected = path.status == .satisfied
                self.detail.text = words(self.connected ? "unreachable" : "noNetwork")
                if self.connected, !was { self.open() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "aio.console-offline"))
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.open() }
        #if DEBUG
        // `-AIOConsoleFailFirst 1`: the first load goes nowhere, to see the card and the console coming back.
        if UserDefaults.standard.bool(forKey: "AIOConsoleFailFirst") {
            webView.stopLoading()
            webView.load(URLRequest(url: URL(string: "https://offline.invalid/")!))
        }
        #endif
    }

    private func check() {
        guard let webView, !webView.isLoading else { return }
        let scheme = webView.url?.scheme?.lowercased()
        if scheme == "https" || scheme == "http" { hide() } else { show() }
    }

    /** Try the console again; only while the card shows, so a page that is there is never reloaded. */
    private func open() {
        guard card != nil, connected, let webView, !webView.isLoading else { return }
        webView.load(URLRequest(url: home))
    }

    private func show() {
        guard card == nil, let webView, let host = webView.superview else { return }
        let card = UIView(frame: host.bounds)
        card.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        card.backgroundColor = .systemBackground
        let title = UILabel()
        title.text = words("title")
        title.font = .preferredFont(forTextStyle: .title3)
        detail.text = words(connected ? "unreachable" : "noNetwork")
        detail.font = .preferredFont(forTextStyle: .subheadline)
        detail.textColor = .secondaryLabel
        var config = UIButton.Configuration.tinted()
        config.title = words("retry")
        let button = UIButton(configuration: config, primaryAction: UIAction { [weak self] _ in self?.open() })
        let stack = UIStackView(arrangedSubviews: [title, detail, button])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.setCustomSpacing(20, after: detail)
        for label in [title, detail] { label.numberOfLines = 0; label.textAlignment = .center; label.adjustsFontForContentSizeCategory = true }
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: card.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -32),
        ])
        host.addSubview(card)
        self.card = card
        retry = Timer.scheduledTimer(withTimeInterval: ConsoleOffline.retrySeconds, repeats: true) { [weak self] _ in self?.open() }
    }

    private func hide() {
        retry?.invalidate()
        retry = nil
        card?.removeFromSuperview()
        card = nil
    }
}
