package server

import "testing"

func TestCallIgnoresUnselectedDeviceAfterAnswer(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("direct", 1)
	b := e.join(key, "B")
	b2 := e.secondDevice(b)
	wa, wb, w2 := a.socket(t), b.socket(t), b2.socket(t)
	emit(t, wa, map[string]any{"t": "call", "k": "offer", "c": chat, "id": "chosen", "e": 1, "body": []byte("sealed")})
	expectCall(t, wb, "offer")
	expectCall(t, w2, "offer")
	emit(t, wb, map[string]any{"t": "call", "k": "answer", "c": chat, "id": "chosen", "to": a.id, "e": 1, "body": []byte("sealed")})
	expectCall(t, wa, "answer")
	expectCall(t, w2, "taken")
	for _, kind := range []string{"busy", "decline", "hangup", "ice", "restart"} {
		emit(t, w2, map[string]any{"t": "call", "k": kind, "c": chat, "id": "chosen", "to": a.id})
	}
	expectCall(t, wa, "")
	emit(t, wb, map[string]any{"t": "call", "k": "hangup", "c": chat, "id": "chosen", "to": a.id})
	expectCall(t, wa, "hangup")
}

func TestCallBusyDeviceLeavesSiblingAbleToAnswer(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("direct", 1)
	b := e.join(key, "B")
	b2 := e.secondDevice(b)
	wa, wb, w2 := a.socket(t), b.socket(t), b2.socket(t)
	emit(t, wa, map[string]any{"t": "call", "k": "offer", "c": chat, "id": "free-phone", "e": 1, "body": []byte("sealed")})
	expectCall(t, wb, "offer")
	expectCall(t, w2, "offer")
	emit(t, w2, map[string]any{"t": "call", "k": "busy", "c": chat, "id": "free-phone", "to": a.id})
	expectCall(t, wa, "")
	emit(t, wb, map[string]any{"t": "call", "k": "answer", "c": chat, "id": "free-phone", "to": a.id, "e": 1, "body": []byte("sealed")})
	expectCall(t, wa, "answer")
}

func TestCallAllDevicesBusy(t *testing.T) {
	r := newRinging()
	key := callKey{chat: 1, id: "busy"}
	d20, d21 := make(chan struct{}), make(chan struct{})
	live := map[int64][]<-chan struct{}{20: {d20}, 21: {d21}}
	if status, _ := r.offer(1, 10, 2, key, []byte("offer"), []int64{20, 21}, nil); status != 1 {
		t.Fatal("offer refused")
	}
	if r.busy(2, 20, 10, key, d20, live) {
		t.Fatal("one busy device ended the call")
	}
	if !r.busy(2, 21, 10, key, d21, live) {
		t.Fatal("all busy devices did not end the call")
	}
	if r.answer(2, 20, 10, key, d20) {
		t.Fatal("answered a finished call")
	}
}

func TestCallSecondOfferDoesNotReplaceFirst(t *testing.T) {
	r := newRinging()
	first, second := callKey{chat: 1, id: "first"}, callKey{chat: 2, id: "second"}
	r.offer(1, 10, 2, first, []byte("first"), []int64{20}, nil)
	if status, _ := r.offer(3, 30, 2, second, []byte("second"), []int64{20}, nil); status != -1 {
		t.Fatal("replaced the ringing call")
	}
	if !r.answer(2, 20, 10, first, nil) {
		t.Fatal("first offer was lost")
	}
}

func TestCallAnswerInAnotherTabDoesNotCancelWinner(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("direct", 1)
	b := e.join(key, "B")
	wa, first, second := a.socket(t), b.socket(t), b.socket(t)
	emit(t, wa, map[string]any{"t": "call", "k": "offer", "c": chat, "id": "tabs", "e": 1, "body": []byte("sealed")})
	expectCall(t, first, "offer")
	expectCall(t, second, "offer")
	answer := map[string]any{"t": "call", "k": "answer", "c": chat, "id": "tabs", "to": a.id, "e": 1, "body": []byte("sealed")}
	emit(t, first, answer)
	expectCall(t, wa, "answer")
	expectCall(t, second, "taken")
	emit(t, second, answer)
	expectCall(t, second, "taken")
	expectCall(t, first, "")
	expectCall(t, wa, "")
}

