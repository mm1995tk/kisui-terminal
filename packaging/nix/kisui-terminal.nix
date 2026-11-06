# GUI（ui/gui/app/）のパッケージ。Tauri の殻（Rust）と、Solid の Web 画面（npm）を 1 つにする。
#   web … buildNpmPackage で vite build した dist
#   殻  … buildRustPackage。dist を ui/gui/app/dist に置いてから cargo build する
#          （tauri が generate_context! で dist を実行ファイルに埋め込む）
# package.json と Cargo.toml（workspace）はリポジトリの根にあるので、src は根から GUI に要るものだけを取る
#
# 自動更新（feature `updater`）は付けない。Nix で入れた GUI の更新は nix flake update と home-manager switch で行う。
# 版は Tauri の設定の `version` として TAURI_CONFIG で渡す（GUI はこれを自分の版として、リモートに入れる shj の版に使う）。
# channel = "nightly" は tauri.nightly.conf.json を重ね（名前 shijimi-editor-nightly）、実行ファイルを
# shijimi-editor-gui-nightly にして、普通の版と並べて入れられるようにする。
{
  pkgs,
  version,
  channel ? "",
  # 同じ版の kisui（GUI が「ローカル」でつなぐサーバー）の実行ファイル。GUI から見つけられるよう libexec に入れる
  kisui,
}:
let
  inherit (pkgs) lib stdenv;
  fs = lib.fileset;
  root = ../..;
  # Go などほかの部分が変わっても GUI を作り直さないよう、要るファイルだけにする
  webSrc = fs.toSource {
    inherit root;
    fileset = fs.unions [
      ../../package.json
      ../../package-lock.json
      ../../tsconfig.json
      ../../vite.config.ts
      ../../ui/gui/app/index.html
      ../../ui/gui/app/src
    ];
  };
  shellSrc = fs.toSource {
    inherit root;
    fileset = fs.unions [
      ../../Cargo.toml
      ../../Cargo.lock
      ../../ui/gui/app/src-tauri
    ];
  };
  nightly = channel == "nightly";
  bin = "shijimi-editor-gui" + lib.optionalString nightly "-nightly";
  tauriConfig =
    lib.optionalAttrs nightly (
      builtins.fromJSON (builtins.readFile ../../ui/gui/app/src-tauri/tauri.nightly.conf.json)
    )
    // {
      inherit version;
    };

  web = pkgs.buildNpmPackage {
    pname = "shijimi-editor-gui-web";
    inherit version;
    src = webSrc;
    # package-lock.json を変えたら、ここを lib.fakeHash にして nix build .#gui を回し、出た値に直す
    npmDepsHash = "sha256-xQcrBNY9zBTmS2Z+pCmrP9tfwdS6kfpnrCvdNRuS848=";
    # tauri の CLI は殻のビルドには使わない（cargo を直接回す）。バイナリの取得を避ける
    npmFlags = [ "--ignore-scripts" ];
    installPhase = ''
      runHook preInstall
      cp -r ui/gui/app/dist $out
      runHook postInstall
    '';
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = bin;
  inherit version;
  src = shellSrc;
  cargoLock.lockFile = ../../Cargo.lock;
  # workspace の根で cargo を回し、殻（ui/gui/app/src-tauri）だけを作ってテストする
  buildAndTestSubdir = "ui/gui/app/src-tauri";

  # release の画面は埋め込んだ Web を使う（cargo tauri build が自動で付ける feature）
  buildFeatures = [ "custom-protocol" ];

  env.TAURI_CONFIG = builtins.toJSON tauriConfig;

  postPatch = ''
    mkdir -p ui/gui/app/dist
    cp -r ${web}/. ui/gui/app/dist/
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

  # kisui は PATH に出さない（shijimi-editor のパッケージの kisui とぶつからないよう）。GUI は実行ファイルの ../libexec/kisui を見る（locate.rs）
  postInstall = ''
    mkdir -p $out/libexec
    ln -s ${kisui} $out/libexec/kisui
  ''
  + lib.optionalString nightly ''
    mv $out/bin/shijimi-editor-gui $out/bin/${bin}
  '';

  # Web 画面だけのビルド。flake の checks が npm test を足して使う（入れるときのビルドではテストを回さない）
  passthru = { inherit web; };

  meta = {
    description = "GUI for shijimi-editor (Tauri)";
    license = lib.licenses.mit;
    mainProgram = bin;
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
