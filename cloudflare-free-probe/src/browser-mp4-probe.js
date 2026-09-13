import puppeteer from "@cloudflare/puppeteer";

const TEST_VIDEO_ID = "2NJdNKJ9LPM";
const PROBE_BYTES = 64 * 1024;
const VIDEO_OFFSETS = [0, 4 * 1024 * 1024, 8 * 1024 * 1024];
const AUDIO_OFFSETS = [0, 4 * 1024 * 1024];
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

async function getAndroidVrStreams(page, videoId) {
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

      const headers = {
        "Content-Type": "application/json",
        "X-YouTube-Client-Name": String(clientDef.id),
        "X-YouTube-Client-Version": clientDef.clientVersion,
        ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {}),
      };

      let response;
      let player;
      try {
        response = await fetch(
          `/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`,
          {
            method: "POST",
            credentials: "include",
            headers,
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
        player = await response.json();
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          api_key_present: true,
          visitor_data_present: Boolean(visitorData),
        };
      }

      const streaming = player?.streamingData || {};
      const adaptive = Array.isArray(streaming.adaptiveFormats)
        ? streaming.adaptiveFormats.filter(
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
      const audio =
        adaptive.find(
          (f) =>
            f?.itag === 140 &&
            String(f?.mimeType || "").includes("audio/mp4"),
        ) ||
        adaptive.find((f) =>
          String(f?.mimeType || "").includes("audio/mp4"),
        ) ||
        null;

      return {
        player_http_status: response.status,
        playability_status: player?.playabilityStatus?.status || null,
        playability_reason: player?.playabilityStatus?.reason || null,
        api_key_present: true,
        visitor_data_present: Boolean(visitorData),
        direct_adaptive_count: adaptive.length,
        video,
        audio,
      };
    },
    { videoId, clientDef: ANDROID_VR },
  );
}

