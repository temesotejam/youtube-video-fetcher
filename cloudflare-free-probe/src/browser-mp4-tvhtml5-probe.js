import puppeteer from "@cloudflare/puppeteer";

const TEST_VIDEO_ID = "2NJdNKJ9LPM";
const RANGE_START = 20 * 1024 * 1024;
const RANGE_LENGTH = 256 * 1024;
const READ_SIZE = 16 * 1024;

const TV_CLIENT = {
  id: 7,
  clientName: "TVHTML5",
  clientVersion: "7.20260707.07.00",
  userAgent:
    "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)",
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
    if (header?.name) {
      map.set(String(header.name).toLowerCase(), String(header.value ?? ""));
    }
  }
  return map;
}

function decodedLength(read) {
  if (!read?.data) return 0;
  if (read.base64Encoded) return atob(read.data).length;
  return new TextEncoder().encode(read.data).byteLength;
}

function publicFormat(format) {
  if (!format) return null;
  let host = null;
  try {
    host = new URL(format.url).hostname;
  } catch {}
  return {
    itag: format.itag ?? null,
    mime_type: format.mimeType || null,
    width: format.width ?? null,
    height: format.height ?? null,
    bitrate: format.bitrate ?? null,
    content_length: format.contentLength || null,
    host,
  };
}

async function openTvPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(TV_CLIENT.userAgent);
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (["image", "font", "stylesheet", "media"].includes(request.resourceType())) {
      request.abort().catch(() => {});
    } else {
      request.continue().catch(() => {});
    }
  });

  const nav = await page.goto("https://www.youtube.com/tv", {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });

  await page
    .waitForFunction(
      () =>
        Boolean(globalThis.ytcfg?.get?.("INNERTUBE_API_KEY")) &&
        Boolean(globalThis.ytcfg?.get?.("INNERTUBE_CONTEXT")),
      { timeout: 5000 },
    )
    .catch(() => {});

  return {
    page,
    page_http_status: nav?.status() ?? null,
    page_title: await page.title(),
  };
}

async function getTvPlayer(page, videoId) {
  return page.evaluate(
    async ({ id, clientDef }) => {
      const get = globalThis.ytcfg?.get?.bind(globalThis.ytcfg);
      const rawContext = get ? get("INNERTUBE_CONTEXT") : null;
      const apiKey = get ? get("INNERTUBE_API_KEY") : null;
      const visitorData =
        (get ? get("VISITOR_DATA") : null) || rawContext?.client?.visitorData || null;

      if (!apiKey) return { error: "INNERTUBE_API_KEY not found" };
      if (!rawContext?.client) return { error: "TV INNERTUBE_CONTEXT not found" };

      const context = JSON.parse(JSON.stringify(rawContext));
      const client = {
        ...context.client,
        clientName: clientDef.clientName,
        clientVersion: clientDef.clientVersion,
        hl: "en",
        gl: "US",
        userAgent: clientDef.userAgent,
        ...(visitorData ? { visitorData } : {}),
      };

      if (client.configInfo?.appInstallData) {
        delete client.configInfo.appInstallData;
      }
      context.client = client;

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
            context,
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
        ? player.streamingData.adaptiveFormats
        : [];
      const direct = adaptive.filter((format) => format && typeof format.url === "string");
      const ciphered = adaptive.filter(
        (format) => format && !format.url && (format.signatureCipher || format.cipher),
      );
      const videoCandidates = direct.filter((format) => {
        const mime = String(format?.mimeType || "");
        return mime.includes("video/mp4") && mime.includes("avc1");
      });
      const video =
        videoCandidates.find((format) => Number(format?.height || 0) === 720) ||
        videoCandidates[0] ||
        null;

      return {
        player_http_status: response.status,
        playability_status: player?.playabilityStatus?.status || null,
        playability_reason: player?.playabilityStatus?.reason || null,
        visitor_data_present: Boolean(visitorData),
        context_client_name: context?.client?.clientName || null,
        context_client_version: context?.client?.clientVersion || null,
        adaptive_count: adaptive.length,
        direct_adaptive_count: direct.length,
        ciphered_adaptive_count: ciphered.length,
        video,
      };
    },
    { id: videoId, clientDef: TV_CLIENT },
  );
}

async function probeRange(browser, format) {
  const total = Number(format?.contentLength || 0);
  const start = RANGE_START;
  const end = total
    ? Math.min(start + RANGE_LENGTH - 1, total - 1)
    : start + RANGE_LENGTH - 1;
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
    await page.setUserAgent(TV_CLIENT.userAgent);
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
        status,
        requested_range: requestedRange,
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
      status,
      requested_range: requestedRange,
      content_range: contentRange,
      content_type: contentType,
      received_bytes: received,
      cdp_read_count: readCount,
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
    resolver = await openTvPage(browser);
    const player = await getTvPlayer(resolver.page, videoId);
    const result = {
      result: "tvhtml5-static-probe-complete",
      browser_session_count: 1,
      page_source: "youtube_tv",
      page_http_status: resolver.page_http_status,
      page_title: resolver.page_title,
      client: {
        id: TV_CLIENT.id,
        name: TV_CLIENT.clientName,
        version: TV_CLIENT.clientVersion,
      },
      player: {
        player_http_status: player.player_http_status ?? null,
        playability_status: player.playability_status ?? null,
        playability_reason: player.playability_reason ?? player.error ?? null,
        visitor_data_present: player.visitor_data_present ?? false,
        context_client_name: player.context_client_name ?? null,
        context_client_version: player.context_client_version ?? null,
        adaptive_count: player.adaptive_count ?? 0,
        direct_adaptive_count: player.direct_adaptive_count ?? 0,
        ciphered_adaptive_count: player.ciphered_adaptive_count ?? 0,
        selected_video: publicFormat(player.video),
      },
      range_probe: null,
      elapsed_ms: null,
      local_pc_required: false,
      browser_run_used: true,
      paid_cloudflare_feature_used: false,
    };

    if (player.playability_status === "OK" && player.video?.url) {
      result.range_probe = await probeRange(browser, player.video);
    }

    result.elapsed_ms = Date.now() - started;
    return result;
  } finally {
    if (resolver?.page) await resolver.page.close().catch(() => {});
    await browser.close().catch(() => {});
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
      if (url.pathname === "/probe/tvhtml5") {
        return json(await runProbe(env, videoId));
      }
      return json({
        service: "youtube-free-browser-tvhtml5-probe",
        endpoint: "/probe/tvhtml5",
        fixed_test_video_id: TEST_VIDEO_ID,
        local_pc_required: false,
        browser_run_used: true,
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
