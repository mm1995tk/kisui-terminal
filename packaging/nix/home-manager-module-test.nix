# home-manager のモジュールの評価の検査（checks.home-manager-module）。
# package = null で何も入れず、channel でフォルダが決まる。
# home-manager 本体は入れず、モジュールが触るオプションだけを仮に置いて評価する
{
  pkgs,
  self,
  system,
}:
let
  lib = pkgs.lib;
  eval =
    module:
    lib.evalModules {
      modules = [
        (import ./home-manager-module.nix self)
        {
          config._module.args.pkgs = pkgs;
          options = {
            home.packages = lib.mkOption {
              type = lib.types.listOf lib.types.package;
              default = [ ];
            };
            xdg.configFile = lib.mkOption {
              type = lib.types.attrsOf lib.types.anything;
              default = { };
            };
            assertions = lib.mkOption {
              type = lib.types.listOf lib.types.unspecified;
              default = [ ];
            };
          };
        }
        {
          programs.kisui-terminal = {
            enable = true;
            settings.server.idle_stop_days = 7;
          }
          // module;
        }
      ];
    };
  files = m: builtins.attrNames (eval m).config.xdg.configFile;
  failed = m: builtins.any (a: !a.assertion) (eval m).config.assertions;
  nightlyPkg = self.packages.${system}.kisui-terminal-nightly;
  cases = [
    {
      name = "package = null: nothing installed";
      ok = (eval { package = null; }).config.home.packages == [ ];
    }
    {
      name = "package = null: stable folder";
      ok = files { package = null; } == [ "kisui-terminal/config.toml" ];
    }
    {
      name = "package = null, channel = nightly";
      ok =
        files {
          package = null;
          channel = "nightly";
        } == [ "kisui-terminal-nightly/config.toml" ];
    }
    {
      name = "default package: installed, stable folder";
      ok =
        files { } == [ "kisui-terminal/config.toml" ]
        && builtins.length (eval { }).config.home.packages == 1;
    }
    {
      name = "stable package, channel = nightly is rejected";
      ok = failed { channel = "nightly"; };
    }
    {
      name = "channel = stable keeps the default";
      ok = !(failed { channel = "stable"; });
    }
    {
      name = "nightly package: nightly folder";
      ok = files { package = nightlyPkg; } == [ "kisui-terminal-nightly/config.toml" ];
    }
    {
      name = "nightly package, channel = stable is rejected";
      ok = failed {
        package = nightlyPkg;
        channel = "stable";
      };
    }
  ];
  bad = map (c: c.name) (builtins.filter (c: !c.ok) cases);
in
pkgs.runCommand "check-home-manager-module" { } (
  if bad == [ ] then
    "touch $out"
  else
    ''
      echo "home-manager module cases failed: ${lib.concatStringsSep ", " bad}" >&2
      exit 1
    ''
)
