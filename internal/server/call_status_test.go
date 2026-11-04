package server

import (
	"testing"
	"time"
)

func TestCallNotificationStatus(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, invite := a.createChat("direct", 1)
	b := e.join(invite, "B")
	x := e.register("X")
	path := "/api/chats/" + itoa(chat) + "/call-status?call=first"
	check := func(want bool) {
		t.Helper()
		var status struct{ Ringing bool }
		b.must(200, "GET", path, nil, &status)
		if status.Ringing != want {
			t.Fatalf("ringing = %v, want %v", status.Ringing, want)
		}
	}
	key := callKey{chat: chat, id: "first"}
	e.s.ring.offer(a.user, a.id, b.user, key, []byte("sealed"), []int64{b.id}, nil)
	check(true)
	x.must(404, "GET", path, nil, nil)
	e.s.ring.offer(a.user, a.id, b.user, callKey{chat: chat, id: "retry"}, []byte("sealed"), []int64{b.id}, nil)
	check(false)
	path = "/api/chats/" + itoa(chat) + "/call-status?call=retry"
	check(true)
	e.s.ring.mu.Lock()
	c := e.s.ring.m[b.user]
	c.until = time.Now().Add(-time.Second)
	e.s.ring.m[b.user] = c
	e.s.ring.mu.Unlock()
	check(false)
	answered := callKey{chat: chat, id: "answered"}
	e.s.ring.offer(a.user, a.id, b.user, answered, []byte("sealed"), []int64{b.id}, nil)
	path = "/api/chats/" + itoa(chat) + "/call-status?call=answered"
	check(true)
	if !e.s.ring.answer(b.user, b.id, a.id, answered, nil) {
		t.Fatal("answer refused")
	}
	check(false)
}

func TestGroupNotificationStatus(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	chat, invite := a.createChat("group", 2)
	b := e.join(invite, "B")
	e.s.groups.byChat[chat] = &groupCall{id: "group-id", devices: map[int64]int64{a.id: a.user}}
	path := "/api/chats/" + itoa(chat) + "/call-status?call=group-id"
	var status struct{ Ringing bool }
	b.must(200, "GET", path, nil, &status)
	if !status.Ringing {
		t.Fatal("running group call was lost")
	}
	a.must(200, "GET", path, nil, &status)
	if status.Ringing {
		t.Fatal("already joined user must not keep ringing")
	}
	b.must(200, "GET", path+"-old", nil, &status)
	if status.Ringing {
		t.Fatal("stale id matched another room")
	}
}
