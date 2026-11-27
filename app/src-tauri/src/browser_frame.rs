//! 内蔵ブラウザのタブのページ（子の webview）を、Window のどこに置くか。座標の扱いは、すべてここで決める（#442）。
//!
//! 画面（メインの webview の DOM）は、ページを出す四角を「viewport の左上からの論理ピクセル」で測り、測ったときの
//! viewport の大きさと一緒に渡す（`Placement`。`browser_open`・`browser_bounds`）。ここは、それを Window の中の場所に直して置く。
//!
//! macOS の決まり（`mac`）:
//! - **数える座標**は、Window の座標（原点は Window の左下、y は上向き。点）。画面の view の枠も、ページの view の枠も、いったん Window の座標に
//!   直してから比べる。view の親がどれか・親の高さがいくつか・親の向き（flipped か）には頼らない
//!   （wry の `set_position`・`set_size` は「親の view の高さ」から数えるので、macOS では使わない）。
//! - **DOM の原点**（viewport が Window のどこにあるか）は、画面の view の枠と、画面が測った viewport の大きさから決める。
//!   viewport は view の左下に付いていて、view の方が大きい分（`Excess`）は、上と右の余白と見る（WebKit が中身を下げるのは
//!   上からだけ。タイトルバーの下に入った分など）。大きさが同じなら、viewport は view の枠そのもの。
//!   view の安全な領域（`safeAreaInsets`）は、WebKit が中身を下げるとは限らないので、決めるのには使わない（ログに出すだけ）。
//! - **ページの四角**は、viewport の 4 辺からの余白で持つ（`page_in_window`）。Window の形が変わって画面の view の枠が変わると、
//!   viewport も同じだけ変わるものとして、余白を保ったまま置き直す。置き直すのは、画面の view の枠が変わったという AppKit の
//!   知らせ（`NSViewFrameDidChangeNotification`）を受けたとき。画面からの送り直しも、待ち時間も要らない。
//!   画面が測り直した場所は、そのあとで届いて、同じ決まりで置き直される。
//!   Window の端をドラッグしている間に届いた場所では、余白を決め直さない（測ってから届くまでに view が大きくなった分を、
//!   余白と取り違えないように）。
//! - ページの view は、AppKit に動かさせない（自動リサイズを切る）。ページを動かすのは、ここだけ。
//!
//! ほかの OS は、wry の数え方（Window の中身の左上から）がそのまま画面の測り方と合うので、wry に渡すだけ。

use tauri::{AppHandle, Webview};

/// 画面（メインの webview の DOM）が測った、ページを出す四角（論理ピクセル。viewport の左上が原点、y は下向き）と、
/// そのときの viewport の大きさ（`vw`×`vh`）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub vw: f64,
    pub vh: f64,
}

impl Placement {
    /// 画面から来た数を受ける。数でないもの（NaN・無限大）と、負の大きさは断る。ページの大きさは 1 以上にする。
    pub fn new(x: f64, y: f64, w: f64, h: f64, vw: f64, vh: f64) -> Result<Self, String> {
        let ok = [x, y, w, h, vw, vh].iter().all(|n| n.is_finite());
        if !ok || vw < 0.0 || vh < 0.0 {
            return Err("invalid place".into());
        }
        Ok(Self {
            x,
            y,
            w: w.max(1.0),
            h: h.max(1.0),
            vw,
            vh,
        })
    }
}

/// Window の座標（原点は Window の左下、y は上向き。点）での枠。`x`・`y` は枠の左下。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq)]
struct WindowRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// 画面の view の大きさのうち、viewport に入っていない分（点）。viewport は view の左下に付いていると見るので、右と上。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Default)]
struct Excess {
    right: f64,
    top: f64,
}

/// これより小さい食い違いは、余白と見ない。画面が渡す viewport の大きさは、整数の CSS ピクセルに表示の大きさ（2 倍まで）を
/// 掛けて丸めた数なので、余白が無くても 2.5 ピクセルまでずれる。タイトルバー（28 以上）とは取り違えない。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const EXCESS_MIN: f64 = 4.0;

