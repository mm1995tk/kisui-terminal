// Package rpc は GUI と shj の間で話す JSON-RPC 2.0 の型と、メッセージの読み書きを持つ。
// 設計は docs/design/gui-protocol.md の 3 章「プロトコル」。
//
// 個々のメソッド（session.hello など）はここには無い。ここは土台だけ。
package rpc

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Version は JSON-RPC のバージョン文字列。
const Version = "2.0"

// 標準のエラーコード。
const (
	CodeParseError     = -32700
	CodeInvalidRequest = -32600
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeInternalError  = -32603
)

// このプロトコル独自のエラーコード（設計書 3 章の表）。
const (
	CodeIncompatibleProtocol = -32001 // incompatible_protocol: プロトコルの major が合わない
	CodeNotOwner             = -32002 // not_owner: 引き継がれたあとの古い GUI が要求した
	CodeNotFound             = -32003 // not_found: ワークスペース・ターミナル・ファイルが無い
	CodeDenied               = -32004 // denied: 権限が無い、またはワークスペースの外
	CodeBusy                 = -32005 // busy: 上限を超えた、またはターミナルが動いている
)

var codeNames = map[int]string{
	CodeParseError:           "parse_error",
	CodeInvalidRequest:       "invalid_request",
	CodeMethodNotFound:       "method_not_found",
	CodeInvalidParams:        "invalid_params",
	CodeInternalError:        "internal_error",
	CodeIncompatibleProtocol: "incompatible_protocol",
	CodeNotOwner:             "not_owner",
	CodeNotFound:             "not_found",
	CodeDenied:               "denied",
	CodeBusy:                 "busy",
}

// CodeName はエラーコードの名前を返す。知らないコードは "" を返す。
func CodeName(code int) string { return codeNames[code] }

// Error は JSON-RPC のエラーオブジェクト。error も満たす。
type Error struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *Error) Error() string {
	if n := CodeName(e.Code); n != "" {
		return fmt.Sprintf("rpc error %d (%s): %s", e.Code, n, e.Message)
	}
	return fmt.Sprintf("rpc error %d: %s", e.Code, e.Message)
}

// Errorf は code と整形した文言から *Error を作る。
func Errorf(code int, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// ID は要求の id。JSON では数または文字列。生の JSON のまま持ち、そのまま返す。
// 空（nil）は「id が無い」＝通知を表す。
type ID json.RawMessage

// IntID は整数の id を作る。
func IntID(n int64) ID { return ID(fmt.Appendf(nil, "%d", n)) }

// IsZero は id が無い（通知）かを返す。
func (i ID) IsZero() bool { return len(i) == 0 }

// String は id の生の JSON を返す。
func (i ID) String() string { return string(i) }

// Message は線の上を流れる 1 件。要求・通知・応答・エラー応答のどれかになる。
//
//	要求:     ID あり、Method あり
//	通知:     ID なし、Method あり
//	応答:     ID あり、Method なし、Error なし（Result は null でもよい）
//	エラー応答: ID あり、Method なし、Error あり
type Message struct {
	ID     ID
	Method string
	Params json.RawMessage
	Result json.RawMessage
	Error  *Error
}

// IsRequest は要求（返事を求める呼び出し）かを返す。
func (m *Message) IsRequest() bool { return m.Method != "" && !m.ID.IsZero() }

// IsNotification は通知（返事を求めない呼び出し）かを返す。
func (m *Message) IsNotification() bool { return m.Method != "" && m.ID.IsZero() }

// IsResponse は応答（成功でもエラーでも）かを返す。
func (m *Message) IsResponse() bool { return m.Method == "" }

// wire は線の上の形。
type wire struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

// MarshalJSON は標準の形に直す。応答の result は無くても "result": null を出す。
func (m Message) MarshalJSON() ([]byte, error) {
	w := wire{JSONRPC: Version, ID: json.RawMessage(m.ID), Method: m.Method, Params: m.Params, Error: m.Error}
	if m.Method == "" && m.Error == nil {
		w.Result = m.Result
		if len(w.Result) == 0 {
			w.Result = json.RawMessage("null")
		}
	}
	return json.Marshal(w)
}

// UnmarshalJSON は 1 件を読んで、形が標準に合うか確かめる。
// 合わなければ CodeInvalidRequest の *Error を返す。
func (m *Message) UnmarshalJSON(b []byte) error {
	var w wire
	if err := json.Unmarshal(b, &w); err != nil {
		return Errorf(CodeParseError, "parse error: %v", err)
	}
	if w.JSONRPC != Version {
		return Errorf(CodeInvalidRequest, "jsonrpc must be %q", Version)
	}
	// 生の JSON の null は id が無いのと区別できないので、ここで揃える。
	// 標準では応答の id が null になるのは「id を読めなかったエラー」のときだけ。
	if bytes.Equal(bytes.TrimSpace(w.ID), []byte("null")) {
		w.ID = nil
	}
	if len(w.ID) > 0 {
		switch w.ID[0] {
		case '"', '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		default:
			return Errorf(CodeInvalidRequest, "id must be a number or a string")
		}
	}
	*m = Message{ID: ID(w.ID), Method: w.Method, Params: w.Params, Result: w.Result, Error: w.Error}
	switch {
	case m.Method != "":
		if m.Error != nil || len(m.Result) > 0 {
			return Errorf(CodeInvalidRequest, "a request must not have result or error")
		}
	case m.Error != nil:
		if len(m.Result) > 0 {
			return Errorf(CodeInvalidRequest, "a response must not have both result and error")
		}
	case len(m.Result) == 0:
		return Errorf(CodeInvalidRequest, "neither method, result nor error")
	}
	return nil
}
