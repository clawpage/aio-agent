import UIKit
import WebKit

// The agent's own browser on this iPhone (docs/EXEC-ENVS.md, capability `browser`): a web view the agent
// drives through aio_env (browser_open, browser_read, …, answered by AgentEnvironment.swift), shown to the
// person as a small live window over the console that opens full screen, where they can watch, take over
// and hand back. It keeps its own sign-ins (a website data store of its own, apart from the console's).
//
// Paying, ordering, sending, deleting and signing in or authorizing are never done on the agent's word:
// such a click first asks the person here, and the call answers `needs_confirmation` (or `declined`)
// until they tap.

private func say(_ key: String) -> String {
    let lang = Locale.preferredLanguages.first ?? "en"
    let table: [String: [String]] = [
        // key: [en, zh-Hans, zh-Hant, ja, es]
        "title": ["AI browser", "AI 浏览器", "AI 瀏覽器", "AI ブラウザ", "Navegador de la IA"],
        "minimize": ["Minimize", "收起", "收起", "最小化", "Minimizar"],
        "close": ["Close", "关闭", "關閉", "閉じる", "Cerrar"],
        "done": ["Done, hand back to AI", "完成，交还给 AI", "完成，交還給 AI", "完了、AI に戻す", "Listo, devolver a la IA"],
        "asks": ["The AI asks you to:", "AI 请你操作：", "AI 請你操作：", "AI からの依頼：", "La IA te pide:"],
        "confirm.title": ["Allow the AI to do this?", "允许 AI 执行这一步吗？", "允許 AI 執行這一步嗎？", "AI にこの操作を許可しますか？", "¿Permitir que la IA haga esto?"],
        "confirm.allow": ["Allow", "允许", "允許", "許可", "Permitir"],
        "confirm.decline": ["Don't allow", "不允许", "不允許", "許可しない", "No permitir"],
    ]
    let index = lang.hasPrefix("zh-Hant") || lang.hasPrefix("zh-TW") || lang.hasPrefix("zh-HK") ? 2 : lang.hasPrefix("zh") ? 1 : lang.hasPrefix("ja") ? 3 : lang.hasPrefix("es") ? 4 : 0
    return table[key]?[index] ?? key
}

struct BrowserError: Error { let code: String; let message: String }

/** Words on a control that mean money, sending, deleting or signing in: the person confirms those on the phone. */
private let sensitive = try! NSRegularExpression(pattern: "\\b(pay|checkout|check out|(place|submit) (your )?order|buy now|purchase|subscribe|confirm (payment|order)|send|post|publish|delete|remove|sign in|log in|login|authori[sz]e|allow|grant|transfer)\\b|支付|付款|购买|購買|下单|下單|提交订单|提交訂單|立即购买|结算|結算|发送|發送|发布|發布|删除|刪除|移除|登录|登入|授权|授權|允许|允許|转账|轉帳|確認付款|确认付款", options: [.caseInsensitive])

/** How long a confirmation waits for the person; a debug build can shorten it for tests (`-AIOConfirmSeconds 3`). */
private var confirmSeconds: Double {
    #if DEBUG
    let seconds = UserDefaults.standard.double(forKey: "AIOConfirmSeconds")
    if seconds > 0 { return seconds }
    #endif
    return 90
}

final class AIBrowser: NSObject, WKNavigationDelegate {
    static let shared = AIBrowser()

