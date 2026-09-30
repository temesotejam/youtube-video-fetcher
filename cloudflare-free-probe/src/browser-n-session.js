import puppeteer from "@cloudflare/puppeteer";

const TEST_VIDEO_ID = "2NJdNKJ9LPM";
const MAX_CHUNK_BYTES = 10 * 1024 * 1024;
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

async function prepareSession(env, videoId) {
  const browser = await puppeteer.launch(env.BROWSER, { keep_alive: 600000 });
  let keepOpen = false;
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
    } catch {}

    const raw = await page.evaluate(
      async ({ id, clientDef }) => {
        const get = globalThis.ytcfg?.get?.bind(globalThis.ytcfg);
        const context = get ? get("INNERTUBE_CONTEXT") : null;
        const apiKey = get ? get("INNERTUBE_API_KEY") : null;
        const visitorData =
          (get ? get("VISITOR_DATA") : null) || context?.client?.visitorData || null;
        const playerJs =
          (get ? get("PLAYER_JS_URL") : null) ||
          Array.from(document.scripts)
            .map((script) => script.src)
            .find((src) => src.includes("/s/player/") && src.includes("base.js")) ||
          null;

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
          player_js_url: playerJs
            ? new URL(playerJs, location.origin).toString()
            : null,
          video,
        });
      },
      { id: videoId, clientDef: ANDROID_VR },
    );

    const result = JSON.parse(raw);
    if (result.playability_status !== "OK" || !result.video?.url) {
      throw new Error(
        `Player not OK: ${result.playability_status || "unknown"} ${result.playability_reason || result.error || ""}`,
      );
    }
    if (!result.player_js_url) throw new Error("PLAYER_JS_URL not found");

    const streamUrl = new URL(result.video.url);
    const nChallenge = streamUrl.searchParams.get("n");
    if (!nChallenge) throw new Error("Direct MP4 URL has no n challenge");

    const state = {
      videoId,
      streamUrl: result.video.url,
      contentLength: result.video.contentLength || null,
      itag: result.video.itag ?? null,
      mimeType: result.video.mimeType || null,
    };
    await page.evaluate((serialized) => {
      globalThis.__YVF_STATE = serialized;
    }, JSON.stringify(state));

    const sessionId = browser.sessionId();
    keepOpen = true;
    browser.disconnect();

    return {
      result: "session-prepared",
      session_id: sessionId,
      page_http_status: nav?.status() ?? null,
      page_title: await page.title().catch(() => null),
      player_http_status: result.player_http_status,
      playability_status: result.playability_status,
      direct_adaptive_count: result.direct_adaptive_count,
      source_itag: result.video.itag ?? null,
      source_height: result.video.height ?? null,
      source_total_bytes: result.video.contentLength || null,
      n_challenge: nChallenge,
      player_js_url: result.player_js_url,
      stream_url_returned: false,
      keep_alive_ms: 600000,
    };
  } finally {
    if (!keepOpen) await browser.close().catch(() => {});
  }
}

async function findStatePage(browser) {
  const pages = await browser.pages();
  for (const page of pages) {
    try {
      const state = await page.evaluate(() => globalThis.__YVF_STATE || null);
      if (typeof state === "string") return { page, state: JSON.parse(state) };
    } catch {}
  }
  throw new Error("Prepared session state not found");
}

async function fetchSolvedRange(browser, state, solvedN, start, length) {
  const total = Number(state.contentLength || 0);
  if (!Number.isSafeInteger(start) || start < 0) throw new Error("Invalid start");
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_CHUNK_BYTES) {
    throw new Error(`length must be 1..${MAX_CHUNK_BYTES}`);
  }
  if (total && start >= total) throw new Error("start beyond content length");
  const end = total ? Math.min(start + length - 1, total - 1) : start + length - 1;
  const expected = end - start + 1;

  const solvedUrl = new URL(state.streamUrl);
  solvedUrl.searchParams.set("n", solvedN);
  const origin = solvedUrl.origin;
  const page = await browser.newPage();
  try {
    await page.setUserAgent(ANDROID_VR.userAgent);
    let landed = false;
    for (const landing of [`${origin}/robots.txt`, `${origin}/`]) {
      try {
        await page.goto(landing, { waitUntil: "domcontentloaded", timeout: 5000 });
      } catch {}
      try {
        if (new URL(page.url()).origin === origin) {
          landed = true;
          break;
        }
      } catch {}
    }
    if (!landed) throw new Error("Could not establish googlevideo same-origin page");

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
          content_range: response.headers.get("content-range"),
          received_bytes: bytes.byteLength,
          body_base64: btoa(binary),
        });
      },
      { url: solvedUrl.toString(), startByte: start, endByte: end },
    );

    const result = JSON.parse(raw);
    if (result.status !== 206 || result.received_bytes !== expected) {
      throw new Error(
        `solved-n range failed: status=${result.status} range=${result.content_range} bytes=${result.received_bytes} expected=${expected}`,
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
      contentType: result.content_type || "video/mp4",
      contentRange: result.content_range || "",
    };
  } finally {
    await page.close();
  }
}

async function resumeChunk(env, sessionId, solvedN, start, length) {
  const browser = await puppeteer.connect(env.BROWSER, sessionId);
  try {
    const { state } = await findStatePage(browser);
    const chunk = await fetchSolvedRange(browser, state, solvedN, start, length);
    const headers = new Headers({
      "Content-Type": chunk.contentType,
      "Content-Length": String(chunk.body.byteLength),
      "Cache-Control": "no-store, max-age=0",
      "X-Upstream-Status": String(chunk.status),
      "X-Upstream-Content-Range": chunk.contentRange,
      "X-Chunk-Start": String(chunk.start),
      "X-Chunk-End": String(chunk.end),
      "X-Source-Itag": String(state.itag ?? ""),
      "X-Source-Total-Bytes": String(state.contentLength || ""),
      "X-N-Solved": "true",
      "X-Capture-Method": "persistent-session-solved-n",
      "X-Paid-Cloudflare-Feature": "false",
    });
    return new Response(chunk.body, { status: 200, headers });
  } finally {
    browser.disconnect();
  }
}

async function closeSession(env, sessionId) {
  const browser = await puppeteer.connect(env.BROWSER, sessionId);
  await browser.close();
  return json({ result: "session-closed" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const videoId = url.searchParams.get("v") || TEST_VIDEO_ID;
    if (videoId !== TEST_VIDEO_ID) return json({ error: "Fixed test video only" }, 403);

    try {
      if (url.pathname === "/session/prepare") {
        return json(await prepareSession(env, videoId));
      }
      if (url.pathname === "/session/chunk") {
        const sessionId = url.searchParams.get("session");
        const solvedN = url.searchParams.get("n");
        const start = Number(url.searchParams.get("start") ?? 4 * 1024 * 1024);
        const length = Number(url.searchParams.get("length") ?? 4 * 1024 * 1024);
        if (!sessionId || !solvedN) return json({ error: "session and n are required" }, 400);
        return await resumeChunk(env, sessionId, solvedN, start, length);
      }
      if (url.pathname === "/session/close") {
        const sessionId = url.searchParams.get("session");
        if (!sessionId) return json({ error: "session is required" }, 400);
        return await closeSession(env, sessionId);
      }
      return json({
        service: "youtube-free-browser-n-session",
        endpoints: ["/session/prepare", "/session/chunk", "/session/close"],
        keep_alive_ms: 600000,
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
