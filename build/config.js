import fs from 'node:fs';

// Read the filesync.json file
const fileSyncJsonRaw = fs.readFileSync('./filesync.json', 'utf8');
const fileSyncJson = JSON.parse(fileSyncJsonRaw);

const dist = fileSyncJson['scriptsFolder'];
const src = 'src';
const allowedFiletypes = fileSyncJson['allowedFiletypes'];

export {
  dist,
  src,
  allowedFiletypes
};
