/** Check whether a string is a valid HTTP(S) URL. */
export function isValidUrl(input) {
  try {
    const url = new URL(input);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

/** Check whether a URL belongs to YouTube or one of its subdomains. */
export function isYouTubeUrl(input) {
  try {
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase();
    return hostname === 'youtu.be'
      || hostname.endsWith('.youtu.be')
      || hostname === 'youtube.com'
      || hostname.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

/** Extract a video ID from standard, short, Shorts, live, or embed URLs. */
export function extractVideoId(input) {
  try {
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase();
    let id = null;

    if (hostname === 'youtu.be' || hostname.endsWith('.youtu.be')) {
      id = url.pathname.split('/').filter(Boolean)[0];
    } else if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
      id = url.searchParams.get('v');
      if (!id) {
        const match = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/]+)/);
        id = match?.[1] || null;
      }
    }

    return isValidVideoId(id) ? id : null;
  } catch {
    return null;
  }
}

export function isValidVideoId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id);
}
