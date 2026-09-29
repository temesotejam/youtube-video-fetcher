import puppeteer from "@cloudflare/puppeteer";

const TEST_VIDEO_ID = "2NJdNKJ9LPM";

const GITHUB_OWNER = "temesotejam";
const GITHUB_REPO = "youtube-video-fetcher";
const REQUEST_PATH = "cloudflare_request.json";
const WORKFLOW_FILE = "fetch-youtube-cloudflare.yml";

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:;",
    },
  });
}

function unauthorized(error = "unauthorized") {
  return json({ ok: false, error }, 401);
}

function apiKeyCheck(request, env) {
  const configured = String(env.FETCH_API_KEY || "").trim();
  if (!configured) return { ok: false, error: "fetch_api_key_not_configured" };

  const supplied = String(request.headers.get("X-API-Key") || "").trim();
  if (!supplied) return { ok: false, error: "access_key_missing" };
  if (supplied !== configured) return { ok: false, error: "access_key_mismatch" };

  return { ok: true };
}

function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function parseYoutubeVideoId(input) {
  const value = String(input || "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (host === "youtu.be" || host === "www.youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
  }

  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (url.pathname === "/watch") {
      const id = url.searchParams.get("v");
      return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && ["shorts", "embed", "live"].includes(parts[0])) {
      return /^[A-Za-z0-9_-]{11}$/.test(parts[1]) ? parts[1] : null;
    }
  }

  return null;
}

async function githubRequest(env, path, init = {}) {
  if (!env.GITHUB_FETCH_TOKEN) {
    throw new Error("GITHUB_FETCH_TOKEN is not configured on the Worker");
  }
  const headers = new Headers(init.headers || {});
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${env.GITHUB_FETCH_TOKEN}`);
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("User-Agent", "youtube-cloudflare-browser-fetch");
  return fetch(`https://api.github.com${path}`, { ...init, headers });
}

async function createFetchRequest(request, env) {
  const keyCheck = apiKeyCheck(request, env);
  if (!keyCheck.ok) return unauthorized(keyCheck.error);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const youtubeUrl = String(body?.youtube_url || "").trim();
  const question = String(body?.question || "").trim().slice(0, 4000);
  const videoId = parseYoutubeVideoId(youtubeUrl);
  if (!videoId) {
    return json({ ok: false, error: "invalid_youtube_url" }, 400);
  }

  const current = await githubRequest(
    env,
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${REQUEST_PATH}?ref=main`,
  );
  if (!current.ok) {
    return json(
      { ok: false, error: "github_read_failed", status: current.status },
      502,
    );
  }
  const currentJson = await current.json();

  const requestId =
    new Date().toISOString().replace(/[:.]/g, "-") +
    "-" +
    crypto.randomUUID().slice(0, 8);

  const payload = {
    request_id: requestId,
    youtube_url: youtubeUrl,
    question,
    note: "Triggered from Cloudflare web/API",
  };

  const update = await githubRequest(
    env,
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${REQUEST_PATH}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Cloudflare fetch request ${requestId}`,
        content: encodeBase64Utf8(JSON.stringify(payload, null, 2) + "\n"),
        sha: currentJson.sha,
        branch: "main",
      }),
    },
  );

  const updateJson = await update.json().catch(() => ({}));
  if (!update.ok) {
    return json(
      {
        ok: false,
        error: "github_update_failed",
        status: update.status,
        details: updateJson?.message || null,
      },
      502,
    );
  }

  const commitSha = updateJson?.commit?.sha || null;
  return json({
    ok: true,
    request_id: requestId,
    video_id: videoId,
    commit_sha: commitSha,
    status_endpoint: commitSha ? `/api/status?sha=${commitSha}` : null,
    actions_url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}`,
  });
}

async function fetchStatus(request, env) {
  const keyCheck = apiKeyCheck(request, env);
  if (!keyCheck.ok) return unauthorized(keyCheck.error);

  const url = new URL(request.url);
  const sha = String(url.searchParams.get("sha") || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    return json({ ok: false, error: "invalid_sha" }, 400);
  }

  const response = await githubRequest(
    env,
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/runs?head_sha=${encodeURIComponent(sha)}&per_page=5`,
  );
  if (!response.ok) {
    return json(
      { ok: false, error: "github_status_failed", status: response.status },
      502,
    );
  }

  const data = await response.json();
  const run = Array.isArray(data.workflow_runs) ? data.workflow_runs[0] : null;
  if (!run) {
    return json({
      ok: true,
      found: false,
      status: "waiting_for_workflow",
      commit_sha: sha,
    });
  }

  const result = {
    ok: true,
    found: true,
    run_id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    run_url: run.html_url,
    created_at: run.created_at,
    updated_at: run.updated_at,
  };

  if (run.status === "completed" && run.conclusion === "success") {
    result.artifact_name = `youtube-cloudflare-${run.id}`;
    result.artifacts_url =
      `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${run.id}#artifacts`;
  }

  return json(result);
}

