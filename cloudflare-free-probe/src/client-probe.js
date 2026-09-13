const DEFAULT_VIDEO_ID = "2NJdNKJ9LPM";
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const RANGE_PROBE_BYTES = 64 * 1024;

const CLIENTS = [
  {
    key: "web_embedded",
    id: 56,
    clientName: "WEB_EMBEDDED_PLAYER",
    clientVersion: "2.20260708.00.00",
    origin: "https://www.youtube.com",
    thirdParty: { embedUrl: "https://www.reddit.com/" },
  },
  {
    key: "mweb",
    id: 2,
    clientName: "MWEB",
    clientVersion: "2.20260708.05.00",
    origin: "https://m.youtube.com",
    userAgent: "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)",
  },
  {
    key: "visionos",
    id: 101,
    clientName: "VISIONOS",
    clientVersion: "1.02",
    origin: "https://www.youtube.com",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    extra: {
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

function decodeJsString(value) {
  return value
    ? value
        .replaceAll("\\u0026", "&")
        .replaceAll("\\u003d", "=")
        .replaceAll("\\u002f", "/")
        .replaceAll("\\/", "/")
    : null;
}

async function harvestConfig(videoId) {
  const url = `https://www.youtube.com/embed/${videoId}?html5=1`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
      Accept: "text/html,*/*",
    },
    redirect: "follow",
  });
  const html = await response.text();
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] || null;
  const visitorData =
    html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] ||
    html.match(/"visitorData":"([^"]+)"/)?.[1] ||
    null;
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || null;
  return {
    apiKey: decodeJsString(apiKey),
    visitorData: decodeJsString(visitorData),
    page_http_status: response.status,
    page_title: title,
    page_bytes: new TextEncoder().encode(html).byteLength,
    bot_challenge: html.toLowerCase().includes("sign in to confirm you're not a bot"),
  };
}

function summarize(player) {
  const streaming = player?.streamingData || {};
  const formats = Array.isArray(streaming.formats) ? streaming.formats : [];
  const adaptive = Array.isArray(streaming.adaptiveFormats) ? streaming.adaptiveFormats : [];
  const all = [...formats, ...adaptive];
  const itag18 = all.find((f) => f?.itag === 18) || null;
  return {
    playability_status: player?.playabilityStatus?.status || null,
    playability_reason: player?.playabilityStatus?.reason || null,
    formats_count: formats.length,
    adaptive_count: adaptive.length,
    direct_url_count: all.filter((f) => typeof f?.url === "string").length,
    cipher_count: all.filter((f) => typeof f?.signatureCipher === "string" || typeof f?.cipher === "string").length,
    has_server_abr_streaming_url: typeof streaming.serverAbrStreamingUrl === "string",
    itag18: itag18
      ? {
          mime_type: itag18.mimeType || null,
          content_length: itag18.contentLength || null,
          has_direct_url: typeof itag18.url === "string",
          has_cipher: typeof itag18.signatureCipher === "string" || typeof itag18.cipher === "string",
        }
      : null,
  };
}

function selectProgressiveMp4(player) {
  const formats = Array.isArray(player?.streamingData?.formats) ? player.streamingData.formats : [];
  return (
    formats.find((f) => f?.itag === 18 && typeof f?.url === "string" && String(f?.mimeType || "").includes("video/mp4")) ||
    formats.find((f) => typeof f?.url === "string" && String(f?.mimeType || "").includes("video/mp4")) ||
    null
  );
}

async function requestPlayer(apiKey, visitorData, videoId, def) {
  const client = {
    clientName: def.clientName,
    clientVersion: def.clientVersion,
    hl: "en",
    gl: "US",
    ...(def.userAgent ? { userAgent: def.userAgent } : {}),
    ...(def.extra || {}),
    ...(visitorData ? { visitorData } : {}),
  };
  const headers = {
    "Content-Type": "application/json",
    "X-YouTube-Client-Name": String(def.id),
    "X-YouTube-Client-Version": def.clientVersion,
    Origin: def.origin,
  };
  if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData;
  if (def.userAgent) headers["User-Agent"] = def.userAgent;

  const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      context: {
        client,
        ...(def.thirdParty ? { thirdParty: def.thirdParty } : {}),
      },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });
  const text = await response.text();
  let player = null;
  try {
    player = JSON.parse(text);
  } catch {}
  return { response, player };
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
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  return total;
}

async function rangeProbe(def, format) {
  if (!format?.url) return null;
  const headers = { Range: `bytes=0-${RANGE_PROBE_BYTES - 1}`, Accept: "*/*" };
  if (def.userAgent) headers["User-Agent"] = def.userAgent;
  const response = await fetch(format.url, { headers, redirect: "follow" });
  const received = response.ok ? await readAtMost(response.body, RANGE_PROBE_BYTES) : 0;
  return {
    status: response.status,
    content_type: response.headers.get("Content-Type"),
    content_length: response.headers.get("Content-Length"),
    content_range: response.headers.get("Content-Range"),
    received_bytes_before_cancel: received,
    success: response.ok && received > 0,
  };
}

async function run(videoId) {
  const started = Date.now();
  const harvested = await harvestConfig(videoId);
  if (!harvested.apiKey) {
    return {
      result: "innertube-api-key-not-found",
      harvested,
      full_media_downloaded: false,
      local_pc_required: false,
      paid_cloudflare_feature_used_by_this_probe: false,
    };
  }

  const clients = [];
  let winner = null;
  for (const def of CLIENTS) {
    try {
      const { response, player } = await requestPlayer(harvested.apiKey, harvested.visitorData, videoId, def);
      const format = selectProgressiveMp4(player);
      const probe = format ? await rangeProbe(def, format) : null;
      const item = {
        client: def.key,
        player_http_status: response.status,
        summary: summarize(player),
        selected_progressive_mp4: format
          ? {
              itag: format.itag || null,
              mime_type: format.mimeType || null,
              content_length: format.contentLength || null,
            }
          : null,
        range_probe: probe,
      };
      clients.push(item);
      if (probe?.success) {
        winner = item;
        break;
      }
    } catch (error) {
      clients.push({ client: def.key, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    result: winner ? "progressive-mp4-range-succeeded-from-worker-origin" : "no-downloadable-progressive-mp4-found",
    elapsed_ms: Date.now() - started,
    harvested: {
      page_http_status: harvested.page_http_status,
      page_title: harvested.page_title,
      page_bytes: harvested.page_bytes,
      visitor_data_present: Boolean(harvested.visitorData),
      bot_challenge: harvested.bot_challenge,
    },
    clients,
    winning_client: winner?.client || null,
    stream_url_returned_to_client: false,
    full_media_downloaded: false,
    local_pc_required: false,
    browser_run_used: false,
    paid_cloudflare_feature_used_by_this_probe: false,
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ service: "youtube-free-worker-client-probe", browser_run_used: false, probe: "/probe/client?v=VIDEO_ID" });
    }
    if (url.pathname !== "/probe/client") return json({ error: "Not found" }, 404);
    const videoId = url.searchParams.get("v") || DEFAULT_VIDEO_ID;
    if (!VIDEO_ID_RE.test(videoId)) return json({ error: "Invalid YouTube video ID" }, 400);
    try {
      return json(await run(videoId));
    } catch (error) {
      return json({
        result: "worker-error",
        error: error instanceof Error ? error.message : String(error),
        full_media_downloaded: false,
        local_pc_required: false,
        browser_run_used: false,
        paid_cloudflare_feature_used_by_this_probe: false,
      }, 502);
    }
  },
};
