export const DEFAULT_LOGIN_TIMEOUT_MS = 30_000;

function loginTimeoutMessage(timeoutMs) {
  return `Timed out after ${timeoutMs}ms waiting for Discord login to complete. `
    + 'The process never received a response from Discord\'s gateway - this usually means '
    + 'outbound WebSocket/HTTPS traffic to discord.com is being blocked, dropped, or proxied '
    + 'by the host/firewall. Verify the host allows outbound connections to discord.com.';
}

/**
 * Wraps client.login() with a timeout.
 *
 * On some restrictive hosts (e.g. WispByte) outbound traffic to Discord's gateway can be
 * silently dropped by a firewall/proxy: the TCP/WebSocket handshake never completes, but it
 * also never errors out. discord.js has no built-in timeout for this, so client.login()'s
 * returned promise simply never settles - the process just sits there forever after printing
 * nothing, with no way to tell a hang apart from a slow-but-working connection.
 *
 * This wraps that promise in a race against a timer so a hang like that surfaces as a clear,
 * actionable error instead of silence.
 */
export function loginWithTimeout(client, token, { timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (settle) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    };

    // Deliberately not unref()'d: this timer is what guarantees we actually detect and report
    // a hang instead of the process idling forever, so it must be allowed to keep the event
    // loop alive until either login settles or the timeout fires.
    const timer = setTimeout(() => {
      finish(() => reject(new Error(loginTimeoutMessage(timeoutMs))));
    }, timeoutMs);

    client.login(token).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}
