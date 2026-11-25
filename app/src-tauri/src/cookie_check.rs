//! 内蔵ブラウザに入れた Cookie を読み戻し、渡したとおりの属性で入ったかを確かめる（#476）。
//!
//! 外のブラウザから写した Cookie（passkey.rs）は、wry の `set_cookie` で WebView に入れる。wry が `cookie::Cookie` の属性を
//! WebView の Cookie（macOS は `NSHTTPCookie`、Linux は libsoup の `SoupCookie`）にどう写すかは wry の中にあり、思っていた
//! 写し方と違っても、こちらの値（`cookie::Cookie`）を見るテストでは分からない。macOS で 2 度、実機で Cookie のファイルを
//! 読むまで気づかなかった（PR #280 の domain、#276 の Secure・HttpOnly）。
//!
//! そこで、入れた後に WebView の Cookie をすべて読み戻し（wry の `cookies`）、ここで渡したものと比べる。食い違えば、
//! 呼ぶ側（passkey.rs の `apply_cookies`）がログとお知らせに出す。
//!
//! 読み戻しで分かること・分からないこと:
//! - Secure・HttpOnly・SameSite・期限・path は分かる。macOS の wry は、読み戻しでは `NSHTTPCookie` の
//!   `isSecure`・`isHTTPOnly`・`sameSitePolicy`・`expiresDate` を読む。入れるとき（属性の辞書を作る）とは別の道なので、
//!   #276 のような「辞書の項目の意味の取り違え」は、読み戻しでは起きない。
//! - domain が host だけか、サブドメインにも送られるか（先頭の `.`）は分からない。wry は読み戻した domain を
//!   `CookieBuilder::domain` に入れ、`cookie::Cookie::domain` は先頭の `.` を取って返すため。これは、wry の版を
//!   確かめた版に留めるテスト（`wry_is_the_checked_version`）と、passkey.rs の、wry に渡す domain のテストで見る。

use serde::Serialize;
use tauri::webview::cookie::{Cookie, SameSite};

/// 渡したとおりに入らなかった Cookie 1 つ。値は持たない（ログとお知らせに Cookie の値を出さない）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Mismatch {
    pub name: String,
    /// 入れようとした domain（先頭の `.` があればサブドメインにも送られるもの）
    pub domain: String,
    pub path: String,
    /// 食い違い（`HttpOnly: want false, got true` の形。入っていなければ `not stored`）
    pub problems: Vec<String>,
}

impl Mismatch {
    /// ログとお知らせに出す 1 行。
    pub fn line(&self) -> String {
        format!(
            "{} (domain {}, path {}): {}",
            self.name,
            self.domain,
            self.path,
            self.problems.join("; ")
        )
    }
}

/// `sent`（入れた順の、wry に渡した Cookie）が、`stored`（入れた後に WebView から読み戻したすべての Cookie）に
/// 渡したとおりの属性で入ったかを比べ、食い違ったものを返す（無ければ空）。
pub fn check(sent: &[Cookie<'_>], stored: &[Cookie<'_>]) -> Vec<Mismatch> {
    // 同じ名前・domain・path のものは、後に入れたものが前のものを上書きする。確かめるのは、残るはずの後のものだけ
    let mut last: Vec<&Cookie<'_>> = Vec::new();
    for c in sent {
        last.retain(|x| !same_key(x, c));
        last.push(c);
    }
    let mut out = Vec::new();
    for want in last {
        let domain = want.domain().unwrap_or_default();
        let path = want.path().unwrap_or("/");
        // 読み戻しの domain は先頭の `.` が取れている（上の説明）。host だけのものとサブドメインにも送られるものは
        // 見分けられないので、どちらかが渡したとおりなら良しとする
        let candidates: Vec<&Cookie<'_>> = stored
            .iter()
            .filter(|s| {
                s.name() == want.name()
                    && s.path().unwrap_or("/") == path
                    && bare(s.domain().unwrap_or_default()) == bare(domain)
            })
            .collect();
        let problems = if candidates.is_empty() {
            vec!["not stored".to_string()]
        } else if candidates.iter().any(|s| differences(want, s).is_empty()) {
            continue;
        } else {
            differences(want, candidates[0])
        };
        out.push(Mismatch {
            name: want.name().to_string(),
            domain: domain.to_string(),
            path: path.to_string(),
            problems,
        });
    }
    out
}

/// 先頭の `.` を取った domain（大文字・小文字は区別しない）。
fn bare(d: &str) -> String {
    d.trim_start_matches('.').to_ascii_lowercase()
}

/// WebView の中で同じ 1 つの Cookie になるか（名前・domain（先頭の `.` も含めて）・path が同じ）。
fn same_key(a: &Cookie<'_>, b: &Cookie<'_>) -> bool {
    a.name() == b.name()
        && a.domain().map(str::to_ascii_lowercase) == b.domain().map(str::to_ascii_lowercase)
        && a.path().unwrap_or("/") == b.path().unwrap_or("/")
}