func TestCallHangupAfterServerForgetsActiveState(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("direct", 1)
	b := e.join(key, "B")
	wa, wb := a.socket(t), b.socket(t)
	emit(t, wa, map[string]any{"t": "call", "k": "offer", "c": chat, "id": "restart", "e": 1, "body": []byte("sealed")})
	expectCall(t, wb, "offer")
	emit(t, wb, map[string]any{"t": "call", "k": "answer", "c": chat, "id": "restart", "to": a.id, "e": 1, "body": []byte("sealed")})
	expectCall(t, wa, "answer")
	e.s.ring.mu.Lock()
	clear(e.s.ring.active)
	e.s.ring.mu.Unlock()
	emit(t, wa, map[string]any{"t": "call", "k": "hangup", "c": chat, "id": "restart", "to": b.id})
	expectCall(t, wb, "hangup")
}

func TestCallUnselectedTabCannotRelayAfterAnswer(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("direct", 1)
	b := e.join(key, "B")
	wa, first, second := a.socket(t), b.socket(t), b.socket(t)
	emit(t, wa, map[string]any{"t": "call", "k": "offer", "c": chat, "id": "tab-signals", "e": 1, "body": []byte("sealed")})
	expectCall(t, first, "offer")
	expectCall(t, second, "offer")
	emit(t, first, map[string]any{"t": "call", "k": "answer", "c": chat, "id": "tab-signals", "to": a.id, "e": 1, "body": []byte("sealed")})
	expectCall(t, wa, "answer")
	expectCall(t, second, "taken")
	for _, kind := range []string{"ice", "restart", "hangup"} {
		emit(t, second, map[string]any{"t": "call", "k": kind, "c": chat, "id": "tab-signals", "to": a.id, "e": 1, "body": []byte("late")})
	}
	expectCall(t, wa, "")
	emit(t, first, map[string]any{"t": "call", "k": "hangup", "c": chat, "id": "tab-signals", "to": a.id})
	expectCall(t, wa, "hangup")
}

func TestCallBusyTabLeavesSiblingTabAbleToAnswer(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("direct", 1)
	b := e.join(key, "B")
	wa, busy, free := a.socket(t), b.socket(t), b.socket(t)
	emit(t, wa, map[string]any{"t": "call", "k": "offer", "c": chat, "id": "free-tab", "e": 1, "body": []byte("sealed")})
	expectCall(t, busy, "offer")
	expectCall(t, free, "offer")
	emit(t, busy, map[string]any{"t": "call", "k": "busy", "c": chat, "id": "free-tab", "to": a.id})
	expectCall(t, wa, "")
	emit(t, free, map[string]any{"t": "call", "k": "answer", "c": chat, "id": "free-tab", "to": a.id, "e": 1, "body": []byte("sealed")})
	expectCall(t, wa, "answer")
}

func TestCallSelectedSocketCanReconnect(t *testing.T) {
	r := newRinging()
	key := callKey{chat: 1, id: "reconnect"}
	caller, callee, sibling, reconnected := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	r.offer(1, 10, 2, key, []byte("offer"), []int64{20}, caller)
	if !r.answer(2, 20, 10, key, callee) {
		t.Fatal("answer refused")
	}
	if r.relay(2, 20, 10, key, sibling) {
		t.Fatal("another live tab took over")
	}
	close(callee)
	if !r.relay(2, 20, 10, key, reconnected) {
		t.Fatal("device could not reconnect")
	}
	if r.relay(2, 20, 10, key, callee) {
		t.Fatal("old socket took over after reconnect")
	}
	if _, _, ended := r.end(2, 20, 1, key, "hangup", sibling); ended {
		t.Fatal("sibling ended reconnected call")
	}
	if _, _, ended := r.end(2, 20, 1, key, "hangup", reconnected); !ended {
		t.Fatal("selected socket could not hang up")
	}
}

