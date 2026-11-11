//! クリップボードの履歴を、kisui-terminal の外から開く小さな窓（#95）。
//!
//! どのアプリを使っていても、全体のキー（Mac は Option+Space、Linux は Alt+Space）でこの窓を前に出す。1 件を選ぶと
//! その文字を OS のクリップボードに戻し、窓を隠して、前に使っていたアプリに戻る。貼るのはユーザー（Cmd+V・Ctrl+V）で、
//! ここからは貼る操作を送らない（macOS のアクセシビリティの許可を要らないようにするため）。Esc は何もせずに隠す。
//!
//! - 窓はメイン窓とは別の窓（ラベル `LABEL`）。中身はメイン窓と同じ画面（index.html）で、画面側は窓のラベルを見て
//!   履歴だけを出す（ClipboardHistoryPopup.tsx）。初めて開くときに作り、閉じても隠すだけで、次はそれを出し直す。
//! - メイン窓は前に出さない。macOS では、この窓をキーの窓にしてからアプリを前に出す（前に出るのはキーの窓と
//!   メインの窓だけなので）。
//! - 前のアプリに戻すのは、macOS は開く前に前にいたアプリを覚えておき、それを前に出してから窓を隠す。Linux は窓を
//!   隠すだけ（ウィンドウマネージャーが前の窓にフォーカスを戻す）。
//! - 窓からフォーカスが外れたら（ほかのアプリを押したなど）、前のアプリには戻さずに隠す。
//! - 全体のキーを取れなくても、kisui-terminal はそのまま動く。ウィンドウマネージャーが先に取っているときは標準エラーに
//!   書く。X11 につながらないとき（X の無い Wayland など）は何も出ない（global-hotkey は X11 につなげないと黙って
//!   何もせず、登録は成功を返す）。

use std::sync::{Mutex, MutexGuard};

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, State, Webview,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::clipboard_history::ClipboardHistory;

/// 窓のラベル（画面側の ClipboardHistoryPopup.tsx・capabilities/clipboard-history.json と同じ）。
pub const LABEL: &str = "clipboard-history";
/// 窓を出し直したことを、窓の画面に知らせるイベント（画面は一覧を読み直し、絞り込みを空にする）。
const EVENT_SHOWN: &str = "clipboard-history-shown";
/// 窓の大きさ（論理ピクセル）。
const WIDTH: f64 = 560.0;
const HEIGHT: f64 = 440.0;

/// 窓の状態。
#[derive(Default)]
pub struct Popup {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// 窓を出す前に前にいたアプリ（macOS の pid。kisui-terminal 自身や、分からないときは None）
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    previous: Option<i32>,
    /// 出してから、窓にフォーカスが来たか（来る前のフォーカスの外れでは隠さない）
    focused: bool,
}

impl Popup {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 窓を出した。前にいたアプリ `previous` を覚え、まだフォーカスは来ていないことにする。
    fn opened(&self, previous: Option<i32>) {
        let mut i = self.lock();
        i.previous = previous;
        i.focused = false;
    }

    /// 窓にフォーカスが来た。
    fn focused(&self) {
        self.lock().focused = true;
    }

    /// 出してから、窓にフォーカスが来たか。
    fn was_focused(&self) -> bool {
        self.lock().focused
    }

    /// 窓を隠す。覚えていた前のアプリを返して忘れる。
    fn take_previous(&self) -> Option<i32> {
        let mut i = self.lock();
        i.focused = false;
        i.previous.take()
    }
}

/// 全体のキー：Option+Space（macOS）・Alt+Space（Linux）。どちらも ALT の修飾。
fn shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT), Code::Space)
}

/// 窓の状態を `app` に持たせ、全体のキーを取る。登録が失敗したとき（ウィンドウマネージャーが先に
/// 取っているなど）は標準エラーに書くだけ。
pub fn start(app: &AppHandle) {
    app.manage(Popup::default());
    let res = app
        .global_shortcut()
        .on_shortcut(shortcut(), |app, _, event| {
            if event.state == ShortcutState::Pressed {
                let a = app.clone();
                let _ = app.run_on_main_thread(move || show(&a));
            }
        });
    if let Err(e) = res {
        eprintln!("kisui-terminal: cannot register the global key for the clipboard history: {e}");
    }
}

