import puppeteer from "@cloudflare/puppeteer";

const TEST_VIDEO_ID = "2NJdNKJ9LPM";
const PROBE_BYTES = 64 * 1024;
const VIDEO_OFFSET = 4 * 1024 * 1024;
const MAX_CHUNK_BYTES = 1024 * 1024;
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

async function resolveVideoInBrowser(browser, videoId) {
  const page = await browser.newPage();
  try {
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
      // Evaluation below reports missing data if needed.
    }

    const pageTitle = await page.title();
    const player = await getAndroidVrVideo(page, videoId);
    return {
      page_http_status: nav?.status() ?? null,
      page_title: pageTitle,
      player,
    };
  } finally {
    await page.close();
  }
}

async function captureRangeResponse(browser, format, start, length, includeBody) {
  const total = Number(format?.contentLength || 0);
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new Error("Invalid chunk start");
  }
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_CHUNK_BYTES) {
    throw new Error(`Chunk length must be 1..${MAX_CHUNK_BYTES}`);
  }
  if (total && start >= total) {
    throw new Error("Chunk start is beyond content length");
  }

  const end = total
    ? Math.min(start + length - 1, total - 1)
    : start + length - 1;
  const expectedBytes = end - start + 1;
  const requestedRange = `bytes=${start}-${end}`;
  const page = await browser.newPage();

  try {
    await page.setUserAgent(ANDROID_VR.userAgent);

    let resolveTargetResponse;
    const targetResponse = new Promise((resolve) => {
      resolveTargetResponse = resolve;
      setTimeout(() => resolve(null), 10000);
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
      .goto(format.url, { waitUntil: "domcontentloaded", timeout: 10000 })
      .catch((error) => {
        gotoError = error instanceof Error ? error.message : String(error);
        return null;
      });

    let response = await targetResponse;
    if (!response) response = await navigation;
    if (!response) {
      throw new Error(gotoError || "No googlevideo response captured");
    }

    const headers = response.headers();
    const status = response.status();
    const contentRange = headers["content-range"] || null;
    const rangeMatched =
      status === 206 && Boolean(contentRange?.startsWith(`bytes ${start}-`));

    if (!rangeMatched) {
      throw new Error(
        `Unexpected upstream range response: status=${status} content-range=${contentRange}`,
      );
    }

    let body = null;
    if (includeBody) {
      body = await response.buffer();
      if (body.byteLength !== expectedBytes) {
        throw new Error(
          `Chunk body size mismatch: expected ${expectedBytes}, got ${body.byteLength}`,
        );
      }
    }

    return {
      start,
      end,
      expected_bytes: expectedBytes,
      requested_range: requestedRange,
      status,
      content_type: headers["content-type"] || null,
      content_length: headers["content-length"] || null,
      content_range: contentRange,
      goto_error: gotoError,
      body,
    };
  } finally {
    await page.close();
  }
}

async function runProbe(env, videoId) {
  const started = Date.now();
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const resolved = await resolveVideoInBrowser(browser, videoId);
    const player = resolved.player;
    if (player.playability_status !== "OK" || !player.video?.url) {
      return {
        result: "browser-player-no-direct-mp4",
        page_http_status: resolved.page_http_status,
        page_title: resolved.page_title,
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

    const range = await captureRangeResponse(
      browser,
      player.video,
      VIDEO_OFFSET,
      PROBE_BYTES,
      false,
    );

    return {
      result: "same-browser-nonzero-mp4-range-succeeded",
      page_http_status: resolved.page_http_status,
      page_title: resolved.page_title,
      elapsed_ms: Date.now() - started,
      player: {
        player_http_status: player.player_http_status,
        playability_status: player.playability_status,
        playability_reason: player.playability_reason,
        visitor_data_present: player.visitor_data_present,
        direct_adaptive_count: player.direct_adaptive_count,
      },
      video_format: publicFormat(player.video),
      nonzero_range_probe: {
        ...range,
        body: undefined,
        success: true,
      },
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

async function runChunk(env, videoId, start, length) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const resolved = await resolveVideoInBrowser(browser, videoId);
    const player = resolved.player;
    if (player.playability_status !== "OK" || !player.video?.url) {
      throw new Error(
        `Player not OK: ${player.playability_status || "unknown"} ${player.playability_reason || player.error || ""}`,
      );
    }

    const chunk = await captureRangeResponse(
      browser,
      player.video,
      start,
      length,
      true,
    );

    const headers = new Headers({
      "Content-Type": chunk.content_type || "application/octet-stream",
      "Content-Length": String(chunk.body.byteLength),
      "Cache-Control": "no-store, max-age=0",
      "X-Upstream-Status": String(chunk.status),
      "X-Upstream-Content-Range": chunk.content_range || "",
      "X-Chunk-Start": String(chunk.start),
      "X-Chunk-End": String(chunk.end),
      "X-Source-Itag": String(player.video.itag ?? ""),
      "X-Source-Total-Bytes": String(player.video.contentLength || ""),
      "X-Browser-Run": "true",
      "X-Paid-Cloudflare-Feature": "false",
    });

    return new Response(chunk.body, { status: 200, headers });
  } finally {
    await browser.close();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const videoId = url.searchParams.get("v") || TEST_VIDEO_ID;
    if (videoId !== TEST_VIDEO_ID) {
      return json({ error: "Fixed test video only" }, 403);
    }

    try {
      if (url.pathname === "/probe/ranges") {
        return json(await runProbe(env, videoId));
      }

      if (url.pathname === "/chunk/video") {
        const start = Number(url.searchParams.get("start") ?? VIDEO_OFFSET);
        const length = Number(url.searchParams.get("length") ?? MAX_CHUNK_BYTES);
        return await runChunk(env, videoId, start, length);
      }

      return json(
        {
          service: "youtube-free-browser-mp4-probe",
          endpoints: ["/probe/ranges", "/chunk/video"],
          max_chunk_bytes: MAX_CHUNK_BYTES,
          local_pc_required: false,
          paid_cloudflare_feature_used: false,
        },
        url.pathname === "/" || url.pathname === "/health" ? 200 : 404,
      );
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
