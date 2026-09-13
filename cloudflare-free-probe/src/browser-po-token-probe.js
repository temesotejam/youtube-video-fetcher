import puppeteer from "@cloudflare/puppeteer";

const TEST_VIDEO_ID = "2NJdNKJ9LPM";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function probeTokens(env, videoId) {
  const browser = await puppeteer.launch(env.BROWSER);
  const started = Date.now();
  try {
    const page = await browser.newPage();
    let playerRequestCount = 0;
    let googlevideoRequestCount = 0;
    let playerPoToken = null;
    let playerClientName = null;
    let gvsPoToken = null;
    let gvsHost = null;

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const requestUrl = request.url();
      const type = request.resourceType();

      if (requestUrl.includes("/youtubei/v1/player")) {
        playerRequestCount += 1;
        try {
          const body = JSON.parse(request.postData() || "{}");
          const token = body?.serviceIntegrityDimensions?.poToken;
          if (!playerPoToken && typeof token === "string" && token.length) {
            playerPoToken = token;
          }
          if (!playerClientName) {
            playerClientName = body?.context?.client?.clientName || null;
          }
        } catch {
          // Diagnostic only.
        }
      }

      if (requestUrl.includes("googlevideo.com/videoplayback")) {
        googlevideoRequestCount += 1;
        try {
          const parsed = new URL(requestUrl);
          const token = parsed.searchParams.get("pot");
          if (!gvsPoToken && token) gvsPoToken = token;
          if (!gvsHost) gvsHost = parsed.hostname;
        } catch {
          // Diagnostic only.
        }
        request.abort();
        return;
      }

      if (["image", "font", "stylesheet"].includes(type)) {
        request.abort();
        return;
      }
      request.continue();
    });

    const nav = await page.goto(`https://www.youtube.com/watch?v=${videoId}`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    try {
      await page.waitForSelector("video", { timeout: 5000 });
      await page.evaluate(async () => {
        const video = document.querySelector("video");
        if (!video) return;
        video.muted = true;
        try {
          await video.play();
        } catch {
          // Loading the player is enough for this diagnostic.
        }
      });
    } catch {
      // Continue.
    }

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !playerPoToken && !gvsPoToken) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const ytcfgMeta = await page.evaluate(() => {
      const get = globalThis.ytcfg?.get?.bind(globalThis.ytcfg);
      const context = get ? get("INNERTUBE_CONTEXT") : null;
      return {
        api_key_present: Boolean(get ? get("INNERTUBE_API_KEY") : null),
        visitor_data_present: Boolean(
          (get ? get("VISITOR_DATA") : null) || context?.client?.visitorData,
        ),
        page_client_name: context?.client?.clientName || null,
        page_client_version: context?.client?.clientVersion || null,
      };
    });

    return {
      result: "po-token-network-probe-complete",
      page_http_status: nav?.status() ?? null,
      page_title: await page.title(),
      elapsed_ms: Date.now() - started,
      player_request_count: playerRequestCount,
      player_request_client_name: playerClientName,
      player_po_token_present: Boolean(playerPoToken),
      player_po_token_length: playerPoToken?.length || 0,
      googlevideo_request_count: googlevideoRequestCount,
      gvs_po_token_present: Boolean(gvsPoToken),
      gvs_po_token_length: gvsPoToken?.length || 0,
      googlevideo_host_present: Boolean(gvsHost),
      ...ytcfgMeta,
      token_values_returned: false,
      full_media_downloaded: false,
      local_pc_required: false,
      browser_run_used: true,
      paid_cloudflare_feature_used: false,
    };
  } finally {
    await browser.close();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const videoId = url.searchParams.get("v") || TEST_VIDEO_ID;
    if (videoId !== TEST_VIDEO_ID) return json({ error: "Fixed test video only" }, 403);

    if (url.pathname === "/probe/pot") {
      try {
        return json(await probeTokens(env, videoId));
      } catch (error) {
        return json(
          {
            result: "worker-error",
            error: error instanceof Error ? error.message : String(error),
            token_values_returned: false,
            full_media_downloaded: false,
            local_pc_required: false,
            browser_run_used: true,
            paid_cloudflare_feature_used: false,
          },
          502,
        );
      }
    }

    return json({
      service: "youtube-free-browser-po-token-probe",
      endpoint: "/probe/pot",
      token_values_returned: false,
      local_pc_required: false,
      paid_cloudflare_feature_used: false,
    });
  },
};