/// 画面の view の大きさ（`view_w`×`view_h`）と、画面が測った viewport の大きさから、viewport に入っていない分を決める。
/// viewport の方が大きい・ほぼ同じなら、余白は無い。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn excess(view_w: f64, view_h: f64, p: &Placement) -> Excess {
    let part = |view: f64, viewport: f64| {
        let d = view - viewport;
        if d < EXCESS_MIN {
            0.0
        } else {
            d
        }
    };
    Excess {
        right: part(view_w, p.vw),
        top: part(view_h, p.vh),
    }
}

/// ページの枠（Window の座標）。`view` は画面の view の、今の枠（Window の座標）。`e` は、画面が場所を測ったときの余白。
///
/// viewport は、`view` から余白（上・右）を除いた所。ページは、viewport の 4 辺から、画面が測った余白だけ内側。
/// 画面が測ったあとで `view` の大きさが変わっていれば、ページは同じだけ伸び縮みする（4 辺の余白を保つ）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn page_in_window(view: WindowRect, e: Excess, p: &Placement) -> WindowRect {
    let (area_w, area_h) = (view.w - e.right, view.h - e.top);
    let (left, top) = (p.x, p.y);
    let (right, bottom) = (p.vw - p.x - p.w, p.vh - p.y - p.h);
    WindowRect {
        x: view.x + left,
        y: view.y + bottom,
        w: (area_w - left - right).max(1.0),
        h: (area_h - top - bottom).max(1.0),
    }
}

/// タブのページ `v` を、画面が測った場所 `p` に置く。macOS では、Window の形が変わったら自分で置き直すように覚える。
#[cfg(target_os = "macos")]
pub fn place(app: &AppHandle, v: &Webview, tab: &str, p: Placement) -> Result<(), String> {
    use tauri::Manager;

    let main = app
        .get_webview("main")
        .ok_or_else(|| "no main webview".to_string())?;
    // 閉包はメインスレッドで、頼んだ順に動く。先に画面の view を覚え、次にページを置く
    main.with_webview(|pv| match crate::browser::wk_webview(&pv) {
        Some((mv, _)) => mac::set_screen(mv),
        None => mac::log_skipped("the screen's view was not found"),
    })
    .map_err(|e| e.to_string())?;
    let tab = tab.to_string();
    v.with_webview(move |pv| match crate::browser::wk_webview(&pv) {
        Some((cv, _)) => mac::place(&tab, cv, p),
        None => mac::log_skipped("the page's view was not found"),
    })
    .map_err(|e| e.to_string())
}

/// タブのページ `v` を、画面が測った場所 `p` に置く。wry の数え方（Window の中身の左上から）が、画面の測り方と合う。
#[cfg(not(target_os = "macos"))]
pub fn place(_: &AppHandle, v: &Webview, _: &str, p: Placement) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize};

    v.set_position(LogicalPosition::new(p.x, p.y))
        .map_err(|e| e.to_string())?;
    v.set_size(LogicalSize::new(p.w, p.h))
        .map_err(|e| e.to_string())
}

