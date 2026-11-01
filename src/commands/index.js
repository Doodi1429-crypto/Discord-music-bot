import * as join from './join.js';
import * as play from './play.js';
import * as pause from './pause.js';
import * as resume from './resume.js';
import * as skip from './skip.js';
import * as stop from './stop.js';
import * as queue from './queue.js';
import * as nowplaying from './nowplaying.js';
import * as leave from './leave.js';
import * as volume from './volume.js';
import * as remove from './remove.js';
import * as clear from './clear.js';
import * as shuffle from './shuffle.js';
import * as loop from './loop.js';
import * as help from './help.js';
import * as health from './health.js';

export const commands = [join, play, pause, resume, skip, stop, queue, nowplaying, leave, volume, remove, clear, shuffle, loop, help, health]
  .map(({ data, execute }) => ({ data, execute }));
