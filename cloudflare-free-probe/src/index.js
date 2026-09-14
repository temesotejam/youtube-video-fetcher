import puppeteer from "@cloudflare/puppeteer";

const DEFAULT_VIDEO_ID = "2NJdNKJ9LPM";
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const RANGE_PROBE_BYTES = 64 * 1024;

const PLAYER_CLIENTS = [
  {
    id: 56,
    key: "web_embedded",
    clientName: "WEB_EMBEDDED_PLAYER",
    clientVersion: "2.20260708.00.00",
    thirdParty: { embedUrl: "https://www.reddit.com/" },
  },
  {
    id: 2,
    key: "mweb",
    clientName: "MWEB",
    clientVersion: "2.20260708.05.00",
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)",
  },
  {
    id: 101,
    key: "visionos",
    clientName: "VISIONOS",
    clientVersion: "1.02",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    extraClient: {
      deviceMake: "Apple",
      deviceModel: "RealityDevice17,1",
      osName: "visionOS",
      osVersion: "26.5.23O471",
    },
  },
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function readAtMost(body, limit) {
  if (!body) return 0;
  const reader = body.getReader();
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += Math.min(value.byteLength, limit - total);
      if (total >= limit) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Diagnostic only.
    }
  }
  return total;
}

function summarizePlayerResponse(player) {
  const streaming = player?.streamingData || {};
  const formats = Array.isArray(streaming.formats) ? streaming.formats : [];
  const adaptive = Array.isArray(streaming.adaptiveFormats)
    ? streaming.adaptiveFormats
    : [];
  const all = [...formats, ...adaptive];
  const itag18 = all.find((f) => f?.itag === 18) || null;

  return {
    playability_status: player?.playabilityStatus?.status || null,
    playability_reason: player?.playabilityStatus?.reason || null,
    formats_count: formats.length,
    adaptive_count: adaptive.length,
    direct_url_count: all.filter((f) => typeof f?.url === "string").length,
    cipher_count: all.filter(
      (f) => typeof f?.signatureCipher === "string" || typeof f?.cipher === "string",
    ).length,
    has_server_abr_streaming_url:
      typeof streaming.serverAbrStreamingUrl === "string",
    itag18: itag18
      ? {
          mime_type: itag18.mimeType || null,
          bitrate: itag18.bitrate || null,
          width: itag18.width || null,
          height: itag18.height || null,
          content_length: itag18.contentLength || null,
          has_direct_url: typeof itag18.url === "string",
          has_signature_cipher:
            typeof itag18.signatureCipher === "string" ||
            typeof itag18.cipher === "string",
        }
      : null,
  };
}

function selectProgressiveMp4(player) {
  const formats = Array.isArray(player?.streamingData?.formats)
    ? player.streamingData.formats
    : [];
  return (
    formats.find(
      (f) =>
        f?.itag === 18 &&
        typeof f?.url === "string" &&
        String(f?.mimeType || "").includes("video/mp4"),
    ) ||
    formats.find(
      (f) =>
        typeof f?.url === "string" &&
        String(f?.mimeType || "").includes("video/mp4"),
    ) ||
    null
  );
}

async function harvestWebConfig(env, videoId) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "font", "stylesheet", "media"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const target = `https://www.youtube.com/watch?v=${videoId}`;
    const nav = await page.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const config = await page.evaluate(() => {
      const get = globalThis.ytcfg?.get?.bind(globalThis.ytcfg);
      const context = get ? get("INNERTUBE_CONTEXT") : null;
      return {
        apiKey: get ? get("INNERTUBE_API_KEY") : null,
        visitorData:
          (get ? get("VISITOR_DATA") : null) ||
          context?.client?.visitorData ||
          null,
        pageClientVersion: context?.client?.clientVersion || null,
      };
    });

    return {
      ...config,
      page_http_status: nav?.status() ?? null,
      page_title: await page.title(),
    };
  } finally {
    await browser.close();
  }
}

