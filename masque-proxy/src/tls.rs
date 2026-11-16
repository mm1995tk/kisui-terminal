//! プロキシの TLS の身元。起動のたびに自己署名の証明書を作る。

use std::io;
use std::net::IpAddr;

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

pub(crate) struct Identity {
    pub(crate) certificate_der: Vec<u8>,
    key_der: Vec<u8>,
}

impl Identity {
    pub(crate) fn generate(listen_ip: IpAddr) -> io::Result<Identity> {
        let names = vec![
            "localhost".to_string(),
            "127.0.0.1".to_string(),
            "::1".to_string(),
            listen_ip.to_string(),
        ];
        let key = rcgen::generate_simple_self_signed(names).map_err(io::Error::other)?;
        Ok(Identity {
            certificate_der: key.cert.der().to_vec(),
            key_der: key.signing_key.serialize_der(),
        })
    }

    /// ALPN を `alpn` にした、TLS 1.3 の rustls の設定。
    pub(crate) fn server_config(&self, alpn: &[u8]) -> io::Result<rustls::ServerConfig> {
        let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
        let mut config = rustls::ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(io::Error::other)?
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(self.certificate_der.clone())],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key_der.clone())),
            )
            .map_err(io::Error::other)?;
        config.alpn_protocols = vec![alpn.to_vec()];
        Ok(config)
    }
}