/// 窓を出す（無ければ作る）。メインスレッドで呼ぶ。
fn show(app: &AppHandle) {
    let w = match app.get_webview_window(LABEL) {
        Some(w) => w,
        None => match create(app) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("kisui-terminal: cannot open the clipboard history window: {e}");
                return;
            }
        },
    };
    let visible = w.is_visible().unwrap_or(false);
    if !visible {
        // 前のアプリは、隠れているときに出すときだけ覚える（出ている間に押し直したら、もう自分が前にいる）
        let previous = platform::frontmost_other();
        app.state::<Popup>().opened(previous);
        place(&w);
        let _ = w.emit_to(LABEL, EVENT_SHOWN, ());
        let _ = w.show();
    }
    platform::focus(&w);
}

/// 窓を作る（隠したまま）。
fn create(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("クリップボードの履歴")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // macOS：今いるデスクトップ（Space）に出す（メイン窓のあるデスクトップに移らない）
        .visible_on_all_workspaces(true)
        .visible(false)
        .focused(true)
        .build()?;
    let app = app.clone();
    w.on_window_event(move |e| match e {
        // 閉じる（macOS の Cmd+W など）は、隠すだけにする（次に出し直す）
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide(&app, true);
        }
        WindowEvent::Focused(true) => {
            app.state::<Popup>().focused();
        }
        // ほかのアプリに移った。前のアプリには戻さずに隠す
        WindowEvent::Focused(false) => {
            if app.state::<Popup>().was_focused() {
                hide(&app, false);
            }
        }
        _ => {}
    });
    Ok(w)
}

/// 窓を隠す。`back` なら、前に使っていたアプリに戻す。
fn hide(app: &AppHandle, back: bool) {
    let previous = app.state::<Popup>().take_previous();
    let Some(w) = app.get_webview_window(LABEL) else {
        return;
    };
    let _ = app.run_on_main_thread(move || {
        // 先に前のアプリを前に出してから隠す（先に隠すと、kisui-terminal のメイン窓が前に出ることがある）
        if back {
            if let Some(pid) = previous {
                platform::activate(pid);
            }
        }
        let _ = w.hide();
    });
}

/// 窓を、マウスのある画面の、真ん中より少し上に置く。画面が分からなければ、今の画面の真ん中。
fn place(w: &WebviewWindow) {
    let monitor = w
        .cursor_position()
        .ok()
        .and_then(|p| w.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| w.current_monitor().ok().flatten())
        .or_else(|| w.primary_monitor().ok().flatten());
    let Some(m) = monitor else {
        let _ = w.center();
        return;
    };
    let scale = m.scale_factor();
    let size = PhysicalSize::new((WIDTH * scale) as u32, (HEIGHT * scale) as u32);
    let pos = upper_center(*m.position(), *m.size(), size);
    let _ = w.set_position(Position::Physical(pos));
}

/// 画面（左上 `origin`・大きさ `screen`）の中で、`win` の大きさの窓を横は真ん中、縦は上から 1/3 の所に置く位置。
/// 窓が画面より大きければ、画面の左上に合わせる。
fn upper_center(
    origin: PhysicalPosition<i32>,
    screen: PhysicalSize<u32>,
    win: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    let free_w = i64::from(screen.width)
        .saturating_sub(i64::from(win.width))
        .max(0);
    let free_h = i64::from(screen.height)
        .saturating_sub(i64::from(win.height))
        .max(0);
    PhysicalPosition::new(
        origin.x.saturating_add((free_w / 2) as i32),
        origin.y.saturating_add((free_h / 3) as i32),
    )
}

