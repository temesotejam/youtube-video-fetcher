import puppeteer from "@cloudflare/puppeteer";

const TEST_VIDEO_ID = "2NJdNKJ9LPM";
const DEFAULT_START = 4 * 1024 * 1024;
const DEFAULT_LENGTH = 64 * 1024;
const READ_SIZE = 16 * 1024;
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

function headerMap(headers = []) {
  const result = new Map();
  for (const header of headers) {
    if (header?.name) {
      result.set(String(header.name).toLowerCase(), String(header.value ?? ""));
    }
  }
  return result;
}

function decodeIoData(read) {
  if (!read?.data) return new Uint8Array(0);
  if (read.base64Encoded) {
    const binary = atob(read.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i) & 0xff;
    }
    return bytes;
  }
  return new TextEncoder().encode(read.data);
}

function concatChunks(chunks, total) {
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function getAndroidVrVideo(page, videoId) {
  return page.evaluate(
    async ({ id, clientDef }) => {
      const get = globalThis.ytcfg?.get?.bind(globalThis.ytcfg);
      const context = get ? get("INNERTUBE_CONTEXT") : null;
      const apiKey = get ? get("INNERTUBE_API_KEY") : null;
      const visitorData =
        (get ? get("VISITOR_DATA") : null) ||
        context?.client?.visitorData ||
        null;

      if (!apiKey) {
        return { error: "INNERTUBE_API_KEY not found" };
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
            (format) => format && typeof format.url === "string",
          )
        : [];
      const videoCandidates = adaptive.filter((format) => {
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
        direct_adaptive_count: adaptive.length,
        video,
      };
    },
    { id: videoId, clientDef: ANDROID_VR },
  );
}

async function resolveVideoInBrowser(browser, videoId) {
  const page = await browser.newPage();
  try {
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
      .waitForFunction(
        () => Boolean(globalThis.ytcfg?.get?.("INNERTUBE_API_KEY")),
        { timeout: 5000 },
      )
      .catch(() => {});

    const player = await getAndroidVrVideo(page, videoId);
    return {
      page_http_status: nav?.status() ?? null,
      page_title: await page.title(),
      player,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function validateRange(format, start, length) {
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
  return {
    total,
    start,
    end,
    expected: end - start + 1,
  };
}

async function fetchRangeViaCdp(browser, format, start, length) {
  const range = validateRange(format, start, length);
  const requestedRange = `bytes=${range.start}-${range.end}`;
  const page = await browser.newPage();
  const cdp = await page.target().createCDPSession();

  let timeoutId;
  let navError = null;
  let pausedResolve;
  let pausedReject;
  const pausedPromise = new Promise((resolve, reject) => {
    pausedResolve = resolve;
    pausedReject = reject;
  });

  try {
    await page.setUserAgent(ANDROID_VR.userAgent);
    await cdp.send("Network.enable");
    await cdp.send("Network.setExtraHTTPHeaders", {
      headers: {
        Range: requestedRange,
        Accept: "*/*",
      },
    });
    await cdp.send("Fetch.enable", {
      patterns: [
        {
          urlPattern: "*://*.googlevideo.com/videoplayback*",
          requestStage: "Response",
        },
      ],
    });

    cdp.on("Fetch.requestPaused", async (event) => {
      if (!event.request?.url?.includes("googlevideo.com/videoplayback")) {
        try {
          await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
        } catch {}
        return;
      }
      if (timeoutId) clearTimeout(timeoutId);
      pausedResolve(event);
    });

    timeoutId = setTimeout(
      () => pausedReject(new Error("Timed out waiting for googlevideo response")),
      20000,
    );

    const navPromise = page
      .goto(format.url, { waitUntil: "domcontentloaded", timeout: 25000 })
      .catch((error) => {
        navError = error instanceof Error ? error.message : String(error);
        return null;
      });

    const paused = await pausedPromise;
    const headers = headerMap(paused.responseHeaders || []);
    const status = paused.responseStatusCode ?? null;
    const contentRange = headers.get("content-range") || null;
    const contentLength = headers.get("content-length") || null;
    const contentType = headers.get("content-type") || null;

    if (status !== 206 || !String(contentRange || "").startsWith(`bytes ${range.start}-`)) {
      throw new Error(
        `Unexpected upstream range response: status=${status} content-range=${contentRange}`,
      );
    }

    const { stream } = await cdp.send("Fetch.takeResponseBodyAsStream", {
      requestId: paused.requestId,
    });

    const chunks = [];
    let total = 0;
    let eof = false;
    let readCount = 0;

    while (!eof) {
      const remaining = range.expected - total;
      const read = await cdp.send("IO.read", {
        handle: stream,
        size: Math.min(READ_SIZE, Math.max(remaining, 1)),
      });
      const chunk = decodeIoData(read);
      if (chunk.byteLength) {
        if (total + chunk.byteLength > range.expected) {
          throw new Error(
            `CDP stream exceeded requested range: ${total + chunk.byteLength} > ${range.expected}`,
          );
        }
        chunks.push(chunk);
        total += chunk.byteLength;
      }
      eof = Boolean(read.eof);
      readCount += 1;
      if (readCount > 128) {
        throw new Error("Too many CDP IO.read calls");
      }
    }

    await cdp.send("IO.close", { handle: stream }).catch(() => {});
    await cdp
      .send("Fetch.failRequest", {
        requestId: paused.requestId,
        errorReason: "Aborted",
      })
      .catch(() => {});
    await navPromise;

    if (total !== range.expected) {
      throw new Error(
        `CDP stream size mismatch: expected ${range.expected}, got ${total}`,
      );
    }

    return {
      body: concatChunks(chunks, total),
      start: range.start,
      end: range.end,
      expected_bytes: range.expected,
      status,
      content_type: contentType || "video/mp4",
      content_length: contentLength,
      content_range: contentRange,
      cdp_read_count: readCount,
      cdp_read_size: READ_SIZE,
      eof,
      nav_error: navError,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    await cdp.send("Fetch.disable").catch(() => {});
    await page.close().catch(() => {});
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

    const chunk = await fetchRangeViaCdp(
      browser,
      player.video,
      start,
      length,
    );

    const headers = new Headers({
      "Content-Type": chunk.content_type,
      "Content-Length": String(chunk.body.byteLength),
      "Cache-Control": "no-store, max-age=0",
      "X-Upstream-Status": String(chunk.status),
      "X-Upstream-Content-Range": chunk.content_range || "",
      "X-Chunk-Start": String(chunk.start),
      "X-Chunk-End": String(chunk.end),
      "X-Source-Itag": String(player.video.itag ?? ""),
      "X-Source-Total-Bytes": String(player.video.contentLength || ""),
      "X-Capture-Method": "browser-binding-cdp-stream",
      "X-CDP-Read-Count": String(chunk.cdp_read_count),
      "X-CDP-Read-Size": String(chunk.cdp_read_size),
      "X-CDP-EOF": String(chunk.eof),
      "X-Browser-Run": "true",
      "X-Paid-Cloudflare-Feature": "false",
    });

    return new Response(chunk.body, { status: 200, headers });
  } finally {
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
      if (url.pathname === "/cdp/chunk/video") {
        const start = Number(url.searchParams.get("start") ?? DEFAULT_START);
        const length = Number(url.searchParams.get("length") ?? DEFAULT_LENGTH);
        return await runChunk(env, videoId, start, length);
      }

      return json({
        service: "youtube-free-browser-cdp-stream-probe",
        endpoints: ["/cdp/chunk/video"],
        fixed_test_video_id: TEST_VIDEO_ID,
        default_start: DEFAULT_START,
        default_length: DEFAULT_LENGTH,
        read_size: READ_SIZE,
        max_chunk_bytes: MAX_CHUNK_BYTES,
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