/// 渡した `want` と読み戻した `got` の属性の食い違い。
///
/// - Secure・HttpOnly：渡さなかった（`None`）ものは false として比べる（passkey.rs は true のときだけ渡す）。
/// - SameSite：`Lax`・`Strict` を渡したら同じであること。`None`（Firefox の `no_restriction`）を渡したら
///   `Lax`・`Strict` でないこと（macOS の wry は `None` を写さず、読み戻すと `None`）。渡さなかったら WebView の
///   決まりに任せ、比べない。
/// - 期限：渡した期限と 1 秒までの違い。渡さなかった（ブラウザを閉じるまでの Cookie）なら、読み戻しにも期限が無いこと。
fn differences(want: &Cookie<'_>, got: &Cookie<'_>) -> Vec<String> {
    let mut out = Vec::new();
    let flag = |name: &str, w: Option<bool>, g: Option<bool>, out: &mut Vec<String>| {
        let (w, g) = (w.unwrap_or(false), g.unwrap_or(false));
        if w != g {
            out.push(format!("{name}: want {w}, got {g}"));
        }
    };
    flag("Secure", want.secure(), got.secure(), &mut out);
    flag("HttpOnly", want.http_only(), got.http_only(), &mut out);
    let same_site_ok = match want.same_site() {
        Some(s @ (SameSite::Lax | SameSite::Strict)) => got.same_site() == Some(s),
        Some(SameSite::None) => !matches!(
            got.same_site(),
            Some(SameSite::Lax) | Some(SameSite::Strict)
        ),
        None => true,
    };
    if !same_site_ok {
        out.push(format!(
            "SameSite: want {}, got {}",
            same_site_text(want.same_site()),
            same_site_text(got.same_site())
        ));
    }
    let w = want.expires_datetime().map(|t| t.unix_timestamp());
    let g = got.expires_datetime().map(|t| t.unix_timestamp());
    let expires_ok = match (w, g) {
        (None, None) => true,
        (Some(a), Some(b)) => (a - b).abs() <= 1,
        _ => false,
    };
    if !expires_ok {
        out.push(format!(
            "Expires: want {}, got {}",
            expires_text(want),
            expires_text(got)
        ));
    }
    out
}

fn same_site_text(s: Option<SameSite>) -> &'static str {
    match s {
        Some(SameSite::Lax) => "Lax",
        Some(SameSite::Strict) => "Strict",
        Some(SameSite::None) => "None",
        None => "unset",
    }
}