async function requestPlayer(apiKey, visitorData, videoId, def) {
  const client = {
    clientName: def.clientName,
    clientVersion: def.clientVersion,
    hl: "en",
    gl: "US",
    ...(def.userAgent ? { userAgent: def.userAgent } : {}),
    ...(def.extraClient || {}),
    ...(visitorData ? { visitorData } : {}),
  };

  const body = {
    context: {
      client,
      ...(def.thirdParty ? { thirdParty: def.thirdParty } : {}),
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };

  const headers = {
    "Content-Type": "application/json",
    "X-YouTube-Client-Name": String(def.id),
    "X-YouTube-Client-Version": def.clientVersion,
    Origin: "https://www.youtube.com",
  };
  if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData;
  if (def.userAgent) headers["User-Agent"] = def.userAgent;

  const response = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "follow",
    },
  );

  const text = await response.text();
  let player = null;
  try {
    player = JSON.parse(text);
  } catch {
    // Keep null; summary will explain the HTTP result.
  }

  return { response, player };
}

async function probeSelectedMp4(def, selected) {
  if (!selected?.url) return null;

  const headers = {
    Range: `bytes=0-${RANGE_PROBE_BYTES - 1}`,
    Accept: "*/*",
  };
  if (def.userAgent) headers["User-Agent"] = def.userAgent;

  const started = Date.now();
  const response = await fetch(selected.url, {
    headers,
    redirect: "follow",
  });
  const received = response.ok
    ? await readAtMost(response.body, RANGE_PROBE_BYTES)
    : 0;

  return {
    status: response.status,
    content_type: response.headers.get("Content-Type"),
    content_length: response.headers.get("Content-Length"),
    content_range: response.headers.get("Content-Range"),
    received_bytes_before_cancel: received,
    elapsed_ms: Date.now() - started,
    success: response.ok && received > 0,
  };
}

