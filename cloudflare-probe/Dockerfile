FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg unzip \
    && rm -rf /var/lib/apt/lists/*

ARG DENO_VERSION=v2.9.6
RUN curl -fsSL --retry 3 \
      "https://github.com/denoland/deno/releases/download/${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" \
      -o /tmp/deno.zip \
    && unzip -q /tmp/deno.zip -d /tmp/deno \
    && install -m 0755 /tmp/deno/deno /usr/local/bin/deno \
    && rm -rf /tmp/deno /tmp/deno.zip

RUN python -m pip install --no-cache-dir --upgrade "yt-dlp[default]"

WORKDIR /app
COPY server.py /app/server.py

EXPOSE 8080
CMD ["python", "/app/server.py"]