function appPage() {
  return html(`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YouTube Fetch Bridge</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { max-width: 760px; margin: 0 auto; padding: 32px 18px 60px; line-height: 1.55; }
.card { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 18px; padding: 22px; margin-top: 18px; }
label { display:block; font-weight:700; margin:14px 0 6px; }
input, textarea, button { width:100%; box-sizing:border-box; font:inherit; }
input, textarea { padding:12px; border-radius:10px; border:1px solid color-mix(in srgb, currentColor 24%, transparent); }
textarea { min-height:110px; resize:vertical; }
button { margin-top:18px; padding:12px 16px; border:0; border-radius:10px; font-weight:700; cursor:pointer; }
small { opacity:.72; }
#status { white-space:pre-wrap; overflow-wrap:anywhere; }
.ok { font-weight:700; }
</style>
</head>
<body>
<h1>YouTube Fetch Bridge</h1>
<p>URLを送ると、Cloudflare Browser Run経由で取得ジョブをGitHub Actionsへ投入します。ローカルPCは不要です。</p>
<div class="card">
  <label for="key">Access key</label>
  <input id="key" type="password" autocomplete="off" placeholder="API access key">
  <label style="font-weight:400; margin-top:8px;">
    <input id="showKey" type="checkbox" style="width:auto; margin-right:8px;">
    表示する
  </label>
  <small>この値はブラウザ内で送信に使うだけで、GitHubには保存されません。</small>

  <label for="url">YouTube URL</label>
  <input id="url" type="url" placeholder="https://youtu.be/..." autocomplete="off">

  <label for="question">解析メモ / 質問（任意）</label>
  <textarea id="question" placeholder="この動画の設計変更を確認して、など"></textarea>

  <button id="submit">取得開始</button>
</div>
<div class="card">
  <strong>Status</strong>
  <div id="status">待機中</div>
</div>
<script>
const $ = (id) => document.getElementById(id);
let timer = null;

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-API-Key", $("key").value.trim());
  if (options.body) headers.set("Content-Type", "application/json");
  const r = await fetch(path, { ...options, headers });
  const data = await r.json().catch(() => ({ ok:false, error:"invalid_response" }));
  if (!r.ok || data.ok === false) throw new Error(data.error || ("HTTP " + r.status));
  return data;
}

async function poll(sha) {
  clearTimeout(timer);
  try {
    const s = await api("/api/status?sha=" + encodeURIComponent(sha));
    let text = s.found
      ? "status: " + s.status + (s.conclusion ? "\\nconclusion: " + s.conclusion : "")
      : "GitHub Actionsの起動待ち";
    if (s.run_url) text += "\\n" + s.run_url;
    if (s.artifacts_url) text += "\\nArtifact: " + s.artifacts_url;
    $("status").textContent = text;
    if (!s.found || s.status !== "completed") timer = setTimeout(() => poll(sha), 5000);
  } catch (e) {
    $("status").textContent = "状態確認エラー: " + e.message;
  }
}

$("showKey").addEventListener("change", () => {
  $("key").type = $("showKey").checked ? "text" : "password";
});

$("submit").addEventListener("click", async () => {
  clearTimeout(timer);
  $("status").textContent = "リクエスト送信中…";
  $("submit").disabled = true;
  try {
    const r = await api("/api/fetch", {
      method: "POST",
      body: JSON.stringify({
        youtube_url: $("url").value,
        question: $("question").value,
      }),
    });
    $("status").textContent =
      "受理しました\\nrequest_id: " + r.request_id +
      "\\ncommit: " + (r.commit_sha || "unknown");
    if (r.commit_sha) poll(r.commit_sha);
  } catch (e) {
    $("status").textContent = "エラー: " + e.message;
  } finally {
    $("submit").disabled = false;
  }
});
</script>
</body>
</html>`);
}

