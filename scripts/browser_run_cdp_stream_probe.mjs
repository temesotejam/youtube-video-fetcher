import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import util from "node:util";
import puppeteer from "puppeteer-core";

const VIDEO_ID = process.env.YOUTUBE_VIDEO_ID || "2NJdNKJ9LPM";
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const API_TOKEN =
  process.env.CLOUDFLARE_BROWSER_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";
const TOKEN_SOURCE = process.env.CLOUDFLARE_BROWSER_TOKEN
  ? "CLOUDFLARE_BROWSER_TOKEN"
  : "CLOUDFLARE_API_TOKEN";
const START = Number(process.env.PROBE_START || 4 * 1024 * 1024);
const LENGTH = Number(process.env.PROBE_LENGTH || 64 * 1024);
const READ_SIZE = Number(process.env.CDP_READ_SIZE || 16 * 1024);
const KEEP_ALIVE_MS = Number(process.env.BROWSER_RUN_KEEP_ALIVE_MS || 600_000);
const OUTPUT_DIR = process.env.OUTPUT_DIR || "output";

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ANDROID_VR = {
  id: 28,
  clientName: "ANDROID_VR",
  clientVersion: "1.65.10",
  userAgent:
    "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
};

function logStage(name, details = {}) {
  console.log(
    JSON.stringify({ stage: name, time: new Date().toISOString(), ...details }),
  );
}

function formatError(error) {
  if (error instanceof Error) return error.stack || error.message;
  return util.inspect(error, {
    depth: 8,
    colors: false,
    breakLength: 160,
    maxArrayLength: 40,
    maxStringLength: 2000,
  });
}

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`${name} is required. Use a Cloudflare API token with Browser Rendering - Edit permission.`);
  }
}

function assertProbeParams() {
  requireEnv("CLOUDFLARE_ACCOUNT_ID", ACCOUNT_ID);
  requireEnv("CLOUDFLARE_BROWSER_TOKEN or CLOUDFLARE_API_TOKEN", API_TOKEN);
  if (!VIDEO_ID_RE.test(VIDEO_ID)) throw new Error(`Invalid YouTube video ID: ${VIDEO_ID}`);
  if (!Number.isSafeInteger(START) || START < 0) throw new Error(`Invalid PROBE_START: ${START}`);
  if (!Number.isSafeInteger(LENGTH) || LENGTH < 1 || LENGTH > 1024 * 1024) {
    throw new Error(`Invalid PROBE_LENGTH: ${LENGTH}. Keep this probe at 1..1048576 bytes.`);
  }
  if (!Number.isSafeInteger(READ_SIZE) || READ_SIZE < 1024 || READ_SIZE > 256 * 1024) {
    throw new Error(`Invalid CDP_READ_SIZE: ${READ_SIZE}`);
  }
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function headerMap(headers = []) {
  const map = new Map();
  for (const header of headers) {
    if (header?.name) map.set(String(header.name).toLowerCase(), String(header.value ?? ""));
  }
  return map;
}

function bufferFromIoRead(readResult) {
  if (!readResult?.data) return Buffer.alloc(0);
  return readResult.base64Encoded
    ? Buffer.from(readResult.data, "base64")
    : Buffer.from(readResult.data, "utf8");
}

async function openBrowser() {
  const endpoint = new URL(
    `wss://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/browser-rendering/devtools/browser`,
  );
  endpoint.searchParams.set("keep_alive", String(KEEP_ALIVE_MS));
  logStage("connect_browser", {
    endpoint_host: endpoint.host,
    endpoint_path: endpoint.pathname,
    keep_alive_ms: KEEP_ALIVE_MS,
    token_source: TOKEN_SOURCE,
  });

  return puppeteer.connect({
    browserWSEndpoint: endpoint.toString(),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
    },
  });
}

