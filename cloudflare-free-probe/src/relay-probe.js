const TEST_VIDEO_ID = "2NJdNKJ9LPM";
const RANGE_PROBE_BYTES = 64 * 1024;
const VIDEO_RANGE_OFFSETS = [0, 4 * 1024 * 1024, 8 * 1024 * 1024];
const AUDIO_RANGE_OFFSETS = [0, 4 * 1024 * 1024];
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const ANDROID_VR = {
  id: 28,
  clientName: "ANDROID_VR",
  clientVersion: "1.65.10",
  userAgent: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
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

function decodeJsString(value) {
  return value
    ? value
        .replaceAll("\\u0026", "&")
        .replaceAll("\\u003d", "=")
        .replaceAll("\\u002f", "/")
        .replaceAll("\\/", "/")
    : null;
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

async function harvestConfig(videoId) {
  const response = await fetch(`https://www.youtube.com/embed/${videoId}?html5=1`, {
    headers: { "User-Agent": DESKTOP_UA, Accept: "text/html,*/*" },
    redirect: "follow",
  });
  const html = await response.text();
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] || null;
  const visitorData =
    html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] ||
    html.match(/"visitorData":"([^"]+)"/)?.[1] ||
    null;
  return {
    apiKey: decodeJsString(apiKey),
    visitorData: decodeJsString(visitorData),
    status: response.status,
  };
}