const SEGMENT_LENGTH = 4 * 1024 * 1024;
const READ_SIZE = 64 * 1024;
const VIDEO_URL_REFRESH_SEGMENTS = 4;

const VISIONOS_CLIENT = {
  id: 101,
  clientName: "VISIONOS",
  clientVersion: "1.02",
  deviceMake: "Apple",
  deviceModel: "RealityDevice17,1",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  osName: "visionOS",
  osVersion: "26.5.23O471",
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
    if (header?.name) map.set(String(header.name).toLowerCase(), String(header.value ?? ""));
  }
  return map;
}

function decodeIoData(read) {
  if (!read?.data) return new Uint8Array(0);
  if (read.base64Encoded) {
    const binary = atob(read.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
    return bytes;
  }
  return new TextEncoder().encode(read.data);
}

async function acquireBrowser(env) {
  try {
    const sessions = await puppeteer.sessions(env.BROWSER);
    const available = Array.isArray(sessions)
      ? sessions.find((session) => session?.sessionId && !session?.connectionId)
      : null;

    if (available?.sessionId) {
      try {
        const browser = await puppeteer.connect(env.BROWSER, available.sessionId);
        return { browser, reused: true };
      } catch {
        // Fall through to a fresh launch if the free session was taken meanwhile.
      }
    }
  } catch {
    // Session enumeration is best-effort; fresh launch remains the fallback.
  }

  const browser = await puppeteer.launch(env.BROWSER, { keep_alive: 600000 });
  return { browser, reused: false };
}

async function releaseBrowser(browser, reused) {
  if (!browser) return;
  if (reused && typeof browser.disconnect === "function") {
    await browser.disconnect().catch(() => {});
    return;
  }
  if (typeof browser.disconnect === "function") {
    await browser.disconnect().catch(() => {});
    return;
  }
  await releaseBrowser(browser, reused);
}

async function resolveFormats(browser, videoId = TEST_VIDEO_ID) {
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

    await page.goto(`https://www.youtube.com/watch?v=${videoId}`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    await page
      .waitForFunction(() => Boolean(globalThis.ytcfg?.get?.("INNERTUBE_API_KEY")), {
        timeout: 5000,
      })
      .catch(() => {});

    return await page.evaluate(
      async ({ videoId, clientDef }) => {
        const get = globalThis.ytcfg?.get?.bind(globalThis.ytcfg);
        const webContext = get ? get("INNERTUBE_CONTEXT") : null;
        const apiKey = get ? get("INNERTUBE_API_KEY") : null;
        const visitorData =
          (get ? get("VISITOR_DATA") : null) || webContext?.client?.visitorData || null;
        if (!apiKey) return { error: "INNERTUBE_API_KEY not found" };

        const client = {
          clientName: clientDef.clientName,
          clientVersion: clientDef.clientVersion,
          hl: "en",
          gl: "US",
          deviceMake: clientDef.deviceMake,
          deviceModel: clientDef.deviceModel,
          userAgent: clientDef.userAgent,
          osName: clientDef.osName,
          osVersion: clientDef.osVersion,
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

        const data = await response.json();
        const adaptive = Array.isArray(data?.streamingData?.adaptiveFormats)
          ? data.streamingData.adaptiveFormats.filter(
              (format) => format && typeof format.url === "string",
            )
          : [];

        const videos = adaptive.filter((format) => {
          const mime = String(format?.mimeType || "");
          return mime.includes("video/mp4") && mime.includes("avc1");
        });
        const audios = adaptive.filter((format) => {
          const mime = String(format?.mimeType || "");
          return mime.includes("audio/mp4") && mime.includes("mp4a");
        });

        const video =
          videos.find((format) => Number(format?.height || 0) === 720) || videos[0] || null;
        const audio =
          audios.find((format) => Number(format?.itag) === 140) ||
          audios.sort((a, b) => Number(b?.bitrate || 0) - Number(a?.bitrate || 0))[0] ||
          null;

        return {
          player_http_status: response.status,
          playability_status: data?.playabilityStatus?.status || null,
          playability_reason: data?.playabilityStatus?.reason || null,
          video,
          audio,
        };
      },
      { videoId, clientDef: VISIONOS_CLIENT },
    );
  } finally {
    await page.close().catch(() => {});
  }
}

function chooseFormat(player, kind) {
  return kind === "audio" ? player.audio : player.video;
}

async function prepareSegment(browser, format, start, length) {
  const sourceTotal = Number(format?.contentLength || 0);
  const end = Math.min(start + length - 1, sourceTotal - 1);
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
    await page.setUserAgent(VISIONOS_CLIENT.userAgent);
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

    cdp.on("Fetch.requestPaused", async (event) => {
      if (!event.request?.url?.includes("googlevideo.com/videoplayback")) {
        return;
      }

      const status = event.responseStatusCode ?? null;
      if (status && status >= 300 && status < 400) {
        // YouTube commonly redirects a media URL to another googlevideo host.
        // Let the browser follow normal redirects and wait for the final 206.
        await cdp
          .send("Fetch.continueResponse", { requestId: event.requestId })
          .catch(async () => {
            await cdp
              .send("Fetch.continueRequest", { requestId: event.requestId })
              .catch(() => {});
          });
        return;
      }

      if (timeoutId) clearTimeout(timeoutId);
      resolvePaused(event);
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

    if (status !== 206 || contentRange !== `bytes ${start}-${end}/${sourceTotal}`) {
      await cdp
        .send("Fetch.failRequest", {
          requestId: paused.requestId,
          errorReason: "Aborted",
        })
        .catch(() => {});
      await navPromise;
      throw new Error(
        `Unexpected upstream range response: status=${status} content-range=${contentRange}`,
      );
    }

    const { stream } = await cdp.send("Fetch.takeResponseBodyAsStream", {
      requestId: paused.requestId,
    });

    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      if (timeoutId) clearTimeout(timeoutId);
      await cdp.send("IO.close", { handle: stream }).catch(() => {});
      await cdp
        .send("Fetch.failRequest", {
          requestId: paused.requestId,
          errorReason: "Aborted",
        })
        .catch(() => {});
      await navPromise;
      await cdp.send("Fetch.disable").catch(() => {});
      await page.close().catch(() => {});
    };

    return {
      cdp,
      stream,
      expected,
      sent: 0,
      cleanup,
    };
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    await cdp.send("Fetch.disable").catch(() => {});
    await page.close().catch(() => {});
    throw error;
  }
}

async function streamFullFormat(env, kind) {
  const { browser, reused } = await acquireBrowser(env);
  let closed = false;
  const closeBrowser = async () => {
    if (closed) return;
    closed = true;
    await releaseBrowser(browser, reused);
  };

  try {
    let player = await resolveFormats(browser);
    let format = chooseFormat(player, kind);
    if (player.playability_status !== "OK" || !format?.url) {
      throw new Error(
        `Player not OK for ${kind}: ${player.playability_status || "unknown"} ${player.playability_reason || player.error || ""}`,
      );
    }

    const sourceTotal = Number(format.contentLength || 0);
    if (!Number.isFinite(sourceTotal) || sourceTotal <= 0) {
      throw new Error(`Missing contentLength for ${kind}`);
    }

    const initialItag = Number(format.itag || 0);
    const segmentCount = Math.ceil(sourceTotal / SEGMENT_LENGTH);
    let segmentIndex = 0;
    let current = null;
    let totalSent = 0;

    const refreshFormat = async () => {
      player = await resolveFormats(browser);
      const refreshed = chooseFormat(player, kind);
      if (player.playability_status !== "OK" || !refreshed?.url) {
        throw new Error(`Unable to refresh ${kind} format`);
      }
      if (Number(refreshed.contentLength || 0) !== sourceTotal) {
        throw new Error(`Refreshed ${kind} contentLength changed`);
      }
      if (Number(refreshed.itag || 0) !== initialItag) {
        throw new Error(`Refreshed ${kind} itag changed`);
      }
      format = refreshed;
    };

    const cleanupCurrent = async () => {
      if (!current) return;
      const segment = current;
      current = null;
      await segment.cleanup();
    };

    const body = new ReadableStream({
      async pull(controller) {
        try {
          if (!current) {
            if (segmentIndex >= segmentCount) {
              if (totalSent !== sourceTotal) {
                throw new Error(
                  `Full stream size mismatch: expected ${sourceTotal}, got ${totalSent}`,
                );
              }
              controller.close();
              await closeBrowser();
              return;
            }

            if (
              kind === "video" &&
              segmentIndex > 0 &&
              segmentIndex % VIDEO_URL_REFRESH_SEGMENTS === 0
            ) {
              await refreshFormat();
            }

            const segmentStart = segmentIndex * SEGMENT_LENGTH;
            const segmentLength = Math.min(SEGMENT_LENGTH, sourceTotal - segmentStart);
            current = await prepareSegment(browser, format, segmentStart, segmentLength);
          }

          const remaining = current.expected - current.sent;
          const read = await current.cdp.send("IO.read", {
            handle: current.stream,
            size: Math.min(READ_SIZE, Math.max(remaining, 1)),
          });
          const chunk = decodeIoData(read);

          if (chunk.byteLength) {
            if (current.sent + chunk.byteLength > current.expected) {
              throw new Error("CDP segment exceeded requested range");
            }
            current.sent += chunk.byteLength;
            totalSent += chunk.byteLength;
            controller.enqueue(chunk);
          }

          if (read.eof) {
            if (current.sent !== current.expected) {
              throw new Error(
                `Segment size mismatch: expected ${current.expected}, got ${current.sent}`,
              );
            }
            await cleanupCurrent();
            segmentIndex += 1;
          }
        } catch (error) {
          controller.error(error);
          await cleanupCurrent().catch(() => {});
          await closeBrowser();
        }
      },
      async cancel() {
        await cleanupCurrent().catch(() => {});
        await closeBrowser();
      },
    });

    const mime = String(format.mimeType || (kind === "audio" ? "audio/mp4" : "video/mp4"));
    const contentType = mime.split(";")[0];

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "X-Upstream-Status": "206",
        "X-Logical-Content-Range": `bytes 0-${sourceTotal - 1}/${sourceTotal}`,
        "X-Source-Itag": String(initialItag),
        "X-Source-Total-Bytes": String(sourceTotal),
        "X-Segment-Count": String(segmentCount),
        "X-Segment-Bytes": String(SEGMENT_LENGTH),
        "X-CDP-Read-Size": String(READ_SIZE),
        "X-URL-Refresh-Segments": kind === "video" ? String(VIDEO_URL_REFRESH_SEGMENTS) : "0",
        "X-Capture-Method": "visionos-cdp-full-segmented-stream",
        "X-Media-Kind": kind,
        "X-Browser-Run": "true",
        "X-Paid-Cloudflare-Feature": "false",
      },
    });
  } catch (error) {
    await closeBrowser();
    throw error;
  }
}



