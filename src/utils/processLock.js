import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/**
 * Prevents two bot processes on the same host from running at once (a PID lock file).
 * A stale lock left by a dead process is replaced. Returns a release function.
 * Note: this protects a single machine only; it cannot detect a bot running elsewhere.
 */
export function acquireProcessLock({ path = join(tmpdir(), 'discord-music-bot.lock'), pid = process.pid, alive = isAlive } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(pid));
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { if (readFileSync(path, 'utf8').trim() === String(pid)) unlinkSync(path); } catch { /* already gone */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number.parseInt(readFileSync(path, 'utf8'), 10);
      if (Number.isInteger(owner) && owner !== pid && alive(owner)) {
        throw new Error(`Another bot process (PID ${owner}) is already running; refusing to start a duplicate.`);
      }
      try { unlinkSync(path); } catch { /* raced with another cleanup */ }
    }
  }
  throw new Error('Could not acquire the process lock.');
}
