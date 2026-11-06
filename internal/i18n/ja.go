package i18n

var ja = map[string]string{
	"kisui.usage":        "usage: kisui serve | kisui attach | kisui --version",
	"serve.usage":        "usage: kisui serve",
	"serve.running":      "kisui serve はすでに動いています（%s）",
	"serve.failed":       "kisui serve はメッセージを出さずに終了しました。ログファイルを見てください。",
	"attach.usage":       "usage: kisui attach",
	"config.err.head":    "設定に間違いが %d 件あるため、kisui を起動しませんでした。直してからもう一度起動してください。",
	"config.err.read":    "ファイルを読めません: %s",
	"config.err.syntax":  "TOML の書き方が間違っています: %s",
	"config.err.nix":     "Nix のファイルを評価できません: %s",
	"config.err.nixtop":  "Nix のファイルは属性集合（{ ... }）に評価される必要があります",
	"config.err.int":     "整数で書いてください",
	"config.err.string":  "文字列で書いてください",
	"config.err.table":   "テーブルで書いてください",
	"config.err.nonneg":  "0 以上で書いてください",
	"config.err.abspath": "絶対パスか、~ で始めて書いてください",
	"config.err.notdir":  "%s というフォルダはありません",
	"config.err.oneof":   "値が正しくないか、この版の kisui では使えない値です。次のどれかで書いてください: %s",
}
