const DEFAULT_VIDEO_ID = "2NJdNKJ9LPM";
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const RANGE_PROBE_BYTES = 64 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function decodeHtml(text) {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1].replace(/\s+/g, " ").trim()) : null;
}

function probeSignals(html) {
  const lower = html.toLowerCase();
  return {
    bot_challenge:
      lower.includes("sign in to confirm you're not a bot") ||
      lower.includes("unusual traffic") ||
      lower.includes("verify it's you"),
    consent_page:
      lower.includes("consent.youtube.com") ||
      lower.includes("before you continue to youtube"),
    yt_initial_player_response: html.includes("ytInitialPlayerResponse"),
    playability_status: html.includes("playabilityStatus"),
    video_details: html.includes("videoDetails"),
    streaming_data: html.includes("streamingData"),
    googlevideo_reference: lower.includes("googlevideo.com"),
    signature_cipher: html.includes("signatureCipher"),
  };
}

function extractBalancedJsonObject(text, fromIndex) {
  const start = text.indexOf("{", fromIndex);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

function extractPlayerResponse(html) {
  const markers = [
    "var ytInitialPlayerResponse =",
    "ytInitialPlayerResponse =",
    'window["ytInitialPlayerResponse"] =',
    "window['ytInitialPlayerResponse'] =",
  ];

  for (const marker of markers) {
    const index = html.indexOf(marker);
    if (index < 0) continue;
    const raw = extractBalancedJsonObject(html, index + marker.length);
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch {
      // Try the next representation if this marker was not a plain JSON object.
    }
  }

  return null;
}

function formatSummary(playerResponse) {
  const streaming = playerResponse?.streamingData || {};
  const formats = Array.isArray(streaming.formats) ? streaming.formats : [];
  const adaptive = Array.isArray(streaming.adaptiveFormats) ? streaming.adaptiveFormats : [];
  const all = [...formats, ...adaptive];

  return {
    progressive_count: formats.length,
    adaptive_count: adaptive.length,
    direct_url_count: all.filter((f) => typeof f?.url === "string").length,
    signature_cipher_count: all.filter(
      (f) => typeof f?.signatureCipher === "string" || typeof f?.cipher === "string",
    ).length,
    formats: all.slice(0, 20).map((f) => ({
      itag: f.itag ?? null,
      mime_type: f.mimeType ?? null,
      bitrate: f.bitrate ?? null,
      width: f.width ?? null,
      height: f.height ?? null,
      audio_quality: f.audioQuality ?? null,
      content_length: f.contentLength ?? null,
      has_direct_url: typeof f.url === "string",
      has_signature_cipher:
        typeof f.signatureCipher === "string" || typeof f.cipher === "string",
    })),
  };
}

function pickDirectProbeFormat(playerResponse) {
  const streaming = playerResponse?.streamingData || {};
  const formats = Array.isArray(streaming.formats) ? streaming.formats : [];
  const adaptive = Array.isArray(streaming.adaptiveFormats) ? streaming.adaptiveFormats : [];

  return (
    formats.find((f) => f?.itag === 18 && typeof f?.url === "string") ||
    formats.find(
      (f) => typeof f?.url === "string" && String(f?.mimeType || "").includes("video/mp4"),
    ) ||
    formats.find((f) => typeof f?.url === "string") ||
    adaptive.find((f) => typeof f?.url === "string") ||
    null
  );
}

async function renderYouTubePage(env, target) {
  const response = await env.BROWSER.quickAction("content", {
    url: target,
    gotoOptions: {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    },
    rejectResourceTypes: ["image", "font", "stylesheet", "media"],
  });

  return {
    response,
    html: await response.text(),
  };
}

async function readAtMost(body, limit) {
  if (!body) return 0;
  const reader = body.getReader();
  let total = 0;

  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += Math.min(value.byteLength, limit - total);
      if (total >= limit) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation failures; this endpoint is diagnostic only.
    }
  }

  return total;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: "youtube-free-browser-probe",
        purpose: "Test YouTube reachability from Cloudflare Browser Run without a local PC",
        paid_components: [],
        uses_cloudflare_containers: false,
        uses_r2: false,
        uses_workers_ai: false,
        browser_run_free_limit: "10 minutes/day on Workers Free",
        probe: "/probe?v=VIDEO_ID",
        range_probe: "/probe/stream?v=VIDEO_ID",
        default_video_id: DEFAULT_VIDEO_ID,
      });
    }

    if (url.pathname !== "/probe" && url.pathname !== "/probe/stream") {
      return json({ error: "Not found" }, 404);
    }

    const videoId = url.searchParams.get("v") || DEFAULT_VIDEO_ID;
    if (!VIDEO_ID_RE.test(videoId)) {
      return json({ error: "Invalid YouTube video ID" }, 400);
    }

    const target = `https://www.youtube.com/watch?v=${videoId}`;
    const started = Date.now();

    try {
      const { response, html } = await renderYouTubePage(env, target);
      const signals = probeSignals(html);
      const blocked = signals.bot_challenge || signals.consent_page;
      const playerResponse = extractPlayerResponse(html);

      if (url.pathname === "/probe") {
        return json({
          result: blocked ? "blocked-or-interstitial" : "page-accessed",
          target,
          http_status: response.status,
          elapsed_ms: Date.now() - started,
          browser_ms_used: response.headers.get("X-Browser-Ms-Used"),
          rendered_html_bytes: new TextEncoder().encode(html).byteLength,
          page_title: extractTitle(html),
          signals,
          player_response_parsed: Boolean(playerResponse),
          format_summary: playerResponse ? formatSummary(playerResponse) : null,
          interpretation: blocked
            ? "Cloudflare Browser Run reached YouTube but received a bot/consent interstitial."
            : playerResponse?.streamingData
              ? "YouTube page rendered and streamingData was parsed."
              : signals.yt_initial_player_response || signals.streaming_data
                ? "Player signals are visible, but the JSON object was not parsed yet."
                : "YouTube page rendered without an obvious bot page, but player data was not found.",
          media_downloaded: false,
          local_pc_required: false,
          paid_cloudflare_feature_used_by_this_probe: false,
        });
      }

      if (blocked) {
        return json(
          {
            result: "blocked-or-interstitial",
            target,
            signals,
            media_downloaded: false,
            local_pc_required: false,
            paid_cloudflare_feature_used_by_this_probe: false,
          },
          502,
        );
      }

      if (!playerResponse) {
        return json(
          {
            result: "player-response-not-parsed",
            target,
            signals,
            media_downloaded: false,
            local_pc_required: false,
            paid_cloudflare_feature_used_by_this_probe: false,
          },
          502,
        );
      }

      const selected = pickDirectProbeFormat(playerResponse);
      if (!selected) {
        return json(
          {
            result: "no-direct-stream-url",
            target,
            format_summary: formatSummary(playerResponse),
            media_downloaded: false,
            local_pc_required: false,
            paid_cloudflare_feature_used_by_this_probe: false,
          },
          502,
        );
      }

      const streamStarted = Date.now();
      const upstream = await fetch(selected.url, {
        headers: {
          Range: `bytes=0-${RANGE_PROBE_BYTES - 1}`,
          Accept: "*/*",
        },
        redirect: "follow",
      });
      const receivedBytes = await readAtMost(upstream.body, RANGE_PROBE_BYTES);

      return json({
        result: upstream.ok ? "range-fetch-reached-googlevideo" : "range-fetch-failed",
        target,
        page_title: playerResponse?.videoDetails?.title || extractTitle(html),
        browser_ms_used: response.headers.get("X-Browser-Ms-Used"),
        selected_format: {
          itag: selected.itag ?? null,
          mime_type: selected.mimeType ?? null,
          bitrate: selected.bitrate ?? null,
          width: selected.width ?? null,
          height: selected.height ?? null,
          content_length: selected.contentLength ?? null,
        },
        upstream_status: upstream.status,
        upstream_content_type: upstream.headers.get("Content-Type"),
        upstream_content_length: upstream.headers.get("Content-Length"),
        upstream_content_range: upstream.headers.get("Content-Range"),
        requested_range_bytes: RANGE_PROBE_BYTES,
        received_bytes_before_cancel: receivedBytes,
        range_fetch_elapsed_ms: Date.now() - streamStarted,
        total_elapsed_ms: Date.now() - started,
        stream_url_returned_to_client: false,
        full_media_downloaded: false,
        local_pc_required: false,
        paid_cloudflare_feature_used_by_this_probe: false,
      });
    } catch (error) {
      return json(
        {
          result: "error",
          target,
          elapsed_ms: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
          media_downloaded: false,
          local_pc_required: false,
          paid_cloudflare_feature_used_by_this_probe: false,
        },
        502,
      );
    }
  },
};
