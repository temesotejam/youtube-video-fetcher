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
  const browser = await puppeteer.launch(env.BROWSER, {
    args: ["--autoplay-policy=no-user-gesture-required"],
  });

  try {
    const page = await browser.newPage();
    let firstGooglevideoRequest = null;
    let requestCount = 0;

    let resolveGooglevideoResponse;
    const googlevideoResponse = new Promise((resolve) => {
      resolveGooglevideoResponse = resolve;
      setTimeout(() => resolve(null), 12000);
    });

    page.on("response", async (response) => {
      const responseUrl = response.url();
      if (!responseUrl.includes("googlevideo.com/videoplayback")) return;

      const headers = response.headers();
      resolveGooglevideoResponse({
        status: response.status(),
        content_type: headers["content-type"] || null,
        content_length: headers["content-length"] || null,
        content_range: headers["content-range"] || null,
        host: (() => {
          try {
            return new URL(responseUrl).hostname;
          } catch {
            return null;
          }
        })(),
      });
    });

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const requestUrl = req.url();
      const type = req.resourceType();

      if (requestUrl.includes("googlevideo.com/videoplayback")) {
        requestCount += 1;
        if (!firstGooglevideoRequest) {
          firstGooglevideoRequest = {
            resource_type: type,
            method: req.method(),
            host: (() => {
              try {
                return new URL(requestUrl).hostname;
              } catch {
                return null;
              }
            })(),
          };

          const headers = {
            ...req.headers(),
            range: `bytes=0-${RANGE_PROBE_BYTES - 1}`,
          };
          req.continue({ headers });
          return;
        }

        req.abort();
        return;
      }

      if (["image", "font", "stylesheet"].includes(type)) {
        req.abort();
        return;
      }

      req.continue();
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
      // Continue; the player can still issue media requests.
    }

    const streamingSummary = await page.evaluate(() => {
      const streaming = globalThis.ytInitialPlayerResponse?.streamingData || {};
      return {
        keys: Object.keys(streaming),
        formats_count: Array.isArray(streaming.formats) ? streaming.formats.length : 0,
        adaptive_count: Array.isArray(streaming.adaptiveFormats)
          ? streaming.adaptiveFormats.length
          : 0,
        has_server_abr_streaming_url:
          typeof streaming.serverAbrStreamingUrl === "string",
      };
    });

    try {
      await page.waitForSelector("video", { timeout: 8000 });
      await page.evaluate(async () => {
        const video = document.querySelector("video");
        if (!video) return;
        video.muted = true;
        try {
          await video.play();
        } catch {
          // The page may have already started loading media on its own.
        }
      });
    } catch {
      // Wait below for any request that the page already emitted.
    }

    const responseMeta = await googlevideoResponse;
    const pageTitle = await page.title();

    try {
      await page.evaluate(() => {
        const video = document.querySelector("video");
        if (video) video.pause();
      });
    } catch {
      // Ignore cleanup failures.
    }

    const rangeHonored =
      responseMeta?.status === 206 || Boolean(responseMeta?.content_range);

    return {
      result: responseMeta
        ? rangeHonored
          ? "same-session-player-range-succeeded"
          : "same-session-player-request-reached-googlevideo"
        : firstGooglevideoRequest
          ? "googlevideo-request-seen-no-response"
          : "no-googlevideo-request-seen",
      target,
      page_http_status: nav?.status() ?? null,
      page_title: pageTitle,
      elapsed_ms: Date.now() - started,
      streaming_data: streamingSummary,
      googlevideo_request_count: requestCount,
      first_googlevideo_request: firstGooglevideoRequest,
      first_googlevideo_response: responseMeta,
      forced_range: `bytes=0-${RANGE_PROBE_BYTES - 1}`,
      range_honored: rangeHonored,
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
