//! kisui serve の中で欄ごとに動かす coneko-term。Go から wazero で動かすための C ABI の殻。
//!
//! wasm のインスタンス 1 つが端末 1 つを持つ（`em_new` で作る）。Go とのやり取りはどれも
//! 数値だけで、バイト列は `em_alloc` で確保した領域に Go が書いてから `em_write` に渡す。
//!
//! 端末の問い合わせ（DA・DECRQM など）への返事は `take_output` に溜まるが、返事をするのは GUI の
//! coneko-term だけにするので、`em_write` が毎回捨てる。捨てた長さは `em_write` の戻り値で分かる。

use coneko_term::Terminal;

/// wasm のインスタンスが持つ端末。インスタンスごとに 1 つなので static で足りる（wasm は 1 スレッド）。
static mut TERM: Option<Terminal> = None;

#[allow(static_mut_refs)]
fn term() -> &'static mut Terminal {
    // SAFETY: wasm32-unknown-unknown は 1 スレッドで、Go 側も 1 つのインスタンスを 1 度に 1 つの呼び出しでしか動かさない
    unsafe { TERM.as_mut().expect("em_new が呼ばれていない") }
}

/// 端末を作る（作り直す）。
#[no_mangle]
pub extern "C" fn em_new(rows: u32, cols: u32) {
    // SAFETY: term() と同じ
    unsafe { TERM = Some(Terminal::new(rows.max(1) as usize, cols.max(1) as usize)) };
}

/// Go が書き込むための領域を確保する。`em_free` で返す。
#[no_mangle]
pub extern "C" fn em_alloc(len: u32) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1) as usize);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// `em_alloc` で確保した領域を返す。
///
/// # Safety
/// `ptr` は同じ `len` で `em_alloc` が返したもので、まだ返していないこと。
#[no_mangle]
pub unsafe extern "C" fn em_free(ptr: *mut u8, len: u32) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1) as usize));
}

/// PTY の出力を端末に書く。端末が返事を作った場合は捨て、捨てたバイト数を返す。
///
/// # Safety
/// `ptr` から `len` バイトが読めること。
#[no_mangle]
pub unsafe extern "C" fn em_write(ptr: *const u8, len: u32) -> u32 {
    let t = term();
    t.write(std::slice::from_raw_parts(ptr, len as usize));
    let dropped = t.take_output().len() as u32;
    // 通知・クリップボードなどのイベントも GUI が扱うので、溜め込まず捨てる
    drop(t.take_events());
    dropped
}

/// 欄の大きさを変える。
#[no_mangle]
pub extern "C" fn em_resize(rows: u32, cols: u32) {
    term().resize(rows.max(1) as usize, cols.max(1) as usize);
}

/// 端末の今の大きさ（上位 16 ビットが rows、下位 16 ビットが cols）。
#[no_mangle]
pub extern "C" fn em_size() -> u32 {
    let s = term().screen();
    ((s.rows() as u32) << 16) | (s.cols() as u32 & 0xffff)
}

/// カーソルの位置（上位 16 ビットが行、下位 16 ビットが列。どちらも 0 始まり）。
#[no_mangle]
pub extern "C" fn em_cursor() -> u32 {
    let c = term().screen().cursor();
    ((c.y as u32) << 16) | (c.x as u32 & 0xffff)
}

/// 端末を始めの状態に戻す（大きさは変えない）。
#[no_mangle]
pub extern "C" fn em_reset() {
    term().reset();
}
