import { Router, type IRouter } from "express";
import { FetchInstagramMediaBody } from "@workspace/api-zod";

const router: IRouter = Router();

type MediaType = "reel" | "video" | "photo" | "story" | "carousel";

function extractShortcode(url: string): string | null {
  const patterns = [
    /instagram\.com\/p\/([A-Za-z0-9_-]+)/,
    /instagram\.com\/reel\/([A-Za-z0-9_-]+)/,
    /instagram\.com\/reels\/([A-Za-z0-9_-]+)/,
    /instagram\.com\/tv\/([A-Za-z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function detectMediaType(url: string): MediaType {
  if (/\/reel\/|\/reels\//i.test(url)) return "reel";
  if (/\/stories\//i.test(url)) return "story";
  if (/\/tv\//i.test(url)) return "video";
  return "photo";
}

function extractMetaTags(html: string): Record<string, string> {
  const meta: Record<string, string> = {};

  // property="..." content="..."
  const re1 =
    /<meta[^>]+property=["']([^"']+)["'][^>]+content=["']([^"']*?)["'][^>]*\/?>/gi;
  let m;
  while ((m = re1.exec(html)) !== null) {
    if (!meta[m[1]]) meta[m[1]] = m[2];
  }

  // content="..." property="..."
  const re2 =
    /<meta[^>]+content=["']([^"']*?)["'][^>]+property=["']([^"']+)["'][^>]*\/?>/gi;
  while ((m = re2.exec(html)) !== null) {
    if (!meta[m[2]]) meta[m[2]] = m[1];
  }

  return meta;
}

/** Detect carousel by looking for multiple og:image tags or carousel markers in the embed HTML */
function detectCarousel(html: string, imageCount: number): boolean {
  return (
    imageCount > 1 ||
    html.includes("carousel_unit") ||
    html.includes('"__typename":"GraphSidecar"') ||
    html.includes("data-slide-index")
  );
}

/** Extract all og:image URLs from HTML to support carousel posts */
function extractAllImages(html: string): string[] {
  const images: string[] = [];
  const re =
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*\/?>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!images.includes(m[1])) images.push(m[1]);
  }
  // Also try content-first format
  const re2 =
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*\/?>/gi;
  while ((m = re2.exec(html)) !== null) {
    if (!images.includes(m[1])) images.push(m[1]);
  }
  return images;
}

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  Referer: "https://www.instagram.com/",
};

router.post("/download", async (req, res) => {
  let parsedBody: { url: string };
  try {
    parsedBody = FetchInstagramMediaBody.parse(req.body);
  } catch {
    res.status(400).json({ success: false, error: "Invalid request body. Provide a valid Instagram URL." });
    return;
  }

  const { url } = parsedBody;

  if (!url || !/instagram\.com\//i.test(url)) {
    res.status(400).json({ success: false, error: "Please provide a valid Instagram URL." });
    return;
  }

  const detectedType = detectMediaType(url);

  // Stories use numeric IDs and cannot be accessed via the public embed page
  if (detectedType === "story") {
    res.status(422).json({
      success: false,
      error:
        "Instagram Stories cannot be downloaded — they are only accessible to logged-in users and expire after 24 hours.",
    });
    return;
  }

  const shortcode = extractShortcode(url);
  if (!shortcode) {
    res.status(400).json({
      success: false,
      error: "Could not parse Instagram URL. Please ensure you paste the full post URL.",
    });
    return;
  }

  try {
    // Fetch the public Instagram embed page
    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
    const response = await fetch(embedUrl, { headers: HEADERS });

    if (!response.ok) {
      res.status(422).json({
        success: false,
        error: "Could not access this Instagram post. It may be private or deleted.",
      });
      return;
    }

    const html = await response.text();
    const meta = extractMetaTags(html);
    const allImages = extractAllImages(html);

    const primaryThumbnail =
      meta["og:image"] || meta["og:image:url"] || meta["og:image:secure_url"] || allImages[0] || "";
    const title = meta["og:title"] || meta["og:description"] || "";
    const videoUrl =
      meta["og:video:secure_url"] || meta["og:video:url"] || meta["og:video"] || "";

    if (videoUrl) {
      // Video / Reel
      const finalType: MediaType = detectedType === "photo" ? "video" : detectedType;
      res.json({
        success: true,
        title: title || undefined,
        thumbnail: primaryThumbnail || undefined,
        mediaType: finalType,
        items: [{ url: videoUrl, type: "video", quality: "HD" }],
      });
      return;
    }

    if (allImages.length > 0) {
      const isCarousel = detectCarousel(html, allImages.length);
      const finalType: MediaType = isCarousel ? "carousel" : "photo";

      const items = allImages.map((imgUrl) => ({
        url: imgUrl,
        type: "image" as const,
        quality: "HD",
      }));

      res.json({
        success: true,
        title: title || undefined,
        thumbnail: primaryThumbnail || undefined,
        mediaType: finalType,
        items,
      });
      return;
    }

    res.status(422).json({
      success: false,
      error:
        "Could not extract media from this post. The post may be private or Instagram may be limiting access.",
    });
  } catch (err) {
    req.log.error({ err }, "Instagram fetch error");
    res.status(500).json({ success: false, error: "An unexpected error occurred. Please try again." });
  }
});

export default router;
