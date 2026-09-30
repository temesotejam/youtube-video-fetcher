import puppeteer from "@cloudflare/puppeteer";

const TEST_VIDEO_ID = "2NJdNKJ9LPM";
const DEFAULT_START = 4 * 1024 * 1024;
const DEFAULT_LENGTH = 4 * 1024 * 1024;
const MAX_LENGTH = 8 * 1024 * 1024;
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

async function resolveFormat18(browser, videoId) {
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
        const formats = Array.isArray(player?.streamingData?.formats)
          ? player.streamingData.formats
          : [];
        const format18 = formats.find(
          (f) => f?.itag === 18 && typeof f?.url === "string",
        ) || null;
        return JSON.stringify({
          player_http_status: response.status,
          playability_status: player?.playabilityStatus?.status || null,
          playability_reason: player?.playabilityStatus?.reason || null,
          formats_count: formats.length,
          format18,
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

async function fetchRange(browser, format, start, length) {
  const total = Number(format?.contentLength || 0);
  if (!Number.isSafeInteger(start) || start < 0) throw new Error("Invalid start");
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_LENGTH) {
    throw new Error(`length must be 1..${MAX_LENGTH}`);
  }
  if (total && start >= total) throw new Error("start beyond content length");
  const end = total ? Math.min(start + length - 1, total - 1) : start + length - 1;
  const expected = end - start + 1;

  const page = await openSameOriginPage(browser, format);
  try {
    const raw = await page.evaluate(
      async ({ url, startByte, endByte }) => {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Range: `bytes=${startByte}-${endByte}`,
            Accept: "*/*",
          },
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
          content_length: response.headers.get("content-length"),
          content_range: response.headers.get("content-range"),
          received_bytes: bytes.byteLength,
          body_base64: btoa(binary),
        });
      },
      { url: format.url, startByte: start, endByte: end },
    );

    const result = JSON.parse(raw);
    if (
      result.status !== 206 ||
      result.received_bytes !== expected
    ) {
      throw new Error(
        `format18 range failed: status=${result.status} range=${result.content_range} bytes=${result.received_bytes} expected=${expected}`,
      );
    }
    const body = decodeBase64(result.body_base64);
    if (body.byteLength !== expected) {
      throw new Error(`decoded size mismatch: expected ${expected}, got ${body.byteLength}`);
    }
    return {
      body,
      start,
      end,
      status: result.status,
      content_type: result.content_type || "video/mp4",
      content_range: result.content_range,
    };
  } finally {
    await page.close();
  }
}

async function withFormat18(env, videoId, callback) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const resolved = await resolveFormat18(browser, videoId);
    const player = resolved.player;
    if (player.playability_status !== "OK" || !player.format18?.url) {
      throw new Error(
        `Format 18 unavailable: ${player.playability_status || "unknown"} ${player.playability_reason || player.error || ""}`,
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
      if (url.pathname === "/chunk/video") {
        const start = Number(url.searchParams.get("start") ?? DEFAULT_START);
        const length = Number(url.searchParams.get("length") ?? DEFAULT_LENGTH);
        const result = await withFormat18(env, videoId, async (browser, resolved, player) => ({
          resolved,
          player,
          chunk: await fetchRange(browser, player.format18, start, length),
        }));
        const { chunk, player } = result;
        const headers = new Headers({
          "Content-Type": chunk.content_type,
          "Content-Length": String(chunk.body.byteLength),
          "Cache-Control": "no-store, max-age=0",
          "X-Upstream-Status": String(chunk.status),
          "X-Chunk-Start": String(chunk.start),
          "X-Chunk-End": String(chunk.end),
          "X-Source-Itag": "18",
          "X-Source-Total-Bytes": String(player.format18.contentLength || ""),
          "X-Format-18": "true",
          "X-Has-Audio": "true",
          "X-Capture-Method": "format18-same-origin-range",
          "X-Paid-Cloudflare-Feature": "false",
        });
        if (chunk.content_range) headers.set("X-Upstream-Content-Range", chunk.content_range);
        return new Response(chunk.body, { status: 200, headers });
      }

      return json({
        service: "youtube-free-browser-format18",
        endpoint: "/chunk/video",
        max_chunk_bytes: MAX_LENGTH,
        format: "itag 18 progressive MP4 with audio",
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
