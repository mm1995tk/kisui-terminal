//! 公開サフィックスの一覧（Public Suffix List。https://publicsuffix.org/list/ 。Mozilla が保守する）で、名前の公開サフィックスを求める。
//!
//! 一覧は `assets/public_suffix_list.dat` に同梱して、コードに埋め込む（ライセンスは MPL-2.0。
//! `assets/public_suffix_list-LICENSE.txt`）。取ってきた日と版は一覧の先頭の `VERSION` の行にある。
//! 更新は `scripts/update-public-suffix-list.sh`（CONTRIBUTING.md）。
//!
//! 一覧の決まり（https://github.com/publicsuffix/list/wiki/Format ）のとおりに読む。
//! - 1 行に 1 つの規則。`//` で始まる行と空の行は飛ばし、規則は行の最初の空白までとする。
//! - ふつうの規則（`co.jp`）・先頭が `*` のワイルドカード（`*.kobe.jp`。`kobe.jp` の 1 つ下の名前はどれも当たる）・
//!   先頭が `!` の例外（`!city.kobe.jp`。ワイルドカードから外す。公開サフィックスは `!` を外した名前から 1 つ目のラベルを除いたもの）。
//! - 当たる規則が複数あれば例外が勝ち、無ければラベルの数がいちばん多いものが勝つ。どれにも当たらなければ `*`（最上位のラベル 1 つ）。
//! - ICANN の節と PRIVATE の節の両方を使う（`github.io` も公開サフィックス）。前に使っていた crate `psl` の `psl::suffix` と同じ。
//! - 日本語などの名前の規則は、ラベルごとに Punycode（`xn--`）にして持つ。調べる名前は ASCII の小文字のものだけ渡す。

use std::collections::HashSet;
use std::sync::LazyLock;

/// 同梱した一覧。
const LIST: &str = include_str!("../assets/public_suffix_list.dat");

/// 一覧の規則。名前はどれも ASCII（Punycode にしたもの）。
struct Rules {
    /// ふつうの規則（`co.jp`）
    normal: HashSet<String>,
    /// ワイルドカードの規則の `*.` を外した名前（`*.kobe.jp` なら `kobe.jp`）
    wildcard: HashSet<String>,
    /// 例外の規則の `!` を外した名前（`!city.kobe.jp` なら `city.kobe.jp`）
    exception: HashSet<String>,
}

static RULES: LazyLock<Rules> = LazyLock::new(|| parse(LIST));

fn parse(text: &str) -> Rules {
    let mut rules = Rules {
        normal: HashSet::new(),
        wildcard: HashSet::new(),
        exception: HashSet::new(),
    };
    for line in text.lines() {
        let Some(rule) = line.split_whitespace().next() else {
            continue;
        };
        if rule.starts_with("//") {
            continue;
        }
        if let Some(r) = rule.strip_prefix('!') {
            rules.exception.insert(to_ascii(r));
        } else if let Some(r) = rule.strip_prefix("*.") {
            rules.wildcard.insert(to_ascii(r));
        } else {
            rules.normal.insert(to_ascii(rule));
        }
    }
    rules
}

/// `name`（ASCII の小文字。`.` で始まらず終わらない）の公開サフィックス。`name` の末尾の部分を返す。
pub fn public_suffix(name: &str) -> &str {
    suffix_with(&RULES, name)
}

fn suffix_with<'a>(rules: &Rules, name: &'a str) -> &'a str {
    // 名前の末尾の部分（name・その 1 つ上・……・最上位のラベル）を、長いものから順に見る
    let candidates = std::iter::once(0)
        .chain(name.match_indices('.').map(|(i, _)| i + 1))
        .map(|i| &name[i..]);
    let mut matched: Option<&str> = None;
    for c in candidates {
        if rules.exception.contains(c) {
            // 例外が勝つ。公開サフィックスは 1 つ目のラベルを除いたもの
            return c.split_once('.').map_or("", |(_, rest)| rest);
        }
        if matched.is_some() {
            continue;
        }
        let wildcard = c
            .split_once('.')
            .is_some_and(|(_, parent)| rules.wildcard.contains(parent));
        if rules.normal.contains(c) || wildcard {
            matched = Some(c);
        }
    }
    // どれにも当たらなければ `*` の規則（最上位のラベル）
    matched.unwrap_or_else(|| name.rsplit_once('.').map_or(name, |(_, tld)| tld))
}

/// 規則の名前を、ラベルごとに ASCII にする（ASCII でないラベルは `xn--` と Punycode）。
fn to_ascii(rule: &str) -> String {
    rule.split('.')
        .map(|label| {
            if label.is_ascii() {
                label.to_string()
            } else {
                format!("xn--{}", punycode(label))
            }
        })
        .collect::<Vec<_>>()
        .join(".")
}

