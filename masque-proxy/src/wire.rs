//! QUIC の可変長整数（RFC 9000 16）と、CONNECT-UDP の行き先の取り出し（RFC 9298 2）。

use bytes::{Buf, BufMut, Bytes, BytesMut};

/// CONNECT-UDP の DATAGRAM の capsule の種類（RFC 9297 3.5）。
pub(crate) const CAPSULE_DATAGRAM: u64 = 0x00;

pub(crate) fn put_varint(buf: &mut BytesMut, v: u64) {
    if v < 1 << 6 {
        buf.put_u8(v as u8);
    } else if v < 1 << 14 {
        buf.put_u16(0x4000 | v as u16);
    } else if v < 1 << 30 {
        buf.put_u32(0x8000_0000 | v as u32);
    } else {
        buf.put_u64(0xc000_0000_0000_0000 | v);
    }
}

/// 先頭の可変長整数を読む。足りなければ None（`buf` は進めない）。
pub(crate) fn get_varint(buf: &mut impl Buf) -> Option<u64> {
    if !buf.has_remaining() {
        return None;
    }
    let len = 1usize << (buf.chunk()[0] >> 6);
    if buf.remaining() < len {
        return None;
    }
    let first = (buf.get_u8() & 0x3f) as u64;
    let mut v = first;
    for _ in 1..len {
        v = (v << 8) | buf.get_u8() as u64;
    }
    Some(v)
}

/// UDP の 1 つのデータを、文脈 ID 0 の HTTP の datagram の中身にする（RFC 9298 5）。
pub(crate) fn udp_payload(payload: &[u8]) -> BytesMut {
    let mut buf = BytesMut::with_capacity(payload.len() + 1);
    put_varint(&mut buf, 0);
    buf.put_slice(payload);
    buf
}

/// HTTP の datagram の中身から UDP のデータを取り出す。文脈 ID が 0 でなければ None（捨てる）。
pub(crate) fn udp_from_payload(mut payload: Bytes) -> Option<Bytes> {
    match get_varint(&mut payload)? {
        0 => Some(payload),
        _ => None,
    }
}

/// HTTP/2 の DATAGRAM の capsule を 1 つ作る。
pub(crate) fn datagram_capsule(payload: &[u8]) -> Bytes {
    let inner = udp_payload(payload);
    let mut buf = BytesMut::with_capacity(inner.len() + 10);
    put_varint(&mut buf, CAPSULE_DATAGRAM);
    put_varint(&mut buf, inner.len() as u64);
    buf.extend_from_slice(&inner);
    buf.freeze()
}

/// 溜めた bytes から capsule を 1 つ取り出す（種類と中身）。足りなければ None。
pub(crate) fn take_capsule(buf: &mut BytesMut) -> Option<(u64, Bytes)> {
    let mut peek = &buf[..];
    let kind = get_varint(&mut peek)?;
    let len = get_varint(&mut peek)? as usize;
    if peek.len() < len {
        return None;
    }
    let header = buf.len() - peek.len();
    buf.advance(header);
    Some((kind, buf.split_to(len).freeze()))
}

/// CONNECT-UDP の path（既定の URI テンプレート
/// `/.well-known/masque/udp/{target_host}/{target_port}/`）から、行き先の名前とポートを取り出す。
pub(crate) fn parse_udp_path(path: &str) -> Option<(String, u16)> {
    let rest = path.strip_prefix("/.well-known/masque/udp/")?;
    let rest = rest.split('?').next()?;
    let mut parts = rest.trim_end_matches('/').split('/');
    let host = percent_decode(parts.next()?)?;
    let port = parts.next()?.parse().ok()?;
    if parts.next().is_some() || host.is_empty() || port == 0 {
        return None;
    }
    Some((host, port))
}

/// `CONNECT` の authority（`host:port`、IPv6 は `[...]:port`）から行き先を取り出す。
pub(crate) fn parse_authority(authority: &str) -> Option<(String, u16)> {
    let (host, port) = authority.rsplit_once(':')?;
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    let port = port.parse().ok()?;
    if host.is_empty() || port == 0 {
        return None;
    }
    Some((host.to_string(), port))
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varint_round_trip() {
        for v in [
            0,
            37,
            63,
            64,
            15293,
            16383,
            16384,
            494878333,
            1 << 30,
            151288809941952652,
        ] {
            let mut buf = BytesMut::new();
            put_varint(&mut buf, v);
            let mut read = buf.freeze();
            assert_eq!(get_varint(&mut read), Some(v));
            assert!(read.is_empty());
        }
    }

    #[test]
    fn varint_needs_all_bytes() {
        let mut short: &[u8] = &[0x40];
        assert_eq!(get_varint(&mut short), None);
    }

    #[test]
    fn capsule_round_trip_and_partial() {
        let capsule = datagram_capsule(b"hello");
        let mut buf = BytesMut::from(&capsule[..capsule.len() - 1]);
        assert_eq!(take_capsule(&mut buf), None);
        buf.extend_from_slice(&capsule[capsule.len() - 1..]);
        buf.extend_from_slice(&capsule);
        let (kind, value) = take_capsule(&mut buf).unwrap();
        assert_eq!(kind, CAPSULE_DATAGRAM);
        assert_eq!(
            udp_from_payload(value).unwrap(),
            Bytes::from_static(b"hello")
        );
        assert!(take_capsule(&mut buf).is_some());
        assert!(buf.is_empty());
    }

    #[test]
    fn udp_path() {
        assert_eq!(
            parse_udp_path("/.well-known/masque/udp/www.google.com/443/"),
            Some(("www.google.com".into(), 443))
        );
        assert_eq!(
            parse_udp_path("/.well-known/masque/udp/2001%3Adb8%3A%3A1/53/"),
            Some(("2001:db8::1".into(), 53))
        );
        assert_eq!(parse_udp_path("/.well-known/masque/udp/a/0/"), None);
        assert_eq!(parse_udp_path("/other/a/1/"), None);
    }

    #[test]
    fn authority() {
        assert_eq!(
            parse_authority("example.com:443"),
            Some(("example.com".into(), 443))
        );
        assert_eq!(
            parse_authority("[2001:db8::1]:443"),
            Some(("2001:db8::1".into(), 443))
        );
        assert_eq!(parse_authority("example.com"), None);
    }

    #[test]
    fn nonzero_context_is_dropped() {
        assert_eq!(udp_from_payload(Bytes::from_static(&[0x01, 0xaa])), None);
    }
}
