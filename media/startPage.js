/**
 * @file media/startPage.js
 * @description The start page's script (webview side). Validates the project name as the user types
 * with the same rules the host applies (media/projectName.js), and turns every button into a message
 * for the extension host (src/startPage.js), which does the real work — the page itself never touches
 * the file system, the network or a command directly.
 *
 * Messages to the host:  ready · browseLocation · create {version, name, location} · openProject ·
 *                        openRecent {slnPath} · removeRecent {slnPath} · command {command} · link {id}
 * Messages from the host: state {location, sep, recents, hasProject} · location {location} ·
 *                         createResult {ok, error?}
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

    /**
     * @param {Array<{slnPath: string, name: string}>} recents
     */
    function renderRecents(recents) {
        const list = $('recent-list');
        list.textContent = '';
        for (const r of recents || []) {
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
        $('recent-empty').hidden = (recents || []).length > 0;
    }

    window.addEventListener('message', (event) => {
        const msg = event.data || {};
        switch (msg.type) {
            case 'state':
                if (msg.sep) sep = msg.sep;
                if (msg.location && !locationInput.value) locationInput.value = msg.location;
                renderRecents(msg.recents);
                $('no-project').hidden = !!msg.hasProject;
                for (const b of document.querySelectorAll('[data-needs-project]')) b.disabled = !msg.hasProject;
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
