import puppeteer from "@cloudflare/puppeteer";

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

async function runSameSessionProbe(env, videoId) {
  const target = `https://www.youtube.com/watch?v=${videoId}`;
  const started = Date.now();
  const browser = await puppeteer.launch(env.BROWSER);

  try {
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "font", "stylesheet", "media"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const nav = await page.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    try {
      await page.waitForFunction(
        () => Boolean(globalThis.ytInitialPlayerResponse?.streamingData),
        { timeout: 8000 },
      );
    } catch {
      // Continue with whatever the page exposed.
    }

    const pageTitle = await page.title();
    const inBrowser = await page.evaluate(async (limit) => {
      const player = globalThis.ytInitialPlayerResponse || null;
      const streaming = player?.streamingData || {};
      const formats = Array.isArray(streaming.formats) ? streaming.formats : [];
      const adaptive = Array.isArray(streaming.adaptiveFormats)
        ? streaming.adaptiveFormats
        : [];
      const all = [...formats, ...adaptive];

      const selected =
        formats.find((f) => f?.itag === 18 && typeof f?.url === "string") ||
        formats.find(
          (f) =>
            typeof f?.url === "string" &&
            String(f?.mimeType || "").includes("video/mp4"),
        ) ||
        formats.find((f) => typeof f?.url === "string") ||
        adaptive.find((f) => typeof f?.url === "string") ||
        null;

      const videoElement = document.querySelector("video");
      const currentSrc = videoElement?.currentSrc || videoElement?.src || null;
      const streamUrl = selected?.url || currentSrc || null;

      const base = {
        player_response_present: Boolean(player),
        streaming_data_present: Boolean(player?.streamingData),
        progressive_count: formats.length,
        adaptive_count: adaptive.length,
        direct_url_count: all.filter((f) => typeof f?.url === "string").length,
        signature_cipher_count: all.filter(
          (f) =>
            typeof f?.signatureCipher === "string" || typeof f?.cipher === "string",
        ).length,
        selected_format: selected
          ? {
              itag: selected.itag ?? null,
              mime_type: selected.mimeType ?? null,
              bitrate: selected.bitrate ?? null,
              width: selected.width ?? null,
              height: selected.height ?? null,
              content_length: selected.contentLength ?? null,
            }
          : null,
        used_video_current_src_fallback: !selected?.url && Boolean(currentSrc),
      };

      if (!streamUrl) {
        return {
          ...base,
          result: "no-direct-stream-url-in-session",
          fetch_attempted: false,
        };
      }

      try {
        const response = await fetch(streamUrl, {
          method: "GET",
          headers: {
            Range: `bytes=0-${limit - 1}`,
          },
          credentials: "include",
          cache: "no-store",
        });

        const reader = response.body?.getReader();
        let received = 0;
        if (reader) {
          try {
            while (received < limit) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value) continue;
              received += Math.min(value.byteLength, limit - received);
              if (received >= limit) break;
            }
          } finally {
            try {
              await reader.cancel();
            } catch {
              // Diagnostic only.
            }
          }
        }

        return {
          ...base,
          result: response.ok
            ? "same-session-range-fetch-succeeded"
            : "same-session-range-fetch-http-error",
          fetch_attempted: true,
          upstream_status: response.status,
          upstream_content_type: response.headers.get("content-type"),
          upstream_content_length: response.headers.get("content-length"),
          upstream_content_range: response.headers.get("content-range"),
          requested_range_bytes: limit,
          received_bytes_before_cancel: received,
          stream_host: new URL(streamUrl).hostname,
        };
      } catch (error) {
        return {
          ...base,
          result: "same-session-fetch-threw",
          fetch_attempted: true,
          error: error instanceof Error ? error.message : String(error),
          stream_host: (() => {
            try {
              return new URL(streamUrl).hostname;
            } catch {
              return null;
            }
          })(),
        };
      }
    }, RANGE_PROBE_BYTES);

    return {
      target,
      page_http_status: nav?.status() ?? null,
      page_title: pageTitle,
      elapsed_ms: Date.now() - started,
      ...inBrowser,
      stream_url_returned_to_client: false,
      full_media_downloaded: false,
      local_pc_required: false,
      paid_cloudflare_feature_used_by_this_probe: false,
    };
  } finally {
    await browser.close();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: "youtube-free-browser-probe",
        mode: "free-only",
        browser_run_free_limit: "10 minutes/day on Workers Free",
        uses_cloudflare_containers: false,
        uses_r2: false,
        uses_workers_ai: false,
        same_session_probe: "/probe/session?v=VIDEO_ID",
        default_video_id: DEFAULT_VIDEO_ID,
      });
    }

    if (url.pathname !== "/probe/session") {
      return json({ error: "Not found" }, 404);
    }

    const videoId = url.searchParams.get("v") || DEFAULT_VIDEO_ID;
    if (!VIDEO_ID_RE.test(videoId)) {
      return json({ error: "Invalid YouTube video ID" }, 400);
    }

    try {
      return json(await runSameSessionProbe(env, videoId));
    } catch (error) {
      return json(
        {
          result: "worker-error",
          error: error instanceof Error ? error.message : String(error),
          full_media_downloaded: false,
          local_pc_required: false,
          paid_cloudflare_feature_used_by_this_probe: false,
        },
        502,
      );
    }
  },
};
