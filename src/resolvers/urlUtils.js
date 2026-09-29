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
    return (
      hostname === 'youtube.com' ||
      hostname === 'www.youtube.com' ||
      hostname === 'youtu.be' ||
      hostname === 'www.youtu.be'
    );
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

    if (hostname === 'youtube.com' || hostname === 'www.youtube.com') {
      // Full form: youtube.com/watch?v=<id>
      const id = url.searchParams.get('v');
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