async function resolveAndroidVrVideo(browser) {
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const type = request.resourceType();
      if (["image", "font", "stylesheet", "media"].includes(type)) {
        request.abort().catch(() => {});
      } else {
        request.continue().catch(() => {});
      }
    });

    const watchUrl = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
    logStage("open_youtube_watch", { video_id: VIDEO_ID });
    const nav = await page.goto(watchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    await page.waitForFunction(
      () => Boolean(globalThis.ytcfg?.get?.("INNERTUBE_API_KEY")),
      { timeout: 10_000 },
    ).catch(() => {});

    logStage("request_android_vr_player");
    const result = await page.evaluate(
      async ({ videoId, clientDef }) => {
        const get = globalThis.ytcfg?.get?.bind(globalThis.ytcfg);
        const context = get ? get("INNERTUBE_CONTEXT") : null;
        const apiKey = get ? get("INNERTUBE_API_KEY") : null;
        const visitorData =
          (get ? get("VISITOR_DATA") : null) || context?.client?.visitorData || null;

        if (!apiKey) {
          return {
            error: "INNERTUBE_API_KEY not found",
            visitor_data_present: Boolean(visitorData),
          };
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
              videoId,
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
          ? player.streamingData.adaptiveFormats.filter((f) => f && typeof f.url === "string")
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
      { videoId: VIDEO_ID, clientDef: ANDROID_VR },
    );

    if (result.error) throw new Error(result.error);
    if (result.playability_status !== "OK") {
      throw new Error(
        `Player not OK: ${result.playability_status || "unknown"} ${result.playability_reason || ""}`,
      );
    }
    if (!result.video?.url) throw new Error("Direct MP4 video URL not found");

    const streamHost = new URL(result.video.url).hostname;
    const contentLength = Number(result.video.contentLength || 0);
    if (contentLength && START >= contentLength) {
      throw new Error(`PROBE_START ${START} is beyond contentLength ${contentLength}`);
    }

    logStage("resolved_video_stream", {
      itag: result.video.itag ?? null,
      height: result.video.height ?? null,
      content_length: result.video.contentLength || null,
      host: streamHost,
    });

    return {
      page_http_status: nav?.status() ?? null,
      page_title: await page.title(),
      player: {
        player_http_status: result.player_http_status,
        playability_status: result.playability_status,
        playability_reason: result.playability_reason,
        visitor_data_present: result.visitor_data_present,
        direct_adaptive_count: result.direct_adaptive_count,
      },
      video: result.video,
      public_video_format: {
        itag: result.video.itag ?? null,
        mime_type: result.video.mimeType || null,
        width: result.video.width ?? null,
        height: result.video.height ?? null,
        bitrate: result.video.bitrate ?? null,
        content_length: result.video.contentLength || null,
        host: streamHost,
      },
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function streamRangeWithCdp(browser, videoUrl, start, length) {
  const mediaPage = await browser.newPage();
  const cdp = await mediaPage.target().createCDPSession();
  const end = start + length - 1;
  const requestedRange = `bytes=${start}-${end}`;

  let navError = null;
  let pausedResolve;
  let pausedReject;
  const pausedPromise = new Promise((resolve, reject) => {
    pausedResolve = resolve;
    pausedReject = reject;
  });
  const timeout = setTimeout(
    () => pausedReject(new Error("Timed out waiting for googlevideo response pause")),
    25_000,
  );

  try {
    logStage("enable_cdp_fetch", { requested_range: requestedRange });
    await mediaPage.setUserAgent(ANDROID_VR.userAgent);
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
      clearTimeout(timeout);
      pausedResolve(event);
    });

    const navPromise = mediaPage
      .goto(videoUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
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

    logStage("googlevideo_response_paused", {
      status,
      content_type: contentType,
      content_length: contentLength,
      content_range: contentRange,
    });

    if (status !== 206 || !String(contentRange || "").startsWith(`bytes ${start}-`)) {
      throw new Error(
        `Unexpected response headers: status=${status} content-range=${contentRange}`,
      );
    }

    const { stream } = await cdp.send("Fetch.takeResponseBodyAsStream", {
      requestId: paused.requestId,
    });
    logStage("cdp_stream_opened");

    const chunks = [];
    let total = 0;
    let eof = false;
    let readCount = 0;

    while (!eof) {
      const read = await cdp.send("IO.read", {
        handle: stream,
        size: Math.min(READ_SIZE, Math.max(length - total, 1)),
      });
      const chunk = bufferFromIoRead(read);
      if (chunk.length) {
        chunks.push(chunk);
        total += chunk.length;
      }
      eof = Boolean(read.eof);
      readCount += 1;
      logStage("cdp_stream_read", { read_count: readCount, chunk_bytes: chunk.length, total_bytes: total, eof });
      if (total > length) {
        throw new Error(`Read more bytes than requested: ${total} > ${length}`);
      }
    }

    await cdp.send("IO.close", { handle: stream }).catch(() => {});
    await cdp
      .send("Fetch.failRequest", { requestId: paused.requestId, errorReason: "Aborted" })
      .catch(() => {});
    await navPromise;

    const body = Buffer.concat(chunks, total);
    if (body.length !== length) {
      throw new Error(`Saved size mismatch: expected ${length}, got ${body.length}`);
    }

    return {
      body,
      meta: {
        requested_range: requestedRange,
        status,
        content_type: contentType,
        content_length: contentLength,
        content_range: contentRange,
        nav_error: navError,
        cdp_read_count: readCount,
        cdp_read_size: READ_SIZE,
        eof,
      },
    };
  } finally {
    clearTimeout(timeout);
    await cdp.send("Fetch.disable").catch(() => {});
    await mediaPage.close().catch(() => {});
  }
}

async function main() {
  logStage("start", {
    video_id: VIDEO_ID,
    probe_start: START,
    probe_length: LENGTH,
    cdp_read_size: READ_SIZE,
    keep_alive_ms: KEEP_ALIVE_MS,
    token_source: TOKEN_SOURCE,
  });
  assertProbeParams();
  mkdirp(OUTPUT_DIR);

  const started = Date.now();
  let browser;
  try {
    browser = await openBrowser();
    logStage("browser_connected");
    const resolved = await resolveAndroidVrVideo(browser);
    const { body, meta } = await streamRangeWithCdp(browser, resolved.video.url, START, LENGTH);

    const chunkPath = path.join(OUTPUT_DIR, "cdp-video-nonzero-64k.bin");
    fs.writeFileSync(chunkPath, body);

    const summary = {
      result: "cdp-stream-range-succeeded",
      video_id: VIDEO_ID,
      browser_session_count: 1,
      page_http_status: resolved.page_http_status,
      page_title: resolved.page_title,
      player: resolved.player,
      video_format: resolved.public_video_format,
      probe: {
        start: START,
        end: START + LENGTH - 1,
        expected_bytes: LENGTH,
        saved_bytes: body.length,
        sha256: crypto.createHash("sha256").update(body).digest("hex"),
        first16_hex: body.subarray(0, 16).toString("hex"),
        ...meta,
      },
      elapsed_ms: Date.now() - started,
      stream_url_logged: false,
      local_pc_required: false,
      paid_cloudflare_feature_used: false,
    };

    const summaryPath = path.join(OUTPUT_DIR, "cdp-range-probe.json");
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("RESULT=FAIL_CDP_STREAM_RANGE");
  console.error(formatError(error));
  process.exit(1);
});
