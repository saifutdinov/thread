"""Music sidecar for Thread (ADR 0004), off unless enabled.

POST /fetch {"url": "https://open.spotify.com/track/<id>"} answers with the
track's audio, found and downloaded by spotDL (Spotify for the metadata,
YouTube Music for the sound). One download at a time; the file is deleted
once sent. Only the app reaches this port, over its own Docker network.

Optional environment: SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET (your own
Spotify app instead of spotDL's shared one), MUSIC_PROXY (a proxy for
spotDL and yt-dlp), and a YouTube cookies file at /config/cookies.txt.
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

TRACK = re.compile(r"https://open\.spotify\.com/track/[0-9A-Za-z]{22}")  # whole string: TRACK.fullmatch
TIMEOUT = 280  # seconds; the app gives up after five minutes
TYPES = {".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".opus": "audio/ogg", ".ogg": "audio/ogg", ".flac": "audio/flac"}
COOKIES = "/config/cookies.txt"

busy = threading.Lock()


def command(url, out, env=os.environ, cookies=COOKIES):
    """The spotDL command line for one track into the folder out."""
    cmd = [
        "spotdl",
        "download",
        url,
        "--output",
        str(Path(out) / "{artists} - {title}.{output-ext}"),
        "--format",
        "m4a",
        "--bitrate",
        "auto",
        "--threads",
        "1",
        "--print-errors",
        "--log-level",
        "ERROR",
    ]
    if env.get("SPOTIFY_CLIENT_ID") and env.get("SPOTIFY_CLIENT_SECRET"):
        cmd += ["--client-id", env["SPOTIFY_CLIENT_ID"], "--client-secret", env["SPOTIFY_CLIENT_SECRET"]]
    if env.get("MUSIC_PROXY"):
        cmd += ["--proxy", env["MUSIC_PROXY"]]
    if os.path.isfile(cookies):
        cmd += ["--cookie-file", cookies]
    return cmd


def run(cmd):
    """Runs spotDL in a process group of its own, so a timeout ends ffmpeg and
    yt-dlp with it. Returns (exit code, output), or None after a timeout."""
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    try:
        out, _ = p.communicate(timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)
        p.communicate()
        return None
    return p.returncode, out


def tags(path):
    """Title and artist from the tags spotDL wrote, the file name otherwise."""
    from mutagen import File, MutagenError

    try:
        f = File(path, easy=True)
    except (MutagenError, OSError):
        f = None
    if f is None:
        return path.stem, ""
    return (f.get("title") or [path.stem])[0], ", ".join(f.get("artist") or [])


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.reply(200 if self.path == "/healthz" else 404)

    def do_POST(self):
        if self.path != "/fetch":
            return self.reply(404)
        try:
            n = max(0, int(self.headers.get("Content-Length") or 0))
            url = json.loads(self.rfile.read(min(n, 4096)) or b"{}").get("url", "")
        except (ValueError, AttributeError):
            return self.reply(400)
        if not isinstance(url, str) or not TRACK.fullmatch(url):
            return self.reply(400)
        if not busy.acquire(blocking=False):
            return self.reply(429)
        tmp = Path(tempfile.mkdtemp())
        try:
            r = run(command(url, tmp))
            if r is None:
                print("spotdl timed out", file=sys.stderr)
                return self.reply(504)
            files = [p for p in tmp.iterdir() if p.suffix in TYPES]
            if not files:
                # spotDL's own words name the track: only the outcome is logged.
                missing = "No results found" in r[1]
                print(f"spotdl exited {r[0]}: {'no match' if missing else 'failed'}", file=sys.stderr)
                return self.reply(404 if missing else 502)
            f = files[0]
            data = f.read_bytes()
            title, artist = tags(f)
            self.send_response(200)
            self.send_header("Content-Type", TYPES[f.suffix])
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Title", quote(title[:300]))
            self.send_header("X-Artist", quote(artist[:300]))
            self.end_headers()
            self.wfile.write(data)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
            busy.release()

    def reply(self, code):
        self.send_response(code)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, fmt, *args):
        pass  # which tracks people fetch stays out of the logs


if __name__ == "__main__":
    ThreadingHTTPServer(("", 8090), Handler).serve_forever()
