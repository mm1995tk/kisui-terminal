//! 中継型のプロキシを 1 つ立てて待つ。確かめるときに使う。
//!
//! ```text
//! masque-proxy [--listen IP] [--h3-port N] [--h2-port N] [--dns IP]... [--cert PATH --key PATH] [--cert-out PATH] [--quiet]
//! masque-proxy gen-cert CERT_PATH KEY_PATH
//! ```
//!
//! `gen-cert` は、`localhost`・`127.0.0.1`・`::1` の自己署名の証明書と鍵を DER で書いて終わる。
//! `--cert` と `--key` を渡すと、その証明書でプロキシを起動する（渡さなければ起動のたびに作る）。
//!
//! 立ち上がると、待ち受けているアドレスを標準出力に 1 行ずつ出す（`h3 127.0.0.1:PORT` と `h2 127.0.0.1:PORT`）。
//! `--cert-out` には、プロキシの自己署名の証明書（DER）を書く。使う側はこれと一致するかで信頼する。

use std::net::IpAddr;
use std::process::ExitCode;

use masque_proxy::{Config, Dns, Proxy};

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("masque-proxy: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut config = Config {
        log: true,
        ..Config::default()
    };
    let mut dns: Vec<IpAddr> = vec![];
    let mut cert_out = None;
    let mut args = std::env::args().skip(1).peekable();
    if args.peek().map(String::as_str) == Some("gen-cert") {
        args.next();
        let (Some(cert), Some(key), None) = (args.next(), args.next(), args.next()) else {
            return Err("usage: masque-proxy gen-cert CERT_PATH KEY_PATH".into());
        };
        masque_proxy::write_certificate(cert.as_ref(), key.as_ref())?;
        return Ok(());
    }
    let mut cert = None;
    let mut key = None;
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or(format!("{arg}: value is missing"));
        match arg.as_str() {
            "--listen" => config.listen_ip = value()?.parse()?,
            "--h3-port" => config.h3_port = value()?.parse()?,
            "--h2-port" => config.h2_port = value()?.parse()?,
            "--dns" => dns.push(value()?.parse()?),
            "--cert" => cert = Some(value()?),
            "--key" => key = Some(value()?),
            "--cert-out" => cert_out = Some(value()?),
            "--quiet" => config.log = false,
            _ => return Err(format!("unknown argument: {arg}").into()),
        }
    }
    match (cert, key) {
        (Some(cert), Some(key)) => config.identity_files = Some((cert.into(), key.into())),
        (None, None) => {}
        _ => return Err("--cert and --key go together".into()),
    }
    if !dns.is_empty() {
        config.dns = Dns::Servers(dns);
    }
    let proxy = Proxy::start(config).await?;
    if let Some(path) = cert_out {
        std::fs::write(path, proxy.certificate_der())?;
    }
    println!("h3 {}", proxy.h3_addr());
    println!("h2 {}", proxy.h2_addr());
    tokio::signal::ctrl_c().await?;
    Ok(())
}
