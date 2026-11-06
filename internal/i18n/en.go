package i18n

var en = map[string]string{
	"kisui.usage":        "usage: kisui serve | kisui attach | kisui --version",
	"serve.usage":        "usage: kisui serve",
	"serve.running":      "kisui serve is already running (%s)",
	"serve.failed":       "kisui serve exited without a message. See its log file.",
	"attach.usage":       "usage: kisui attach",
	"config.err.head":    "The configuration has %d error(s), so kisui did not start. Fix them and start it again:",
	"config.err.read":    "cannot read the file: %s",
	"config.err.syntax":  "invalid TOML: %s",
	"config.err.nix":     "cannot evaluate the Nix file: %s",
	"config.err.nixtop":  "the Nix file must evaluate to an attribute set",
	"config.err.int":     "must be an integer",
	"config.err.string":  "must be a string",
	"config.err.table":   "must be a table",
	"config.err.nonneg":  "must be 0 or more",
	"config.err.abspath": "must be an absolute path, or start with ~",
	"config.err.notdir":  "%s is not a folder that exists",
	"config.err.oneof":   "is not valid, or this version of kisui cannot use it. It must be one of: %s",
}