    private(set) lazy var webView: WKWebView = {
        let config = WKWebViewConfiguration()
        // Its own cookies and storage, kept across launches, never the console's.
        if #available(iOS 17.0, *) {
            let key = "aio.aiBrowser.store"
            let id = UserDefaults.standard.string(forKey: key).flatMap(UUID.init(uuidString:)) ?? {
                let fresh = UUID(); UserDefaults.standard.set(fresh.uuidString, forKey: key); return fresh
            }()
            config.websiteDataStore = WKWebsiteDataStore(forIdentifier: id)
        }
        config.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        view.allowsBackForwardNavigationGestures = true
        return view
    }()

    private var loads: [(Result<Void, BrowserError>) -> Void] = []
    private lazy var panel = BrowserPanel(webView: webView)
    private var humanWait: ((Bool) -> Void)?

    // MARK: Tools (main queue; each answers once)

    func open(_ raw: String, _ done: @escaping (Result<[String: Any], BrowserError>) -> Void) {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            done(.failure(BrowserError(code: "invalid", message: "only http(s) addresses"))); return
        }
        panel.show(expanded: false)
        loads.append { result in
            switch result {
            case .success: done(.success(["url": self.webView.url?.absoluteString ?? raw, "title": self.webView.title ?? ""]))
            case .failure(let error): done(.failure(error))
            }
        }
        webView.load(URLRequest(url: url))
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in self?.finishLoads(.success(())) }
    }

    func read(_ done: @escaping (Result<[String: Any], BrowserError>) -> Void) {
        evaluate(AIBrowser.readScript) { value in
            guard let page = value as? [String: Any] else { done(.failure(BrowserError(code: "failed", message: "the page could not be read\(self.lastError.map { ": \($0)" } ?? "")"))); return }
            done(.success(page))
        }
    }

    func click(_ ref: String, _ done: @escaping (Result<[String: Any], BrowserError>) -> Void) {
        evaluate("(() => { const el = \(AIBrowser.find(ref)); if (!el) return null; const form = el.closest('form'); return { label: (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').trim().slice(0, 120), action: form ? (form.getAttribute('action') || '') : '' }; })()") { value in
            guard let target = value as? [String: Any] else { done(.failure(BrowserError(code: "not_found", message: "no element \(ref); read the page again"))); return }
            let label = target["label"] as? String ?? ""
            let action = target["action"] as? String ?? ""
            let press = {
                self.evaluate("(() => { const el = \(AIBrowser.find(ref)); if (!el) return false; el.scrollIntoView({block: 'center'}); el.click(); return true; })()") { clicked in
                    guard clicked as? Bool == true else { done(.failure(BrowserError(code: "not_found", message: "no element \(ref)"))); return }
                    // A click that leads to another page answers once that page is there, so the next read is of it.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                        let answer = { done(.success(["clicked": ref, "url": self.webView.url?.absoluteString ?? ""])) }
                        guard self.navigating else { answer(); return }
                        self.loads.append { _ in answer() }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in self?.finishLoads(.success(())) }
                    }
                }
            }
            let text = "\(label) \(action)"
            guard sensitive.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil else { press(); return }
            let site = self.webView.url?.host ?? ""
            self.confirm("\(label.isEmpty ? ref : "“\(label)”") — \(site)") { allowed in
                switch allowed {
                case true?: press()
                case false?: done(.failure(BrowserError(code: "declined", message: label)))
                case nil: done(.failure(BrowserError(code: "needs_confirmation", message: "\(label.isEmpty ? ref : label) on \(site)")))
                }
            }
        }
    }

    func type(_ ref: String, _ text: String, submit: Bool, _ done: @escaping (Result<[String: Any], BrowserError>) -> Void) {
        let script = """
        (() => {
          const el = \(AIBrowser.find(ref));
          if (!el) return 'missing';
          if ((el.type || '').toLowerCase() === 'password') return 'password';
          el.focus();
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value');
          if (el.isContentEditable) el.textContent = \(AIBrowser.quote(text)); else if (setter && setter.set) setter.set.call(el, \(AIBrowser.quote(text))); else el.value = \(AIBrowser.quote(text));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          if (\(submit ? "true" : "false")) {
            const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
            el.dispatchEvent(new KeyboardEvent('keydown', opts)); el.dispatchEvent(new KeyboardEvent('keyup', opts));
            if (el.form) { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); }
          }
          return 'ok';
        })()
        """
        evaluate(script) { value in
            switch value as? String {
            case "ok": done(.success(["typed": ref]))
            case "password": done(.failure(BrowserError(code: "invalid", message: "passwords are typed by the user: ask them with browser_request_human")))
            default: done(.failure(BrowserError(code: "not_found", message: "no field \(ref); read the page again")))
            }
        }
    }

    func scroll(_ direction: String, _ done: @escaping (Result<[String: Any], BrowserError>) -> Void) {
        evaluate("window.scrollBy(0, \(direction == "up" ? "-" : "")Math.round(window.innerHeight * 0.8)); window.scrollY") { value in
            done(.success(["scrollY": value as? Double ?? 0]))
        }
    }

    func back(_ done: @escaping (Result<[String: Any], BrowserError>) -> Void) {
        guard webView.canGoBack else { done(.failure(BrowserError(code: "invalid", message: "no page to go back to"))); return }
        loads.append { _ in done(.success(["url": self.webView.url?.absoluteString ?? "", "title": self.webView.title ?? ""])) }
        webView.goBack()
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in self?.finishLoads(.success(())) }
    }

    func screenshot(_ done: @escaping (Result<[String: Any], BrowserError>) -> Void) {
        guard webView.url != nil else { done(.failure(BrowserError(code: "invalid", message: "no page is open; use browser_open first"))); return }
        let config = WKSnapshotConfiguration()
        config.snapshotWidth = NSNumber(value: Double(min(webView.bounds.width > 0 ? webView.bounds.width : 390, 430)))
        webView.takeSnapshot(with: config) { image, _ in
            guard let png = image?.pngData() else { done(.failure(BrowserError(code: "failed", message: "no picture"))); return }
            done(.success(["image": png.base64EncodedString(), "mimeType": "image/png"]))
        }
    }

    /** The person does a step themselves: the browser opens full screen with the agent's reason, until they hand it back. */
    func requestHuman(_ reason: String, _ done: @escaping (Result<[String: Any], BrowserError>) -> Void) {
        humanWait?(false)
        panel.show(expanded: true, ask: reason) { [weak self] in self?.humanWait?(true) }
        var answered = false
        humanWait = { [weak self] handedBack in
            guard !answered else { return }
            answered = true
            self?.humanWait = nil
            done(handedBack ? .success(["handedBack": true, "url": self?.webView.url?.absoluteString ?? ""]) : .failure(BrowserError(code: "busy", message: "another request took its place")))
        }
        // The agent's call ends after 10 minutes; the person can still hand back later by asking again.
        DispatchQueue.main.asyncAfter(deadline: .now() + 600) { [weak self] in
            guard !answered else { return }
            answered = true
            self?.humanWait = nil
            done(.failure(BrowserError(code: "needs_confirmation", message: "still waiting for the user to finish in the browser")))
        }
    }

    // MARK: Helpers

    /** Asks the person on the phone; nil when nobody answers in time (90 s; the alert goes away). */
    private func confirm(_ what: String, _ answer: @escaping (Bool?) -> Void) {
        panel.show(expanded: true)
        let alert = UIAlertController(title: say("confirm.title"), message: what, preferredStyle: .alert)
        var answered = false
        let finish = { (value: Bool?) in guard !answered else { return }; answered = true; answer(value) }
        alert.addAction(UIAlertAction(title: say("confirm.decline"), style: .cancel) { _ in finish(false) })
        alert.addAction(UIAlertAction(title: say("confirm.allow"), style: .default) { _ in finish(true) })
        guard let top = BrowserPanel.topController() else { finish(nil); return }
        top.present(alert, animated: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + confirmSeconds) {
            guard !answered else { return }
            alert.dismiss(animated: true)
            finish(nil)
        }
    }

    /** What the last script failed with, for the agent's message. */
    private var lastError: String?

    /**
     * The agent's scripts run in a world of their own: they see the page's document, while the page sees
     * none of their code, globals or element refs, so a site cannot tell it is being read.
     */
    private static let world = WKContentWorld.world(name: "aio")

    private func evaluate(_ script: String, _ done: @escaping (Any?) -> Void) {
        webView.evaluateJavaScript(script, in: nil, in: AIBrowser.world) { [weak self] result in
            switch result {
            case .success(let value):
                self?.lastError = nil
                done(value is NSNull ? nil : value)
            case .failure(let error):
                self?.lastError = (error as NSError).localizedDescription
                trace("script failed: \((error as NSError).domain) \((error as NSError).code) \(error.localizedDescription)")
                done(nil)
            }
        }
    }

    /** The element a ref from the last read names, while it is still in the page. */
    private static func find(_ ref: String) -> String {
        "(e => e && e.isConnected ? e : null)(globalThis.__aio ? globalThis.__aio.byRef.get(\(quote(ref))) : null)"
    }

    /** The page is on its way to another one (allowed, not there yet). */
    private var navigating = false

    private func finishLoads(_ result: Result<Void, BrowserError>) {
        navigating = false
        let waiting = loads
        loads = []
        waiting.forEach { $0(result) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finishLoads(.success(())) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finishLoads(.failure(BrowserError(code: "failed", message: error.localizedDescription))) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finishLoads(.failure(BrowserError(code: "failed", message: error.localizedDescription))) }

    /** Only web pages: no app links, files or other schemes from what the agent opens. */
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let scheme = action.request.url?.scheme?.lowercased() ?? ""
        let allowed = ["http", "https", "about", "blob", "data"].contains(scheme)
        if allowed, action.targetFrame?.isMainFrame == true { navigating = true }
        decisionHandler(allowed ? .allow : .cancel)
    }

    static func quote(_ text: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [text]), let array = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(array.dropFirst().dropLast())
    }

    /** The page's text and its controls, each with a ref for click and type. Refs live in the agent's world, not on the page. */
    static let readScript = """
    (() => {
      const pick = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [onclick], [contenteditable=true]';
      const aio = globalThis.__aio || (globalThis.__aio = { byRef: new Map(), byEl: new WeakMap(), n: 0 });
      aio.byRef.clear();
      const seen = [];
      for (const el of document.querySelectorAll(pick)) {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width < 2 || r.height < 2 || style.visibility === 'hidden' || style.display === 'none') continue;
        let ref = aio.byEl.get(el);
        if (!ref) aio.byEl.set(el, ref = 'e' + (++aio.n));
        aio.byRef.set(ref, el);
        const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || '').replace(/\\s+/g, ' ').trim().slice(0, 100);
        const role = el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'INPUT' ? (el.type || 'text') : el.tagName.toLowerCase());
        seen.push({ ref, role, name, ...(el.tagName === 'A' ? { href: el.href.slice(0, 200) } : {}) });
        if (seen.length >= 200) break;
      }
      const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 20000);
      return { url: location.href, title: document.title, text, elements: seen };
    })()
    """
}