/// 呼んだ webview が、この窓か。
fn from_popup(w: &Webview) -> Result<(), String> {
    if w.label() == LABEL {
        Ok(())
    } else {
        Err("not allowed".into())
    }
}

/// 選んだ文字をクリップボードに戻し、窓を隠して前のアプリに戻る。この窓の画面からだけ呼べる。
/// 戻せるのは履歴にある文字だけ。
#[tauri::command]
pub fn clipboard_popup_pick(
    webview: Webview,
    app: AppHandle,
    history: State<ClipboardHistory>,
    text: String,
) -> Result<(), String> {
    from_popup(&webview)?;
    if !history.contains(&text) {
        return Err("not in the clipboard history".into());
    }
    app.clipboard()
        .write_text(text)
        .map_err(|e| e.to_string())?;
    hide(&app, true);
    Ok(())
}

/// 何もせずに窓を隠し、前のアプリに戻る（Esc）。この窓の画面からだけ呼べる。
#[tauri::command]
pub fn clipboard_popup_dismiss(webview: Webview, app: AppHandle) -> Result<(), String> {
    from_popup(&webview)?;
    hide(&app, true);
    Ok(())
}

/// メイン窓が閉じたら、この窓も閉じる（隠れたこの窓が残って、アプリが終わらなくなるのを避ける）。
pub fn close(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }
}

/// macOS：前にいたアプリを覚えて戻す。この窓をキーの窓にしてからアプリを前に出す。
#[cfg(target_os = "macos")]
mod platform {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationOptions, NSRunningApplication, NSWindow, NSWorkspace,
    };
    use tauri::WebviewWindow;

    /// 今いちばん前にいるアプリの pid。kisui-terminal 自身なら None。
    pub fn frontmost_other() -> Option<i32> {
        let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
        let pid = app.processIdentifier();
        (pid > 0 && pid as u32 != std::process::id()).then_some(pid)
    }

    /// `pid` のアプリを前に出す（もう終わっていれば何もしない）。
    pub fn activate(pid: i32) {
        if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
            app.activateWithOptions(NSApplicationActivationOptions::empty());
        }
    }

    /// 窓をキーの窓にしてから、アプリを前に出す。アプリを前に出すと、前に出るのはキーの窓とメインの窓だけなので、
    /// 先にこの窓をキー（とメイン）にしておけば、kisui-terminal のメイン窓は前に出ない。メインスレッドで呼ぶ。
    pub fn focus(w: &WebviewWindow) {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = w.set_focus();
            return;
        };
        if let Ok(ptr) = w.ns_window() {
            // SAFETY: ns_window は、この窓の生きている NSWindow を指す。メインスレッドで使う
            let win: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
            win.makeKeyAndOrderFront(None);
        }
        #[allow(deprecated)]
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
    }
}

/// Linux など：前のアプリは覚えない（窓を隠すと、ウィンドウマネージャーが前の窓にフォーカスを戻す）。
#[cfg(not(target_os = "macos"))]
mod platform {
    use tauri::WebviewWindow;

    pub fn frontmost_other() -> Option<i32> {
        None
    }

    pub fn activate(_pid: i32) {}

    pub fn focus(w: &WebviewWindow) {
        let _ = w.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn places_the_window_in_the_upper_middle_of_the_screen() {
        let pos = upper_center(
            PhysicalPosition::new(1920, 0),
            PhysicalSize::new(1920, 1080),
            PhysicalSize::new(560, 440),
        );
        assert_eq!(pos, PhysicalPosition::new(1920 + 680, 213));
    }

    #[test]
    fn a_window_larger_than_the_screen_goes_to_its_top_left() {
        let pos = upper_center(
            PhysicalPosition::new(-800, 100),
            PhysicalSize::new(400, 300),
            PhysicalSize::new(560, 440),
        );
        assert_eq!(pos, PhysicalPosition::new(-800, 100));
    }

    #[test]
    fn the_key_is_alt_space() {
        assert!(shortcut().matches(Modifiers::ALT, Code::Space));
    }
}