async function runPlayerClientProbe(env, videoId) {
  const started = Date.now();
  const harvested = await harvestWebConfig(env, videoId);

  if (!harvested.apiKey) {
    return {
      result: "innertube-api-key-not-found",
      harvested: {
        page_http_status: harvested.page_http_status,
        page_title: harvested.page_title,
        visitor_data_present: Boolean(harvested.visitorData),
      },
      full_media_downloaded: false,
      local_pc_required: false,
      paid_cloudflare_feature_used_by_this_probe: false,
    };
  }

  const results = [];
  let success = null;

  for (const def of PLAYER_CLIENTS) {
    try {
      const { response, player } = await requestPlayer(
        harvested.apiKey,
        harvested.visitorData,
        videoId,
        def,
      );
      const summary = summarizePlayerResponse(player);
      const selected = selectProgressiveMp4(player);
      const rangeProbe = selected ? await probeSelectedMp4(def, selected) : null;

      const item = {
        client: def.key,
        player_http_status: response.status,
        summary,
        selected_progressive_mp4: selected
          ? {
              itag: selected.itag ?? null,
              mime_type: selected.mimeType ?? null,
              width: selected.width ?? null,
              height: selected.height ?? null,
              content_length: selected.contentLength ?? null,
            }
          : null,
        range_probe: rangeProbe,
      };
      results.push(item);

      if (rangeProbe?.success) {
        success = item;
        break;
      }
    } catch (error) {
      results.push({
        client: def.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    result: success
      ? "progressive-mp4-range-succeeded-from-worker-origin"
      : "no-downloadable-progressive-mp4-found",
    elapsed_ms: Date.now() - started,
    harvested: {
      page_http_status: harvested.page_http_status,
      page_title: harvested.page_title,
      visitor_data_present: Boolean(harvested.visitorData),
      page_client_version: harvested.pageClientVersion,
    },
    clients: results,
    winning_client: success?.client || null,
    stream_url_returned_to_client: false,
    full_media_downloaded: false,
    local_pc_required: false,
    paid_cloudflare_feature_used_by_this_probe: false,
  };
}

async function runSameSessionProbe(env, videoId) {
  const target = `https://www.youtube.com/watch?v=${videoId}`;
  const started = Date.now();
  const browser = await puppeteer.launch(env.BROWSER, {
    args: ["--autoplay-policy=no-user-gesture-required"],
  });

  try {
    const page = await browser.newPage();
    let firstGooglevideoRequest = null;
    let requestCount = 0;

    let resolveGooglevideoResponse;
    const googlevideoResponse = new Promise((resolve) => {
      resolveGooglevideoResponse = resolve;
      setTimeout(() => resolve(null), 12000);
    });

    page.on("response", (response) => {
      const responseUrl = response.url();
      if (!responseUrl.includes("googlevideo.com/videoplayback")) return;
      const headers = response.headers();
      resolveGooglevideoResponse({
        status: response.status(),
        content_type: headers["content-type"] || null,
        content_length: headers["content-length"] || null,
        content_range: headers["content-range"] || null,
        host: new URL(responseUrl).hostname,
      });
    });

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const requestUrl = req.url();
      const type = req.resourceType();

      if (requestUrl.includes("googlevideo.com/videoplayback")) {
        requestCount += 1;
        if (!firstGooglevideoRequest) {
          firstGooglevideoRequest = {
            resource_type: type,
            method: req.method(),
            host: new URL(requestUrl).hostname,
          };
          req.continue({
            headers: {
              ...req.headers(),
              range: `bytes=0-${RANGE_PROBE_BYTES - 1}`,
            },
          });
          return;
        }
        req.abort();
        return;
      }

      if (["image", "font", "stylesheet"].includes(type)) {
        req.abort();
        return;
      }
      req.continue();
    });

    const nav = await page.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    try {
      await page.waitForFunction(
        () => Boolean(globalThis.ytInitialPlayerResponse?.streamingData),
        { timeout: 8000 },
      );
    } catch {
      // Continue; the player can still issue media requests.
    }

    const streamingSummary = await page.evaluate(() => {
      const streaming = globalThis.ytInitialPlayerResponse?.streamingData || {};
      return {
        keys: Object.keys(streaming),
        formats_count: Array.isArray(streaming.formats) ? streaming.formats.length : 0,
        adaptive_count: Array.isArray(streaming.adaptiveFormats)
          ? streaming.adaptiveFormats.length
          : 0,
        has_server_abr_streaming_url:
          typeof streaming.serverAbrStreamingUrl === "string",
      };
    });

    try {
      await page.waitForSelector("video", { timeout: 8000 });
      await page.evaluate(async () => {
        const video = document.querySelector("video");
        if (!video) return;
        video.muted = true;
        try {
          await video.play();
        } catch {
          // It may already be loading.
        }
      });
    } catch {
      // Continue to response wait.
    }

    const responseMeta = await googlevideoResponse;
    const rangeHonored =
      responseMeta?.status === 206 || Boolean(responseMeta?.content_range);

    return {
      result: responseMeta
        ? rangeHonored
          ? "same-session-player-range-succeeded"
          : "same-session-player-request-reached-googlevideo"
        : firstGooglevideoRequest
          ? "googlevideo-request-seen-no-response"
          : "no-googlevideo-request-seen",
      target,
      page_http_status: nav?.status() ?? null,
      page_title: await page.title(),
      elapsed_ms: Date.now() - started,
      streaming_data: streamingSummary,
      googlevideo_request_count: requestCount,
      first_googlevideo_request: firstGooglevideoRequest,
      first_googlevideo_response: responseMeta,
      forced_range: `bytes=0-${RANGE_PROBE_BYTES - 1}`,
      range_honored: rangeHonored,
      stream_url_returned_to_client: false,
      full_media_downloaded: false,
      local_pc_required: false,
      paid_cloudflare_feature_used_by_this_probe: false,
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
        service: "youtube-free-browser-probe",
        mode: "free-only",
        browser_run_free_limit: "10 minutes/day on Workers Free",
        uses_cloudflare_containers: false,
        uses_r2: false,
        uses_workers_ai: false,
        same_session_probe: "/probe/session?v=VIDEO_ID",
        player_client_probe: "/probe/client?v=VIDEO_ID",
        default_video_id: DEFAULT_VIDEO_ID,
      });
    }

    if (url.pathname !== "/probe/session" && url.pathname !== "/probe/client") {
      return json({ error: "Not found" }, 404);
    }

    const videoId = url.searchParams.get("v") || DEFAULT_VIDEO_ID;
    if (!VIDEO_ID_RE.test(videoId)) {
      return json({ error: "Invalid YouTube video ID" }, 400);
    }

    try {
      return json(
        url.pathname === "/probe/client"
          ? await runPlayerClientProbe(env, videoId)
          : await runSameSessionProbe(env, videoId),
      );
    } catch (error) {
      return json(
        {
          result: "worker-error",
          error: error instanceof Error ? error.message : String(error),
          full_media_downloaded: false,
          local_pc_required: false,
          paid_cloudflare_feature_used_by_this_probe: false,
        },
        502,
      );
    }
  },
};