async function streamBoundedRange(env, videoId, kind, start, length) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new Error("Invalid YouTube video ID");
  }
  if (!["video", "audio"].includes(kind)) {
    throw new Error("kind must be video or audio");
  }

  const maxLength = 16 * 1024 * 1024;
  const segmentLength = 4 * 1024 * 1024;

  if (!Number.isInteger(start) || start < 0) {
    throw new Error("start must be a non-negative integer");
  }
  if (!Number.isInteger(length) || length <= 0 || length > maxLength) {
    throw new Error(`length must be between 1 and ${maxLength}`);
  }

  const { browser, reused } = await acquireBrowser(env);
  let closed = false;
  const closeBrowser = async () => {
    if (closed) return;
    closed = true;
    await releaseBrowser(browser, reused);
  };

  try {
    const player = await resolveFormats(browser, videoId);
    const format = chooseFormat(player, kind);
    if (player.playability_status !== "OK" || !format?.url) {
      throw new Error(
        `Player not OK for ${kind}: ${player.playability_status || "unknown"} ${player.playability_reason || player.error || ""}`,
      );
    }

    const sourceTotal = Number(format.contentLength || 0);
    if (!Number.isFinite(sourceTotal) || sourceTotal <= 0) {
      throw new Error(`Missing contentLength for ${kind}`);
    }
    if (start >= sourceTotal) {
      throw new Error(`start ${start} is beyond source length ${sourceTotal}`);
    }

    const totalExpected = Math.min(length, sourceTotal - start);
    const segmentCount = Math.ceil(totalExpected / segmentLength);
    let segmentIndex = 0;
    let current = null;
    let totalSent = 0;

    const cleanupCurrent = async () => {
      if (!current) return;
      const segment = current;
      current = null;
      await segment.cleanup();
    };

    const body = new ReadableStream({
      async pull(controller) {
        try {
          if (!current) {
            if (segmentIndex >= segmentCount) {
              if (totalSent !== totalExpected) {
                throw new Error(
                  `Bounded stream size mismatch: expected ${totalExpected}, got ${totalSent}`,
                );
              }
              controller.close();
              await closeBrowser();
              return;
            }

            const segmentStart = start + segmentIndex * segmentLength;
            const remainingLogical = totalExpected - segmentIndex * segmentLength;
            const thisLength = Math.min(segmentLength, remainingLogical);

            current = await prepareSegment(
              browser,
              format,
              segmentStart,
              thisLength,
            );
          }

          const remaining = current.expected - current.sent;
          const read = await current.cdp.send("IO.read", {
            handle: current.stream,
            size: Math.min(READ_SIZE, Math.max(remaining, 1)),
          });
          const chunk = decodeIoData(read);

          if (chunk.byteLength) {
            if (current.sent + chunk.byteLength > current.expected) {
              throw new Error("CDP segment exceeded requested range");
            }
            current.sent += chunk.byteLength;
            totalSent += chunk.byteLength;
            controller.enqueue(chunk);
          }

          if (read.eof) {
            if (current.sent !== current.expected) {
              throw new Error(
                `Segment size mismatch: expected ${current.expected}, got ${current.sent}`,
              );
            }
            await cleanupCurrent();
            segmentIndex += 1;
          }
        } catch (error) {
          controller.error(error);
          await cleanupCurrent().catch(() => {});
          await closeBrowser();
        }
      },
      async cancel() {
        await cleanupCurrent().catch(() => {});
        await closeBrowser();
      },
    });

    const mime = String(format.mimeType || (kind === "audio" ? "audio/mp4" : "video/mp4"));
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": mime.split(";")[0],
        "Content-Length": String(totalExpected),
        "Cache-Control": "no-store",
        "X-Source-Itag": String(format.itag || ""),
        "X-Source-Total-Bytes": String(sourceTotal),
        "X-Range-Start": String(start),
        "X-Range-Length": String(totalExpected),
        "X-Segment-Count": String(segmentCount),
        "X-Segment-Bytes": String(segmentLength),
        "X-Capture-Method": "visionos-cdp-bounded-segmented-stream",
      },
    });
  } catch (error) {
    await closeBrowser();
    throw error;
  }
}

