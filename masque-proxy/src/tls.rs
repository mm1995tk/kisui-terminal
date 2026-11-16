//! プロキシの TLS の身元。既定では起動のたびに自己署名の証明書を作る。
//! 確かめるときのために、固定のファイル（証明書と鍵、どちらも DER）に書き出し、読み込むこともできる。

use std::io;
use std::net::IpAddr;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

/// 証明書の有効な長さ。macOS は、TLS のサーバーの証明書で有効な長さが 825 日を超えるものを信頼しない。
const VALIDITY: Duration = Duration::from_secs(30 * 24 * 60 * 60);

pub(crate) struct Identity {
    pub(crate) certificate_der: Vec<u8>,
    key_der: Vec<u8>,
}

impl Identity {
    /// `localhost`・`127.0.0.1`・`::1`（と `listen_ip`）の、自己署名の証明書を作る。
    /// CA ではなく、用途は TLS のサーバーだけ。有効な長さは今から 30 日。
    pub(crate) fn generate(listen_ip: IpAddr) -> io::Result<Identity> {
        let mut names = vec![
            "localhost".to_string(),
            "127.0.0.1".to_string(),
            "::1".to_string(),
        ];
        if !names.contains(&listen_ip.to_string()) {
            names.push(listen_ip.to_string());
        }
        let mut params = rcgen::CertificateParams::new(names).map_err(io::Error::other)?;
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "masque-proxy (localhost)");
        params.is_ca = rcgen::IsCa::ExplicitNoCa;
        params.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        let now = rcgen::date_time_ymd(1970, 1, 1)
            + SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(io::Error::other)?;
        params.not_before = now - Duration::from_secs(60 * 60);
        params.not_after = now + VALIDITY;
        let key = rcgen::KeyPair::generate().map_err(io::Error::other)?;
        let cert = params.self_signed(&key).map_err(io::Error::other)?;
        Ok(Identity {
            certificate_der: cert.der().to_vec(),
            key_der: key.serialize_der(),
        })
    }

    /// `write` で書いた証明書と鍵を読む。
    pub(crate) fn read(cert: &Path, key: &Path) -> io::Result<Identity> {
        Ok(Identity {
            certificate_der: std::fs::read(cert)?,
            key_der: std::fs::read(key)?,
        })
    }

    /// 証明書と鍵（PKCS#8）を DER で書く。鍵は持ち主だけが読めるようにする。
    /// 鍵のファイルがすでにあれば消してから作る。権限（mode）は新しく作るときにしか付かず、
    /// 広い権限のファイルに書くと、その権限が残るため。
    pub(crate) fn write(&self, cert: &Path, key: &Path) -> io::Result<()> {
        std::fs::write(cert, &self.certificate_der)?;
        match std::fs::remove_file(key) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        io::Write::write_all(&mut options.open(key)?, &self.key_der)
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn key_is_owner_only_even_if_the_file_existed() {
        let dir = std::env::temp_dir().join(format!("masque-proxy-tls-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (cert, key) = (dir.join("cert.der"), dir.join("key.der"));
        std::fs::write(&key, b"old").unwrap();
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();

        let identity = Identity::generate(IpAddr::from([127, 0, 0, 1])).unwrap();
        identity.write(&cert, &key).unwrap();
        let mode = std::fs::metadata(&key).unwrap().permissions().mode() & 0o777;
        let read = Identity::read(&cert, &key).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();

        assert_eq!(mode, 0o600);
        assert_eq!(read.key_der, identity.key_der);
        assert_eq!(read.certificate_der, identity.certificate_der);
    }
}
