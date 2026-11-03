# Music sidecar (ADR 0004): spotDL finds a Spotify track's audio on YouTube
# Music and hands it to the app, which alone may reach it. When YouTube
# changes and downloads start failing, bump yt-dlp (and spotdl) in
# pyproject.toml and run `uv lock`.
FROM python:3.13.18-slim-trixie@sha256:ae14d4ce8771606477a81446e7ef429edd6762305fc50c84507c1041fa8285d1
COPY --from=astral/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 /uv /bin/uv
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
ENV UV_PYTHON_DOWNLOADS=never UV_COMPILE_BYTECODE=1 UV_NO_CACHE=1 PATH=/app/.venv/bin:$PATH
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY server.py ./
RUN useradd --create-home --uid 10001 music
USER music
WORKDIR /home/music
EXPOSE 8090
CMD ["python", "-u", "/app/server.py"]