/**
 * The browser as the person sees it: a small live window over the console, or full screen. The page keeps
 * the phone's full size either way (the small window shows it scaled down), so what the agent reads and
 * pictures does not change with it.
 */
/** The console's colors (`src/ui/src/theme.css`): dark and light, by the system's appearance. */
private enum Theme {
    private static func pair(_ dark: UInt32, _ light: UInt32) -> UIColor {
        UIColor { traits in
            let hex = traits.userInterfaceStyle == .light ? light : dark
            return UIColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
        }
    }
    static let surface = pair(0x1a1823, 0xffffff)
    static let border = pair(0x2d2939, 0xe6e3ee)
    static let text = pair(0xecebf3, 0x1d1b26)
    static let textDim = pair(0x9d98ae, 0x6b6878)
    /** Indigo: the AI is working. */
    static let ai = pair(0x8f86ff, 0x5a4fe0)
    /** Amber: the person's turn. */
    static let you = pair(0xffb547, 0xa15f00)
    static let youSoft = pair(0x3a2c16, 0xfff3df)
    static let onYou = pair(0x1b1200, 0xffffff)
}

private final class BrowserPanel: UIView {
    private let webView: WKWebView
    private let holder = UIView()
    private let bar = UIStackView()
    private let barLine = UIView()
    private let dot = UIView()
    private let askBox = UIView()
    private let banner = UILabel()
    private let doneBox = UIView()
    private let doneButton = UIButton(type: .system)
    private var expanded = false
    private var onDone: (() -> Void)?
    private var hideTimer: Timer?

