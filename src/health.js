import { logger as defaultLogger } from './utils/logger.js';

const WS_STATUS = ['READY', 'CONNECTING', 'RECONNECTING', 'IDLE', 'NEARLY', 'DISCONNECTED', 'WAITING_FOR_GUILDS', 'IDENTIFYING', 'RESUMING'];

export function healthSnapshot(client, manager) {
  const code = client.ws?.status;
  return {
    status: WS_STATUS[code] ?? `UNKNOWN(${code})`,
    ready: code === 0,
    pingMs: Math.round(client.ws?.ping ?? -1),
    uptimeMin: Math.floor(process.uptime() / 60),
    guilds: client.guilds?.cache?.size ?? 0,
    voiceConnections: [...(manager?.players?.values() ?? [])].filter((p) => p.connection).length,
    activePlayers: manager?.players?.size ?? 0,
    rssMb: Math.round(process.memoryUsage().rss / 1048576)
  };
}

/**
 * Logs a health line on every interval. The heartbeat is a real internal health check, not a
 * keep-alive trick: if the gateway stays unhealthy for `maxUnhealthyBeats` consecutive beats,
 * `onUnhealthy` runs (index.js exits non-zero so the host's process supervisor restarts the worker).
 */
export function startHeartbeat({ client, manager, intervalMs = 600_000, maxUnhealthyBeats = 2, onUnhealthy, logger = defaultLogger, setIntervalImpl = setInterval }) {
  let unhealthyBeats = 0;
  const beat = () => {
    const snapshot = healthSnapshot(client, manager);
    if (snapshot.ready) {
      unhealthyBeats = 0;
      logger.info('Heartbeat: healthy', snapshot);
      return;
    }
    unhealthyBeats += 1;
    logger.warn('Heartbeat: gateway not ready', { ...snapshot, unhealthyBeats });
    if (unhealthyBeats >= maxUnhealthyBeats) {
      logger.error('Heartbeat: gateway unhealthy for too long, requesting restart', snapshot);
      onUnhealthy?.(snapshot);
    }
  };
  const timer = setIntervalImpl(beat, intervalMs);
  timer.unref?.();
  return { beat, stop: () => clearInterval(timer) };
}