func TestCallLateConnectedTabRemainsAbleToAnswer(t *testing.T) {
	r := newRinging()
	key := callKey{chat: 1, id: "late-tab"}
	first, late, otherDevice := make(chan struct{}), make(chan struct{}), make(chan struct{})
	r.offer(1, 10, 2, key, []byte("offer"), []int64{20, 21}, nil)
	live := map[int64][]<-chan struct{}{20: {first}, 21: {otherDevice}}
	if r.busy(2, 20, 10, key, first, live) {
		t.Fatal("other device still rings")
	}
	live[20] = append(live[20], late)
	if r.busy(2, 21, 10, key, otherDevice, live) {
		t.Fatal("new tab still rings")
	}
	if !r.answer(2, 20, 10, key, late) {
		t.Fatal("new tab could not answer")
	}
}

func TestCallRetryAfterCallerReload(t *testing.T) {
	r := newRinging()
	first, retry := callKey{chat: 1, id: "first"}, callKey{chat: 1, id: "retry"}
	gone := make(chan struct{})
	r.offer(1, 10, 2, first, []byte("first"), []int64{20}, gone)
	close(gone)
	if status, _ := r.offer(1, 10, 2, retry, []byte("retry"), []int64{20}, make(chan struct{})); status != 1 {
		t.Fatal("reloaded caller must be able to retry immediately")
	}
	if r.answer(2, 20, 10, first, nil) {
		t.Fatal("answered the replaced call")
	}
	if !r.answer(2, 20, 10, retry, nil) {
		t.Fatal("retry was lost")
	}
}

func TestCallRetryStopsPreviousRingBeforeNewOffer(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, key := a.createChat("direct", 1)
	b := e.join(key, "B")
	wa, wb := a.socket(t), b.socket(t)
	emit(t, wa, map[string]any{"t": "call", "k": "offer", "c": chat, "id": "old", "e": 1, "body": []byte("old")})
	expectCall(t, wb, "offer")
	emit(t, wa, map[string]any{"t": "call", "k": "offer", "c": chat, "id": "new", "e": 1, "body": []byte("new")})
	if ev := expectCall(t, wb, "taken"); ev["id"] != "old" {
		t.Fatalf("stopped wrong ring: %v", ev)
	}
	if ev := expectCall(t, wb, "offer"); ev["id"] != "new" {
		t.Fatalf("wrong replacement: %v", ev)
	}
	emit(t, wb, map[string]any{"t": "call", "k": "answer", "c": chat, "id": "old", "to": a.id})
	expectCall(t, wb, "taken")
	emit(t, wb, map[string]any{"t": "call", "k": "answer", "c": chat, "id": "new", "to": a.id, "e": 1, "body": []byte("answer")})
	expectCall(t, wa, "answer")
}

func TestCallLiveSiblingCannotReplacePendingOffer(t *testing.T) {
	r := newRinging()
	first, sibling := make(chan struct{}), make(chan struct{})
	key := callKey{chat: 1, id: "first"}
	r.offer(1, 10, 2, key, []byte("first"), []int64{20}, first)
	if status, _ := r.offer(1, 10, 2, callKey{chat: 1, id: "sibling"}, []byte("second"), []int64{20}, sibling); status != -1 {
		t.Fatal("live sibling replaced the selected caller tab")
	}
}

func TestCallBusyLeavesPushOnlyPhoneAbleToAnswer(t *testing.T) {
	r := newRinging()
	key := callKey{chat: 1, id: "push-phone"}
	laptop, phone := make(chan struct{}), make(chan struct{})
	r.offer(1, 10, 2, key, []byte("offer"), []int64{20, 21}, nil)
	if r.busy(2, 20, 10, key, laptop, map[int64][]<-chan struct{}{20: {laptop}}) {
		t.Fatal("busy laptop cancelled push-only phone")
	}
	if !r.answer(2, 21, 10, key, phone) {
		t.Fatal("phone waking from push could not answer")
	}
}
