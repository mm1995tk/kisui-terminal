# home-manager module: programs.kisui-terminal
#
# 設定（[server] と [[gui.machines]]）は shj と同じ config.toml にあるので、shijimi-editor の
# home-manager モジュールの programs.shijimi-editor.settings で書く（shijimi-editor のマニュアルの
# 「Nix と home-manager」）。ここは入れるだけ。
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.kisui-terminal;
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
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
