# home-manager module: programs.kisui-terminal
#
# 設定（[server]・[[gui.machines]]・[[db.connections]]・ui-language）は kisui-terminal 自身の設定のフォルダ
# （~/.config/kisui-terminal/。nightly のパッケージなら kisui-terminal-nightly/）にある。
# programs.kisui-terminal.settings に書くと、そのフォルダの config.toml を（読み取り専用で）作る。
# programs.kisui-terminal.package = null にすると、パッケージは入れず設定だけを置く（アプリを .dmg など別の方法で入れたとき用）。
# そのときのフォルダは programs.kisui-terminal.channel（"stable" か "nightly"）で決める。
# channel を書かなければ、パッケージがあるときはパッケージの名前で、package = null のときは "stable" で決める。書いてパッケージと食い違えば assertion で止める。
# 同じフォルダの config.local.toml は config.toml の上に重ねて読む（同じ項目は config.local.toml が勝つ）。
# アプリが設定を書くときは config.local.toml に書くので、このモジュールが作る config.toml とぶつからない。
# shijimi-editor の設定（programs.shijimi-editor.settings）は、kisui-terminal には届かない（ui-language も）。
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.kisui-terminal;
  toml = pkgs.formats.toml { };
  # nightly のパッケージ（kisui-terminal-nightly）は、自分の名前のフォルダを先に読む。
  # package = null（アプリは別の方法で入れ、設定だけを置く）のときは、パッケージの名前が無いので channel（既定 "stable"）で決める
  packageChannel = if lib.hasSuffix "-nightly" (cfg.package.pname or "") then "nightly" else "stable";
  channel =
    if cfg.package == null then
      (if cfg.channel == null then "stable" else cfg.channel)
    else
      packageChannel;
  dir = if channel == "nightly" then "kisui-terminal-nightly" else "kisui-terminal";
in
{
  options.programs.kisui-terminal = {
    enable = lib.mkEnableOption "kisui-terminal. Built with Nix it has no auto update; update it with `nix flake update` and `home-manager switch`";

    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.kisui-terminal;
      defaultText = lib.literalExpression "kisui-terminal.packages.\${system}.kisui-terminal";
      description = "The kisui-terminal package to install. Use `kisui-terminal-nightly` for the nightly build (installed under that name, next to the stable one). Set it to `null` to install nothing and only place the settings, for an app installed another way (for example the .dmg on macOS, which updates itself); then `channel` chooses the folder of the settings.";
    };

    channel = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.enum [
          "stable"
          "nightly"
        ]
      );
      default = null;
      example = "nightly";
      description = "Which folder the settings go to: `\"stable\"` for `~/.config/kisui-terminal/`, `\"nightly\"` for `~/.config/kisui-terminal-nightly/` (the folder of the nightly build). Left unset, it follows `package` (`kisui-terminal-nightly` gives `\"nightly\"`, anything else `\"stable\"`), and `\"stable\"` when `package` is `null`. Set it when `package` is `null` and the app you installed yourself is the nightly one. Setting it to a value that differs from the package is an error.";
    };

    settings = lib.mkOption {
      type = toml.type;
      default = { };
      example = lib.literalExpression ''
        {
          server.idle_stop_days = 7;
          gui.machines = [
            { ssh = "dev-vm"; name = "dev"; }
          ];
        }
      '';
      description = "Settings of kisui-terminal, written to `~/.config/kisui-terminal/config.toml` (`kisui-terminal-nightly/` for the nightly package) as a read-only file. Nothing is written when it is empty. A `config.local.toml` next to it, if any, is read on top of it and wins.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.package == null || cfg.channel == null || cfg.channel == packageChannel;
        message = "programs.kisui-terminal.channel (\"${toString cfg.channel}\") does not match programs.kisui-terminal.package (\"${packageChannel}\"). Drop channel, change package, or set package = null.";
      }
    ];
    home.packages = lib.optional (cfg.package != null) cfg.package;
    xdg.configFile."${dir}/config.toml" = lib.mkIf (cfg.settings != { }) {
      source = toml.generate "kisui-terminal-config.toml" cfg.settings;
    };
  };
}
