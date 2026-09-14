import puppeteer from "@cloudflare/puppeteer";

const TEST_VIDEO_ID = "2NJdNKJ9LPM";
const SEGMENT_LENGTH = 4 * 1024 * 1024;
const READ_SIZE = 64 * 1024;

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

async function resolveFormats(browser) {
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

    await page.goto(`https://www.youtube.com/watch?v=${TEST_VIDEO_ID}`, {
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
      { videoId: TEST_VIDEO_ID, clientDef: VISIONOS_CLIENT },
    );
  } finally {
    await page.close().catch(() => {});
  }
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

    cdp.on("Fetch.requestPaused", (event) => {
      if (event.request?.url?.includes("googlevideo.com/videoplayback")) {
        if (timeoutId) clearTimeout(timeoutId);
        resolvePaused(event);
      }
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
    const contentType = headers.get("content-type") || "application/octet-stream";

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
      contentType,
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
  const browser = await puppeteer.launch(env.BROWSER);
  let closed = false;
  const closeBrowser = async () => {
    if (closed) return;
    closed = true;
    await browser.close().catch(() => {});
  };

  try {
    const player = await resolveFormats(browser);
    const format = kind === "audio" ? player.audio : player.video;
    if (player.playability_status !== "OK" || !format?.url) {
      throw new Error(
        `Player not OK for ${kind}: ${player.playability_status || "unknown"} ${player.playability_reason || player.error || ""}`,
      );
    }

    const sourceTotal = Number(format.contentLength || 0);
    if (!Number.isFinite(sourceTotal) || sourceTotal <= 0) {
      throw new Error(`Missing contentLength for ${kind}`);
    }

    const segmentCount = Math.ceil(sourceTotal / SEGMENT_LENGTH);
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
              if (totalSent !== sourceTotal) {
                throw new Error(
                  `Full stream size mismatch: expected ${sourceTotal}, got ${totalSent}`,
                );
              }
              controller.close();
              await closeBrowser();
              return;
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
        "Content-Length": String(sourceTotal),
        "Cache-Control": "no-store",
        "X-Upstream-Status": "206",
        "X-Logical-Content-Range": `bytes 0-${sourceTotal - 1}/${sourceTotal}`,
        "X-Source-Itag": String(format.itag ?? ""),
        "X-Source-Total-Bytes": String(sourceTotal),
        "X-Segment-Count": String(segmentCount),
        "X-Segment-Bytes": String(SEGMENT_LENGTH),
        "X-CDP-Read-Size": String(READ_SIZE),
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/stream/video") return await streamFullFormat(env, "video");
      if (url.pathname === "/stream/audio") return await streamFullFormat(env, "audio");
      return json({
        service: "youtube-free-browser-visionos-full-stream-probe",
        endpoints: ["/stream/video", "/stream/audio"],
        fixed_test_video_id: TEST_VIDEO_ID,
        segment_length: SEGMENT_LENGTH,
        read_size: READ_SIZE,
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
