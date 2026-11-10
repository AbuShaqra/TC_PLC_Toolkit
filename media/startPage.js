/**
 * @file media/startPage.js
 * @description The start page's script (webview side). Validates the project name as the user types
 * with the same rules the host applies (media/projectName.js), and turns every button into a message
 * for the extension host (src/startPage.js), which does the real work — the page itself never touches
 * the file system, the network or a command directly.
 *
 * Messages to the host:  ready · browseLocation · create {version, name, location} · openProject ·
 *                        openRecent {slnPath} · removeRecent {slnPath} · command {command} · link {id} ·
 *                        openSettings {section}
 * Messages from the host: state {location, sep, recents, recentsShown, hasProject, compilerReady, xaeShells} ·
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

    /**
     * The Compile project tile. Without a configured compiler it stays as it shipped: disabled,
     * "Coming in a later release". With one it is an ordinary project action.
     * @param {boolean} ready A compiler is configured and its file exists.
     * @param {boolean} hasProject A PLC project is open.
     */
    function renderCompileTile(ready, hasProject) {
        const tile = $('compile-project');
        tile.disabled = !(ready && hasProject);
        tile.classList.toggle('ready', ready);
        tile.title = ready ? '' : 'Arrives in a later release';
        $('compile-detail').textContent = ready
            ? 'Check the project with an external IEC 61131-3 compiler'
            : 'Coming in a later release';
        $('compile-soon').hidden = ready;
    }
    $('compile-project').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'twincat.compileProject' }));

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
                $('no-project').hidden = !!msg.hasProject;
                for (const b of document.querySelectorAll('[data-needs-project]')) b.disabled = !msg.hasProject;
                renderCompileTile(!!msg.compilerReady, !!msg.hasProject);
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
