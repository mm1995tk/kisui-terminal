_: {
  projectRootFile = "flake.nix";
  programs.nixfmt.enable = true;
  programs.gofmt.enable = true;
  programs.taplo.enable = true;
  programs.rustfmt = {
    enable = true;
    edition = "2021";
  };
  # app/ の Web 画面（Solid + TypeScript）と、根に置いたその設定。Markdown などには触れない
  programs.prettier = {
    enable = true;
    includes = [
      "package.json"
      "tsconfig.json"
      "vite.config.ts"
      "app/**/*.ts"
      "app/**/*.tsx"
      "app/**/*.html"
      "app/**/*.json"
    ];
  };
  # gomod2nix writes this file; reformatting it only makes the next gomod2nix run show a diff.
  # package-lock.json は npm が書く。整形すると次の npm install で差分が出る
  settings.global.excludes = [
    "gomod2nix.toml"
    "package-lock.json"
    "app/src-tauri/icons/*"
    "app/src-tauri/gen/*"
  ];
}
