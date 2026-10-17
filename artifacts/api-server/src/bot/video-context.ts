type VideoKind = "youtube" | "tiktok";

interface VideoLink {
  kind: VideoKind;
  canonicalUrl: string;
  oEmbedUrl: string;
  videoId?: string;
}

interface OEmbedResponse {
  title?: string;
  author_name?: string;
}

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_PAGE_BYTES = 4_000_000;
const MAX_TRANSCRIPT_CHARS = 7_000;

function parseVideoLink(rawUrl: string): VideoLink | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:") return undefined;

  const host = url.hostname.toLowerCase();
  const youtubeHosts = new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
  ]);
  const tiktokHosts = new Set([
    "tiktok.com",
    "www.tiktok.com",
    "vm.tiktok.com",
    "m.tiktok.com",
  ]);

  if (youtubeHosts.has(host)) {
    const videoId =
      host === "youtu.be"
        ? url.pathname.split("/").filter(Boolean)[0]
        : url.searchParams.get("v") ??
          url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]+)/)?.[1];
    if (!videoId || !/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return undefined;

    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
    return {
      kind: "youtube",
      videoId,
      canonicalUrl,
      oEmbedUrl: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(canonicalUrl)}`,
    };
  }

  const isTikTokVideo = /\/video\/\d+/.test(url.pathname);
  const isTikTokShortLink =
    host === "vm.tiktok.com" &&
    /^\/(?:t\/)?[A-Za-z0-9_-]{5,64}\/?$/.test(url.pathname);
  if (tiktokHosts.has(host) && (isTikTokVideo || isTikTokShortLink)) {
    const canonicalUrl = url.toString();
    return {
      kind: "tiktok",
      canonicalUrl,
      oEmbedUrl: `https://www.tiktok.com/oembed?url=${encodeURIComponent(canonicalUrl)}`,
    };
  }

  return undefined;
}

async function readTextLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let totalBytes = 0;

  try {
    while (totalBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;

      const remainingBytes = maxBytes - totalBytes;
      const chunk = value.subarray(0, remainingBytes);
      totalBytes += chunk.byteLength;
      result += decoder.decode(chunk, { stream: totalBytes < maxBytes });
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return result + decoder.decode();
}

async function fetchText(url: string, maxBytes: number): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "User-Agent": "MackThicklinDiscordBot/1.0" },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`video source responded with ${response.status}`);
  }

  return readTextLimited(response, maxBytes);
}

async function fetchOEmbed(link: VideoLink): Promise<OEmbedResponse> {
  const text = await fetchText(link.oEmbedUrl, 64_000);
  return JSON.parse(text) as OEmbedResponse;
}

function extractJsonObjectAfterKey(
  source: string,
  key: string,
): Record<string, unknown> | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*`).exec(source);
  if (!match) return undefined;

  const start = source.indexOf("{", match.index + match[0].length);
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1)) as Record<
            string,
            unknown
          >;
        } catch {
          return undefined;
        }
      }
    }
  }

  return undefined;
}

async function fetchYouTubeTranscript(videoId: string): Promise<string> {
  const watchPage = await fetchText(
    `https://www.youtube.com/watch?v=${videoId}&hl=en`,
    MAX_PAGE_BYTES,
  );
  const captions = extractJsonObjectAfterKey(
    watchPage,
    "playerCaptionsTracklistRenderer",
  );
  const tracks = captions?.["captionTracks"];
  if (!Array.isArray(tracks)) return "";

  const track = (tracks as Array<Record<string, unknown>>).find(
    (candidate) =>
      typeof candidate["languageCode"] === "string" &&
      candidate["languageCode"].startsWith("en"),
  );
  const baseUrl = track?.["baseUrl"];
  if (typeof baseUrl !== "string") return "";

  const captionsUrl = new URL(baseUrl);
  captionsUrl.searchParams.set("fmt", "json3");
  const transcriptJson = await fetchText(captionsUrl.toString(), 2_000_000);
  const parsed = JSON.parse(transcriptJson) as {
    events?: Array<{ segs?: Array<{ utf8?: string }> }>;
  };

  return (
    parsed.events
      ?.flatMap((event) => event.segs ?? [])
      .map((segment) => segment.utf8 ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TRANSCRIPT_CHARS) ?? ""
  );
}

async function describeVideo(link: VideoLink): Promise<string> {
  const [metadata, transcript] = await Promise.allSettled([
    fetchOEmbed(link),
    link.kind === "youtube" && link.videoId
      ? fetchYouTubeTranscript(link.videoId)
      : Promise.resolve(""),
  ]);

  const details =
    metadata.status === "fulfilled"
      ? [
          metadata.value.title
            ? `title: ${metadata.value.title.slice(0, 500)}`
            : "",
          metadata.value.author_name
            ? `creator: ${metadata.value.author_name.slice(0, 200)}`
            : "",
        ].filter(Boolean)
      : [];
  const transcriptText =
    transcript.status === "fulfilled" ? transcript.value : "";

  if (details.length === 0 && !transcriptText) return "";

  return [
    `${link.kind} video context from its public title, creator, and available captions`,
    ...details,
    transcriptText ? `available transcript: ${transcriptText}` : "",
    link.kind === "tiktok" && !transcriptText
      ? "only the public title or caption is available, do not invent unseen video details"
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function getVideoContext(content: string): Promise<string[]> {
  const matches = content.match(/https:\/\/[^\s<>]+/gi) ?? [];
  const links = new Map<string, VideoLink>();

  for (const match of matches) {
    const rawUrl = match.replace(/[),.!?]+$/, "");
    const link = parseVideoLink(rawUrl);
    if (link) links.set(link.canonicalUrl, link);
    if (links.size >= 2) break;
  }

  return Promise.all(
    [...links.values()].map(async (link) => {
      try {
        return await describeVideo(link);
      } catch {
        return `${link.kind} video link was shared but no public title or captions could be retrieved`;
      }
    }),
  );
}
