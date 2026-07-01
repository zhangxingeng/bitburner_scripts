import fs from 'node:fs';
import path from 'node:path';
import syncDirectoryLib from 'sync-directory';
import fastGlob from 'fast-glob';
import chokidar from 'chokidar';
import { src, dist, allowedFiletypes } from './config.js';

const syncDirectory = syncDirectoryLib;
const fg = fastGlob;

/** Format dist path for printing */
function normalize(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Sync static files.
 * Include init and watch phase.
 */
async function syncStatic() {
  return syncDirectory.async(path.resolve(src), path.resolve(dist), {
    exclude: (file) => {
      const { ext } = path.parse(file);
      // .js is EXCLUDED here on purpose, even though it's in allowedFiletypes (that list is
      // also consulted elsewhere, e.g. by the game-side filesync). syncStatic() mirrors src ->
      // dist by literal same-name/same-extension match with deleteOrphaned:true — since every
      // real source is .ts/.tsx (never .js), it never finds a match for a compiled .js file and
      // was deleting EVERY .js in dist/ as "orphaned" on every startup (only sheer timing luck
      // spared whichever files tsc hadn't finished re-emitting yet at that exact moment — this
      // is what wiped dist/cross/game_agent.js while brain.ts was live). initTypeScript()/
      // watchTypeScript() below already own .js orphan cleanup, extension-translation-aware;
      // syncStatic() must stay out of their way entirely.
      if (ext === '.js') return true;
      return ext && !allowedFiletypes.includes(ext);
    },
    async afterEachSync(event) {
      // log file action
      let eventType;
      if (event.eventType === 'add' || event.eventType === 'init:copy') {
        eventType = 'changed';
      } else if (event.eventType === 'unlink') {
        eventType = 'deleted';
      }
      if (eventType) {
        let relative = event.relativePath;
        if (relative[0] === '\\') {
          relative = relative.substring(1);
        }
        console.log(`${normalize(relative)} ${eventType}`);
      }
    },
    watch: true,
    deleteOrphaned: true,
  });
}

/**
 * Sync ts script files.
 * Init phase only.
 */
async function initTypeScript() {
  const distFiles = await fg(`${dist}/**/*.js`);
  for (const distFile of distFiles) {
    // search existing *.js file in dist
    const relative = path.relative(dist, distFile);
    const srcFile = path.resolve(src, relative);
    // if srcFile does not exist, delete distFile — must check .tsx too, or every React
    // component (src/ui/**/*.tsx) gets wrongly treated as orphaned and wiped on every start.
    if (
      !fs.existsSync(srcFile) &&
      !fs.existsSync(srcFile.replace(/\.js$/, '.ts')) &&
      !fs.existsSync(srcFile.replace(/\.js$/, '.tsx'))
    ) {
      // syncStatic()'s deleteOrphaned runs concurrently (not awaited above) and can already
      // have removed this same orphaned file — ENOENT here just means the goal is already met.
      try {
        await fs.promises.unlink(distFile);
        console.log(`${normalize(relative)} deleted`);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  }
}

/**
 * Sync ts script files.
 * Watch phase only.
 */
async function watchTypeScript() {
  chokidar.watch([`${src}/**/*.ts`, `${src}/**/*.tsx`]).on('unlink', async (p) => {
    // called on *.ts/*.tsx file get deleted
    const relative = path.relative(src, p).replace(/\.tsx?$/, '.js');
    const distFile = path.resolve(dist, relative);
    // if distFile exists, delete it (still guard the unlink itself — same syncStatic() race
    // as initTypeScript() above)
    if (fs.existsSync(distFile)) {
      try {
        await fs.promises.unlink(distFile);
        console.log(`${normalize(relative)} deleted`);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  });
}

/**
 * Sync ts script files.
 * Include init and watch phase.
 */
async function syncTypeScript() {
  await initTypeScript();
  return watchTypeScript();
}

console.log('Start watching static and ts files...');
// syncStatic()'s initial pass (deleteOrphaned) and syncTypeScript()'s initial pass
// (initTypeScript) both walk dist/ deleting orphaned files independently — run them serially
// so they can't race on the same file (one's unlink, the other's internal lstat before its own
// unlink, throwing ENOENT — the crash this comment replaces). Both still continue watching
// concurrently in the background afterward; only the initial sweep is serialized.
await syncStatic();
await syncTypeScript();
