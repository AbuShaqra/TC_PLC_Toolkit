/**
 * @file test_library_scope.js
 * @description Which libraries the "TwinCAT Libraries" view shows, in a workspace with more than one
 * PLC project — both halves of the decision, LSP side and extension-host side.
 *
 * The view used to show the flat UNION of every project's libraries, because the host never told the
 * LSP which file was active. That is wrong in the same way the pre-0.6.0 flat symbol index was wrong:
 * it offers namespaces the active file cannot actually use. The load-bearing part of the fix is the
 * half that is easy to get wrong in the other direction — an explicitly scoped request whose project
 * has NO libraries must answer with nothing, not quietly widen to the union. That widening is exactly
 * what the previous implementation did (`if (catalog.length > 0) return catalog;`), and it makes an
 * empty project indistinguishable from its neighbour.
 *
 * Two levels are pinned here:
 *  - `selectLibraryCatalog` (src/lsp/workspaceScan.js) — the pure scope decision the `custom/libraries`
 *    handler is a one-line call to. server.js opens IPC at require time and cannot be loaded
 *    standalone, which is why the decision lives in workspaceScan.js at all. The catalog *builders*
 *    are injected here (fakes that make each project's libraries obvious); the real ones are pinned by
 *    test_library_catalog.js and test_multi_project_scope.js.
 *  - `scopeProjectKey` / `scopeDescription` / `readLibraryResponse` and the provider's `setActiveFile`
 *    (src/libraryTreeProvider.js) — the host's change detection and scope indicator. `vscode` is
 *    stubbed, exactly as test_library_tree.js does, so this runs in plain Node like every harness.
 *
 * The fixture is two minimal `.plcproj` files in a temp directory: routing to a project is by
 * directory containment (projectMap.js), so no object files are needed, and the harness never touches
 * `sample/` — it therefore cannot skip, and needs no coverage report.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// --- vscode stub (see test_library_tree.js) ---------------------------------------------------
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === 'vscode') return 'vscode-stub';
    return origResolve.call(this, req, ...rest);
};
require.cache['vscode-stub'] = {
    id: 'vscode-stub', filename: 'vscode-stub', loaded: true,
    exports: {
        EventEmitter: class {
            constructor() { this.fired = 0; this.event = () => {}; }
            fire() { this.fired++; }
        },
        TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
        ThemeIcon: class { constructor(id) { this.id = id; } },
        MarkdownString: class { appendMarkdown() {} }
    }
};

const {
    createEmptyWorkspace, scanWorkspace, selectLibraryCatalog, normalizeProjectPath
} = require('../src/lsp/workspaceScan');
const { createProjectMap } = require('../src/lsp/projectMap');
const {
    TwinCatLibraryTreeDataProvider, scopeProjectKey, scopeDescription, readLibraryResponse,
    UNION_DESCRIPTION
} = require('../src/libraryTreeProvider');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// --- fixture: two PLC projects and one file belonging to neither -------------------------------

/** A `.plcproj` skeleton — only its location matters here; ownership routing is by directory. */
const PLCPROJ = '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<Project ToolsVersion="4.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\n'
    + '  <ItemGroup />\n'
    + '</Project>\n';

const root = path.join(os.tmpdir(), 'tc_libscope_' + process.pid + '_' + Date.now());
const dirA = path.join(root, 'LineA', 'LineA_PLC');
const dirB = path.join(root, 'LineB', 'LineB_PLC');
fs.mkdirSync(dirA, { recursive: true });
fs.mkdirSync(dirB, { recursive: true });
const plcprojA = path.join(dirA, 'LineA_PLC.plcproj');
const plcprojB = path.join(dirB, 'LineB_PLC.plcproj');
fs.writeFileSync(plcprojA, PLCPROJ);
fs.writeFileSync(plcprojB, PLCPROJ);
const fileA = path.join(dirA, 'POUs', 'MAIN.TcPOU');
const fileB = path.join(dirB, 'POUs', 'MAIN.TcPOU');
const looseFile = path.join(root, 'notes', 'Scratch.TcPOU');   // under the root, under no project

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* best effort */ } });

const keyA = normalizeProjectPath(plcprojA);
const keyB = normalizeProjectPath(plcprojB);

/** A file URI the LSP's routing accepts, built the way the extension host builds one. */
const uriOf = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '');

// --- LSP side: selectLibraryCatalog ------------------------------------------------------------
// Real routing (a real scanWorkspace over the fixture), fake catalogs: the decision under test is
// WHICH index answers, so each project's libraries are just a marker written onto its index.

const workspace = scanWorkspace([root], { indexLibraries: () => {} });
const libsOf = { [keyA]: [{ namespace: 'Tc2_LineAOnly' }], [keyB]: [{ namespace: 'Tc2_LineBOnly' }] };
for (const [key, libs] of Object.entries(libsOf)) workspace.indexForKey(key).__libs = libs;

