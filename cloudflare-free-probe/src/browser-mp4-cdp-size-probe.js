import puppeteer from "@cloudflare/puppeteer";

const TEST_VIDEO_ID = "2NJdNKJ9LPM";
const START = 4 * 1024 * 1024;
const READ_SIZE = 16 * 1024;
const SIZES = [64 * 1024, 256 * 1024, 512 * 1024, 1024 * 1024];
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

function headerMap(headers = []) {
  const map = new Map();
  for (const header of headers) {
    if (header?.name) map.set(String(header.name).toLowerCase(), String(header.value ?? ""));
  }
  return map;
}

function decodedLength(read) {
  if (!read?.data) return 0;
  if (read.base64Encoded) return atob(read.data).length;
  return new TextEncoder().encode(read.data).byteLength;
}

async function openResolverPage(browser, videoId) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (["image", "font", "stylesheet", "media"].includes(request.resourceType())) {
      request.abort().catch(() => {});
    } else {
      request.continue().catch(() => {});
    }
  });
  const nav = await page.goto(`https://www.youtube.com/watch?v=${videoId}`, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await page
    .waitForFunction(() => Boolean(globalThis.ytcfg?.get?.("INNERTUBE_API_KEY")), {
      timeout: 5000,
    })
    .catch(() => {});
  return {
    page,
    page_http_status: nav?.status() ?? null,
    page_title: await page.title(),
  };
}

async function getAndroidVrVideo(page, videoId) {
  return page.evaluate(
    async ({ id, clientDef }) => {
      const get = globalThis.ytcfg?.get?.bind(globalThis.ytcfg);
      const context = get ? get("INNERTUBE_CONTEXT") : null;
      const apiKey = get ? get("INNERTUBE_API_KEY") : null;
      const visitorData =
        (get ? get("VISITOR_DATA") : null) || context?.client?.visitorData || null;
      if (!apiKey) return { error: "INNERTUBE_API_KEY not found" };

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
              contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" },
            },
            contentCheckOk: true,
            racyCheckOk: true,
          }),
        },
      );

      const player = await response.json();
      const adaptive = Array.isArray(player?.streamingData?.adaptiveFormats)
        ? player.streamingData.adaptiveFormats.filter(
            (format) => format && typeof format.url === "string",
          )
        : [];
      const candidates = adaptive.filter((format) => {
        const mime = String(format?.mimeType || "");
        return mime.includes("video/mp4") && mime.includes("avc1");
      });
      const video =
        candidates.find((format) => Number(format?.height || 0) === 720) ||
        candidates[0] ||
        null;
      return {
        player_http_status: response.status,
        playability_status: player?.playabilityStatus?.status || null,
        playability_reason: player?.playabilityStatus?.reason || null,
        direct_adaptive_count: adaptive.length,
        visitor_data_present: Boolean(visitorData),
        video,
      };
    },
    { id: videoId, clientDef: ANDROID_VR },
  );
}

