# 外のブラウザの拡張機能（extension/。パスキーのログインの Cookie を kisui-terminal に送る）。
# 出力は Chrome と Firefox のフォルダと、ストアに上げる zip（node extension/build.mjs と同じもの）。
# テスト（npm run test:extension と同じ）も回す。依存は Node だけ（npm の依存は使わない）
{ pkgs }:
let
  fs = pkgs.lib.fileset;
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "kisui-terminal-extension";
  version = (builtins.fromJSON (builtins.readFile ../../extension/manifest.json)).version;
  src = fs.toSource {
    root = ../..;
    fileset = fs.unions [
      ../../extension
      # テストが、受け口の許す Firefox の拡張機能の id を読む
      ../../app/src-tauri/src/passkey.rs
    ];
  };
  nativeBuildInputs = [ pkgs.nodejs_26 ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    node extension/build.mjs "$PWD/build"
    runHook postBuild
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    node --test "extension/**/*.test.ts"
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    cp -r build $out
    runHook postInstall
  '';
}
