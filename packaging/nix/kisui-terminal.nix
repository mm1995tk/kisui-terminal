# GUI（gui/）のパッケージ。Tauri の殻（Rust）と、Solid の Web 画面（npm）を 1 つにする。
#   web … buildNpmPackage で vite build した dist
#   殻  … buildRustPackage。dist を gui/dist に置いてから cargo build する
#          （tauri が generate_context! で dist を実行ファイルに埋め込む）
#
# 自動更新（feature `updater`）は付けない。Nix で入れた GUI の更新は nix flake update と home-manager switch で行う。
# 版は Tauri の設定の `version` として TAURI_CONFIG で渡す（GUI はこれを自分の版として、リモートに入れる shj の版に使う）。
# channel = "nightly" は tauri.nightly.conf.json を重ね（名前 shijimi-editor-nightly）、実行ファイルを
# shijimi-editor-gui-nightly にして、普通の版と並べて入れられるようにする。
{
  pkgs,
  version,
  channel ? "",
}:
let
  inherit (pkgs) lib stdenv;
  nightly = channel == "nightly";
  bin = "shijimi-editor-gui" + lib.optionalString nightly "-nightly";
  tauriConfig =
    lib.optionalAttrs nightly (
      builtins.fromJSON (builtins.readFile ../../gui/src-tauri/tauri.nightly.conf.json)
    )
    // {
      inherit version;
    };

  web = pkgs.buildNpmPackage {
    pname = "shijimi-editor-gui-web";
    inherit version;
    src = ../../gui;
    # package-lock.json を変えたら、ここを lib.fakeHash にして nix build .#gui を回し、出た値に直す
    npmDepsHash = "sha256-o88Hy2e9d3WIWPG9gwVwMWWlCUm2q7eTdcv+k2pkBs4=";
    # tauri の CLI は殻のビルドには使わない（cargo を直接回す）。バイナリの取得を避ける
    npmFlags = [ "--ignore-scripts" ];
    installPhase = ''
      runHook preInstall
      cp -r dist $out
      runHook postInstall
    '';
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = bin;
  inherit version;
  src = ../../gui;
  sourceRoot = "gui/src-tauri";
  cargoLock.lockFile = ../../gui/src-tauri/Cargo.lock;

  # release の画面は埋め込んだ Web を使う（cargo tauri build が自動で付ける feature）
  buildFeatures = [ "custom-protocol" ];

  env.TAURI_CONFIG = builtins.toJSON tauriConfig;

  postPatch = ''
    chmod u+w ..
    mkdir -p ../dist
    cp -r ${web}/. ../dist/
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

  postInstall = lib.optionalString nightly ''
    mv $out/bin/shijimi-editor-gui $out/bin/${bin}
  '';

  meta = {
    description = "GUI for shijimi-editor (Tauri)";
    license = lib.licenses.mit;
    mainProgram = bin;
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
