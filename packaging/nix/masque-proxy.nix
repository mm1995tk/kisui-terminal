# 内蔵ブラウザ（macOS）に使わせる中継型のプロキシ（masque-proxy/）。nix flake check でテストを回す。
# Cargo.toml（workspace）はリポジトリの根にあるので、src は根から、cargo が読む member の Cargo.toml も含めて取る。
# テストは loopback に立てたサーバーにだけつなぐ（外の回線と DNS は使わない）。
{ pkgs }:
let
  fs = pkgs.lib.fileset;
  root = ../..;
in
pkgs.rustPlatform.buildRustPackage {
  pname = "masque-proxy";
  version = (builtins.fromTOML (builtins.readFile ../../masque-proxy/Cargo.toml)).package.version;
  src = fs.toSource {
    inherit root;
    fileset = fs.unions [
      ../../Cargo.toml
      ../../Cargo.lock
      ../../masque-proxy
      # workspace の member。このプロキシの build には使わないが、cargo は member の Cargo.toml を読む
      ../../app/src-tauri
      ../../emulator
    ];
  };
  cargoLock.lockFile = ../../Cargo.lock;
  buildAndTestSubdir = "masque-proxy";
  # macOS のビルドの環境でも、テストが loopback で待ち受けられるようにする
  __darwinAllowLocalNetworking = true;
  meta.mainProgram = "masque-proxy";
}
