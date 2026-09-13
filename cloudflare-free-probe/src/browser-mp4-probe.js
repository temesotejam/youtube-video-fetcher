import puppeteer from "@cloudflare/puppeteer";

const TEST_VIDEO_ID = "2NJdNKJ9LPM";
const PROBE_BYTES = 64 * 1024;
const VIDEO_OFFSET = 4 * 1024 * 1024;
const ANDROID_VR = {
  id: 28,
  clientName: "ANDROID_VR",
  clientVersion: "1.65.10",
  userAgent:
    "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function publicFormat(format) {
  if (!format) return null;
  return {
    itag: format.itag ?? null,
    mime_type: format.mimeType || null,
    width: format.width ?? null,
    height: format.height ?? null,
    bitrate: format.bitrate ?? null,
    content_length: format.contentLength || null,
    host: (() => {
      try {
        return new URL(format.url).hostname;
      } catch {
        return null;
      }
    })(),
  };
}

async function getAndroidVrVideo(page, videoId) {
  return page.evaluate(
    async ({ videoId: id, clientDef }) => {
      const get = globalThis.ytcfg?.get?.bind(globalThis.ytcfg);
      const context = get ? get("INNERTUBE_CONTEXT") : null;
      const apiKey = get ? get("INNERTUBE_API_KEY") : null;
      const visitorData =
        (get ? get("VISITOR_DATA") : null) ||
        context?.client?.visitorData ||
        null;

      if (!apiKey) {
        return { error: "INNERTUBE_API_KEY not found in Browser Run page" };
      }

      const client = {
        clientName: clientDef.clientName,
        clientVersion: clientDef.clientVersion,
        hl: "en",
        gl: "US",
        userAgent: clientDef.userAgent,
        deviceMake: "Oculus",
        deviceModel: "Quest 3",
        androidSdkVersion: 32,
        osName: "Android",
        osVersion: "12L",
        ...(visitorData ? { visitorData } : {}),
      };

      const response = await fetch(
        `/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-YouTube-Client-Name": String(clientDef.id),
            "X-YouTube-Client-Version": clientDef.clientVersion,
            ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {}),
          },
          body: JSON.stringify({
            context: { client },
            videoId: id,
            playbackContext: {
              contentPlaybackContext: {
                html5Preference: "HTML5_PREF_WANTS",
              },
            },
            contentCheckOk: true,
            racyCheckOk: true,
          }),
        },
      );
      const player = await response.json();
      const adaptive = Array.isArray(player?.streamingData?.adaptiveFormats)
        ? player.streamingData.adaptiveFormats.filter(
            (f) => f && typeof f.url === "string",
          )
        : [];
      const videoCandidates = adaptive.filter((f) => {
        const mime = String(f?.mimeType || "");
        return mime.includes("video/mp4") && mime.includes("avc1");
      });
      const video =
        videoCandidates.find((f) => Number(f?.height || 0) === 720) ||
        videoCandidates[0] ||
        null;

      return {
        player_http_status: response.status,
        playability_status: player?.playabilityStatus?.status || null,
        playability_reason: player?.playabilityStatus?.reason || null,
        visitor_data_present: Boolean(visitorData),
        direct_adaptive_count: adaptive.length,
        video,
      };
    },
    { videoId, clientDef: ANDROID_VR },
  );
}

async function probeOneRange(browser, format) {
  const total = Number(format?.contentLength || 0);
  const start = VIDEO_OFFSET;
  const end = total
    ? Math.min(start + PROBE_BYTES - 1, total - 1)
    : start + PROBE_BYTES - 1;
  const requestedRange = `bytes=${start}-${end}`;
  const page = await browser.newPage();

  try {
    await page.setUserAgent(ANDROID_VR.userAgent);

    let resolveTargetResponse;
    const targetResponse = new Promise((resolve) => {
      resolveTargetResponse = resolve;
      setTimeout(() => resolve(null), 5000);
    });

    page.on("response", (response) => {
      if (response.url().includes("googlevideo.com/videoplayback")) {
        resolveTargetResponse(response);
      }
    });

    let firstNavigationHandled = false;
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (!firstNavigationHandled && request.isNavigationRequest()) {
        firstNavigationHandled = true;
        request.continue({
          headers: {
            ...request.headers(),
            range: requestedRange,
            accept: "*/*",
          },
        });
      } else {
        request.continue();
      }
    });

    let gotoError = null;
    const navigation = page
      .goto(format.url, { waitUntil: "domcontentloaded", timeout: 5000 })
      .catch((error) => {
        gotoError = error instanceof Error ? error.message : String(error);
        return null;
      });

    let response = await targetResponse;
    if (!response) {
      response = await navigation;
    }

    if (!response) {
      return {
        start,
        end,
        requested_range: requestedRange,
        success: false,
        error: gotoError || "No googlevideo response captured within 5 seconds",
      };
    }

    const headers = response.headers();
    const status = response.status();
    const contentRange = headers["content-range"] || null;
    const success =
      status === 206 && Boolean(contentRange?.startsWith(`bytes ${start}-`));

    return {
      start,
      end,
      requested_range: requestedRange,
      status,
      content_type: headers["content-type"] || null,
      content_length: headers["content-length"] || null,
      content_range: contentRange,
      goto_error: gotoError,
      success,
    };
  } finally {
    await page.close();
  }
}

async function runProbe(env, videoId) {
  const started = Date.now();
  const browser = await puppeteer.launch(env.BROWSER);

  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (["image", "font", "stylesheet", "media"].includes(request.resourceType())) {
        request.abort();
      } else {
        request.continue();
      }
    });

    const nav = await page.goto(`https://www.youtube.com/watch?v=${videoId}`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    try {
      await page.waitForFunction(
        () => Boolean(globalThis.ytcfg?.get?.("INNERTUBE_API_KEY")),
        { timeout: 5000 },
      );
    } catch {
      // Evaluation below will report missing data.
    }

    const pageTitle = await page.title();
    const player = await getAndroidVrVideo(page, videoId);
    await page.close();

    if (
      player.playability_status !== "OK" ||
      !player.video?.url
    ) {
      return {
        result: "browser-player-no-direct-mp4",
        page_http_status: nav?.status() ?? null,
        page_title: pageTitle,
        elapsed_ms: Date.now() - started,
        player: {
          player_http_status: player.player_http_status ?? null,
          playability_status: player.playability_status ?? null,
          playability_reason: player.playability_reason ?? player.error ?? null,
          visitor_data_present: player.visitor_data_present ?? null,
          direct_adaptive_count: player.direct_adaptive_count ?? 0,
        },
        full_media_downloaded: false,
        local_pc_required: false,
        browser_run_used: true,
        paid_cloudflare_feature_used: false,
      };
    }

    const range = await probeOneRange(browser, player.video);
    return {
      result: range.success
        ? "same-browser-nonzero-mp4-range-succeeded"
        : "same-browser-nonzero-mp4-range-failed",
      page_http_status: nav?.status() ?? null,
      page_title: pageTitle,
      elapsed_ms: Date.now() - started,
      player: {
        player_http_status: player.player_http_status,
        playability_status: player.playability_status,
        playability_reason: player.playability_reason,
        visitor_data_present: player.visitor_data_present,
        direct_adaptive_count: player.direct_adaptive_count,
      },
      video_format: publicFormat(player.video),
      nonzero_range_probe: range,
      stream_url_returned_to_client: false,
      full_media_downloaded: false,
      local_pc_required: false,
      browser_run_used: true,
      paid_cloudflare_feature_used: false,
    };
  } finally {
    await browser.close();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/probe/ranges") {
      return json({ error: "Not found" }, 404);
    }
    const videoId = url.searchParams.get("v") || TEST_VIDEO_ID;
    if (videoId !== TEST_VIDEO_ID) {
      return json({ error: "Fixed test video only" }, 403);
    }
    try {
      return json(await runProbe(env, videoId));
    } catch (error) {
      return json(
        {
          result: "worker-error",
          error: error instanceof Error ? error.message : String(error),
          full_media_downloaded: false,
          local_pc_required: false,
          browser_run_used: true,
          paid_cloudflare_feature_used: false,
        },
        502,
      );
    }
  },
};
