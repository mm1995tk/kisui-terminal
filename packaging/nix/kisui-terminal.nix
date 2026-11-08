# kisui-terminal（GUI）のパッケージ。Tauri の殻（Rust）と、Solid の Web 画面（npm）を 1 つにする。
#   web … buildNpmPackage で vite build した dist
#   殻  … buildRustPackage。dist を app/dist に置いてから cargo build する
#          （tauri が generate_context! で dist を実行ファイルに埋め込む）
# package.json と Cargo.toml（workspace）はリポジトリの根にあるので、src は根から殻と画面に要るものだけを取る
#
# 自動更新（feature `updater`）は付けない。Nix で入れた GUI の更新は nix flake update と home-manager switch で行う。
# 版は Tauri の設定の `version` として TAURI_CONFIG で渡す（GUI はこれを自分の版として、リモートに入れる shj の版に使う）。
# channel = "nightly" は tauri.nightly.conf.json を重ね（名前 kisui-terminal-nightly）、実行ファイルを
# kisui-terminal-nightly にして、普通の版と並べて入れられるようにする。
{
  pkgs,
  version,
  channel ? "",
  # 同じ版の kisui（GUI が「ローカル」でつなぐサーバー）の実行ファイル。GUI から見つけられるよう libexec に入れる
  kisui,
  # 同梱する shj（flake の入力 shijimi-editor のもの）。欄の中で先に使われる。GUI は libexec/shj-bin に置いて kisui に渡す（bin/ に出さない）
  shj,
}:
let
  inherit (pkgs) lib stdenv;
  fs = lib.fileset;
  root = ../..;
  # kisui（Go）などほかの部分が変わっても画面を作り直さないよう、要るファイルだけにする
  webSrc = fs.toSource {
    inherit root;
    fileset = fs.unions [
      ../../package.json
      ../../package-lock.json
      ../../tsconfig.json
      ../../vite.config.ts
      ../../app/index.html
      ../../app/src
    ];
  };
  shellSrc = fs.toSource {
    inherit root;
    fileset = fs.unions [
      ../../Cargo.toml
      ../../Cargo.lock
      ../../app/src-tauri
      # workspace の member。殻の build には使わないが、cargo は member の Cargo.toml を読む
      ../../emulator
    ];
  };
  nightly = channel == "nightly";
  bin = "kisui-terminal" + lib.optionalString nightly "-nightly";
  tauriConfig =
    lib.optionalAttrs nightly (
      builtins.fromJSON (builtins.readFile ../../app/src-tauri/tauri.nightly.conf.json)
    )
    // {
      inherit version;
    };

  web = pkgs.buildNpmPackage {
    pname = "kisui-terminal-web";
    inherit version;
    src = webSrc;
    # package-lock.json を変えたら、ここを lib.fakeHash にして nix build .#kisui-terminal を回し、出た値に直す
    npmDepsHash = "sha256-mgIyFs0WLBVjTvsqFB/UUhzEBzvPw5SBKwSnO6iSWvE=";
    # tauri の CLI は殻のビルドには使わない（cargo を直接回す）。バイナリの取得を避ける
    npmFlags = [ "--ignore-scripts" ];
    installPhase = ''
      runHook preInstall
      cp -r app/dist $out
      runHook postInstall
    '';
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = bin;
  inherit version;
  src = shellSrc;
  cargoLock.lockFile = ../../Cargo.lock;
  # workspace の根で cargo を回し、殻（app/src-tauri）だけを作ってテストする
  buildAndTestSubdir = "app/src-tauri";

  # release の画面は埋め込んだ Web を使う（cargo tauri build が自動で付ける feature）
  buildFeatures = [ "custom-protocol" ];

  env.TAURI_CONFIG = builtins.toJSON tauriConfig;

  postPatch = ''
    mkdir -p app/dist
    cp -r ${web}/. app/dist/
  '';

  nativeBuildInputs = [
    pkgs.pkg-config
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [ pkgs.wrapGAppsHook3 ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    pkgs.webkitgtk_4_1
    pkgs.gtk3
    pkgs.libsoup_3
    pkgs.glib
    pkgs.openssl
    pkgs.glib-networking
  ];

  # ssh_config のパース・ホスト名の検査などの単体テスト（cargo test）
  doCheck = true;

  # kisui は PATH に出さない（kisui は GUI だけが使う）。GUI は実行ファイルの ../libexec/kisui を見る（locate.rs）
  postInstall = ''
    mkdir -p $out/libexec
    ln -s ${kisui} $out/libexec/kisui
    # shj も PATH の bin/ には出さない（home-manager などで別に入れた shj の bin/shj とぶつからないよう）。
    # GUI は ../libexec/shj-bin を KISUI_SHJ_DIR として kisui に渡し、kisui が欄の中の PATH の先頭に足す（locate.rs）
    mkdir -p $out/libexec/shj-bin
    ln -s ${shj} $out/libexec/shj-bin/shj
  ''
  + lib.optionalString nightly ''
    mv $out/bin/kisui-terminal $out/bin/${bin}
  '';

  # Web 画面だけのビルド。flake の checks が npm test を足して使う（入れるときのビルドではテストを回さない）
  passthru = { inherit web; };

  meta = {
    description = "kisui-terminal (Tauri), the terminal-centered workspace that works closely with shijimi-editor";
    license = lib.licenses.mit;
    mainProgram = bin;
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