async function metadata(env, videoId) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new Error("Invalid YouTube video ID");
  }
  const { browser, reused } = await acquireBrowser(env);
  try {
    const player = await resolveFormats(browser, videoId);
    if (player.playability_status !== "OK") {
      throw new Error(
        `Player not OK: ${player.playability_status || "unknown"} ${player.playability_reason || player.error || ""}`,
      );
    }
    return json({
      video_id: videoId,
      playability_status: player.playability_status,
      video: player.video
        ? {
            itag: player.video.itag,
            contentLength: player.video.contentLength,
            mimeType: player.video.mimeType,
            height: player.video.height,
          }
        : null,
      audio: player.audio
        ? {
            itag: player.audio.itag,
            contentLength: player.audio.contentLength,
            mimeType: player.audio.mimeType,
          }
        : null,
    });
  } finally {
    await releaseBrowser(browser, reused);
  }
}

async function streamProbe(env, kind) {
  const { browser, reused } = await acquireBrowser(env);
  try {
    const player = await resolveFormats(browser);
    const format = chooseFormat(player, kind);
    if (player.playability_status !== "OK" || !format?.url) {
      throw new Error(
        `Player not OK for ${kind}: ${player.playability_status || "unknown"} ${player.playability_reason || player.error || ""}`,
      );
    }

    const sourceTotal = Number(format.contentLength || 0);
    if (!Number.isFinite(sourceTotal) || sourceTotal <= 0) {
      throw new Error(`Missing contentLength for ${kind}`);
    }

    const probeLength = Math.min(2 * 1024 * 1024, sourceTotal);
    const segment = await prepareSegment(browser, format, 0, probeLength);
    const chunks = [];
    let total = 0;
    try {
      while (total < segment.expected) {
        const remaining = segment.expected - total;
        const read = await segment.cdp.send("IO.read", {
          handle: segment.stream,
          size: Math.min(READ_SIZE, Math.max(remaining, 1)),
        });
        const chunk = decodeIoData(read);
        if (chunk.byteLength) {
          chunks.push(chunk);
          total += chunk.byteLength;
        }
        if (read.eof) break;
      }
    } finally {
      await segment.cleanup();
    }

    if (total !== probeLength) {
      throw new Error(`Probe size mismatch: expected ${probeLength}, got ${total}`);
    }

    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const mime = String(format.mimeType || (kind === "audio" ? "audio/mp4" : "video/mp4"));
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": mime.split(";")[0],
        "Cache-Control": "no-store",
        "X-Source-Itag": String(format.itag || ""),
        "X-Source-Total-Bytes": String(sourceTotal),
        "X-Probe-Bytes": String(total),
        "X-Capture-Method": "visionos-cdp-2mb-probe",
      },
    });
  } finally {
    await releaseBrowser(browser, reused);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return appPage();
    }
    if (request.method === "POST" && url.pathname === "/api/fetch") {
      return await createFetchRequest(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      return await fetchStatus(request, env);
    }

    try {
      if (url.pathname === "/meta") {
        return await metadata(env, url.searchParams.get("video_id") || "");
      }
      if (url.pathname === "/range") {
        const videoId = url.searchParams.get("video_id") || "";
        const kind = url.searchParams.get("kind") || "video";
        const start = Number(url.searchParams.get("start") || "0");
        const length = Number(url.searchParams.get("length") || String(4 * 1024 * 1024));
        return await streamBoundedRange(env, videoId, kind, start, length);
      }
      if (url.pathname === "/probe/video") return await streamProbe(env, "video");
      if (url.pathname === "/probe/audio") return await streamProbe(env, "audio");
      if (url.pathname === "/stream/video") return await streamFullFormat(env, "video");
      if (url.pathname === "/stream/audio") return await streamFullFormat(env, "audio");
      return json({
        service: "youtube-cloudflare-browser-fetch",
        endpoints: ["/meta", "/range", "/probe/video", "/probe/audio", "/stream/video", "/stream/audio"],
        fixed_test_video_id: TEST_VIDEO_ID,
        segment_length: SEGMENT_LENGTH,
        read_size: READ_SIZE,
        video_url_refresh_segments: VIDEO_URL_REFRESH_SEGMENTS,
        audio_url_refresh_segments: 0,
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
