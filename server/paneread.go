package server

// ほかのペインの画面を字で読む（kisui pane read。#342）。設計は docs/design/gui-protocol.md の「ペインの中のコマンド」。
//
// 相手は名前か id で指す（termManager.find。このマシンのどのワークスペース・タブのペインでもよい）。字は、serve が
// ペインごとに持つ画面の状態（screenFeed の coneko-term）から作る。色や装飾は入らない。

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// maxReadLines は kisui pane read --lines で遡れる scrollback の行数。serve の coneko-term が持つ scrollback
// （coneko-term の既定。GUI と同じ）がこれだけなので、多く頼まれても、あるだけを返す。
const maxReadLines = snapshotScrollback

// readTimeout は、画面の状態が届いた出力に追いつくのを待つ時間。kisui の待ち時間（panecmd.Timeout）より短くする。
var readTimeout = 5 * time.Second // テストが短くする

var errBadLines = errors.New("the number of lines must not be negative")

// readScreen は kisui pane read。名前か id が target のペインの、見えている画面に、その上の scrollback を
// 新しいほうから lines 行まで足した字を返す（cleanScreenText で整える）。返す id は見つけたペイン。
func (m *termManager) readScreen(target string, lines int) (text, id string, err error) {
	if lines < 0 {
		return "", "", fmt.Errorf("%w: %d", errBadLines, lines)
	}
	t, err := m.find(target)
	if err != nil {
		return "", "", err
	}
	t.mu.Lock()
	res := t.feed.text(min(lines, maxReadLines)) // それまでの出力を全部反映した画面を読む
	t.mu.Unlock()
	timer := time.NewTimer(readTimeout)
	defer timer.Stop()
	select {
	case r := <-res:
		if r.err != nil {
			return "", t.id, fmt.Errorf("cannot read the screen of %s: %w", t.id, r.err)
		}
		return cleanScreenText(string(r.data)), t.id, nil
	case <-timer.C:
		return "", t.id, fmt.Errorf("the screen of %s is not ready (much output is still being read; try again)", t.id)
	}
}

// cleanScreenText は画面の字を整える：行末の空白と、終わりの空の行（プロンプトより下の、まだ何も書かれていない行）を落とし、
// 字があれば改行で終える。
func cleanScreenText(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " ")
	}
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n") + "\n"
}
