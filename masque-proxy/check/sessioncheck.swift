// 同じ中継型のプロキシの設定を、同じプロセスの URLSession に使わせて URL を開く。
import Foundation
import Network

let args = CommandLine.arguments
let h3Port = UInt16(args[1])!
let h2Port = UInt16(args[2])!
let certificate = try! Data(contentsOf: URL(fileURLWithPath: args[3]))
let tls = NWProtocolTLS.Options()
sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
    let secTrust = sec_trust_copy_ref(trust).takeRetainedValue()
    let chain = (SecTrustCopyCertificateChain(secTrust) as? [SecCertificate]) ?? []
    let leaf = chain.first.map { SecCertificateCopyData($0) as Data }
    print("-- verify relay: match=\(leaf == certificate)")
    complete(leaf == certificate)
}, DispatchQueue.global())
let hop = ProxyConfiguration.RelayHop(
    http3RelayEndpoint: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: h3Port)!),
    http2RelayEndpoint: h2Port == 0 ? nil : .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: h2Port)!),
    tlsOptions: tls)
let config = URLSessionConfiguration.ephemeral
config.proxyConfigurations = [ProxyConfiguration(relayHops: [hop])]
let session = URLSession(configuration: config)
for url in args[4...] {
    let sem = DispatchSemaphore(value: 0)
    var req = URLRequest(url: URL(string: url)!)
    req.assumesHTTP3Capable = ProcessInfo.processInfo.environment["H3"] != nil
    session.dataTask(with: req) { data, resp, err in
        print("== \(url) status=\((resp as? HTTPURLResponse)?.statusCode ?? -1) final=\(resp?.url?.absoluteString ?? "-") err=\(String(describing: err))")
        if let data, let s = String(data: data, encoding: .utf8) { print(String(s.prefix(400))) }
        sem.signal()
    }.resume()
    sem.wait()
}