async function probeNavigationRange(browser, format, start) {
  const total = Number(format?.contentLength || 0);
  if (total && start >= total) {
    return { start, skipped: true, reason: "offset-beyond-content-length" };
  }

  const end = total
    ? Math.min(start + PROBE_BYTES - 1, total - 1)
    : start + PROBE_BYTES - 1;
  const rangeValue = `bytes=${start}-${end}`;
  const page = await browser.newPage();

  try {
    await page.setUserAgent(ANDROID_VR.userAgent);

    let firstNavigationHandled = false;
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (!firstNavigationHandled && request.isNavigationRequest()) {
        firstNavigationHandled = true;
        request.continue({
          headers: {
            ...request.headers(),
            range: rangeValue,
            accept: "*/*",
          },
        });
        return;
      }
      request.continue();
    });

    let capturedResponse = null;
    page.on("response", (response) => {
      const responseUrl = response.url();
      if (
        !capturedResponse &&
        responseUrl.includes("googlevideo.com/videoplayback")
      ) {
        capturedResponse = response;
      }
    });

    let gotoError = null;
    try {
      const response = await page.goto(format.url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      if (response) capturedResponse = response;
    } catch (error) {
      gotoError = error instanceof Error ? error.message : String(error);
    }

    if (!capturedResponse) {
      return {
        start,
        end,
        requested_range: rangeValue,
        success: false,
        error: gotoError || "No googlevideo response captured",
      };
    }

    const headers = capturedResponse.headers();
    const status = capturedResponse.status();
    const contentRange = headers["content-range"] || null;
    const contentLength = headers["content-length"] || null;
    const expectedPrefix = `bytes ${start}-`;
    const rangeMatched =
      status === 206 && Boolean(contentRange?.startsWith(expectedPrefix));

    let bytes = 0;
    let bodyError = null;
    if (rangeMatched) {
      const declaredLength = Number(contentLength || 0);
      if (!declaredLength || declaredLength <= PROBE_BYTES + 1024) {
        try {
          const body = await capturedResponse.buffer();
          bytes = body.byteLength;
        } catch (error) {
          bodyError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    return {
      start,
      end,
      requested_range: rangeValue,
      status,
      content_type: headers["content-type"] || null,
      content_length: contentLength,
      content_range: contentRange,
      bytes,
      body_error: bodyError,
      goto_error: gotoError,
      success: rangeMatched && (bytes > 0 || bodyError === null),
    };
  } finally {
    await page.close();
  }
}

async function probeFormatRanges(browser, format, offsets) {
  const results = [];
  for (const offset of offsets) {
    results.push(await probeNavigationRange(browser, format, offset));
  }
  const checked = results.filter((item) => !item.skipped);
  return {
    same_browser_process: true,
    checked_count: checked.length,
    all_success: checked.length > 0 && checked.every((item) => item.success),
    results,
  };
}

async function runProbe(env, videoId) {
  const started = Date.now();
  const browser = await puppeteer.launch(env.BROWSER);

  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const type = request.resourceType();
      if (["image", "font", "stylesheet", "media"].includes(type)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    const nav = await page.goto(
      `https://www.youtube.com/watch?v=${videoId}`,
      {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      },
    );

    try {
      await page.waitForFunction(
        () => Boolean(globalThis.ytcfg?.get?.("INNERTUBE_API_KEY")),
        { timeout: 8000 },
      );
    } catch {
      // The evaluation below will report the missing key if necessary.
    }

    const pageTitle = await page.title();
    const streams = await getAndroidVrStreams(page, videoId);
    await page.close();

    if (streams.error) {
      return {
        result: "browser-player-request-error",
        page_http_status: nav?.status() ?? null,
        page_title: pageTitle,
        elapsed_ms: Date.now() - started,
        player: streams,
        full_media_downloaded: false,
        local_pc_required: false,
        paid_cloudflare_feature_used: false,
      };
    }

    if (
      streams.playability_status !== "OK" ||
      !streams.video?.url ||
      !streams.audio?.url
    ) {
      return {
        result: "browser-player-no-direct-mp4",
        page_http_status: nav?.status() ?? null,
        page_title: pageTitle,
        elapsed_ms: Date.now() - started,
        player: {
          player_http_status: streams.player_http_status,
          playability_status: streams.playability_status,
          playability_reason: streams.playability_reason,
          api_key_present: streams.api_key_present,
          visitor_data_present: streams.visitor_data_present,
          direct_adaptive_count: streams.direct_adaptive_count,
        },
        full_media_downloaded: false,
        local_pc_required: false,
        paid_cloudflare_feature_used: false,
      };
    }

    const videoRanges = await probeFormatRanges(
      browser,
      streams.video,
      VIDEO_OFFSETS,
    );
    const audioRanges = await probeFormatRanges(
      browser,
      streams.audio,
      AUDIO_OFFSETS,
    );

    return {
      result:
        videoRanges.all_success && audioRanges.all_success
          ? "same-browser-direct-mp4-ranges-succeeded"
          : "same-browser-direct-mp4-ranges-failed",
      page_http_status: nav?.status() ?? null,
      page_title: pageTitle,
      elapsed_ms: Date.now() - started,
      player: {
        player_http_status: streams.player_http_status,
        playability_status: streams.playability_status,
        playability_reason: streams.playability_reason,
        api_key_present: streams.api_key_present,
        visitor_data_present: streams.visitor_data_present,
        direct_adaptive_count: streams.direct_adaptive_count,
      },
      video: {
        format: publicFormat(streams.video),
        ranges: videoRanges,
      },
      audio: {
        format: publicFormat(streams.audio),
        ranges: audioRanges,
      },
      stream_urls_returned_to_client: false,
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

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: "youtube-free-browser-mp4-probe",
        mode: "fixed-test-video-only",
        test_video_id: TEST_VIDEO_ID,
        browser_run_free_limit: "10 minutes/day on Workers Free",
        endpoint: "/probe/ranges?v=VIDEO_ID",
        paid_cloudflare_feature_used: false,
      });
    }

    if (url.pathname !== "/probe/ranges") {
      return json({ error: "Not found" }, 404);
    }

    const videoId = url.searchParams.get("v") || TEST_VIDEO_ID;
    if (videoId !== TEST_VIDEO_ID) {
      return json(
        { error: "This experimental probe is restricted to the fixed test video" },
        403,
      );
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