// Punycode（RFC 3492）の定数
const BASE: u32 = 36;
const T_MIN: u32 = 1;
const T_MAX: u32 = 26;
const SKEW: u32 = 38;
const DAMP: u32 = 700;
const INITIAL_BIAS: u32 = 72;
const INITIAL_N: u32 = 128;

/// ラベル 1 つを Punycode にする（RFC 3492 の 6.3。`xn--` は付けない）。一覧のラベルは短いので、桁あふれは起きない。
fn punycode(label: &str) -> String {
    let cps: Vec<u32> = label.chars().map(u32::from).collect();
    let mut out: String = label.chars().filter(char::is_ascii).collect();
    let b = out.len() as u32;
    if b > 0 {
        out.push('-');
    }
    let mut n = INITIAL_N;
    let mut delta: u32 = 0;
    let mut bias = INITIAL_BIAS;
    let mut h = b;
    while (h as usize) < cps.len() {
        let m = cps.iter().copied().filter(|&c| c >= n).min().unwrap_or(n);
        delta += (m - n) * (h + 1);
        n = m;
        for &c in &cps {
            if c < n {
                delta += 1;
            }
            if c == n {
                let mut q = delta;
                let mut k = BASE;
                loop {
                    let t = if k <= bias {
                        T_MIN
                    } else if k >= bias + T_MAX {
                        T_MAX
                    } else {
                        k - bias
                    };
                    if q < t {
                        break;
                    }
                    out.push(digit(t + (q - t) % (BASE - t)));
                    q = (q - t) / (BASE - t);
                    k += BASE;
                }
                out.push(digit(q));
                bias = adapt(delta, h + 1, h == b);
                delta = 0;
                h += 1;
            }
        }
        delta += 1;
        n += 1;
    }
    out
}

fn adapt(delta: u32, num_points: u32, first: bool) -> u32 {
    let mut delta = if first { delta / DAMP } else { delta / 2 };
    delta += delta / num_points;
    let mut k = 0;
    while delta > ((BASE - T_MIN) * T_MAX) / 2 {
        delta /= BASE - T_MIN;
        k += BASE;
    }
    k + (BASE - T_MIN + 1) * delta / (delta + SKEW)
}

fn digit(d: u32) -> char {
    if d < 26 {
        (b'a' + d as u8) as char
    } else {
        (b'0' + (d - 26) as u8) as char
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffixes() {
        for (name, want) in [
            // ふつうの規則
            ("com", "com"),
            ("example.com", "com"),
            ("www.example.com", "com"),
            ("co.uk", "co.uk"),
            ("example.co.uk", "co.uk"),
            ("example.co.jp", "co.jp"),
            // PRIVATE の節の規則
            ("github.io", "github.io"),
            ("alice.github.io", "github.io"),
            // 一覧に無い最上位のドメインは `*` の規則
            ("internal", "internal"),
            ("host.internal", "internal"),
            // ワイルドカード（*.kobe.jp・*.ck）
            ("x.kobe.jp", "x.kobe.jp"),
            ("a.x.kobe.jp", "x.kobe.jp"),
            ("kobe.jp", "jp"),
            ("example.ck", "example.ck"),
            ("ck", "ck"),
            // 例外（!city.kobe.jp・!www.ck）
            ("city.kobe.jp", "kobe.jp"),
            ("www.city.kobe.jp", "kobe.jp"),
            ("www.ck", "ck"),
            // 日本語の名前の規則（Punycode）。中国 = xn--fiqs8s、栃木.jp = xn--4pvxs.jp
            ("example.xn--fiqs8s", "xn--fiqs8s"),
            ("xn--4pvxs.jp", "xn--4pvxs.jp"),
        ] {
            assert_eq!(public_suffix(name), want, "{name}");
        }
    }

    // RFC 3492 の 7.1 の例と、一覧にある名前
    #[test]
    fn punycode_examples() {
        assert_eq!(punycode("中国"), "fiqs8s");
        assert_eq!(punycode("栃木"), "4pvxs");
        assert_eq!(punycode("bücher"), "bcher-kva");
        assert_eq!(punycode("ليهمابتكلموشعربي؟"), "egbpdaj6bu4bxfgehfvwxn");
        assert_eq!(punycode("3年B組金八先生"), "3B-ww4c5e180e575a65lsy2b");
    }

    #[test]
    fn rules_are_read() {
        let r = &*RULES;
        assert!(r.normal.contains("com"));
        assert!(r.normal.contains("github.io"));
        assert!(r.wildcard.contains("kobe.jp"));
        assert!(r.exception.contains("city.kobe.jp"));
        assert!(r.normal.contains("xn--fiqs8s"));
        assert!(r.normal.len() > 5000);
    }
}
