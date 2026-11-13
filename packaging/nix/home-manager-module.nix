# home-manager module: programs.kisui-terminal
#
# 設定（[server]・[[gui.machines]]・ui-language）は kisui-terminal 自身の config.toml
# （~/.config/kisui-terminal/config.toml。nightly のパッケージなら kisui-terminal-nightly/）にある。
# programs.kisui-terminal.settings に書くと、そのファイルを作る。
# shijimi-editor の config.toml（programs.shijimi-editor.settings）には、もう書かない（読まない。
# ui-language だけは、ここに無ければ shijimi-editor 側のものを使う）。
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
  # nightly のパッケージ（kisui-terminal-nightly）は、自分の名前のフォルダを先に読む
  dir = if lib.hasSuffix "-nightly" (cfg.package.pname or "") then "kisui-terminal-nightly" else "kisui-terminal";
in
{
  options.programs.kisui-terminal = {
    enable = lib.mkEnableOption "kisui-terminal. Built with Nix it has no auto update; update it with `nix flake update` and `home-manager switch`";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.kisui-terminal;
      defaultText = lib.literalExpression "kisui-terminal.packages.\${system}.kisui-terminal";
      description = "The kisui-terminal package to install. Use `kisui-terminal-nightly` for the nightly build (installed under that name, next to the stable one).";
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
      description = "Settings of kisui-terminal, written to `~/.config/kisui-terminal/config.toml` (`kisui-terminal-nightly/` for the nightly package). Nothing is written when it is empty.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
    xdg.configFile."${dir}/config.toml" = lib.mkIf (cfg.settings != { }) {
      source = toml.generate "kisui-terminal-config.toml" cfg.settings;
    };
  };
}