    init(webView: WKWebView) {
        self.webView = webView
        super.init(frame: .zero)
        backgroundColor = Theme.surface
        layer.cornerRadius = 14
        layer.borderWidth = 1.5
        clipsToBounds = true

        // The dot says whose turn it is, as the console does: indigo while the AI works, amber when it asks.
        dot.layer.cornerRadius = 4
        dot.widthAnchor.constraint(equalToConstant: 8).isActive = true
        dot.heightAnchor.constraint(equalToConstant: 8).isActive = true
        let title = UILabel()
        title.text = say("title")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.textColor = Theme.text
        let icon = { (name: String, label: String, then: @escaping () -> Void) -> UIButton in
            let button = UIButton(type: .system)
            button.setImage(UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .medium)), for: .normal)
            button.tintColor = Theme.textDim
            button.accessibilityLabel = label
            button.widthAnchor.constraint(equalToConstant: 40).isActive = true
            button.addAction(UIAction { _ in then() }, for: .touchUpInside)
            return button
        }
        bar.axis = .horizontal
        bar.alignment = .center
        bar.spacing = 8
        bar.layoutMargins = UIEdgeInsets(top: 0, left: 16, bottom: 0, right: 6)
        bar.isLayoutMarginsRelativeArrangement = true
        bar.addArrangedSubview(dot)
        bar.addArrangedSubview(title)
        bar.addArrangedSubview(UIView())
        bar.addArrangedSubview(icon("chevron.down", say("minimize")) { [weak self] in self?.show(expanded: false) })
        bar.addArrangedSubview(icon("xmark", say("close")) { [weak self] in self?.removeFromSuperview() })
        barLine.backgroundColor = Theme.border

        // Two lines of what is asked, so the page keeps the screen; a tap shows all of it.
        banner.numberOfLines = 2
        banner.isUserInteractionEnabled = true
        banner.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(askTapped)))
        banner.font = .preferredFont(forTextStyle: .footnote)
        banner.textColor = Theme.text
        askBox.backgroundColor = Theme.youSoft
        askBox.addSubview(banner)
        // The person's turn: the one filled amber control on the screen.
        doneButton.setTitle(say("done"), for: .normal)
        doneButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        doneButton.setTitleColor(Theme.onYou, for: .normal)
        doneButton.backgroundColor = Theme.you
        doneButton.layer.cornerRadius = 12
        doneBox.backgroundColor = Theme.surface
        doneBox.addSubview(doneButton)
        // Handed back: the agent carries on, so the browser goes back to the small window and the console is in front again.
        doneButton.addAction(UIAction { [weak self] _ in let done = self?.onDone; self?.onDone = nil; self?.setAsk(nil); self?.show(expanded: false); done?() }, for: .touchUpInside)

        holder.clipsToBounds = true
        webView.layer.anchorPoint = .zero
        holder.addSubview(webView)
        [bar, barLine, askBox, holder, doneBox].forEach(addSubview)
        setAsk(nil)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
    }

    required init?(coder: NSCoder) { nil }

    /** The app's window: the key one, or (before any is key, as right after launch) the first on screen. */
    static func appWindow() -> UIWindow? {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        return windows.first { $0.isKeyWindow } ?? windows.first { !$0.isHidden }
    }

    static func topController() -> UIViewController? {
        var top = appWindow()?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }

    private func setAsk(_ reason: String?) {
        banner.text = reason.map { "\(say("asks")) \($0)" }
        banner.numberOfLines = 2
        askBox.isHidden = reason == nil
        doneBox.isHidden = reason == nil
        tint()
        setNeedsLayout()
    }

    private func tint() {
        let turn = askBox.isHidden ? Theme.ai : Theme.you
        dot.backgroundColor = turn
        layer.borderColor = turn.resolvedColor(with: traitCollection).cgColor
    }

    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        tint()
    }

    @objc private func tapped() { if !expanded { show(expanded: true) } }

    @objc private func askTapped() { banner.numberOfLines = banner.numberOfLines == 0 ? 2 : 0; setNeedsLayout() }

    /** The page's own size: the screen's under the status bar, less the panel's bar. */
    private var pageSize: CGSize {
        let window = self.window ?? superview
        let bounds = window?.bounds ?? UIScreen.main.bounds
        let safe = window?.safeAreaInsets ?? .zero
        return CGSize(width: bounds.width, height: bounds.height - safe.top - 44)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        var y: CGFloat = 0
        bar.isHidden = !expanded
        barLine.isHidden = !expanded
        if expanded {
            bar.frame = CGRect(x: 0, y: 0, width: bounds.width, height: 44)
            barLine.frame = CGRect(x: 0, y: 44 - 1 / UIScreen.main.scale, width: bounds.width, height: 1 / UIScreen.main.scale)
            y = 44
        }
        let showAsk = expanded && !askBox.isHidden
        askBox.alpha = showAsk ? 1 : 0
        if showAsk {
            let height = banner.sizeThatFits(CGSize(width: bounds.width - 32, height: .greatestFiniteMagnitude)).height
            banner.frame = CGRect(x: 16, y: 10, width: bounds.width - 32, height: height)
            askBox.frame = CGRect(x: 0, y: y, width: bounds.width, height: height + 20)
            y += height + 20
        }
        // The button sits above the home indicator.
        let showDone = expanded && !doneBox.isHidden
        let bottom: CGFloat = showDone ? 68 + (window?.safeAreaInsets.bottom ?? 0) : 0
        doneBox.alpha = showDone ? 1 : 0
        doneBox.frame = CGRect(x: 0, y: bounds.height - bottom, width: bounds.width, height: bottom)
        doneButton.frame = CGRect(x: 16, y: 10, width: bounds.width - 32, height: 48)
        holder.frame = CGRect(x: 0, y: y, width: bounds.width, height: bounds.height - y - bottom)
        let page = pageSize
        webView.transform = .identity
        webView.frame = CGRect(origin: .zero, size: expanded ? holder.bounds.size : page)
        if !expanded { webView.transform = CGAffineTransform(scaleX: holder.bounds.width / page.width, y: holder.bounds.width / page.width) }
        webView.layer.position = .zero
        webView.isUserInteractionEnabled = expanded
    }

    func show(expanded: Bool, ask: String? = nil, onDone: (() -> Void)? = nil) {
        guard let window = BrowserPanel.appWindow() else { return }
        if superview !== window { window.addSubview(self) }
        window.bringSubviewToFront(self)
        self.expanded = expanded
        if let ask { setAsk(ask); self.onDone = onDone }
        let safe = window.safeAreaInsets
        let bounds = window.bounds
        UIView.animate(withDuration: 0.25) {
            // The whole screen under the status bar, or a live thumbnail of the page at the top right, under the console's header.
            self.frame = expanded
                ? CGRect(x: 0, y: safe.top, width: bounds.width, height: bounds.height - safe.top)
                : CGRect(x: bounds.width - 128 - 12, y: safe.top + 52, width: 128, height: 220)
            self.layer.cornerRadius = expanded ? 0 : 14
            self.layer.borderWidth = expanded ? 0 : 1.5
            self.layoutIfNeeded()
        }
        // Out of the way once the agent has not used it for a while.
        hideTimer?.invalidate()
        if !expanded { hideTimer = Timer.scheduledTimer(withTimeInterval: 180, repeats: false) { [weak self] _ in self?.removeFromSuperview() } }
    }
}
