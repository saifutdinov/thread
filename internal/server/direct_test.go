package server

import "testing"

func TestDirectChat(t *testing.T) {
	e := newEnv(t)
	a := e.register("A")
	group, key := a.createChat("group", 5)
	b := e.join(key, "B")
	y := e.join(key, "Y")
	x := e.register("X")
	keys := func(devices ...int64) []map[string]any {
		out := []map[string]any{}
		for _, d := range devices {
			out = append(out, map[string]any{"device": d, "wrapped": wrapped()})
		}
		return out
	}
	type direct struct {
		ChatID   int64 `json:"chat_id"`
		Existing bool  `json:"existing"`
	}
	const path = "/api/chats/direct"

	// Only someone you share a chat with (not who left it), and not yourself.
	a.must(404, "POST", path, map[string]any{"user": x.user, "keys": keys(a.id, x.id)}, nil)
	y.must(200, "DELETE", "/api/chats/"+itoa(group), nil, nil)
	a.must(404, "POST", path, map[string]any{"user": y.user, "keys": keys(a.id, y.id)}, nil)
	a.must(400, "POST", path, map[string]any{"user": a.user, "keys": keys(a.id)}, nil)
	// The first key goes to every device of both, or the chat is not made.
	a.must(409, "POST", path, map[string]any{"user": b.user, "keys": keys(a.id)}, nil)

	var made direct
	a.must(200, "POST", path, map[string]any{"user": b.user, "keys": keys(a.id, b.id)}, &made)
	if made.ChatID == 0 || made.ChatID == group || made.Existing {
		t.Fatalf("made %+v", made)
	}
	var chats []struct {
		ID      int64  `json:"id"`
		Kind    string `json:"kind"`
		Epoch   int    `json:"epoch"`
		Members []struct {
			ID int64 `json:"id"`
		} `json:"members"`
	}
	b.must(200, "GET", "/api/chats", nil, &chats)
	found := false
	for _, c := range chats {
		if c.ID == made.ChatID {
			found = c.Kind == "direct" && c.Epoch == 1 && len(c.Members) == 2
		}
	}
	if !found {
		t.Fatalf("B's chats: %+v", chats)
	}
	var bKeys []wrappedKey
	b.must(200, "GET", "/api/keys", nil, &bKeys)
	found = false
	for _, k := range bKeys {
		found = found || (k.Chat == made.ChatID && k.Epoch == 1)
	}
	if !found {
		t.Fatal("B got no key for the new chat")
	}

	// Asked again, from either side: the same chat, nothing new.
	var again direct
	b.must(200, "POST", path, map[string]any{"user": a.user, "keys": keys(a.id, b.id)}, &again)
	if again.ChatID != made.ChatID || !again.Existing {
		t.Fatalf("again %+v, made %+v", again, made)
	}
	// After B leaves it, A can start a new one.
	b.must(200, "DELETE", "/api/chats/"+itoa(made.ChatID), nil, nil)
	var fresh direct
	a.must(200, "POST", path, map[string]any{"user": b.user, "keys": keys(a.id, b.id)}, &fresh)
	if fresh.ChatID == made.ChatID || fresh.Existing {
		t.Fatalf("fresh %+v", fresh)
	}
}