/// 閉じたタブを忘れる（macOS。Window の形が変わっても、もう置き直さない）。
pub fn forget(app: &AppHandle, tab: &str) {
    #[cfg(target_os = "macos")]
    {
        let tab = tab.to_string();
        if let Err(e) = app.run_on_main_thread(move || mac::forget(&tab)) {
            eprintln!("kisui-terminal: cannot forget the page's place: {e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, tab);
}

/// macOS：ページの view を置く。すべてメインスレッドで動く（覚えは、メインスレッドだけが持つ）。
#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::ptr::NonNull;
    use std::sync::Mutex;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::NSObjectProtocol;
    use objc2::Message;
    use objc2_app_kit::{NSAutoresizingMaskOptions, NSView, NSViewFrameDidChangeNotification};
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSPoint, NSRect, NSSize};

    use super::{excess, page_in_window, Excess, Placement, WindowRect};

    /// 置いているページ 1 つ。
    struct Page {
        view: Retained<NSView>,
        place: Placement,
        /// 画面が場所を測ったときの、画面の view の余白（次に画面が測るまで、変わらないものとして使う）
        excess: Excess,
    }

    #[derive(Default)]
    struct Placed {
        /// 画面（メインの webview）の view
        screen: Option<Retained<NSView>>,
        pages: HashMap<String, Page>,
    }

    thread_local! {
        static PLACED: RefCell<Placed> = RefCell::default();
    }

    /// 画面の view を覚え、その枠（と、親の view の枠）が変わったら、ページを置き直すようにする。同じ view なら何もしない。
    pub fn set_screen(view: &NSView) {
        let same = PLACED.with(|p| {
            let mut p = p.borrow_mut();
            if p.screen.as_deref().is_some_and(|s| std::ptr::eq(s, view)) {
                return true;
            }
            p.screen = Some(view.retain());
            false
        });
        if same {
            return;
        }
        watch(view);
        // SAFETY: メインスレッドで、生きている view の親を読むだけ
        if let Some(parent) = unsafe { view.superview() } {
            watch(&parent);
        }
    }

    /// view の枠が変わったら、ページを置き直す。見張りは、アプリが終わるまで外さない（画面の view はアプリと同じだけ生きる）。
    fn watch(view: &NSView) {
        view.setPostsFrameChangedNotifications(true);
        let block = RcBlock::new(|_: NonNull<NSNotification>| follow());
        // SAFETY: メインスレッドで、生きている view を相手に見張りを足す。ブロックは、メインスレッドだけの覚えを読む
        // （queue が無いので、知らせを出したスレッド、つまり view の枠を変えたメインスレッドで呼ばれる）
        let token = unsafe {
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(NSViewFrameDidChangeNotification),
                Some(view),
                None,
                &block,
            )
        };
        std::mem::forget(token);
    }

    /// ページの view を、画面が測った場所に置き、覚える。
    pub fn place(tab: &str, view: &NSView, p: Placement) {
        // ページを動かすのは、ここだけにする（wry は、親の大きさが変わると上の端に付いて動くようにしている）
        view.setAutoresizingMask(NSAutoresizingMaskOptions::empty());
        let Some(screen) = PLACED.with(|pl| pl.borrow().screen.clone()) else {
            log_skipped("the screen's view is not known");
            return;
        };
        let Some(area) = frame_in_window(&screen) else {
            log_skipped("the screen's view has no parent");
            return;
        };
        // Window の端をドラッグしている間は、余白を決め直さない。画面が測った viewport の大きさは、殻に届くまでに古くなるので、
        // その間に view が大きくなった分を、上の余白と取り違える（ページと URL バーの間にすき間が空く）。
        // ドラッグでは余白（タイトルバーの分など）は変わらないので、覚えている余白を使う
        let kept = if screen.inLiveResize() {
            PLACED.with(|pl| pl.borrow().pages.get(tab).map(|page| page.excess))
        } else {
            None
        };
        let e = kept.unwrap_or_else(|| excess(area.w, area.h, &p));
        log_place(area, &p, e, &screen);
        apply(view, area, e, &p);
        PLACED.with(|pl| {
            pl.borrow_mut().pages.insert(
                tab.to_string(),
                Page {
                    view: view.retain(),
                    place: p,
                    excess: e,
                },
            );
        });
    }

    /// 閉じたタブのページを忘れる（view を放し、もう置き直さない）。
    pub fn forget(tab: &str) {
        PLACED.with(|p| p.borrow_mut().pages.remove(tab));
    }

    /// 画面の view の枠が変わった。覚えているページを、今の枠に合わせて置き直す。
    fn follow() {
        // AppKit から呼ばれるので、ここで panic させない。アプリが終わるとき（覚えを片付けたあと）に呼ばれたら、何もしない
        let _ = PLACED.try_with(|p| {
            // 覚えを書き換えている最中に呼ばれたら、何もしない（書き換えた側が、そのあとで置く）
            let Ok(p) = p.try_borrow() else {
                return;
            };
            let Some(area) = p.screen.as_deref().and_then(frame_in_window) else {
                return;
            };
            for page in p.pages.values() {
                apply(&page.view, area, page.excess, &page.place);
            }
        });
    }

    /// view の枠を、Window の座標で。親が無ければ（Window に載っていなければ）None。
    fn frame_in_window(view: &NSView) -> Option<WindowRect> {
        // SAFETY: メインスレッドで、生きている view の親を読むだけ
        let parent = unsafe { view.superview() }?;
        let f = parent.convertRect_toView(view.frame(), None);
        Some(WindowRect {
            x: f.origin.x,
            y: f.origin.y,
            w: f.size.width,
            h: f.size.height,
        })
    }

    /// ページの view の枠を決めて当てる。Window に載っていない view（閉じたあとなど）には何もしない。
    fn apply(view: &NSView, area: WindowRect, e: Excess, p: &Placement) {
        // SAFETY: メインスレッドで、生きている view の親を読むだけ
        let Some(parent) = (unsafe { view.superview() }) else {
            return;
        };
        let r = page_in_window(area, e, p);
        let want = parent.convertRect_fromView(
            NSRect::new(NSPoint::new(r.x, r.y), NSSize::new(r.w, r.h)),
            None,
        );
        if view.frame() != want {
            view.setFrame(want);
        }
    }

    /// Mac で確かめる手がかり：場所を決めるのに使った数を、決め方（余白）が変わったときだけログに出す（出す数には上限がある）。
    /// 安全な領域は、決めるのには使わないが、余白がそれで説明できるかを見るために出す。
    fn log_place(area: WindowRect, p: &Placement, e: Excess, screen: &NSView) {
        static LAST: Mutex<Option<(Excess, u32)>> = Mutex::new(None);
        let mut last = LAST.lock().unwrap();
        let n = match *last {
            Some((seen, n)) if seen == e || n >= 30 => return,
            Some((_, n)) => n + 1,
            None => 1,
        };
        *last = Some((e, n));
        let safe = if screen.respondsToSelector(objc2::sel!(safeAreaInsets)) {
            let i = screen.safeAreaInsets();
            format!(
                "top={} left={} bottom={} right={}",
                i.top, i.left, i.bottom, i.right
            )
        } else {
            "none".to_string()
        };
        eprintln!(
            "kisui-terminal: the page is placed in the screen \
             [the screen's view in the window: x={} y={} w={} h={}; the screen's viewport: w={} h={}; \
             outside the viewport: top={} right={}; the screen's safe area: {safe}; \
             the screen asked: x={} y={} w={} h={}]",
            area.x, area.y, area.w, area.h, p.vw, p.vh, e.top, e.right, p.x, p.y, p.w, p.h
        );
    }

    /// 置けなかった理由を、理由ごとに 1 回だけログに出す（黙って戻ると、置けていないのかが分からない）。
    pub fn log_skipped(why: &'static str) {
        static SEEN: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
        let mut seen = SEEN.lock().unwrap();
        if !seen.contains(&why) {
            seen.push(why);
            eprintln!("kisui-terminal: the page was not placed: {why}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> WindowRect {
        WindowRect { x, y, w, h }
    }

    fn at(x: f64, y: f64, w: f64, h: f64, vw: f64, vh: f64) -> Placement {
        Placement::new(x, y, w, h, vw, vh).unwrap()
    }

    #[test]
    fn rejects_numbers_that_are_not_a_place() {
        assert!(Placement::new(f64::NAN, 0.0, 1.0, 1.0, 1.0, 1.0).is_err());
        assert!(Placement::new(0.0, 0.0, f64::INFINITY, 1.0, 1.0, 1.0).is_err());
        assert!(Placement::new(0.0, 0.0, 1.0, 1.0, -1.0, 1.0).is_err());
        // ページの大きさは 1 以上にする
        let p = at(0.0, 0.0, 0.0, -5.0, 10.0, 10.0);
        assert_eq!((p.w, p.h), (1.0, 1.0));
    }

    #[test]
    fn no_excess_when_the_viewport_fills_the_view() {
        let p = at(300.0, 40.0, 900.0, 760.0, 1200.0, 800.0);
        assert_eq!(excess(1200.0, 800.0, &p), Excess::default());
        // 丸めの分（数ピクセル）の食い違いと、viewport の方が大きいときは、余白と見ない
        assert_eq!(excess(1203.0, 799.0, &p), Excess::default());
        assert_eq!(excess(1100.0, 700.0, &p), Excess::default());
    }

    #[test]
    fn excess_is_what_the_view_has_beyond_the_viewport() {
        // 画面の view が、viewport よりタイトルバーの高さ（28）だけ高い
        let p = at(300.0, 40.0, 900.0, 760.0, 1200.0, 800.0);
        assert_eq!(
            excess(1200.0, 828.0, &p),
            Excess {
                right: 0.0,
                top: 28.0
            }
        );
    }

    #[test]
    fn the_page_is_counted_down_from_the_top_of_the_view() {
        // 画面の view は Window の中身いっぱい（1200×800、左下が原点）。ページは左から 300、上から 40
        let p = at(300.0, 40.0, 900.0, 760.0, 1200.0, 800.0);
        assert_eq!(
            page_in_window(rect(0.0, 0.0, 1200.0, 800.0), Excess::default(), &p),
            rect(300.0, 0.0, 900.0, 760.0)
        );
        // 画面の view が Window の中でずれていれば、その分だけずれる
        assert_eq!(
            page_in_window(rect(10.0, 20.0, 1200.0, 800.0), Excess::default(), &p),
            rect(310.0, 20.0, 900.0, 760.0)
        );
    }

    #[test]
    fn the_page_stays_below_what_the_viewport_does_not_cover() {
        // 画面の view がタイトルバーの下まで広がっていて（高さ 828）、viewport は下の 800 だけ（#326 の形）。
        // ページの上の端は、view の上の端から 28 + 40 下
        let p = at(300.0, 40.0, 900.0, 700.0, 1200.0, 800.0);
        let view = rect(0.0, 0.0, 1200.0, 828.0);
        let e = excess(view.w, view.h, &p);
        let r = page_in_window(view, e, &p);
        assert_eq!(r, rect(300.0, 60.0, 900.0, 700.0));
        assert_eq!(view.y + view.h - (r.y + r.h), 28.0 + 40.0);
    }

    #[test]
    fn the_page_follows_the_view_when_the_window_changes() {
        // 画面が測ったあとで、Window が横に 100、縦に 50 大きくなった（画面はまだ測り直していない）。
        // 4 辺の余白（左 300・上 40・右 0・下 60）を保って、ページが伸びる
        let p = at(300.0, 40.0, 900.0, 700.0, 1200.0, 800.0);
        let e = excess(1200.0, 800.0, &p);
        assert_eq!(
            page_in_window(rect(0.0, 0.0, 1300.0, 850.0), e, &p),
            rect(300.0, 60.0, 1000.0, 750.0)
        );
        // 余白がある Window（タイトルバーの下まで広がった view）でも同じ。上の端は、余白と上からの距離を保つ
        let e = excess(1200.0, 828.0, &p);
        let r = page_in_window(rect(0.0, 0.0, 1300.0, 878.0), e, &p);
        assert_eq!(r, rect(300.0, 60.0, 1000.0, 750.0));
        assert_eq!(878.0 - (r.y + r.h), 28.0 + 40.0);
    }

    #[test]
    fn the_page_never_gets_an_empty_frame() {
        // Window が、測ったときの余白より小さくなっても、大きさは 1 以上
        let p = at(300.0, 40.0, 900.0, 700.0, 1200.0, 800.0);
        let r = page_in_window(rect(0.0, 0.0, 200.0, 50.0), Excess::default(), &p);
        assert_eq!((r.w, r.h), (1.0, 1.0));
    }
}
