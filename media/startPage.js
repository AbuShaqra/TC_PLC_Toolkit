/**
 * @file media/startPage.js
 * @description The start page's script (webview side). Validates the project name as the user types
 * with the same rules the host applies (media/projectName.js), and turns every button into a message
 * for the extension host (src/startPage.js), which does the real work — the page itself never touches
 * the file system, the network or a command directly.
 *
 * Messages to the host:  ready · browseLocation · create {version, name, location} · openProject ·
 *                        openRecent {slnPath} · removeRecent {slnPath} · command {command} · link {id} ·
 *                        openSettings {section} · setCompileOption {key, value} · setXaeOption {key, value}
 * Messages from the host: state {location, sep, recents, recentsShown, hasProject, compilerReady, compileOptions,
 *                         xaeShells, gpp, xaeOptions} ·
 *                         location {location} · createResult {ok, error?}
 */

(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    const validateProjectName = /** @type {any} */ (self).projectName.validateProjectName;
    const PLC_SUFFIX = /** @type {any} */ (self).projectName.PLC_SUFFIX;

    const $ = (id) => /** @type {any} */ (document.getElementById(id));
    const nameInput = $('project-name');
    const versionSelect = $('tc-version');
    const locationInput = $('location');
    const createBtn = $('create-btn');
    const nameError = $('name-error');
    const createError = $('create-error');
    const targetPath = $('target-path');
    const plcName = $('plc-name');

    let sep = '/';
    let busy = false;
    // A name the user has not touched yet is not reported as an error; Create still stays disabled.
    let nameTouched = false;

    // Restore what the user had typed if the panel was hidden and shown again.
    const saved = vscode.getState() || {};
    if (saved.name) nameInput.value = saved.name;
    if (saved.version) versionSelect.value = saved.version;
    if (saved.location) locationInput.value = saved.location;

    function persist() {
        vscode.setState({ name: nameInput.value, version: versionSelect.value, location: locationInput.value });
    }

    function refresh() {
        const name = nameInput.value.trim();
        const problem = validateProjectName(name);
        const showError = problem && (nameTouched || name.length > 0);
        nameError.hidden = !showError;
        nameError.textContent = showError ? problem : '';
        nameInput.setAttribute('aria-invalid', showError ? 'true' : 'false');
        plcName.textContent = (problem ? '<name>' : name) + PLC_SUFFIX;
        const location = locationInput.value;
        targetPath.textContent = location && !problem
            ? 'Creates ' + location.replace(/[\\/]+$/, '') + sep + name + sep + name + '.sln'
            : '';
        createBtn.disabled = busy || !!problem || !location;
        persist();
    }

    nameInput.addEventListener('input', () => { createError.hidden = true; refresh(); });
    nameInput.addEventListener('blur', () => { nameTouched = true; refresh(); });
    versionSelect.addEventListener('change', refresh);
    $('browse').addEventListener('click', () => vscode.postMessage({ type: 'browseLocation' }));

    $('create-form').addEventListener('submit', (e) => {
        e.preventDefault();
        nameTouched = true;
        refresh();
        if (createBtn.disabled) return;
        busy = true;
        createBtn.disabled = true;
        createBtn.textContent = 'Creating…';
        createError.hidden = true;
        vscode.postMessage({
            type: 'create',
            version: versionSelect.value,
            name: nameInput.value.trim(),
            location: locationInput.value
        });
    });

    $('open-project').addEventListener('click', () => vscode.postMessage({ type: 'openProject' }));

    for (const btn of document.querySelectorAll('[data-command]')) {
        btn.addEventListener('click', () => vscode.postMessage({ type: 'command', command: btn.getAttribute('data-command') }));
    }
    for (const a of document.querySelectorAll('[data-link]')) {
        a.addEventListener('click', (e) => {
            e.preventDefault();
            vscode.postMessage({ type: 'link', id: a.getAttribute('data-link') });
        });
    }

    $('xae-change').addEventListener('click', () => vscode.postMessage({ type: 'openSettings', section: 'xaeShell' }));
    $('gpp-change').addEventListener('click', () => vscode.postMessage({ type: 'openSettings', section: 'gpp' }));
    $('xae-build-change').addEventListener('click', () => vscode.postMessage({ type: 'openSettings', section: 'xaeBuild' }));

    /** The last recent list and row limit the host sent; kept so the toggle can re-render without it. */
    let lastRecents = [];
    let recentsShown = 2;
    // "Show all" is a view state of this page only: deliberately not saved, so a reload starts collapsed.
    let recentsExpanded = false;

    /**
     * Renders the recent solutions: at most `recentsShown` rows, then one "Show all (K)" tile when more
     * are stored, which expands the list in place and becomes "Show fewer".
     * @param {boolean} [focusToggle] Put the focus back on the toggle (it was just activated and the
     *   list is rebuilt around it, which would otherwise drop keyboard focus to the page).
     */
    function renderRecents(focusToggle) {
        const list = $('recent-list');
        list.textContent = '';
        const all = lastRecents;
        const overflow = all.length > recentsShown;
        if (!overflow) recentsExpanded = false;
        for (const r of recentsExpanded ? all : all.slice(0, recentsShown)) {
            const li = document.createElement('li');
            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'recent-open';
            open.title = r.slnPath;
            const name = document.createElement('span');
            name.className = 'recent-name';
            name.textContent = r.name;
            const where = document.createElement('span');
            where.className = 'recent-path';
            where.textContent = r.slnPath;
            open.append(name, where);
            open.addEventListener('click', () => vscode.postMessage({ type: 'openRecent', slnPath: r.slnPath }));
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'recent-remove';
            remove.title = 'Remove from the list';
            remove.setAttribute('aria-label', 'Remove ' + r.name + ' from the list');
            remove.textContent = '×';
            remove.addEventListener('click', () => vscode.postMessage({ type: 'removeRecent', slnPath: r.slnPath }));
            li.append(open, remove);
            list.append(li);
        }
        if (overflow) {
            const li = document.createElement('li');
            li.className = 'recent-toggle';
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.id = 'recent-toggle';
            toggle.className = 'recent-open';
            toggle.setAttribute('aria-expanded', recentsExpanded ? 'true' : 'false');
            toggle.setAttribute('aria-controls', 'recent-list');
            const label = document.createElement('span');
            label.className = 'recent-name';
            label.textContent = recentsExpanded ? 'Show fewer' : 'Show all (' + all.length + ')';
            toggle.append(label);
            toggle.addEventListener('click', () => {
                recentsExpanded = !recentsExpanded;
                renderRecents(true);
            });
            li.append(toggle);
            list.append(li);
            if (focusToggle) toggle.focus();
        }
        $('recent-empty').hidden = all.length > 0;
    }

    /**
     * Renders the two XAE Shell path settings: "3.1.4024: <path>" or "not found", with a warning when
     * a configured path is not a file on this machine.
     * @param {Array<{id: string, version: string, path: string, exists: boolean}>} shells
     */
    function renderXaeShells(shells) {
        const list = $('xae-list');
        list.textContent = '';
        for (const s of shells) {
            const li = document.createElement('li');
            const missing = !!s.path && !s.exists;
            li.className = 'xae-row' + (missing ? ' missing' : '') + (s.path ? '' : ' unset');
            li.setAttribute('data-xae', s.id);
            const version = document.createElement('span');
            version.className = 'xae-version';
            version.textContent = s.version + ':';
            const where = document.createElement('span');
            where.className = 'xae-path';
            where.textContent = s.path || 'not found';
            li.append(version, where);
            if (missing) {
                const warning = document.createElement('span');
                warning.className = 'xae-warning';
                warning.textContent = 'This file does not exist.';
                li.append(warning);
            }
            list.append(li);
        }
    }

    /** Why a set g++ path cannot be used (src/gpp.js checkConfiguredGpp's reasons). */
    const GPP_PROBLEMS = {
        missing: 'This file does not exist.',
        'not-on-path': 'No such command on PATH.',
        folder: 'This folder has no g++ in it.'
    };

    /**
     * Renders the g++ path setting like an XAE Shell row: the configured path; when it is empty, the
     * g++ a build would use (detected, not written) or "not found"; a warning when a set value is unusable
     * or the g++ is older than 7; and, when no usable g++ was found but MSYS2 is installed without one
     * (`msys2Root`, src/msys2Detect.js), the package to install there.
     * @param {{state: string, configured: string, path: string, source?: string, problem?: string, version?: string, tooOld?: boolean,
     *   msys2Root?: string}|undefined} g
     */
    function renderGpp(g) {
        const list = $('gpp-list');
        list.textContent = '';
        if (!g || typeof g.state !== 'string') return;
        const li = document.createElement('li');
        // A g++ older than 7 (src/gpp.js GPP_MIN_MAJOR) is shown like a missing file: the build will not run it.
        const tooOld = (g.state === 'set' || g.state === 'detected') && g.tooOld === true;
        const invalid = g.state === 'invalid' || tooOld;
        const unset = g.state === 'notFound';
        li.className = 'xae-row' + (invalid ? ' missing' : '') + (unset ? ' unset' : '') + (g.state === 'detected' ? ' detected' : '');
        li.setAttribute('data-gpp', g.state);
        const label = document.createElement('span');
        label.className = 'xae-version';
        label.textContent = 'g++:';
        const where = document.createElement('span');
        where.className = 'xae-path';
        where.textContent = g.state === 'detected' ? g.path : (g.configured || 'not found');
        li.append(label, where);
        let note = '';
        if (g.state === 'detected') {
            const foundAt = g.source === 'default' ? 'in a usual install folder' : 'on PATH';
            // A too-old g++ is found but never run (compileCommands.js status 'too-old').
            note = tooOld ? 'Not set: found ' + foundAt + ', but a build will not use it.' : 'Not set: a build uses this one, found ' + foundAt + '.';
        } else if (g.state === 'set' && g.path && g.path !== g.configured) {
            note = 'Runs ' + g.path;
        }
        if (note) {
            const n = document.createElement('span');
            n.className = 'xae-note';
            n.textContent = note;
            li.append(n);
        }
        if (invalid) {
            const warning = document.createElement('span');
            warning.className = 'xae-warning';
            warning.textContent = tooOld
                ? 'g++ ' + (typeof g.version === 'string' && g.version ? g.version : '') + ' is too old: needs 7 or later.'
                : (GPP_PROBLEMS[g.problem] || GPP_PROBLEMS.missing);
            li.append(warning);
        }
        if ((unset || (tooOld && g.state === 'detected')) && typeof g.msys2Root === 'string' && g.msys2Root) {
            const msys = document.createElement('span');
            msys.className = 'xae-note gpp-msys2';
            msys.textContent = 'MSYS2 is installed at ' + g.msys2Root + ' but has no g++: in the MSYS2 UCRT64 shell run pacman -S mingw-w64-ucrt-x86_64-gcc';
            li.append(msys);
        }
        list.append(li);
    }

    /**
     * The Compile project tile. The compiler ships with the extension, so it is an ordinary project
     * action; only a compiler setting that names a missing file disables it, and the tile says so.
     * A missing Node.js is not known here: the command explains it when the tile is clicked.
     * @param {boolean} ready The compiler file exists.
     * @param {boolean} hasProject A PLC project is open.
     */
    let compileReady = true;
    function renderCompileTile(ready, hasProject) {
        const tile = $('compile-project');
        compileReady = ready;
        tile.disabled = !(ready && hasProject);
        tile.classList.toggle('ready', ready);
        tile.title = ready ? '' : 'The compiler file named in the Compile Project settings does not exist';
        describeCompileTile();
        $('compile-missing').hidden = ready;
    }
    /** The tile's detail says what a click does with the current options (the checkboxes). */
    function describeCompileTile() {
        const cpp = $('opt-generate-cpp').checked;
        const gpp = $('opt-build-gpp').checked;
        $('compile-detail').textContent = !compileReady
            ? 'Compiler file not found — check the compiler setting'
            : (gpp ? 'Check the project, write it as C++ into CPP_Files and build that with g++'
                : (cpp ? 'Check the project, then write it as C++ into CPP_Files'
                    : 'Check the project with the IEC 61131-3 compiler'));
    }
    $('compile-project').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'twincat.compileProject' }));

    // The Compile dropdown (R13): two checkboxes that show and write the C++ settings. The host writes
    // them (with their coupling: the g++ build needs the C++) and sends the result back in `state`.
    const optionsToggle = $('compile-options-toggle');
    const optionsPanel = $('compile-options');
    const optGenerate = $('opt-generate-cpp');
    const optBuild = $('opt-build-gpp');
    function setOptionsOpen(open, focusToggle) {
        optionsPanel.hidden = !open;
        optionsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        optionsToggle.classList.toggle('open', open);
        if (open) optGenerate.focus();
        else if (focusToggle) optionsToggle.focus();
    }
    optionsToggle.addEventListener('click', () => setOptionsOpen(optionsPanel.hidden, false));
    optionsPanel.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); setOptionsOpen(false, true); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            // Every visible, enabled control of the panel, in order (the XAE part only when shown).
            e.preventDefault();
            const items = Array.from(optionsPanel.querySelectorAll('input, button')).filter(el => !el.disabled && !el.closest('[hidden]'));
            const at = items.indexOf(document.activeElement);
            // Focus outside the items (on the panel itself): Down goes to the first, Up to the last.
            const next = at < 0 ? items[e.key === 'ArrowDown' ? 0 : items.length - 1]
                : items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
            if (next) next.focus();
        }
    });
    // Build through XAE (R14): the two actions run their commands (data-command); the checkbox writes
    // tcToolkit.xaeBuild.showWindow through the host, which answers with `state`.
    const optXaeWindow = $('opt-xae-window');
    /**
     * @param {{available?: boolean, showWindow?: boolean, running?: boolean, configuration?: string, platform?: string}} o
     * @param {boolean} hasProject The two actions also need an open PLC project (like data-needs-project).
     */
    function renderXaeOptions(o, hasProject) {
        $('xae-options').hidden = !(o && o.available);
        optXaeWindow.checked = !!(o && o.showWindow);
        $('xae-build-run').disabled = !!(o && o.running) || !hasProject;
        $('xae-activate-run').disabled = !!(o && o.running) || !hasProject;
        optionsToggle.title = o && o.available
            ? 'Compile options: C++ generation, the g++ build and the XAE build'
            : 'Compile options: C++ generation and the g++ build';
        $('xae-build-mode').textContent = `${o && o.showWindow ? 'window shown' : 'headless'}; ` +
            `${(o && o.configuration) || 'Release'} | ${(o && o.platform) || 'TwinCAT RT (x64)'}` +
            (o && o.available === false ? ' (needs Windows with TwinCAT XAE)' : '');
    }
    optXaeWindow.addEventListener('change', () => vscode.postMessage({ type: 'setXaeOption', key: 'showWindow', value: optXaeWindow.checked }));
    /** @param {{generateCpp?: boolean, buildWithGpp?: boolean}} o */
    function renderCompileOptions(o) {
        optGenerate.checked = !!(o && (o.generateCpp || o.buildWithGpp));
        optBuild.checked = !!(o && o.buildWithGpp);
        describeCompileTile();
    }
    for (const [box, key] of [[optGenerate, 'generateCpp'], [optBuild, 'buildWithGpp']]) {
        box.addEventListener('change', () => {
            // Shown at once; the host's `state` confirms (or corrects) it.
            if (key === 'buildWithGpp' && box.checked) optGenerate.checked = true;
            if (key === 'generateCpp' && !box.checked) optBuild.checked = false;
            describeCompileTile();
            vscode.postMessage({ type: 'setCompileOption', key, value: box.checked });
        });
    }

    window.addEventListener('message', (event) => {
        const msg = event.data || {};
        switch (msg.type) {
            case 'state':
                if (msg.sep) sep = msg.sep;
                if (msg.location && !locationInput.value) locationInput.value = msg.location;
                lastRecents = Array.isArray(msg.recents) ? msg.recents : [];
                if (typeof msg.recentsShown === 'number' && msg.recentsShown >= 1) recentsShown = Math.floor(msg.recentsShown);
                renderRecents();
                renderXaeShells(Array.isArray(msg.xaeShells) ? msg.xaeShells : []);
                renderGpp(msg.gpp);
                $('no-project').hidden = !!msg.hasProject;
                for (const b of document.querySelectorAll('[data-needs-project]')) b.disabled = !msg.hasProject;
                renderCompileTile(!!msg.compilerReady, !!msg.hasProject);
                renderCompileOptions(msg.compileOptions);
                renderXaeOptions(msg.xaeOptions, !!msg.hasProject);
                refresh();
                break;
            case 'location':
                if (msg.location) locationInput.value = msg.location;
                createError.hidden = true;
                refresh();
                break;
            case 'createResult':
                busy = false;
                createBtn.textContent = 'Create';
                if (!msg.ok) {
                    createError.textContent = msg.error || 'The project could not be created.';
                    createError.hidden = false;
                } else {
                    // Created: start the next one from a clean name (the same one would be refused).
                    nameInput.value = '';
                    nameTouched = false;
                }
                refresh();
                break;
        }
    });

    refresh();
    vscode.postMessage({ type: 'ready' });
}());
