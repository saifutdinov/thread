"""Checks for the music sidecar without spotDL or a network:
uv run --only-group dev pytest (in deploy/music)."""

import pytest

import server


def test_track_link():
    assert server.TRACK.fullmatch("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")


@pytest.mark.parametrize(
    "bad",
    [
        "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x",
        "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC\n",
        "https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC",
        "http://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
        "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC --output /etc",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ],
)
def test_other_links(bad):
    assert server.TRACK.fullmatch(bad) is None


def test_run_ends_the_whole_group_on_timeout(monkeypatch):
    monkeypatch.setattr(server, "TIMEOUT", 0.2)
    assert server.run(["sh", "-c", "sleep 5 & sleep 5"]) is None
    assert server.run(["sh", "-c", "echo hi; exit 3"]) == (3, "hi\n")


def test_command_plain(tmp_path):
    cmd = server.command("https://open.spotify.com/track/x", tmp_path, env={}, cookies=str(tmp_path / "none"))
    assert cmd[:3] == ["spotdl", "download", "https://open.spotify.com/track/x"]
    assert "--proxy" not in cmd and "--client-id" not in cmd and "--cookie-file" not in cmd


def test_command_options(tmp_path):
    cookies = tmp_path / "cookies.txt"
    cookies.write_text("")
    env = {"MUSIC_PROXY": "http://p:3128", "SPOTIFY_CLIENT_ID": "id", "SPOTIFY_CLIENT_SECRET": "s"}
    cmd = server.command("u", tmp_path, env=env, cookies=str(cookies))
    assert cmd[cmd.index("--proxy") + 1] == "http://p:3128"
    assert cmd[cmd.index("--client-secret") + 1] == "s"
    assert cmd[cmd.index("--cookie-file") + 1] == str(cookies)