async function readRange(browser, format, start, length) {
  const totalSourceBytes = Number(format?.contentLength || 0);
  const end = Math.min(start + length - 1, totalSourceBytes - 1);
  const expected = end - start + 1;
  const requestedRange = `bytes=${start}-${end}`;
  const page = await browser.newPage();
  const cdp = await page.target().createCDPSession();
  let timeoutId;
  let resolvePaused;
  let rejectPaused;
  const pausedPromise = new Promise((resolve, reject) => {
    resolvePaused = resolve;
    rejectPaused = reject;
  });

  try {
    await page.setUserAgent(ANDROID_VR.userAgent);
    await cdp.send("Network.enable");
    await cdp.send("Network.setExtraHTTPHeaders", {
      headers: { Range: requestedRange, Accept: "*/*" },
    });
    await cdp.send("Fetch.enable", {
      patterns: [
        {
          urlPattern: "*://*.googlevideo.com/videoplayback*",
          requestStage: "Response",
        },
      ],
    });
    cdp.on("Fetch.requestPaused", (event) => {
      if (event.request?.url?.includes("googlevideo.com/videoplayback")) {
        if (timeoutId) clearTimeout(timeoutId);
        resolvePaused(event);
      }
    });
    timeoutId = setTimeout(
      () => rejectPaused(new Error("Timed out waiting for googlevideo response")),
      20000,
    );

    const navPromise = page
      .goto(format.url, { waitUntil: "domcontentloaded", timeout: 25000 })
      .catch(() => null);
    const paused = await pausedPromise;
    const headers = headerMap(paused.responseHeaders || []);
    const status = paused.responseStatusCode ?? null;
    const contentRange = headers.get("content-range") || null;
    const contentType = headers.get("content-type") || null;

    if (status !== 206 || !String(contentRange || "").startsWith(`bytes ${start}-`)) {
      await cdp
        .send("Fetch.failRequest", {
          requestId: paused.requestId,
          errorReason: "Aborted",
        })
        .catch(() => {});
      await navPromise;
      return {
        success: false,
        requested_bytes: length,
        requested_range: requestedRange,
        status,
        content_range: contentRange,
        content_type: contentType,
        received_bytes: 0,
      };
    }

    const { stream } = await cdp.send("Fetch.takeResponseBodyAsStream", {
      requestId: paused.requestId,
    });
    let received = 0;
    let readCount = 0;
    let eof = false;
    while (!eof) {
      const remaining = expected - received;
      const read = await cdp.send("IO.read", {
        handle: stream,
        size: Math.min(READ_SIZE, Math.max(remaining, 1)),
      });
      received += decodedLength(read);
      readCount += 1;
      eof = Boolean(read.eof);
      if (received > expected) throw new Error(`Received too much data: ${received}`);
      if (readCount > 128) throw new Error("Too many IO.read calls");
    }
    await cdp.send("IO.close", { handle: stream }).catch(() => {});
    await cdp
      .send("Fetch.failRequest", {
        requestId: paused.requestId,
        errorReason: "Aborted",
      })
      .catch(() => {});
    await navPromise;

    return {
      success: received === expected,
      requested_bytes: length,
      requested_range: requestedRange,
      status,
      content_range: contentRange,
      content_type: contentType,
      received_bytes: received,
      cdp_read_count: readCount,
      cdp_read_size: READ_SIZE,
      eof,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    await cdp.send("Fetch.disable").catch(() => {});
    await page.close().catch(() => {});
  }
}

async function runProbe(env, videoId) {
  const started = Date.now();
  const browser = await puppeteer.launch(env.BROWSER);
  let resolver;
  try {
    resolver = await openResolverPage(browser, videoId);
    const results = [];
    for (const size of SIZES) {
      try {
        const player = await getAndroidVrVideo(resolver.page, videoId);
        if (player.playability_status !== "OK" || !player.video?.url) {
          results.push({
            requested_bytes: size,
            success: false,
            stage: "player",
            player_http_status: player.player_http_status ?? null,
            playability_status: player.playability_status ?? null,
            playability_reason: player.playability_reason ?? player.error ?? null,
          });
          continue;
        }
        let host = null;
        try {
          host = new URL(player.video.url).hostname;
        } catch {}
        const range = await readRange(browser, player.video, START, size);
        results.push({
          ...range,
          itag: player.video.itag ?? null,
          source_total_bytes: Number(player.video.contentLength || 0),
          host,
          direct_adaptive_count: player.direct_adaptive_count ?? 0,
        });
      } catch (error) {
        results.push({
          requested_bytes: size,
          success: false,
          stage: "exception",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      result: "single-browser-cdp-size-probe-complete",
      browser_session_count: 1,
      page_http_status: resolver.page_http_status,
      page_title: resolver.page_title,
      start: START,
      read_size: READ_SIZE,
      sizes: SIZES,
      results,
      elapsed_ms: Date.now() - started,
      local_pc_required: false,
      browser_run_used: true,
      paid_cloudflare_feature_used: false,
    };
  } finally {
    if (resolver?.page) await resolver.page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const videoId = url.searchParams.get("v") || TEST_VIDEO_ID;
    if (videoId !== TEST_VIDEO_ID) return json({ error: "Fixed test video only" }, 403);
    try {
      if (url.pathname === "/cdp/probe/sizes") {
        return json(await runProbe(env, videoId));
      }
      return json({
        service: "youtube-free-browser-cdp-size-probe",
        endpoints: ["/cdp/probe/sizes"],
        sizes: SIZES,
        start: START,
        read_size: READ_SIZE,
        local_pc_required: false,
        paid_cloudflare_feature_used: false,
      });
    } catch (error) {
      return json(
        {
          result: "worker-error",
          error: error instanceof Error ? error.message : String(error),
          local_pc_required: false,
          browser_run_used: true,
          paid_cloudflare_feature_used: false,
        },
        502,
      );
    }
  },
};
