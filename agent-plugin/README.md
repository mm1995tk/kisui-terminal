# agent-plugin

kisui-terminal のキャラクターを作る skill `make-mascot` を、Claude Code と Codex のプラグイン `kisui-mascot` として配る。

- skill の元は `skills/make-mascot/SKILL.md` の 1 か所。`.claude-plugin/plugin.json` と `.codex-plugin/plugin.json` が同じ `skills/` を指す。
- リポジトリの直下の `.agents/skills`・`.claude/skills` には置かない。置くと、このリポジトリで作業するエージェントに同じ skill が二重に載る。
- SKILL.md には、入れた先でこのリポジトリが無くても使えるよう、形式の要点を書いてある。`docs/mascot.md` の形式（場面・項目・既定の値・画像の決まり）を変えたら、SKILL.md も直す。
