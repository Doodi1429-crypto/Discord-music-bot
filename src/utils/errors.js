export class UserInputError extends Error {}
export class AudioSourceError extends Error {}

export function userMessage(error) {
  if (error instanceof UserInputError || error instanceof AudioSourceError) return error.message;
  return 'Playback failed. Check that the URL is public, reachable, and points to supported media.';
}
