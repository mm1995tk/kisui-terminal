// 中継型のプロキシ（nw_relay_hop_create）を設定した WKWebView で URL を順に開き、
// 開けた URL と本文を標準出力に出す。
// 使い方: relaycheck <h3 port> <h2 port | 0> <証明書(DER)のパス> <URL | wait:<秒>>...
// 環境変数: STORE_ID（永続のデータストアの UUID）、TIMEOUT（全体の秒数。既定 60）
// プロキシの名前は既定で localhost（環境変数 RELAY_HOST で変えられる）。
// WKWebView では relay_tls_options の検証の block が効かないので、プロキシの証明書は OS に信頼させておく。
import Cocoa
import Network
import WebKit

let args = CommandLine.arguments
let h3Port = UInt16(args[1])!
let h2Port = UInt16(args[2])!
let certificate = try! Data(contentsOf: URL(fileURLWithPath: args[3]))
var queue = Array(args[4...])

let tls = NWProtocolTLS.Options()
if ProcessInfo.processInfo.environment["NOAUTH"] != nil { sec_protocol_options_set_peer_authentication_required(tls.securityProtocolOptions, false) }
sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
    let secTrust = sec_trust_copy_ref(trust).takeRetainedValue()
    let chain = (SecTrustCopyCertificateChain(secTrust) as? [SecCertificate]) ?? []
    let leaf = chain.first.map { SecCertificateCopyData($0) as Data }
    print("-- verify relay: chain=\(chain.count) match=\(leaf == certificate)")
    complete(leaf == certificate)
}, DispatchQueue.main)

let relayHost = ProcessInfo.processInfo.environment["RELAY_HOST"] ?? "localhost"
func endpoint(_ port: UInt16) -> NWEndpoint? {
    port == 0 ? nil : .hostPort(host: NWEndpoint.Host(relayHost), port: NWEndpoint.Port(rawValue: port)!)
}
let hop = ProxyConfiguration.RelayHop(
    http3RelayEndpoint: endpoint(h3Port)!,
    http2RelayEndpoint: endpoint(h2Port),
    tlsOptions: tls)
// STORE_ID（UUID）を渡すと、その識別子の永続のデータストアを使う。プロセスをまたいで Alt-Svc を覚えさせ、
// 次のプロセスでは新しい接続で開くため。渡さなければ、使い捨てのデータストア。
let storeID = ProcessInfo.processInfo.environment["STORE_ID"].flatMap { UUID(uuidString: $0) }
let store = storeID.map { WKWebsiteDataStore(forIdentifier: $0) } ?? WKWebsiteDataStore.nonPersistent()
store.proxyConfigurations = [ProxyConfiguration(relayHops: [hop])]

final class Delegate: NSObject, WKNavigationDelegate {
    func next(_ web: WKWebView) {
        if queue.isEmpty { exit(0) }
        let url = queue.removeFirst()
        // `wait:<秒>` は、次の URL を開く前に待つ（使っていない接続が閉じるのを待つため）。
        if url.hasPrefix("wait:"), let seconds = Double(url.dropFirst(5)) {
            print("== wait \(seconds)s")
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { self.next(web) }
            return
        }
        print("== load \(url)")
        web.load(URLRequest(url: URL(string: url)!))
    }
    func webView(_ web: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        var leafMatches = false
        if let trust = space.serverTrust,
           let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first {
            leafMatches = (SecCertificateCopyData(leaf) as Data) == certificate
        }
        print("-- challenge host=\(space.host) port=\(space.port) method=\(space.authenticationMethod) proxy=\(space.isProxy()) leafIsRelay=\(leafMatches)")
        if leafMatches, let trust = space.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
    func webView(_ web: WKWebView, didFinish _: WKNavigation!) {
        web.evaluateJavaScript("document.body ? document.body.innerText.slice(0, 600) : ''") { body, _ in
            print("-- finished \(web.url?.absoluteString ?? "?")")
            print(body as? String ?? "")
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.next(web) }
        }
    }
    func webView(_ web: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError error: Error) {
        print("-- failed \(error)")
        next(web)
    }
    func webView(_ web: WKWebView, didFail _: WKNavigation!, withError error: Error) {
        print("-- failed \(error)")
        next(web)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let config = WKWebViewConfiguration()
config.websiteDataStore = store
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: config)
let window = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
window.contentView = web
let delegate = Delegate()
web.navigationDelegate = delegate
let timeout = Double(ProcessInfo.processInfo.environment["TIMEOUT"] ?? "") ?? 60
DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { print("-- timeout"); exit(2) }
delegate.next(web)
app.run()
