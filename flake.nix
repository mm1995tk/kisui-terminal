{
  description = "kisui-terminal: the terminal-centered workspace that works closely with shijimi-editor";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    gomod2nix.url = "github:nix-community/gomod2nix";
    gomod2nix.inputs.nixpkgs.follows = "nixpkgs";
    gomod2nix.inputs.flake-utils.follows = "flake-utils";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    # 同梱する shj（shijimi-editor）。欄の中では同梱の shj が先に使われる。
    # 安定版は release ブランチ（一番新しいリリース）、nightly 版はタグ nightly（毎日 main の最新に付け直される）を追う。
    # update-flake.yml が毎日進める
    shijimi-editor = {
      url = "github:mm1995tk/shijimi-editor/release";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
      inputs.gomod2nix.follows = "gomod2nix";
      inputs.treefmt-nix.follows = "treefmt-nix";
    };
    shijimi-editor-nightly = {
      url = "github:mm1995tk/shijimi-editor/nightly";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
      inputs.gomod2nix.follows = "gomod2nix";
      inputs.treefmt-nix.follows = "treefmt-nix";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      gomod2nix,
      treefmt-nix,
      shijimi-editor,
      shijimi-editor-nightly,
    }:
    let
      perSystem = flake-utils.lib.eachDefaultSystem (
        system:
        let
          project-name = "mm1995tk/kisui-terminal";
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ gomod2nix.overlays.default ];
          };

          treefmtEval = treefmt-nix.lib.evalModule pkgs ./flake-treefmt.nix;

          # 版は Tauri の殻の Cargo.toml にある。上げるにはそこを直す（docs/releasing.md）
          version = (builtins.fromTOML (builtins.readFile ./app/src-tauri/Cargo.toml)).package.version;

          # dirtyShortRev ends in "-dirty" when built from uncommitted changes
          commit = self.shortRev or self.dirtyShortRev or "";

          # nightly は X.Y.Z に -nightly、コミットの日付とハッシュを付けたもの（shijimi-editor と同じ付け方）
          nightlyVersion = "${version}-nightly.${
            builtins.substring 0 8 (self.lastModifiedDate or "00000000")
          }.${commit}";

          # 同梱する shj。安定版は入力 shijimi-editor の shj、nightly 版は入力 shijimi-editor-nightly の shj-nightly
          shj = shijimi-editor.packages.${system}.default;
          shjNightly = shijimi-editor-nightly.packages.${system}.shj-nightly;

          # kisui（GUI のサーバー。kisui serve / kisui attach）。安定版と nightly 版は同じプログラムで、
          # channel だけが違う（設定とソケットの置き場を shj と shj-nightly に合わせる。internal/buildinfo）
          mkKisui =
            {
              channel ? "",
            }:
            pkgs.buildGoApplication {
              go = pkgs.go_1_27;
              pname = "kisui" + pkgs.lib.optionalString (channel != "") "-${channel}";
              version = if channel == "" then version else nightlyVersion;
              pwd = ./.;
              src = ./.;
              modules = ./gomod2nix.toml;
              subPackages = [ "cmd/kisui" ];
              CGO_ENABLED = 0;
              ldflags = [
                "-X github.com/mm1995tk/kisui-terminal/internal/buildinfo.Version=${version}"
                "-X github.com/mm1995tk/kisui-terminal/internal/buildinfo.Commit=${commit}"
                "-X github.com/mm1995tk/kisui-terminal/internal/buildinfo.Channel=${channel}"
              ];
              meta = {
                description = "kisui, the server of kisui-terminal";
                license = pkgs.lib.licenses.mit;
                mainProgram = "kisui";
              };
            };
          # kisui serve が欄ごとに動かす coneko-term の wasm（emulator/ の Rust）。Go は internal/emulator/emulator.wasm
          # にコミットしたものを埋め込むので、Rust が無くても kisui は作れる。ソースを変えたら
          # scripts/build-emulator.sh でコミットし直す（食い違うと checks.emulator-wasm が落ちる）。
          # wasm のバイト列は作ったホスト（OS と CPU）で変わるので、作る場所は x86_64-linux に決めている。
          # macOS でも、この derivation は x86_64-linux のビルダー（linux-builder など）で作られる
          pkgsX86 = nixpkgs.legacyPackages.x86_64-linux;
          emulatorWasm = pkgsX86.stdenv.mkDerivation {
            pname = "kisui-emulator-wasm";
            version = "0.1.0";
            src = pkgsX86.lib.fileset.toSource {
              root = ./.;
              fileset = pkgsX86.lib.fileset.unions [
                ./Cargo.toml
                ./Cargo.lock
                ./app/src-tauri
                ./emulator
              ];
            };
            cargoDeps = pkgsX86.rustPlatform.importCargoLock { lockFile = ./Cargo.lock; };
            nativeBuildInputs = [
              pkgsX86.rustPlatform.cargoSetupHook
              pkgsX86.cargo
              pkgsX86.rustc
              pkgsX86.lld
            ];
            buildPhase = ''
              runHook preBuild
              # panic の位置などにソースのパスが入る。Nix の作業ディレクトリ（macOS は作るたびに名前が変わる）を
              # 固定の文字列にして、どこで作っても同じバイト列にする
              export RUSTFLAGS="--remap-path-prefix=$NIX_BUILD_TOP=/build"
              cargo build -p kisui-emulator --release --target wasm32-unknown-unknown --offline
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              install -Dm644 target/wasm32-unknown-unknown/release/kisui_emulator.wasm $out/emulator.wasm
              runHook postInstall
            '';
            dontFixup = true;
          };
          kisuiDrv = mkKisui { };
          kisuiNightlyDrv = mkKisui { channel = "nightly"; };

          # kisui-terminal（GUI）。Nix で作る版に自動更新は無い（nix flake update で進める）
          guiDrv = import ./packaging/nix/kisui-terminal.nix {
            inherit pkgs version;
            kisui = "${kisuiDrv}/bin/kisui";
            shj = "${shj}/bin/shj";
          };
          # nightly 版。kisui-terminal-nightly として、普通の版と並べて入れられる
          guiNightlyDrv = import ./packaging/nix/kisui-terminal.nix {
            inherit pkgs;
            version = nightlyVersion;
            kisui = "${kisuiNightlyDrv}/bin/kisui";
            shj = "${shjNightly}/bin/shj-nightly";
            channel = "nightly";
          };
        in
        {
          packages = {
            default = guiDrv;
            kisui-terminal = guiDrv;
            kisui-terminal-nightly = guiNightlyDrv;
            kisui = kisuiDrv;
            kisui-nightly = kisuiNightlyDrv;
            # 同梱する shj（入力のまま）。リリースのワークフローが nix eval --raw .#shj.version で版を読む
            inherit shj;
            shj-nightly = shjNightly;
            emulator-wasm = emulatorWasm;
            treefmt = treefmtEval.config.build.configFile;
          };

          apps.default = flake-utils.lib.mkApp { drv = guiDrv; };

          # リポジトリを整える（scripts/tidy.sh）。devShell に入らなくても nix run .#tidy で動かせる
          apps.tidy = flake-utils.lib.mkApp {
            drv = pkgs.writeShellApplication {
              name = "tidy";
              runtimeInputs = [
                pkgs.go_1_27
                pkgs.gomod2nix
                pkgs.gopls
                pkgs.git
              ];
              text = "exec ${./scripts/tidy.sh}";
            };
          };

          # GUI を開発用に起動する（tauri dev）。リポジトリのどこからでも nix run .#dev で動く。
          # devShell の中なら、根で go build -o target/dev/kisui ./cmd/kisui と npm run tauri dev と同じ
          apps.dev = flake-utils.lib.mkApp {
            drv = pkgs.writeShellApplication {
              name = "dev";
              runtimeInputs = [ pkgs.git ];
              # bash -c '…' の中の $PWD などは、devShell の中で展開させるためにわざと単一引用符にしている
              excludeShellChecks = [ "SC2016" ];
              text = ''
                root="$(git rev-parse --show-toplevel)"
                cd "$root"
                # node_modules が無いか package-lock.json より古ければ入れ直す
                exec nix develop "$root" --command bash -c '
                  if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
                    npm ci
                  fi
                  # GUI をつなぐ kisui（同梱の代わり）。GUI は SHIJIMI_KISUI を先に見る（locate.rs）。
                  # 欄の中の shj は PATH のもの
                  go build -o target/dev/kisui ./cmd/kisui
                  export SHIJIMI_KISUI="$PWD/target/dev/kisui"
                  exec npm run tauri dev -- "$@"
                ' dev "$@"
              '';
            };
          };

          devShells = import ./flake-shell.nix { inherit pkgs project-name; };
          formatter = treefmtEval.config.build.wrapper;

          # nix flake check で回す検査。CI（check.yml）も同じものを回す
          checks = {
            formatting = treefmtEval.config.build.check self;

            # GUI の殻（cargo test も回る）と Web 画面のテスト（npm test）
            kisui-terminal = guiDrv;
            web-test = guiDrv.web.overrideAttrs (_: {
              pname = "kisui-terminal-web-test";
              doCheck = true;
              checkPhase = ''
                runHook preCheck
                npm test
                runHook postCheck
              '';
            });
          }
          // pkgs.lib.optionalAttrs (system == "x86_64-linux") {
            # コミットした internal/emulator/emulator.wasm が emulator/ のソースから作ったものと同じ
            # （作る場所が x86_64-linux だけなので、検査もそこでだけ回す）
            emulator-wasm = pkgs.runCommand "check-emulator-wasm" { } ''
              if ! cmp ${emulatorWasm}/emulator.wasm ${./internal/emulator/emulator.wasm}; then
                echo "internal/emulator/emulator.wasm が emulator/ のソースと食い違っています。scripts/build-emulator.sh でコミットし直してください" >&2
                exit 1
              fi
              touch $out
            '';
          }
          # Go のテスト（go test ./...）。Linux だけ。macOS の Nix のビルド環境には PATH に ps が無く、
          # ソケットのパスが長すぎ、PTY のシェルも動かないので、テストが前提にする環境にならない
          // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            go-test = kisuiDrv.overrideAttrs (_: {
              pname = "kisui-go-test";
              nativeCheckInputs = [ pkgs.git ];
              checkPhase = ''
                runHook preCheck
                export HOME="$TMPDIR/home"
                mkdir -p "$HOME"
                go test ./...
                runHook postCheck
              '';
            });
          };
        }
      );
    in
    perSystem
    // {
      homeManagerModules.default = import ./packaging/nix/home-manager-module.nix self;
      homeManagerModules.kisui-terminal = self.homeManagerModules.default;
    };
}