/** @type {{getLibraryCatalog: Function, getUnionLibraryCatalog: Function}} */
const fakeCatalogs = {
    getLibraryCatalog: (index) => ((index && index.__libs) || []).slice(),
    getUnionLibraryCatalog: (indexes) => {
        const seen = new Map();
        for (const index of indexes) {
            for (const entry of (index && index.__libs) || []) {
                if (!seen.has(entry.namespace)) seen.set(entry.namespace, entry);
            }
        }
        return Array.from(seen.values());
    }
};
const select = (uri) => selectLibraryCatalog(workspace, uri, fakeCatalogs);
const namespaces = (res) => res.libraries.map(e => e.namespace).sort();

assert(workspace.projectMap.projects.size === 2, 'fixture: the scan found both PLC projects');

const resA = select(uriOf(fileA));
assert(resA.scope === 'project', "a fileUri in LineA answers with scope 'project'");
assert(resA.projectKey === keyA, "…and names LineA's project key");
assert(JSON.stringify(namespaces(resA)) === JSON.stringify(['Tc2_LineAOnly']),
    "…and returns ONLY LineA's libraries — never LineB's");

const resB = select(uriOf(fileB));
assert(resB.projectKey === keyB && JSON.stringify(namespaces(resB)) === JSON.stringify(['Tc2_LineBOnly']),
    'the same request from LineB answers with LineB, and only LineB');

// THE behaviour change. A project that references no libraries has an empty view, and that is the
// truth about it; the old handler widened this case to the union, which showed the neighbour's
// libraries under an explicit scope — indistinguishable from a bug, and unusable as an answer to
// "what can I type here?".
workspace.indexForKey(keyB).__libs = [];
const resEmpty = select(uriOf(fileB));
assert(resEmpty.scope === 'project' && resEmpty.projectKey === keyB,
    'an empty project is still answered as an explicit project scope');
assert(resEmpty.libraries.length === 0,
    'an EMPTY project catalog stays empty under an explicit scope — it never widens to the union');
workspace.indexForKey(keyB).__libs = libsOf[keyB];

const resNone = select('');
assert(resNone.scope === 'union' && resNone.projectKey === null, "no fileUri answers with scope 'union'");
assert(JSON.stringify(namespaces(resNone)) === JSON.stringify(['Tc2_LineAOnly', 'Tc2_LineBOnly']),
    '…and unions every project — the fallback that keeps the view from ever rendering empty');

const resLoose = select(uriOf(looseFile));
assert(resLoose.scope === 'union' && resLoose.projectKey === null,
    'a file under NO project directory routes to (loose), which is not a scope — union');
assert(JSON.stringify(namespaces(resLoose)) === JSON.stringify(['Tc2_LineAOnly', 'Tc2_LineBOnly']),
    '…with every project’s libraries in it');

const empty = createEmptyWorkspace();
const resPreScan = selectLibraryCatalog(empty, uriOf(fileA), fakeCatalogs);
assert(resPreScan.scope === 'union' && resPreScan.libraries.length === 0,
    'before any scan there is no partition to route with: union (of nothing), never a throw');

// --- host side: the pure scope decisions --------------------------------------------------------

const hostMap = createProjectMap([root]);
const soloMap = createProjectMap([path.join(root, 'LineA')]);

assert(scopeProjectKey(hostMap, fileA) === keyA, 'scopeProjectKey: a file in LineA gives LineA’s key');
assert(scopeProjectKey(hostMap, fileB) === keyB, 'scopeProjectKey: a file in LineB gives LineB’s key');
assert(scopeProjectKey(hostMap, looseFile) === '',
    "scopeProjectKey: a file under no project gives '' — (loose) is never a scope");
assert(scopeProjectKey(hostMap, '') === '' && scopeProjectKey(null, fileA) === '',
    "scopeProjectKey: no file and no partition both give ''");

assert(scopeDescription(hostMap, fileA, 'project') === 'LineA_PLC',
    'scopeDescription: the scoped label is the project’s REAL spelling, not the lowercased key');
assert(!/[/\\]/.test(scopeDescription(hostMap, fileA, 'project')),
    '…and is a label, never a path (normalized keys are not file paths)');
assert(scopeDescription(hostMap, '', 'union') === UNION_DESCRIPTION
    && UNION_DESCRIPTION === 'All projects',
    "scopeDescription: the union reads 'All projects'");
assert(scopeDescription(hostMap, looseFile, 'project') === UNION_DESCRIPTION,
    'scopeDescription: a file the host routes nowhere falls back to the union wording');
assert(soloMap.projects.size === 1 && scopeDescription(soloMap, fileA, 'project') === '',
    'scopeDescription: a SINGLE-project workspace shows nothing — a description there is pure noise');
assert(scopeDescription(soloMap, fileA, 'union') === '' && scopeDescription(null, fileA, 'union') === '',
    '…and that holds for the union wording too, and with no partition at all');

assert(readLibraryResponse([{ namespace: 'X' }]).scope === 'union'
    && readLibraryResponse([{ namespace: 'X' }]).libraries.length === 1,
    'readLibraryResponse: a bare array (an older LSP) is accepted, and read as the union');
