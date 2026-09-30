import puppeteer from "@cloudflare/puppeteer";

const TEST_VIDEO_ID = "2NJdNKJ9LPM";
const DEFAULT_START = 4 * 1024 * 1024;
const PIECE_BYTES = 64 * 1024;
const MAX_DIRECT_BYTES = 1024 * 1024;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
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

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
  return bytes;
}

async function resolveVideo(browser, videoId) {
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
    } catch {}

    const result = await page.evaluate(
      async ({ id, clientDef }) => {
        const get = globalThis.ytcfg?.get?.bind(globalThis.ytcfg);
        const context = get ? get("INNERTUBE_CONTEXT") : null;
        const apiKey = get ? get("INNERTUBE_API_KEY") : null;
        const visitorData =
          (get ? get("VISITOR_DATA") : null) || context?.client?.visitorData || null;
        if (!apiKey) return JSON.stringify({ error: "INNERTUBE_API_KEY not found" });

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
              (f) => f && typeof f.url === "string",
            )
          : [];
        const candidates = adaptive.filter((f) => {
          const mime = String(f?.mimeType || "");
          return mime.includes("video/mp4") && mime.includes("avc1");
        });
        const video =
          candidates.find((f) => Number(f?.height || 0) === 720) ||
          candidates[0] ||
          null;
        return JSON.stringify({
          player_http_status: response.status,
          playability_status: player?.playabilityStatus?.status || null,
          playability_reason: player?.playabilityStatus?.reason || null,
          direct_adaptive_count: adaptive.length,
          video,
        });
      },
      { id: videoId, clientDef: ANDROID_VR },
    );

    return {
      page_http_status: nav?.status() ?? null,
      page_title: await page.title(),
      player: JSON.parse(result),
    };
  } finally {
    await page.close();
  }
}

function validateRange(format, start, length, maxLength) {
  const total = Number(format?.contentLength || 0);
  if (!Number.isSafeInteger(start) || start < 0) throw new Error("Invalid start");
  if (!Number.isSafeInteger(length) || length < 1 || length > maxLength) {
    throw new Error(`length must be 1..${maxLength}`);
  }
  if (total && start >= total) throw new Error("start beyond content length");
  const end = total ? Math.min(start + length - 1, total - 1) : start + length - 1;
  return { total, start, end, expected: end - start + 1 };
}

async function openGooglevideoOriginPage(browser, format) {
  const streamUrl = new URL(format.url);
  const page = await browser.newPage();
  await page.setUserAgent(ANDROID_VR.userAgent);
  const landingCandidates = [`${streamUrl.origin}/robots.txt`, `${streamUrl.origin}/`];
  let landed = false;
  for (const landing of landingCandidates) {
    try {
      await page.goto(landing, { waitUntil: "domcontentloaded", timeout: 5000 });
    } catch {}
    try {
      if (new URL(page.url()).origin === streamUrl.origin) {
        landed = true;
        break;
      }
    } catch {}
  }
  if (!landed) {
    await page.close();
    throw new Error("Could not establish googlevideo same-origin page");
  }
  return page;
}

async function fetchSameOriginRange(browser, format, start, length) {
  const range = validateRange(format, start, length, MAX_DIRECT_BYTES);
  const page = await openGooglevideoOriginPage(browser, format);
  try {
    const raw = await page.evaluate(
      async ({ url, startByte, endByte }) => {
        const response = await fetch(url, {
          method: "GET",
          headers: { Range: `bytes=${startByte}-${endByte}`, Accept: "*/*" },
          credentials: "include",
          cache: "no-store",
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        const block = 16 * 1024;
        for (let i = 0; i < bytes.length; i += block) {
          binary += String.fromCharCode(...bytes.subarray(i, i + block));
        }
        return JSON.stringify({
          status: response.status,
          content_type: response.headers.get("content-type"),
          content_range: response.headers.get("content-range"),
          received_bytes: bytes.byteLength,
          body_base64: btoa(binary),
        });
      },
      { url: format.url, startByte: range.start, endByte: range.end },
    );
    const result = JSON.parse(raw);
    if (
      result.status !== 206 ||
      !String(result.content_range || "").startsWith(`bytes ${range.start}-`) ||
      result.received_bytes !== range.expected
    ) {
      throw new Error(
        `Unexpected same-origin range response: status=${result.status} range=${result.content_range} bytes=${result.received_bytes}`,
      );
    }
    const body = decodeBase64(result.body_base64);
    if (body.byteLength !== range.expected) {
      throw new Error(`Decoded size mismatch: expected ${range.expected}, got ${body.byteLength}`);
    }
    return {
      body,
      start: range.start,
      end: range.end,
      status: result.status,
      content_type: result.content_type || "video/mp4",
      content_range: result.content_range,
    };
  } finally {
    await page.close();
  }
}

async function fetchSameOriginBatch(browser, format, start, length) {
  const range = validateRange(format, start, length, MAX_BATCH_BYTES);
  const page = await openGooglevideoOriginPage(browser, format);
  try {
    const raw = await page.evaluate(
      async ({ url, startByte, endByte, pieceBytes }) => {
        const parts = [];
        const ranges = [];
        let received = 0;
        for (let pos = startByte; pos <= endByte; pos += pieceBytes) {
          const partEnd = Math.min(pos + pieceBytes - 1, endByte);
          const response = await fetch(url, {
            method: "GET",
            headers: { Range: `bytes=${pos}-${partEnd}`, Accept: "*/*" },
            credentials: "include",
            cache: "no-store",
          });
          const contentRange = response.headers.get("content-range");
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (
            response.status !== 206 ||
            !String(contentRange || "").startsWith(`bytes ${pos}-`) ||
            bytes.byteLength !== partEnd - pos + 1
          ) {
            throw new Error(
              `piece failed: ${pos}-${partEnd} status=${response.status} range=${contentRange} bytes=${bytes.byteLength}`,
            );
          }
          let binary = "";
          const block = 16 * 1024;
          for (let i = 0; i < bytes.length; i += block) {
            binary += String.fromCharCode(...bytes.subarray(i, i + block));
          }
          parts.push(btoa(binary));
          ranges.push(contentRange);
          received += bytes.byteLength;
        }
        return JSON.stringify({ parts, ranges, received });
      },
      {
        url: format.url,
        startByte: range.start,
        endByte: range.end,
        pieceBytes: PIECE_BYTES,
      },
    );

    const result = JSON.parse(raw);
    if (result.received !== range.expected) {
      throw new Error(`Batch size mismatch: expected ${range.expected}, got ${result.received}`);
    }
    const decoded = result.parts.map(decodeBase64);
    const body = new Uint8Array(range.expected);
    let offset = 0;
    for (const part of decoded) {
      body.set(part, offset);
      offset += part.byteLength;
    }
    return {
      body,
      start: range.start,
      end: range.end,
      status: 206,
      content_type: "video/mp4",
      piece_count: decoded.length,
      piece_bytes: PIECE_BYTES,
      first_content_range: result.ranges[0] || "",
      last_content_range: result.ranges[result.ranges.length - 1] || "",
    };
  } finally {
    await page.close();
  }
}

async function withResolvedVideo(env, videoId, callback) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const resolved = await resolveVideo(browser, videoId);
    const player = resolved.player;
    if (player.playability_status !== "OK" || !player.video?.url) {
      throw new Error(
        `Player not OK: ${player.playability_status || "unknown"} ${player.playability_reason || player.error || ""}`,
      );
    }
    return await callback(browser, resolved, player);
  } finally {
    await browser.close();
  }
}