fn expires_text(c: &Cookie<'_>) -> String {
    match c.expires_datetime() {
        Some(t) => t.to_string(),
        None => "session".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::webview::cookie::time::OffsetDateTime;
    use tauri::webview::cookie::Expiration;

    /// wry が WebView から読み戻したときの形（wry 0.57.0 の `cookie_from_wkwebview`・`cookie_from_soup_cookie`）：
    /// domain は WebView のもの（サブドメインにも送られるものは先頭に `.`）、Secure・HttpOnly・SameSite はいつも入り、
    /// 期限が無ければ `Expiration::Session`。
    fn read_back(sent: &Cookie<'_>) -> Cookie<'static> {
        let mut b = Cookie::build((sent.name().to_string(), sent.value().to_string()))
            .domain(sent.domain().unwrap_or_default().to_string())
            .path(sent.path().unwrap_or("/").to_string())
            .secure(sent.secure().unwrap_or(false))
            .http_only(sent.http_only().unwrap_or(false))
            .same_site(sent.same_site().unwrap_or(SameSite::None));
        b = match sent.expires_datetime() {
            Some(t) => b.expires(t),
            None => b.expires(Expiration::Session),
        };
        b.build()
    }

    fn sent(name: &str, domain: &str) -> Cookie<'static> {
        Cookie::build((name.to_string(), "v".to_string()))
            .domain(domain.to_string())
            .path("/")
            .secure(true)
            .http_only(true)
            .same_site(SameSite::Lax)
            .build()
    }

    #[test]
    fn cookies_stored_as_sent_pass() {
        let mut a = sent("SID", "..google.com");
        a.set_expires(OffsetDateTime::from_unix_timestamp(2_000_000_000).unwrap());
        let b = Cookie::build(("SAPISID", "v"))
            .domain("..google.com")
            .path("/")
            .build();
        let c = sent("user_session", "github.com");
        let sent = vec![a, b, c];
        let stored: Vec<_> = sent.iter().map(read_back).collect();
        assert_eq!(check(&sent, &stored), vec![]);
    }

    // #276：HttpOnly・Secure を false で渡したのに、macOS の WebView では true で入った
    #[test]
    fn finds_flags_that_differ() {
        let want = Cookie::build(("SAPISID", "v"))
            .domain("..google.com")
            .path("/")
            .build();
        let mut got = read_back(&want);
        got.set_http_only(true);
        got.set_secure(true);
        let m = check(&[want], &[got]);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].name, "SAPISID");
        assert_eq!(m[0].domain, ".google.com");
        assert_eq!(
            m[0].problems,
            vec![
                "Secure: want false, got true",
                "HttpOnly: want false, got true"
            ]
        );
        assert_eq!(
            m[0].line(),
            "SAPISID (domain .google.com, path /): Secure: want false, got true; HttpOnly: want false, got true"
        );
    }

    #[test]
    fn finds_same_site_and_expiry_that_differ() {
        let mut want = sent("a", "github.com");
        want.set_expires(OffsetDateTime::from_unix_timestamp(2_000_000_000).unwrap());
        let mut got = read_back(&want);
        got.set_same_site(SameSite::None);
        got.set_expires(Expiration::Session);
        let m = check(&[want.clone()], &[got]);
        assert_eq!(
            m[0].problems,
            vec![
                "SameSite: want Lax, got None",
                "Expires: want 2033-05-18 3:33:20.0 +00:00:00, got session"
            ]
        );
        // 1 秒までの違いは良しとする（NSDate の秒の端数）
        let mut got = read_back(&want);
        got.set_expires(OffsetDateTime::from_unix_timestamp(2_000_000_001).unwrap());
        assert_eq!(check(&[want], &[got]), vec![]);
    }

    #[test]
    fn same_site_none_and_unset() {
        // no_restriction（None）を渡せば、読み戻しが None なら良い。Lax なら食い違い
        let mut want = sent("a", "github.com");
        want.set_same_site(SameSite::None);
        assert_eq!(check(&[want.clone()], &[read_back(&want)]), vec![]);
        let mut got = read_back(&want);
        got.set_same_site(SameSite::Lax);
        assert_eq!(check(&[want], &[got]).len(), 1);
        // 渡さなければ（Firefox の unspecified）、WebView の決まりに任せる
        let mut want = sent("b", "github.com");
        want.set_same_site(None);
        let mut got = read_back(&want);
        got.set_same_site(SameSite::Lax);
        assert_eq!(check(&[want], &[got]), vec![]);
    }

    #[test]
    fn finds_cookies_not_stored() {
        let want = sent("a", "github.com");
        let other = read_back(&sent("a", "example.com"));
        let m = check(&[want], &[other]);
        assert_eq!(m[0].problems, vec!["not stored"]);
    }

    // 上のドメインから寄せたもの（`.cloudflare.com` → `dash.cloudflare.com`）と、もとから host だけのものが同じ名前なら、
    // 後に入れたものが残る。前のものは比べない
    #[test]
    fn only_the_last_of_the_same_cookie_is_checked() {
        let mut first = sent("CF", "dash.cloudflare.com");
        first.set_http_only(false);
        let second = sent("CF", "dash.cloudflare.com");
        let stored = vec![read_back(&second)];
        assert_eq!(check(&[first, second], &stored), vec![]);
    }

    // `.google.com` と、host だけの `google.com` に同じ名前があれば、読み戻しでは domain が同じに見える。
    // どちらかが渡したとおりなら良い
    #[test]
    fn host_only_and_domain_cookies_of_the_same_name() {
        let mut a = sent("x", "..google.com");
        a.set_http_only(false);
        let b = sent("x", "google.com");
        let stored = vec![read_back(&b), read_back(&a)];
        assert_eq!(check(&[a, b], &stored), vec![]);
    }

    /// 読み戻しでは、domain が host だけかサブドメインにも送られるかが分からない（上の説明）。wry が `cookie::Cookie` を
    /// WebView の Cookie に写す作り（macOS の `cookie_into_wkwebview`：`domain()` をそのまま `NSHTTPCookieDomain` に、
    /// `Some(false)` の Secure・HttpOnly も "FALSE" の項目に。Linux の `cookie_into_soup_cookie`）は、wry 0.57.0 で
    /// 確かめた。wry の版が変わったら、それを読み直し、passkey.rs の `accept_cookie` の渡し方と、ここの読み戻しの前提
    /// （`read_back`）が合っているかを確かめてから、この版を書き換える。
    #[test]
    fn wry_is_the_checked_version() {
        let lock = include_str!("../../../Cargo.lock");
        assert!(
            lock.contains("name = \"wry\"\nversion = \"0.57.0\"\n"),
            "wry is no longer 0.57.0: re-check how it maps cookie::Cookie to the WebView's cookie (see cookie_check.rs)"
        );
    }
}