const parsed = readLibraryResponse({ scope: 'project', projectKey: keyA, libraries: [{ namespace: 'X' }] });
assert(parsed.scope === 'project' && parsed.projectKey === keyA && parsed.libraries.length === 1,
    'readLibraryResponse: the scoped shape is read through unchanged');
assert(readLibraryResponse(null).libraries.length === 0
    && readLibraryResponse({ scope: 'project' }).scope === 'union',
    'readLibraryResponse: garbage degrades to an empty union, never to a throw');

// --- host side: the provider only refetches when the PROJECT changes ----------------------------

/**
 * A provider wired to a recording request stub.
 * @param {Object|null} projectMap The partition the provider sees.
 * @returns {{provider: Object, calls: Array<Object|undefined>, descriptions: Array<string>,
 *   catalogs: Object}}
 */
function makeProvider(projectMap) {
    const calls = [];
    const descriptions = [];
    const byNamespace = {
        [keyA]: [{ namespace: 'Tc2_LineAOnly' }],
        [keyB]: [{ namespace: 'Tc2_LineBOnly' }]
    };
    const provider = new TwinCatLibraryTreeDataProvider(
        // Stands in for selectLibraryCatalog: a URI inside a project answers with that project, and
        // anything else (no URI, or a file under none) answers with the union.
        (method, params) => {
            calls.push(params);
            const uri = (params && params.fileUri) || '';
            const key = uri.includes('/LineA/') ? keyA : (uri.includes('/LineB/') ? keyB : '');
            return Promise.resolve(key
                ? { scope: 'project', projectKey: key, libraries: byNamespace[key] }
                : { scope: 'union', projectKey: null, libraries: [].concat(byNamespace[keyA], byNamespace[keyB]) });
        },
        { getProjectMap: () => projectMap, setDescription: (text) => descriptions.push(text) }
    );
    return { provider, calls, descriptions };
}

const uriObj = (p) => ({ fsPath: p, toString: () => uriOf(p) });

(async () => {
    const { provider, calls, descriptions } = makeProvider(hostMap);

    provider.setActiveFile(uriObj(fileA));
    let catalog = await provider.getCatalog();
    assert(calls.length === 1 && calls[0] && calls[0].fileUri === uriOf(fileA),
        'the request carries the active file’s URI');
    assert(catalog.length === 1 && catalog[0].namespace === 'Tc2_LineAOnly',
        '…and the view holds that project’s catalog');
    assert(descriptions[descriptions.length - 1] === 'LineA_PLC',
        '…and the view description names the project');

    // A second file of the SAME project: same libraries, so nothing may be dropped or refetched.
    provider.setActiveFile(uriObj(path.join(dirA, 'DUTs', 'ST_Foo.TcDUT')));
    catalog = await provider.getCatalog();
    assert(calls.length === 1, 'switching files WITHIN one project does not refetch the catalog');
    assert(catalog[0].namespace === 'Tc2_LineAOnly', '…and the view still shows that project');

    // Crossing into the other project must invalidate.
    provider.setActiveFile(uriObj(fileB));
    catalog = await provider.getCatalog();
    assert(calls.length === 2 && calls[1].fileUri === uriOf(fileB),
        'crossing into another project refetches, with the new file');
    assert(catalog[0].namespace === 'Tc2_LineBOnly', '…and the view swaps to that project’s libraries');
    assert(descriptions[descriptions.length - 1] === 'LineB_PLC', '…and the description follows');

    // Leaving every project drops back to the union, and says so.
    provider.setActiveFile(uriObj(looseFile));
    catalog = await provider.getCatalog();
    assert(calls.length === 3 && calls[2] && calls[2].fileUri === uriOf(looseFile),
        'a file under no project still sends its URI — the LSP owns the routing decision, not the host');
    assert(catalog.length === 2, '…and the LSP’s union answer is what the view holds');
    assert(descriptions[descriptions.length - 1] === UNION_DESCRIPTION,
        '…and the description says the list is not scoped');

    // refresh() (the .plcproj watcher / the Refresh command) must still drop the cache.
    provider.refresh();
    await provider.getCatalog();
    assert(calls.length === 4, 'refresh() still drops the cached catalog and refetches');

    // Single-project workspace: the same flow, no description at all.
    const solo = makeProvider(soloMap);
    solo.provider.setActiveFile(uriObj(fileA));
    await solo.provider.getCatalog();
    assert(solo.descriptions[solo.descriptions.length - 1] === '',
        'a single-project workspace gets NO description, even while scoped to that project');

    // An LSP that fails the request leaves the view empty rather than throwing at the tree.
    const failing = new TwinCatLibraryTreeDataProvider(() => Promise.reject(new Error('down')),
        { getProjectMap: () => hostMap });
    assert((await failing.getCatalog()).length === 0, 'a failed request yields an empty catalog, not a throw');

    console.log(errors === 0 ? '\nAll library-scope tests passed.' : `\n${errors} test(s) failed.`);
    process.exit(errors === 0 ? 0 : 1);
})();
