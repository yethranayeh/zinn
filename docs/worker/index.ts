interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const markdownNotFound = `# Page not found

The requested page does not exist on zinn.sh. Find Zinn's documentation and CLI guidance in [llms.txt](https://zinn.sh/llms.txt), or return to the [homepage](https://zinn.sh/).
`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await env.ASSETS.fetch(request);
    const isReadRequest = request.method === "GET" || request.method === "HEAD";
    if (response.status !== 404 || !isReadRequest) {
      return response;
    }

    const acceptedTypes = (request.headers.get("Accept") ?? "").split(",").map((entry) => {
      const [mediaType, ...parameters] = entry.trim().toLowerCase().split(";");
      const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith("q="));
      const quality = qualityParameter === undefined ? 1 : Number(qualityParameter.trim().slice(2));
      return {
        mediaType: mediaType?.trim(),
        quality: quality >= 0 && quality <= 1 ? quality : 0,
      };
    });
    const markdownQuality =
      acceptedTypes.find((type) => type.mediaType === "text/markdown")?.quality ?? 0;
    const htmlQuality =
      acceptedTypes.find((type) => type.mediaType === "text/html")?.quality ??
      acceptedTypes.find((type) => type.mediaType === "text/*")?.quality ??
      acceptedTypes.find((type) => type.mediaType === "*/*")?.quality ??
      0;
    const wantsMarkdown = markdownQuality > 0 && markdownQuality >= htmlQuality;
    const headers = new Headers(response.headers);
    const vary = headers.get("Vary");
    if (
      vary !== "*" &&
      !vary?.split(",").some((field) => field.trim().toLowerCase() === "accept")
    ) {
      headers.set("Vary", vary ? `${vary}, Accept` : "Accept");
    }
    // Avoid caching one negotiated error representation for another client.
    headers.set("Cache-Control", "no-store");
    if (wantsMarkdown) {
      headers.set("Content-Type", "text/markdown; charset=utf-8");
      for (const header of ["Content-Length", "Content-Encoding", "ETag", "Last-Modified"]) {
        headers.delete(header);
      }
    }
    const body =
      request.method === "HEAD" ? null : wantsMarkdown ? markdownNotFound : response.body;
    return new Response(body, { status: 404, headers });
  },
};
