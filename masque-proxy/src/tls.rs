//! プロキシの TLS の身元（自己署名の証明書と鍵）。既定では起動のたびに作る。
//! 使う側が作って覚えておいたもの（`Identity::generate` と `Identity::from_der`）を渡すこともでき、
//! 確かめるときのために、固定のファイル（証明書と鍵、どちらも DER）に書き出し、読み込むこともできる。

use std::fmt;
use std::io;
use std::net::IpAddr;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

/// 起動のたびに作る証明書の有効な長さ。macOS は、TLS のサーバーの証明書で有効な長さが 825 日を超えるものを信頼しない。
const VALIDITY: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// 起動のたびに作る証明書の名前（CN）。
const COMMON_NAME: &str = "masque-proxy (localhost)";

/// プロキシの TLS の身元。自己署名の証明書（DER）と、その鍵（PKCS#8 の DER）。
#[derive(Clone)]
pub struct Identity {
    pub(crate) certificate_der: Vec<u8>,
    key_der: Vec<u8>,
}

// 鍵は出さない
impl fmt::Debug for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Identity")
            .field("certificate_der", &self.certificate_der.len())
            .finish_non_exhaustive()
    }
}

impl Identity {
    /// `localhost`・`127.0.0.1`・`::1` の、自己署名の証明書と鍵を作る。名前（CN）は `common_name`。
    /// CA ではなく、用途は TLS のサーバーだけ。有効な長さは、今の 1 時間前から、今から `validity` まで。
    /// 使う側が覚えておき（`certificate_der`・`key_der`）、次の起動で `from_der` から渡すため。
    pub fn generate(common_name: &str, validity: Duration) -> io::Result<Identity> {
        Self::generate_for(None, common_name, validity)
    }

    /// 覚えておいた証明書（DER）と鍵（PKCS#8 の DER）から作る。合っているかは、プロキシを起動するときに確かめる。
    pub fn from_der(certificate_der: Vec<u8>, key_der: Vec<u8>) -> Identity {
        Identity {
            certificate_der,
            key_der,
        }
    }

    /// 証明書（DER）。
    pub fn certificate_der(&self) -> &[u8] {
        &self.certificate_der
    }

    /// 鍵（PKCS#8 の DER）。覚えておくときは、ファイルに平文で置かない（使う側の決まり）。
    pub fn key_der(&self) -> &[u8] {
        &self.key_der
    }

    /// 証明書と鍵を TLS に使えるか（読めるか）を確かめる。覚えておいたものが壊れていないかを、起動の前に知るため。
    pub fn check(&self) -> io::Result<()> {
        self.server_config(b"h3").map(|_| ())
    }

    /// 起動のたびに作る身元。`listen_ip` が `localhost`・`127.0.0.1`・`::1` のほかなら、それも名前に足す。
    pub(crate) fn generate_ephemeral(listen_ip: IpAddr) -> io::Result<Identity> {
        Self::generate_for(Some(listen_ip), COMMON_NAME, VALIDITY)
    }

    fn generate_for(
        listen_ip: Option<IpAddr>,
        common_name: &str,
        validity: Duration,
    ) -> io::Result<Identity> {
        let mut names = vec![
            "localhost".to_string(),
            "127.0.0.1".to_string(),
            "::1".to_string(),
        ];
        if let Some(ip) = listen_ip {
            if !names.contains(&ip.to_string()) {
                names.push(ip.to_string());
            }
        }
        let mut params = rcgen::CertificateParams::new(names).map_err(io::Error::other)?;
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, common_name);
        params.is_ca = rcgen::IsCa::ExplicitNoCa;
        params.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        let now = rcgen::date_time_ymd(1970, 1, 1)
            + SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(io::Error::other)?;
        params.not_before = now - Duration::from_secs(60 * 60);
        params.not_after = now + validity;
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

#[cfg(test)]
mod check_tests {
    use super::*;

    #[test]
    fn broken_identities_fail_the_check() {
        let good = Identity::generate("check", Duration::from_secs(60 * 60)).unwrap();
        assert!(good.check().is_ok());
        let broken_key = Identity::from_der(good.certificate_der().to_vec(), b"broken".to_vec());
        assert!(broken_key.check().is_err());
        let broken_cert = Identity::from_der(b"broken".to_vec(), good.key_der().to_vec());
        assert!(broken_cert.check().is_err());
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

        let identity = Identity::generate_ephemeral(IpAddr::from([127, 0, 0, 1])).unwrap();
        identity.write(&cert, &key).unwrap();
        let mode = std::fs::metadata(&key).unwrap().permissions().mode() & 0o777;
        let read = Identity::read(&cert, &key).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();

        assert_eq!(mode, 0o600);
        assert_eq!(read.key_der, identity.key_der);
        assert_eq!(read.certificate_der, identity.certificate_der);
    }
}
