const DEFAULT_VIDEO_ID = "2NJdNKJ9LPM";
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

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
        default_video_id: DEFAULT_VIDEO_ID,
      });
    }

    if (url.pathname !== "/probe") {
      return json({ error: "Not found" }, 404);
    }

    const videoId = url.searchParams.get("v") || DEFAULT_VIDEO_ID;
    if (!VIDEO_ID_RE.test(videoId)) {
      return json({ error: "Invalid YouTube video ID" }, 400);
    }

    const target = `https://www.youtube.com/watch?v=${videoId}`;
    const started = Date.now();

    try {
      const response = await env.BROWSER.quickAction("content", {
        url: target,
        gotoOptions: {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        },
        rejectResourceTypes: ["image", "font", "stylesheet", "media"],
      });

      const html = await response.text();
      const signals = probeSignals(html);
      const blocked = signals.bot_challenge || signals.consent_page;

      return json({
        result: blocked ? "blocked-or-interstitial" : "page-accessed",
        target,
        http_status: response.status,
        elapsed_ms: Date.now() - started,
        browser_ms_used: response.headers.get("X-Browser-Ms-Used"),
        rendered_html_bytes: new TextEncoder().encode(html).byteLength,
        page_title: extractTitle(html),
        signals,
        interpretation: blocked
          ? "Cloudflare Browser Run reached YouTube but received a bot/consent interstitial."
          : signals.yt_initial_player_response || signals.streaming_data
            ? "YouTube page rendered and player data is visible. This is promising for the next free-only experiment."
            : "YouTube page rendered without an obvious bot page, but player data was not found in the returned HTML.",
        media_downloaded: false,
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
