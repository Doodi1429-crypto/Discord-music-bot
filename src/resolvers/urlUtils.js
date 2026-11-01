import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

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

/** Check whether a URL belongs to SoundCloud (including on.soundcloud.com short links). */
export function isSoundCloudUrl(input) {
  try {
    const hostname = new URL(input).hostname.toLowerCase();
    return hostname === 'soundcloud.com' || hostname.endsWith('.soundcloud.com') || hostname === 'snd.sc';
  } catch {
    return false;
  }
}

/** Check whether a YouTube URL points at a playlist (list= without a specific video, or /playlist). */
export function extractPlaylistId(input) {
  try {
    const url = new URL(input);
    const id = url.searchParams.get('list');
    if (!id || !/^[a-zA-Z0-9_-]{10,64}$/.test(id)) return null;
    // Auto-generated "mix" playlists (RD...) are endless; treat only explicit playlists as such.
    if (id.startsWith('RD')) return null;
    return url.pathname.startsWith('/playlist') ? id : null;
  } catch {
    return null;
  }
}

/** True for loopback, private, link-local, CGNAT, multicast and otherwise non-public IP literals. */
export function isPrivateAddress(address) {
  if (typeof address !== 'string') return true;
  let ip = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) ip = mapped[1];

  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (ip.includes(':')) {
    return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith('ff');
  }
  return true;
}

/**
 * Validate an http(s) URL and make sure it does not point at a private network address.
 * Hostnames are resolved via DNS and every returned address must be public.
 * Throws a UserInputError-compatible Error (message in Arabic) on failure.
 */
export async function assertPublicUrl(value, { lookup = dnsLookup, ErrorType = Error } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new ErrorType('الرابط غير صالح. استخدم رابط http(s) صحيح.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ErrorType('يُدعم فقط روابط http(s).');
  if (url.username || url.password) throw new ErrorType('الروابط التي تحتوي على بيانات دخول غير مسموحة.');

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new ErrorType('الروابط المحلية غير مسموحة.');
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new ErrorType('عناوين الشبكات الخاصة غير مسموحة.');
    return url;
  }
  let addresses;
  try { addresses = await lookup(host, { all: true }); }
  catch { throw new ErrorType('تعذّر الوصول إلى عنوان الرابط (DNS).'); }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new ErrorType('عناوين الشبكات الخاصة غير مسموحة.');
  }
  return url;
}
