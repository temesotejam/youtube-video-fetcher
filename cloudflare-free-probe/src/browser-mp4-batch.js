import puppeteer from "@cloudflare/puppeteer";

const TEST_VIDEO_ID = "2NJdNKJ9LPM";
const PIECE_BYTES = 64 * 1024;
const DEFAULT_START = 4 * 1024 * 1024;
const DEFAULT_BATCH = 1024 * 1024;
const MAX_BATCH = 4 * 1024 * 1024;
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

    const raw = await page.evaluate(
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
      player: JSON.parse(raw),
    };
  } finally {
    await page.close();
  }
}

async function openSameOriginPage(browser, format) {
  const origin = new URL(format.url).origin;
  const page = await browser.newPage();
  await page.setUserAgent(ANDROID_VR.userAgent);
  for (const landing of [`${origin}/robots.txt`, `${origin}/`]) {
    try {
      await page.goto(landing, { waitUntil: "domcontentloaded", timeout: 5000 });
    } catch {}
    try {
      if (new URL(page.url()).origin === origin) return page;
    } catch {}
  }
  await page.close();
  throw new Error("Could not establish googlevideo same-origin page");
}

async function fetchBatch(browser, format, start, length) {
  const total = Number(format?.contentLength || 0);
  if (!Number.isSafeInteger(start) || start < 0) throw new Error("Invalid start");
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_BATCH) {
    throw new Error(`length must be 1..${MAX_BATCH}`);
  }
  if (total && start >= total) throw new Error("start beyond content length");
  const end = total ? Math.min(start + length - 1, total - 1) : start + length - 1;
  const expected = end - start + 1;
  const page = await openSameOriginPage(browser, format);

  try {
    const raw = await page.evaluate(
      async ({ url, startByte, endByte, pieceBytes }) => {
        const parts = [];
        const details = [];
        let received = 0;
        for (let pos = startByte; pos <= endByte; pos += pieceBytes) {
          const partEnd = Math.min(pos + pieceBytes - 1, endByte);
          const response = await fetch(url, {
            method: "GET",
            headers: { Range: `bytes=${pos}-${partEnd}`, Accept: "*/*" },
            credentials: "include",
            cache: "no-store",
          });
          const bytes = new Uint8Array(await response.arrayBuffer());
          const expectedPart = partEnd - pos + 1;
          const contentRange = response.headers.get("content-range");
          if (response.status !== 206 || bytes.byteLength !== expectedPart) {
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
          details.push({
            start: pos,
            end: partEnd,
            status: response.status,
            bytes: bytes.byteLength,
            contentRange,
          });
          received += bytes.byteLength;
        }
        return JSON.stringify({ parts, details, received });
      },
      {
        url: format.url,
        startByte: start,
        endByte: end,
        pieceBytes: PIECE_BYTES,
      },
    );

    const result = JSON.parse(raw);
    if (result.received !== expected) {
      throw new Error(`Batch size mismatch: expected ${expected}, got ${result.received}`);
    }

    const decoded = result.parts.map(decodeBase64);
    const body = new Uint8Array(expected);
    let offset = 0;
    for (const part of decoded) {
      body.set(part, offset);
      offset += part.byteLength;
    }

    return {
      body,
      start,
      end,
      piece_count: decoded.length,
      first_piece: result.details[0],
      last_piece: result.details[result.details.length - 1],
    };
  } finally {
    await page.close();
  }
}

async function withVideo(env, videoId, callback) {
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const videoId = url.searchParams.get("v") || TEST_VIDEO_ID;
    if (videoId !== TEST_VIDEO_ID) return json({ error: "Fixed test video only" }, 403);

    try {
      if (url.pathname === "/batch/video") {
        const start = Number(url.searchParams.get("start") ?? DEFAULT_START);
        const length = Number(url.searchParams.get("length") ?? DEFAULT_BATCH);
        const result = await withVideo(env, videoId, async (browser, resolved, player) => ({
          resolved,
          player,
          batch: await fetchBatch(browser, player.video, start, length),
        }));
        const { batch, player } = result;
        return new Response(batch.body, {
          status: 200,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(batch.body.byteLength),
            "Cache-Control": "no-store, max-age=0",
            "X-Upstream-Status": "206",
            "X-Chunk-Start": String(batch.start),
            "X-Chunk-End": String(batch.end),
            "X-Source-Itag": String(player.video.itag ?? ""),
            "X-Source-Total-Bytes": String(player.video.contentLength || ""),
            "X-Capture-Method": "same-origin-64k-batch-relaxed-header",
            "X-Piece-Count": String(batch.piece_count),
            "X-Piece-Bytes": String(PIECE_BYTES),
            "X-First-Piece-Status": String(batch.first_piece?.status ?? ""),
            "X-First-Piece-Bytes": String(batch.first_piece?.bytes ?? ""),
            "X-Last-Piece-Status": String(batch.last_piece?.status ?? ""),
            "X-Last-Piece-Bytes": String(batch.last_piece?.bytes ?? ""),
            "X-Paid-Cloudflare-Feature": "false",
          },
        });
      }

      return json({
        service: "youtube-free-browser-mp4-batch",
        endpoint: "/batch/video",
        piece_bytes: PIECE_BYTES,
        max_batch_bytes: MAX_BATCH,
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
