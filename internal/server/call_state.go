package server

import (
	"sync"
	"time"
)

type callKey struct {
	chat int64
	id   string
}

type pendingCall struct {
	callKey
	caller, callee, callerDevice, calleeDevice int64
	ev                                         []byte
	until                                      time.Time
	callerDone, calleeDone                     <-chan struct{}
	devices                                    map[int64]map[<-chan struct{}]bool // device -> socket -> reported busy
}

// A pending call belongs to a person; an answered one belongs to the two
// selected devices. Keeping both states prevents a late busy/decline from
// another phone from cancelling the selected connection.
type ringing struct {
	mu     sync.Mutex
	m      map[int64]pendingCall // callee -> ringing call
	active map[callKey]pendingCall
}

func newRinging() *ringing {
	return &ringing{m: map[int64]pendingCall{}, active: map[callKey]pendingCall{}}
}

// offer: 1 starts ringing, 0 is a repeat, -1 means another call is ringing.
// A retry from the selected caller tab (or its reconnected socket) replaces
// its pending call. The returned old call must be stopped before the new offer.
func (r *ringing) offer(caller, device, callee int64, key callKey, ev []byte, devices []int64, done <-chan struct{}) (int, *pendingCall) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.active[key]; ok {
		return 0, nil
	}
	var replaced *pendingCall
	if old, ok := r.m[callee]; ok && time.Now().Before(old.until) {
		if old.caller != caller || old.callerDevice != device || !sameCallSocket(old.callerDone, done) {
			return -1, nil
		}
		if old.callKey == key {
			old.callerDone = done
			r.m[callee] = old
			return 0, nil
		}
		replaced = &old
	}
	busy := make(map[int64]map[<-chan struct{}]bool, len(devices))
	for _, d := range devices {
		busy[d] = map[<-chan struct{}]bool{}
	}
	r.m[callee] = pendingCall{callKey: key, caller: caller, callerDevice: device, callee: callee,
		ev: ev, until: time.Now().Add(ringFor), devices: busy, callerDone: done}
	return 1, replaced
}

func (r *ringing) answer(user, device, to int64, key callKey, done <-chan struct{}) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.m[user]
	if !ok || c.callKey != key || c.callerDevice != to || !time.Now().Before(c.until) {
		return false
	}
	delete(r.m, user)
	c.calleeDevice = device
	c.calleeDone = done
	c.ev, c.devices = nil, nil
	c.until = time.Now().Add(24 * time.Hour)
	r.active[key] = c
	return true
}

// Only every currently connected tab of every device being busy ends a
// ring. An offline device or another still-ringing tab may pick up later.
func (r *ringing) busy(user, device, to int64, key callKey, done <-chan struct{}, live map[int64][]<-chan struct{}) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.m[user]
	if !ok || c.callKey != key || c.callerDevice != to || !time.Now().Before(c.until) {
		return false
	}
	if _, ok := c.devices[device]; !ok {
		return false
	}
	for d, sockets := range live {
		if c.devices[d] == nil {
			c.devices[d] = map[<-chan struct{}]bool{}
		}
		for _, socket := range sockets {
			if _, exists := c.devices[d][socket]; !exists {
				c.devices[d][socket] = false
			}
		}
	}
	c.devices[device][done] = true
	for d, sockets := range c.devices {
		if len(live[d]) == 0 {
			return false
		}
		for _, socket := range live[d] {
			if !sockets[socket] {
				return false
			}
		}
	}
	delete(r.m, user)
	return true
}

func (r *ringing) end(user, device, peer int64, key callKey, kind string, done <-chan struct{}) (to, ringingUser int64, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if c, exists := r.active[key]; exists {
		if kind != "hangup" {
			return 0, 0, false
		}
		switch {
		case c.caller == user && c.callerDevice == device && sameCallSocket(c.callerDone, done):
			to = c.calleeDevice
		case c.callee == user && c.calleeDevice == device && sameCallSocket(c.calleeDone, done):
			to = c.callerDevice
		default:
			return 0, 0, false
		}
		delete(r.active, key)
		return to, 0, true
	}
	if c, exists := r.m[user]; exists && c.callKey == key && time.Now().Before(c.until) {
		if kind == "decline" || (kind == "hangup" && device != 0) {
			delete(r.m, user)
			return c.callerDevice, user, true
		}
	}
	if c, exists := r.m[peer]; exists && c.callKey == key && c.caller == user && c.callerDevice == device && sameCallSocket(c.callerDone, done) && kind == "hangup" {
		delete(r.m, peer)
		return 0, peer, true // still ringing: reach every device of the callee
	}
	return 0, 0, false
}

func (r *ringing) relay(user, device, to int64, key callKey, done <-chan struct{}) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.active[key]
	if !ok {
		// A server restart forgets call state, while the browser's encrypted
		// WebRTC connection survives and may need an ICE restart.
		return true
	}
	switch {
	case user == c.caller && device == c.callerDevice && to == c.calleeDevice && sameCallSocket(c.callerDone, done):
		c.callerDone = done
	case user == c.callee && device == c.calleeDevice && to == c.callerDevice && sameCallSocket(c.calleeDone, done):
		c.calleeDone = done
	default:
		return false
	}
	r.active[key] = c
	return true
}

func sameCallSocket(selected, incoming <-chan struct{}) bool {
	if selected == incoming {
		return true
	}
	select {
	case <-selected: // the same device reconnects after losing its socket
		return true
	default:
		return false
	}
}

func (r *ringing) get(user int64) []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.m[user]
	if !ok || time.Now().After(c.until) {
		delete(r.m, user)
		return nil
	}
	return c.ev
}

func (r *ringing) prune() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for user, c := range r.m {
		if time.Now().After(c.until) {
			delete(r.m, user)
		}
	}
	for key, c := range r.active {
		if time.Now().After(c.until) {
			delete(r.active, key)
		}
	}
}
