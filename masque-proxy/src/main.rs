//! 中継型のプロキシを 1 つ立てて待つ。確かめるときに使う。
//!
//! ```text
//! masque-proxy [--listen IP] [--h3-port N] [--h2-port N] [--dns IP]... [--cert-out PATH] [--quiet]
//! ```
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
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or(format!("{arg}: value is missing"));
        match arg.as_str() {
            "--listen" => config.listen_ip = value()?.parse()?,
            "--h3-port" => config.h3_port = value()?.parse()?,
            "--h2-port" => config.h2_port = value()?.parse()?,
            "--dns" => dns.push(value()?.parse()?),
            "--cert-out" => cert_out = Some(value()?),
            "--quiet" => config.log = false,
            _ => return Err(format!("unknown argument: {arg}").into()),
        }
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
