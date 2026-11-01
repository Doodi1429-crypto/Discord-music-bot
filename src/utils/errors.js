export class UserInputError extends Error {}
export class AudioSourceError extends Error {}

export function userMessage(error) {
  if (error instanceof UserInputError || error instanceof AudioSourceError) return error.message;
  return 'Playback failed. Check that the URL is public, reachable, and points to supported media.';
}

/** Arabic, user-safe message for command failures (never leaks stack traces or secrets). */
export function arabicError(error) {
  const text = String(error?.message ?? '');
  if (error instanceof UserInputError) return text;
  if (/not a bot|additional verification|automated (queries|requests)|sign in to confirm/i.test(text)) {
    return 'يوتيوب يطلب التحقق ويمنع الوصول من هذا الخادم حالياً. جرّب `/play` مع المصدر **SoundCloud** أو رابط آخر.';
  }
  if (/FFmpeg executable not found/i.test(text)) return 'FFmpeg غير مثبّت على الخادم. أبلغ مشرف البوت.';
  if (error instanceof AudioSourceError) return text.length > 300 ? `${text.slice(0, 297)}…` : text;
  return 'فشل التشغيل. تأكد أن الرابط عام ويمكن الوصول إليه ويحتوي على وسائط مدعومة.';
}
