import { Container, getContainer } from "@cloudflare/containers";

export class YouTubeProbeContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({
        service: "youtube-video-fetcher Cloudflare Container probe",
        experimental: true,
        pcRequired: false,
        endpoints: ["/probe/versions", "/probe/info", "/probe/sample"],
        note: "The probe uses one fixed public test video and never acts as a generic proxy."
      }, {
        headers: { "Cache-Control": "no-store" }
      });
    }

    if (!["/probe/versions", "/probe/info", "/probe/sample", "/health"].includes(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }

    const container = getContainer(env.YOUTUBE_PROBE, "fixed-youtube-probe");
    return container.fetch(request);
  }
};
