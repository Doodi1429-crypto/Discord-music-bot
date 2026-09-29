/**
 * Check if string is a valid HTTP(S) URL
 */
export function isValidUrl(input) {
  try {
    const url = new URL(input);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Check if URL is a YouTube URL
 */
export function isYouTubeUrl(input) {
  try {
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase();
    return ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'].includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Extract YouTube video ID from URL
 * Supports:
 * - youtube.com/watch?v=<id>
 * - youtu.be/<id>
 */
export function extractVideoId(input) {
  try {
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase();

    if (hostname === 'youtu.be' || hostname === 'www.youtu.be') {
      // Short form: youtu.be/<id>
      const id = url.pathname.slice(1).split('?')[0];
      return isValidVideoId(id) ? id : null;
    }

    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(hostname)) {
      const pathId = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/)?.[1];
      const id = url.searchParams.get('v') || pathId;
      return id && isValidVideoId(id) ? id : null;
    }
  } catch {}
  return null;
}

/**
 * Validate YouTube video ID format (11 alphanumeric characters)
 */
export function isValidVideoId(id) {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}