function mediaResponse(result, format, captureMethod) {
  const chunk = result.chunk;
  const headers = new Headers({
    "Content-Type": chunk.content_type,
    "Content-Length": String(chunk.body.byteLength),
    "Cache-Control": "no-store, max-age=0",
    "X-Upstream-Status": String(chunk.status),
    "X-Chunk-Start": String(chunk.start),
    "X-Chunk-End": String(chunk.end),
    "X-Source-Itag": String(format.itag ?? ""),
    "X-Source-Total-Bytes": String(format.contentLength || ""),
    "X-Capture-Method": captureMethod,
    "X-Paid-Cloudflare-Feature": "false",
  });
  if (chunk.content_range) headers.set("X-Upstream-Content-Range", chunk.content_range);
  if (chunk.piece_count) {
    headers.set("X-Piece-Count", String(chunk.piece_count));
    headers.set("X-Piece-Bytes", String(chunk.piece_bytes));
    headers.set("X-First-Upstream-Content-Range", chunk.first_content_range);
    headers.set("X-Last-Upstream-Content-Range", chunk.last_content_range);
  }
  return new Response(chunk.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const videoId = url.searchParams.get("v") || TEST_VIDEO_ID;
    if (videoId !== TEST_VIDEO_ID) return json({ error: "Fixed test video only" }, 403);

    try {
      if (url.pathname === "/probe/ranges") {
        const result = await withResolvedVideo(
          env,
          videoId,
          async (browser, resolved, player) => {
            const chunk = await fetchSameOriginRange(
              browser,
              player.video,
              DEFAULT_START,
              PIECE_BYTES,
            );
            return {
              result: "same-origin-mp4-body-succeeded",
              page_http_status: resolved.page_http_status,
              page_title: resolved.page_title,
              player_http_status: player.player_http_status,
              playability_status: player.playability_status,
              direct_adaptive_count: player.direct_adaptive_count,
              upstream_status: chunk.status,
              content_range: chunk.content_range,
              received_bytes: chunk.body.byteLength,
              full_media_downloaded: false,
              local_pc_required: false,
              browser_run_used: true,
              paid_cloudflare_feature_used: false,
            };
          },
        );
        return json(result);
      }

      if (url.pathname === "/chunk/video" || url.pathname === "/batch/video") {
        const start = Number(url.searchParams.get("start") ?? DEFAULT_START);
        const defaultLength = url.pathname === "/batch/video" ? 1024 * 1024 : PIECE_BYTES;
        const length = Number(url.searchParams.get("length") ?? defaultLength);
        const batched = url.pathname === "/batch/video";
        const result = await withResolvedVideo(
          env,
          videoId,
          (browser, _resolved, player) =>
            (batched
              ? fetchSameOriginBatch(browser, player.video, start, length)
              : fetchSameOriginRange(browser, player.video, start, length)
            ).then((chunk) => ({ chunk, format: player.video })),
        );
        return mediaResponse(
          result,
          result.format,
          batched ? "same-origin-64k-batch" : "same-origin-fetch",
        );
      }

      return json({
        service: "youtube-free-browser-mp4-same-origin",
        endpoints: ["/probe/ranges", "/chunk/video", "/batch/video"],
        piece_bytes: PIECE_BYTES,
        max_batch_bytes: MAX_BATCH_BYTES,
        local_pc_required: false,
        paid_cloudflare_feature_used: false,
      });
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
