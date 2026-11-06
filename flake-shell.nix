{
  pkgs,
  project-name,
  ...
}:
let
  inherit (pkgs) lib stdenv;
  goEnv = pkgs.mkGoEnv {
    pwd = ./.;
    go = pkgs.go_1_27;
  };
in
{
  default = pkgs.mkShell {
    nativeBuildInputs = [ pkgs.pkg-config ];
    buildInputs = [
      # kisui（Go）
      goEnv
      pkgs.gomod2nix
      pkgs.gopls
      pkgs.git
      # Web 画面（package.json はリポジトリの根）
      pkgs.nodejs_26
      # 殻（app/src-tauri。Cargo.toml の workspace はリポジトリの根）
      pkgs.cargo
      pkgs.rustc
      # emulator（wasm）のリンク
      pkgs.lld
    ]
    # Linux で殻をビルドし tauri dev で動かすための WebView 周りのライブラリ（nix build .#kisui-terminal と同じもの）
    ++ lib.optionals stdenv.hostPlatform.isLinux [
      pkgs.webkitgtk_4_1
      pkgs.gtk3
      pkgs.libsoup_3
      pkgs.glib
      pkgs.openssl
      pkgs.glib-networking
      pkgs.librsvg
    ];

    CGO_ENABLED = "0";
    PROJECT_NAME = project-name;

    # nix build .#kisui-terminal では wrapGAppsHook3 が付ける環境。devShell では自分で足す
    # （GTK の設定のスキーマと、WebView が HTTPS に使う GIO のモジュール）
    shellHook = lib.optionalString stdenv.hostPlatform.isLinux ''
      export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}''${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"
      export GIO_MODULE_DIR="${pkgs.glib-networking}/lib/gio/modules/"
    '';
  };
}