async function requestPlayer(videoId, config) {
  const client = {
    clientName: ANDROID_VR.clientName,
    clientVersion: ANDROID_VR.clientVersion,
    hl: "en",
    gl: "US",
    userAgent: ANDROID_VR.userAgent,
    visitorData: config.visitorData || undefined,
    deviceMake: "Oculus",
    deviceModel: "Quest 3",
    androidSdkVersion: 32,
    osName: "Android",
    osVersion: "12L",
  };
  const headers = {
    "Content-Type": "application/json",
    "X-YouTube-Client-Name": String(ANDROID_VR.id),
    "X-YouTube-Client-Version": ANDROID_VR.clientVersion,
    "User-Agent": ANDROID_VR.userAgent,
    Origin: "https://www.youtube.com",
  };
  if (config.visitorData) headers["X-Goog-Visitor-Id"] = config.visitorData;

  const response = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(config.apiKey)}&prettyPrint=false`,
    {
      method: "POST",
      headers,
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
  return { response, player };
}

function selectStreams(player) {
  const adaptive = Array.isArray(player?.streamingData?.adaptiveFormats)
    ? player.streamingData.adaptiveFormats.filter((f) => typeof f?.url === "string")
    : [];

  const video =
    adaptive.find(
      (f) =>
        String(f?.mimeType || "").includes("video/mp4") &&
        String(f?.mimeType || "").includes("avc1") &&
        Number(f?.height || 0) === 720,
    ) ||
    adaptive.find(
      (f) =>
        String(f?.mimeType || "").includes("video/mp4") &&
        String(f?.mimeType || "").includes("avc1"),
    ) ||
    null;

  const audio =
    adaptive.find(
      (f) =>
        f?.itag === 140 &&
        String(f?.mimeType || "").includes("audio/mp4"),
    ) ||
    adaptive.find((f) => String(f?.mimeType || "").includes("audio/mp4")) ||
    null;

  return { video, audio };
}

async function resolveStreams(videoId) {
  const config = await harvestConfig(videoId);
  if (!config.apiKey) throw new Error("INNERTUBE_API_KEY not found");
  const { player } = await requestPlayer(videoId, config);
  if (player?.playabilityStatus?.status !== "OK") {
    throw new Error(
      `Player not OK: ${player?.playabilityStatus?.status || "unknown"} ${player?.playabilityStatus?.reason || ""}`,
    );
  }
  const streams = selectStreams(player);
  if (!streams.video || !streams.audio) {
    throw new Error("Direct adaptive MP4 video/audio pair not found");
  }
  return streams;
}

function streamMeta(format) {
  return {
    itag: format.itag ?? null,
    mime_type: format.mimeType || null,
    width: format.width ?? null,
    height: format.height ?? null,
    bitrate: format.bitrate ?? null,
    content_length: format.contentLength || null,
  };
}

async function probeFormat(format) {
  const response = await fetch(format.url, {
    headers: {
      Range: `bytes=0-${RANGE_PROBE_BYTES - 1}`,
      "User-Agent": ANDROID_VR.userAgent,
      Accept: "*/*",
    },
    redirect: "follow",
  });
  const bytes = response.ok
    ? await readAtMost(response.body, RANGE_PROBE_BYTES)
    : 0;
  return {
    status: response.status,
    content_type: response.headers.get("Content-Type"),
    content_length: response.headers.get("Content-Length"),
    content_range: response.headers.get("Content-Range"),
    bytes,
    success: response.ok && bytes > 0,
  };
}

async function probeRangeAt(format, start) {
  const total = Number(format.contentLength || 0);
  if (total && start >= total) {
    return { start, skipped: true, reason: "offset-beyond-content-length" };
  }

  const end = total
    ? Math.min(start + RANGE_PROBE_BYTES - 1, total - 1)
    : start + RANGE_PROBE_BYTES - 1;
  const response = await fetch(format.url, {
    headers: {
      Range: `bytes=${start}-${end}`,
      "User-Agent": ANDROID_VR.userAgent,
      Accept: "*/*",
    },
    redirect: "follow",
  });

  const bytes = response.ok
    ? await readAtMost(response.body, RANGE_PROBE_BYTES)
    : 0;
  const contentRange = response.headers.get("Content-Range");
  const expectedPrefix = `bytes ${start}-`;
  const success =
    response.status === 206 &&
    Boolean(contentRange?.startsWith(expectedPrefix)) &&
    bytes > 0;

  return {
    start,
    end,
    status: response.status,
    content_type: response.headers.get("Content-Type"),
    content_length: response.headers.get("Content-Length"),
    content_range: contentRange,
    bytes,
    success,
  };
}

async function probeSequentialRanges(format, offsets) {
  const results = [];
  for (const offset of offsets) {
    try {
      results.push(await probeRangeAt(format, offset));
    } catch (error) {
      results.push({
        start: offset,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const checked = results.filter((item) => !item.skipped);
  return {
    same_resolved_url_reused: true,
    checked_count: checked.length,
    all_success: checked.length > 0 && checked.every((item) => item.success),
    results,
  };
}

async function relay(request, format, kind) {
  const upstreamHeaders = {
    "User-Agent": ANDROID_VR.userAgent,
    Accept: "*/*",
  };
  const range = request.headers.get("Range");
  if (range) upstreamHeaders.Range = range;

  const upstream = await fetch(format.url, {
    headers: upstreamHeaders,
    redirect: "follow",
  });

  const headers = new Headers();
  for (const name of [
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "ETag",
    "Last-Modified",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("X-Relay-Kind", kind);
  headers.set("X-Relay-Itag", String(format.itag ?? ""));
  headers.set("X-Relay-Test-Only", "true");

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: "youtube-free-mp4-probe",
        mode: "fixed-test-video-only",
        test_video_id: TEST_VIDEO_ID,
        browser_run_used: false,
        paid_cloudflare_feature_used: false,
        endpoints: ["/probe", "/probe/ranges", "/relay/video", "/relay/audio"],
      });
    }

    const videoId = url.searchParams.get("v") || TEST_VIDEO_ID;
    if (videoId !== TEST_VIDEO_ID) {
      return json({ error: "This experimental relay is restricted to the fixed test video" }, 403);
    }

    try {
      const streams = await resolveStreams(videoId);

      if (url.pathname === "/probe") {
        const [videoProbe, audioProbe] = await Promise.all([
          probeFormat(streams.video),
          probeFormat(streams.audio),
        ]);
        return json({
          result:
            videoProbe.success && audioProbe.success
              ? "adaptive-mp4-relay-ready"
              : "adaptive-mp4-relay-not-ready",
          video: { format: streamMeta(streams.video), probe: videoProbe },
          audio: { format: streamMeta(streams.audio), probe: audioProbe },
          full_media_downloaded: false,
          local_pc_required: false,
          browser_run_used: false,
          paid_cloudflare_feature_used: false,
        });
      }

      if (url.pathname === "/probe/ranges") {
        const videoRanges = await probeSequentialRanges(
          streams.video,
          VIDEO_RANGE_OFFSETS,
        );
        const audioRanges = await probeSequentialRanges(
          streams.audio,
          AUDIO_RANGE_OFFSETS,
        );
        return json({
          result:
            videoRanges.all_success && audioRanges.all_success
              ? "same-worker-nonzero-ranges-succeeded"
              : "same-worker-nonzero-ranges-failed",
          resolved_streams_once: true,
          video: { format: streamMeta(streams.video), ranges: videoRanges },
          audio: { format: streamMeta(streams.audio), ranges: audioRanges },
          full_media_downloaded: false,
          local_pc_required: false,
          browser_run_used: false,
          paid_cloudflare_feature_used: false,
        });
      }

      if (url.pathname === "/relay/video") {
        return relay(request, streams.video, "video");
      }
      if (url.pathname === "/relay/audio") {
        return relay(request, streams.audio, "audio");
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json(
        {
          result: "error",
          error: error instanceof Error ? error.message : String(error),
          local_pc_required: false,
          browser_run_used: false,
          paid_cloudflare_feature_used: false,
        },
        502,
      );
    }
  },
};
