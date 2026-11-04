package hotkeys

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"sync/atomic"
	"testing"
	"time"
)

func frame(v any) []byte {
	data, _ := json.Marshal(v)
	var b bytes.Buffer
	_ = binary.Write(&b, binary.LittleEndian, uint32(len(data)))
	b.Write(data)
	return b.Bytes()
}
func TestFramesRejectUnboundedAndUnknownCommands(t *testing.T) {
	var big bytes.Buffer
	_ = binary.Write(&big, binary.LittleEndian, uint32(4097))
	trailing := frame(Config{Type: "configure", Binding: Binding{Code: "Space"}})
	trailing = append(trailing, []byte("{}")...)
	binary.LittleEndian.PutUint32(trailing, uint32(len(trailing)-4))
	for _, data := range [][]byte{big.Bytes(), trailing, frame(map[string]any{"type": "exec", "binding": Binding{Code: "Space"}}), frame(map[string]any{"type": "configure", "binding": Binding{Code: "Space"}, "command": "private"})} {
		if _, err := Read(bytes.NewReader(data)); err == nil {
			t.Fatal("accepted invalid command")
		}
	}
	c := Config{Type: "configure", Binding: Binding{Code: "KeyV", Ctrl: true, Shift: true}, Session: "opaque", Enabled: true}
	if got, err := Read(bytes.NewReader(frame(c))); err != nil || got != c {
		t.Fatalf("round trip: %v %v", got, err)
	}
}
func TestGateRequiresReleaseAfterConfiguration(t *testing.T) {
	var g Gate
	if g.Poll(true) {
		t.Fatal("already-held key activated")
	}
	g.Poll(false)
	if !g.Poll(true) {
		t.Fatal("fresh press ignored")
	}
	g.Reset()
	if g.Poll(true) {
		t.Fatal("configuration retained held input")
	}
}
func TestNativeHostFramesReleaseAndStopPollingOnDisconnect(t *testing.T) {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	var pressed atomic.Bool
	var polls atomic.Int64
	ticks := make(chan time.Time)
	polled := make(chan struct{}, 1)
	done := make(chan error, 1)
	go func() {
		done <- run(inR, outW, func(Binding) bool { down := pressed.Load(); polls.Add(1); polled <- struct{}{}; return down }, ticks, time.Now)
		_ = outW.Close()
	}()
	states := make(chan State, 32)
	go func() {
		defer close(states)
		for {
			var n uint32
			if binary.Read(outR, binary.LittleEndian, &n) != nil {
				return
			}
			b := make([]byte, n)
			if _, err := io.ReadFull(outR, b); err != nil {
				return
			}
			var s State
			if json.Unmarshal(b, &s) == nil {
				states <- s
			}
		}
	}()
	defer func() { _ = inW.Close(); _ = outR.Close() }()
	wait := func(match func(State) bool) {
		t.Helper()
		timer := time.NewTimer(2 * time.Second)
		defer timer.Stop()
		for {
			select {
			case s, ok := <-states:
				if !ok {
					t.Fatal("host stopped early")
				}
				if match(s) {
					return
				}
			case <-timer.C:
				t.Fatal("no expected state")
			}
		}
	}
	wait(func(s State) bool { return s.Type == "ready" })
	if polls.Load() != 0 {
		t.Fatal("polled without an active configuration")
	}
	pressed.Store(true)
	_, _ = inW.Write(frame(Config{Type: "configure", Binding: Binding{Code: "F9"}, Enabled: true, Session: "one"}))
	wait(func(s State) bool { return s.Type == "state" && s.Session == "one" && !s.Down })
	pressed.Store(false)
	ticks <- time.Now()
	<-polled
	pressed.Store(true)
	ticks <- time.Now()
	<-polled
	wait(func(s State) bool { return s.Session == "one" && s.Down })
	pressed.Store(false)
	ticks <- time.Now()
	<-polled
	wait(func(s State) bool { return s.Session == "one" && !s.Down })
	_ = inW.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("host did not exit on disconnect")
	}
}

func TestNativeHostRejectsRapidBindingChanges(t *testing.T) {
	for _, delay := range []time.Duration{0, 999 * time.Millisecond, time.Second} {
		t.Run(delay.String(), func(t *testing.T) {
			one := Config{Type: "configure", Binding: Binding{Code: "F9"}, Enabled: true, Session: "one"}
			two := one
			two.Binding.Code = "F10"
			input := bytes.NewReader(append(frame(one), frame(two)...))
			var output bytes.Buffer
			at := time.Unix(100, 0)
			err := run(input, &output, func(Binding) bool { t.Error("unexpected polling"); return false }, nil, func() time.Time { v := at; at = at.Add(delay); return v })
			if delay < time.Second {
				if err == nil || err.Error() != "binding_rate_limited" {
					t.Fatalf("rapid change accepted: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestNativeHostAllowsSessionAndEnableUpdatesForTheSameBinding(t *testing.T) {
	one := Config{Type: "configure", Binding: Binding{Code: "F9"}, Enabled: true, Session: "one"}
	two := one
	two.Enabled = false
	two.Session = "two"
	var output bytes.Buffer
	if err := run(bytes.NewReader(append(frame(one), frame(two)...)), &output, func(Binding) bool { return false }, nil, func() time.Time { return time.Unix(100, 0) }); err != nil {
		t.Fatal(err)
	}
}
