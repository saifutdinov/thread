// Package hotkeys implements a local native-messaging companion. It never
// handles audio, chat identifiers, network requests, or arbitrary key logs.
package hotkeys

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"sync"
	"time"
)

type Binding struct {
	Code  string `json:"code"`
	Ctrl  bool   `json:"ctrl"`
	Alt   bool   `json:"alt"`
	Shift bool   `json:"shift"`
	Meta  bool   `json:"meta"`
}

var validCode = regexp.MustCompile(`^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Backspace|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|Insert|Delete)$`)

func (b Binding) Valid() bool { return validCode.MatchString(b.Code) }

type Config struct {
	Type    string  `json:"type"`
	Binding Binding `json:"binding"`
	Enabled bool    `json:"enabled"`
	Session string  `json:"session"`
}
type State struct {
	Type    string `json:"type"`
	Down    bool   `json:"down"`
	Session string `json:"session"`
	Version int    `json:"version,omitempty"`
}

// Arming requires release after configuration, so assigning a held key or
// beginning the next call cannot accidentally open the microphone.
type Gate struct{ armed, held bool }

func (g *Gate) Reset() { g.armed, g.held = false, false }
func (g *Gate) Poll(down bool) bool {
	if !down {
		g.armed, g.held = true, false
	} else {
		g.held = g.armed
	}
	return g.held
}

func Read(r io.Reader) (Config, error) {
	var size uint32
	if err := binary.Read(r, binary.LittleEndian, &size); err != nil {
		return Config{}, err
	}
	if size == 0 || size > 4096 {
		return Config{}, errors.New("invalid_frame")
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(r, data); err != nil {
		return Config{}, err
	}
	var c Config
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&c); err != nil {
		return Config{}, err
	}
	if d.Decode(new(json.RawMessage)) != io.EOF {
		return Config{}, errors.New("invalid_frame")
	}
	if c.Type != "configure" || len(c.Session) > 64 || !c.Binding.Valid() {
		return Config{}, errors.New("invalid_config")
	}
	return c, nil
}

func Run(in io.Reader, out io.Writer, pressed func(Binding) bool) error {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	return run(in, out, pressed, ticker.C, time.Now)
}

func run(in io.Reader, out io.Writer, pressed func(Binding) bool, ticks <-chan time.Time, now func() time.Time) error {
	var stateMu, writeMu sync.Mutex
	write := func(s State) error {
		data, err := json.Marshal(s)
		if err != nil {
			return err
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := binary.Write(out, binary.LittleEndian, uint32(len(data))); err != nil {
			return err
		}
		_, err = out.Write(data)
		return err
	}
	if err := write(State{Type: "ready", Version: 1}); err != nil {
		return err
	}
	var c Config
	var bindingAt time.Time
	var gate Gate
	done, stopped := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(stopped)
		var sent State
		last := time.Time{}
		for {
			select {
			case <-done:
				return
			case tick := <-ticks:
				stateMu.Lock()
				s := State{Type: "state", Session: c.Session}
				if c.Enabled {
					s.Down = gate.Poll(pressed(c.Binding))
				}
				if s != sent || tick.Sub(last) >= 300*time.Millisecond {
					if err := write(s); err != nil {
						stateMu.Unlock()
						return
					}
					sent, last = s, tick
				}
				stateMu.Unlock()
			}
		}
	}()
	defer func() { close(done); <-stopped; _ = write(State{Type: "state", Session: c.Session}) }()
	for {
		next, err := Read(in)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		stateMu.Lock()
		if next.Binding != c.Binding {
			at := now()
			if !bindingAt.IsZero() && at.Sub(bindingAt) < time.Second {
				stateMu.Unlock()
				return errors.New("binding_rate_limited")
			}
			bindingAt = at
		}
		c = next
		gate.Reset()
		err = write(State{Type: "state", Session: c.Session})
		stateMu.Unlock()
		if err != nil {
			return err
		}
	}
}
