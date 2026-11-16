/**
 * @file test_recent_projects.js
 * @description The start page's recent-solutions list (src/recentProjects.js): most recent first,
 * one entry per solution (Windows paths compared case-insensitively), at most ten, entries whose
 * `.sln` is gone pruned, malformed stored data ignored, and the globalState adapter.
 */

'use strict';

const {
    MAX_RECENTS, DEFAULT_RECENTS_SHOWN, recentsShownLimit, RECENTS_KEY, addRecent, removeRecent, pruneRecents, createRecentStore
} = require('../src/recentProjects');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const paths = (list) => list.map(e => e.slnPath);

let list = [];
list = addRecent(list, 'C:\\Work\\A\\A.sln', 1);
list = addRecent(list, 'C:\\Work\\B\\B.sln', 2);
assert(JSON.stringify(paths(list)) === JSON.stringify(['C:\\Work\\B\\B.sln', 'C:\\Work\\A\\A.sln']), 'most recent first');
assert(list[0].name === 'B' && list[0].at === 2, 'entry carries the solution name and the time');

list = addRecent(list, 'c:/work/a/A.SLN', 3);
assert(list.length === 2 && list[0].slnPath === 'c:/work/a/A.SLN', 're-adding a Windows path in another case/separator moves it to the top, no duplicate');

for (let i = 0; i < 15; i++) list = addRecent(list, `/home/u/P${i}/P${i}.sln`, 10 + i);
assert(list.length === MAX_RECENTS && MAX_RECENTS === 10, `capped at ${MAX_RECENTS}`);
assert(list[0].slnPath === '/home/u/P14/P14.sln', 'newest kept on top after the cap');

list = removeRecent(list, '/home/u/P14/P14.sln');
assert(!paths(list).includes('/home/u/P14/P14.sln') && list.length === 9, 'removeRecent drops one entry');

const exists = (p) => !/P1[0-3]/.test(p);
const pruned = pruneRecents(list, exists);
assert(pruned.every(e => exists(e.slnPath)) && pruned.length === list.length - 4, `missing solutions are pruned (${list.length} → ${pruned.length})`);

const junk = [null, 5, { slnPath: 7 }, { slnPath: '/x/notasolution.txt' }, { slnPath: '/x/Ok.sln' }, { slnPath: '/x/Ok.sln' }];
const cleaned = pruneRecents(junk, () => true);
assert(cleaned.length === 1 && cleaned[0].name === 'Ok', 'malformed and duplicate stored entries are ignored');
assert(pruneRecents('garbage', () => true).length === 0 && addRecent(undefined, '/y/Y.sln').length === 1, 'non-array stored state is treated as empty');

// The globalState adapter.
const store = new Map();
const memento = { get: (k, d) => (store.has(k) ? store.get(k) : d), update: (k, v) => { store.set(k, v); return Promise.resolve(); } };
let onDisk = new Set(['/p/One.sln', '/p/Two.sln']);
const recents = createRecentStore(memento, (p) => onDisk.has(p));
recents.add('/p/One.sln');
recents.add('/p/Two.sln');
assert(JSON.stringify(paths(recents.list())) === JSON.stringify(['/p/Two.sln', '/p/One.sln']), 'the store lists what was added, newest first');
onDisk = new Set(['/p/One.sln']);
assert(JSON.stringify(paths(recents.list())) === JSON.stringify(['/p/One.sln']), 'the store prunes a deleted solution on read');
assert(store.get(RECENTS_KEY).length === 1, 'and writes the pruned list back');
recents.remove('/p/One.sln');
assert(recents.list().length === 0, 'remove empties it');

// The start page's row limit (tcToolkit.startPage.recentProjectsShown), as read from hand-editable settings.
assert(DEFAULT_RECENTS_SHOWN === 2 && recentsShownLimit(undefined) === 2 && recentsShownLimit('8') === 2 && recentsShownLimit(NaN) === 2 && recentsShownLimit(null) === 2,
    'the shown limit defaults to 2 for anything that is not a number');
assert(recentsShownLimit(1) === 1 && recentsShownLimit(7) === 7 && recentsShownLimit(10) === 10, 'a value from 1 to 10 is used as is');
assert(recentsShownLimit(0) === 1 && recentsShownLimit(-3) === 1 && recentsShownLimit(11) === MAX_RECENTS && recentsShownLimit(Infinity) === 2 && recentsShownLimit(3.7) === 3,
    'out-of-range values are clamped to 1..10 and fractions floored');

if (errors) {
    console.error(`\n${errors} failure(s)`);
    process.exit(1);
}
console.log('\nAll recent-projects tests passed.');
