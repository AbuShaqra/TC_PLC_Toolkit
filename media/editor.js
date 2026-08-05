(function() {
    const vscode = acquireVsCodeApi();

    // Global Error Listener for Webview Debugging
    window.addEventListener('error', event => {
        const overlay = document.getElementById('error-overlay');
        if (overlay) {
            overlay.style.display = 'block';
            overlay.innerHTML = `<h3>Webview Runtime Failure</h3>
            <p><b>Message:</b> ${event.message}</p>
            <p><b>File:</b> ${event.filename}</p>
            <p><b>Position:</b> Line ${event.lineno}, Column ${event.colno}</p>
            <pre style="background: rgba(0, 0, 0, 0.4); padding: 12px; border-radius: 4px; overflow: auto; border: 1px solid rgba(255,255,255,0.1);">${event.error ? event.error.stack : ''}</pre>`;
        }
        vscode.postMessage({
            type: 'error',
            message: event.message,
            error: event.error ? event.error.stack : null
        });
    });

    let components = [];
    let activeComponentId = null;
    let typesMap = {};
    let declEditor = null;
    let implEditor = null;
    // The pane the user was last typing in. Needed because an insert can arrive from the Explorer
    // (the "TwinCAT Libraries" view), and clicking a tree item pulls DOM focus out of the webview:
    // Monaco keeps each pane's selection, but only this tells us which pane the caret belongs to.
    let lastFocusedEditor = null;
    let isUpdatingFromExtension = false;
    let debounceTimer = null;
    let currentDeclPct = 50;

    let isAutoSync = true;
    let pendingEdits = {}; // key -> { context, blockType, content }
    let activeFileUri = '';
    const pendingRequests = new Map();

    function sendBridgeRequest(type, params) {
        const requestId = Math.random().toString(36).substring(2);
        return new Promise((resolve) => {
            pendingRequests.set(requestId, resolve);
            vscode.postMessage({
                type: type,
                requestId: requestId,
                fileUri: activeFileUri,
                ...params
            });
        });
    }

    let diagDebounceTimer = null;
    function updateDiagnostics() {
        if (!declEditor || !implEditor || !activeFileUri || !window.monaco) return;
        clearTimeout(diagDebounceTimer);
        diagDebounceTimer = setTimeout(async () => {
            // Diagnostics run against the whole document (assembled in the extension); results
            // come back already mapped to { componentId, pane, range } per component.
            const declVal = paneDeclEl.style.display !== 'none' ? declEditor.getValue() : undefined;
            const implVal = paneImplEl.style.display !== 'none' ? implEditor.getValue() : undefined;

            const requestedComponentId = activeComponentId;
            const diags = await sendBridgeRequest('custom/diagnostics', {
                componentId: requestedComponentId,
                decl: declVal,
                impl: implVal
            });

            // Ignore stale responses if the user switched components meanwhile.
            if (requestedComponentId !== activeComponentId) return;

            const declMarkers = [];
            const implMarkers = [];

            (diags || []).forEach(d => {
                if (d.componentId !== activeComponentId) return;
                const marker = {
                    severity: d.severity === 1 ? monaco.MarkerSeverity.Error
                        : (d.severity === 2 ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info),
                    message: d.message,
                    startLineNumber: d.range.startLineNumber,
                    startColumn: d.range.startColumn,
                    endLineNumber: d.range.endLineNumber,
                    endColumn: d.range.endColumn
                };
                if (d.pane === 'declaration') declMarkers.push(marker);
                else implMarkers.push(marker);
            });

            if (paneDeclEl.style.display !== 'none') {
                monaco.editor.setModelMarkers(declEditor.getModel(), 'st-validator', declMarkers);
            }
            if (paneImplEl.style.display !== 'none') {
                monaco.editor.setModelMarkers(implEditor.getModel(), 'st-validator', implMarkers);
            }
        }, 300);
    }

    // Initialize DOM references
    const objTypeEl = document.getElementById('obj-type');
    const objNameEl = document.getElementById('obj-name');
    const selectEl = document.getElementById('component-select');
    const statusEl = document.getElementById('save-status');
    
    const containerEl = document.getElementById('editor-container');
    const paneDeclEl = document.getElementById('pane-decl');
    const paneImplEl = document.getElementById('pane-impl');
    const splitterEl = document.getElementById('pane-splitter');

    const toggleEl = document.getElementById('sync-mode-toggle');
    const toggleWrapper = document.getElementById('sync-toggle-wrapper');
    const toggleText = document.getElementById('sync-mode-text');

    // Toggle logic
    toggleEl.addEventListener('change', () => {
        isAutoSync = toggleEl.checked;
        if (isAutoSync) {
            toggleWrapper.classList.add('active');
            toggleText.textContent = 'Auto Sync';
            flushPendingEdits();
        } else {
            toggleWrapper.classList.remove('active');
            toggleText.textContent = 'Manual Sync';
            updateStatusText();
        }
        vscode.postMessage({
            type: 'toggleSyncMode',
            isAutoSync: isAutoSync
        });
    });

    const generateBtn = document.getElementById('generate-st-btn');
    if (generateBtn) {
        generateBtn.addEventListener('click', () => {
            vscode.postMessage({
                type: 'generate-st'
            });
        });
    }

    function updateStatusText() {
        const pendingCount = Object.keys(pendingEdits).length;
        if (pendingCount > 0) {
            statusEl.textContent = `Unsaved Changes (${pendingCount})`;
            statusEl.className = 'status-indicator modified';
        } else {
            statusEl.textContent = 'Synced';
            statusEl.className = 'status-indicator';
        }
    }

    function flushPendingEdits() {
        const edits = Object.values(pendingEdits);
        if (edits.length > 0) {
            statusEl.textContent = 'Saving...';
            statusEl.className = 'status-indicator modified';
            vscode.postMessage({
                type: 'sync-pending',
                edits: edits
            });
            pendingEdits = {};
        }
        updateStatusText();
    }

    function triggerManualSave() {
        const edits = Object.values(pendingEdits);
        statusEl.textContent = 'Saving...';
        statusEl.className = 'status-indicator modified';
        vscode.postMessage({
            type: 'save',
            edits: edits
        });
        pendingEdits = {};
        updateStatusText();
    }

    // Capture global Ctrl+S / Cmd+S key events
    window.addEventListener('keydown', e => {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const isSaveKey = isMac ? (e.metaKey && e.key.toLowerCase() === 's') : (e.ctrlKey && e.key.toLowerCase() === 's');
        if (isSaveKey) {
            e.preventDefault();
            triggerManualSave();
        }
    });

    // Handle Editor Changes
    function onEditorChange(editor, blockType) {
        if (isUpdatingFromExtension || !activeComponentId) return;
        updateDiagnostics();

        const val = editor.getValue();
        const activeComp = components.find(c => c.id === activeComponentId);
        if (!activeComp) return;

        if (blockType === 'Declaration' && activeComp.declaration === val) return;
        if (blockType === 'ST' && activeComp.implementation === val) return;

        if (blockType === 'Declaration') {
            activeComp.declaration = val;
        } else {
            activeComp.implementation = val;
        }

        if (isAutoSync) {
            statusEl.textContent = 'Saving...';
            statusEl.className = 'status-indicator modified';

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                vscode.postMessage({
                    type: 'edit',
                    context: activeComp.xmlContext,
                    blockType: blockType,
                    content: val
                });
            }, 200);
        } else {
            const key = `${activeComponentId}_${blockType}`;
            pendingEdits[key] = {
                context: activeComp.xmlContext,
                blockType: blockType,
                content: val
            };
            updateStatusText();
            vscode.postMessage({
                type: 'updatePendingEdits',
                pendingEdits: pendingEdits
            });
        }
    }

    // Build the LSP bridge payload describing the active component and cursor position.
    // The extension assembles the full document ST and maps this local position to the unit.
    function buildBridgeContext(model, position) {
        const isDecl = declEditor && model === declEditor.getModel();
        const declVal = (declEditor && paneDeclEl.style.display !== 'none') ? declEditor.getValue() : undefined;
        const implVal = (implEditor && paneImplEl.style.display !== 'none') ? implEditor.getValue() : undefined;
        return {
            componentId: activeComponentId,
            pane: isDecl ? 'decl' : 'impl',
            position: { lineNumber: position.lineNumber, column: position.column },
            decl: declVal,
            impl: implVal
        };
    }

    /**
     * The pane an Explorer-initiated insert should go into: the last one the user focused, unless it
     * is currently collapsed (a DUT shows no implementation pane, a GVL no declaration pane — the
     * panes carry `display: none` then, exactly as every other pane-aware path here checks).
     * Falls back to the implementation pane, which is where code is written.
     * @returns {Object|null} A Monaco editor, or null when neither pane is usable.
     */
    function insertTargetEditor() {
        const isVisible = (ed) => {
            if (!ed) return false;
            const paneEl = (ed === declEditor) ? paneDeclEl : paneImplEl;
            return paneEl.style.display !== 'none';
        };
        if (isVisible(lastFocusedEditor)) return lastFocusedEditor;
        if (isVisible(implEditor)) return implEditor;
        if (isVisible(declEditor)) return declEditor;
        return null;
    }

    /**
     * Inserts text at the caret of the active pane, replacing the selection if there is one.
     *
     * executeEdits fires onDidChangeModelContent, so the existing onEditorChange pipeline marks the
     * edit pending (or auto-saves) and dirties the document — the insert needs no change notification
     * of its own.
     * @param {string} text Text to insert.
     * @param {boolean} triggerSuggest Open the completion list afterwards (a `Namespace.` insert does).
     */
    function insertTextAtCursor(text, triggerSuggest) {
        const editor = insertTargetEditor();
        if (!editor || !text) return;
        const selection = editor.getSelection();
        if (!selection) return;
        // forceMoveMarkers pushes the caret to the end of the inserted text, so a follow-up suggest
        // fires at the position the user expects (right after the dot).
        editor.executeEdits('twincat-library-insert', [{
            range: selection,
            text: text,
            forceMoveMarkers: true
        }]);
        editor.focus();
        if (triggerSuggest) {
            editor.trigger('twincat', 'editor.action.triggerSuggest', {});
        }
    }

    // Wait for Monaco to load
    window.monacoReady.then(monaco => {
        // Register custom language for Structured Text (ST)
        monaco.languages.register({ id: 'iecst' });

        monaco.languages.setLanguageConfiguration('iecst', {
            comments: {
                lineComment: '//',
                blockComment: ['(*', '*)']
            },
            brackets: [
                ['[', ']'],
                ['(', ')']
            ],
            autoClosingPairs: [
                { open: '[', close: ']' },
                { open: '(', close: ')' },
                { open: "'", close: "'" },
                { open: '"', close: '"' }
            ],
            surroundingPairs: [
                { open: '[', close: ']' },
                { open: '(', close: ')' },
                { open: "'", close: "'" },
                { open: '"', close: '"' }
            ]
        });

        // Monaco Monarch highlighter configuration
        monaco.languages.setMonarchTokensProvider('iecst', {
            defaultToken: '',
            tokenPostfix: '.iecst',
            ignoreCase: true, // Structured Text is case-insensitive (if/IF/If all highlight)

            keywords: [
                'VAR', 'END_VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 
                'VAR_GLOBAL', 'VAR_TEMP', 'VAR_STAT', 'VAR_EXTERNAL',
                'CONSTANT', 'RETAIN', 'PERSISTENT',
                'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
                'CASE', 'OF', 'END_CASE',
                'FOR', 'TO', 'BY', 'DO', 'END_FOR',
                'WHILE', 'END_WHILE',
                'REPEAT', 'UNTIL', 'END_REPEAT',
                'PROGRAM', 'FUNCTION_BLOCK', 'FUNCTION', 
                'TYPE', 'STRUCT', 'END_STRUCT', 
                'INTERFACE', 'END_INTERFACE', 'IMPLEMENTS', 'EXTENDS',
                'AND', 'OR', 'XOR', 'NOT', 'MOD',
                'TRUE', 'FALSE', 'NULL', 'RETURN', 'EXIT'
            ],

            typeKeywords: [
                'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
                'SINT', 'USINT', 'INT', 'UINT', 'DINT', 'UDINT', 'LINT', 'ULINT',
                'REAL', 'LREAL',
                'TIME', 'DATE', 'TOD', 'DT', 'LTIME',
                'STRING', 'WSTRING', 'ARRAY', 'POINTER', 'REFERENCE'
            ],

            operators: [
                ':=', '=', '<>', '<=', '>=', '<', '>', '+', '-', '*', '/', '^'
            ],

            symbols: /[=><!~?:&|+\-*\/\^%]+/,
            escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

            tokenizer: {
                root: [
                    [/[a-zA-Z_][a-zA-Z0-9_]*/, {
                        cases: {
                            '@keywords': 'keyword',
                            '@typeKeywords': 'type',
                            '@default': 'identifier'
                        }
                    }],

                    { include: '@whitespace' },

                    // Pragmas and attributes — {region "Motion FB's"}, {attribute 'qualified_only'},
                    // {IF ...} — are metadata, not code, and must be consumed whole.
                    //
                    // Consuming them whole is not cosmetic. ST strings are single-quoted, so without
                    // this the apostrophe in `{region "Motion FB's"}` opened the @string state and
                    // every following line stayed string-scoped until the next quote in the document.
                    // Monaco's default quickSuggestions ({other: on, strings: off}) then switched
                    // IntelliSense off for the whole VAR block below the region. The second rule keeps
                    // a half-typed pragma on its own line, so completion does not die as you type it.
                    [/\{[^}]*\}/, 'annotation'],
                    [/\{[^}]*$/, 'annotation'],

                    [/[{}()\[\]]/, '@brackets'],
                    [/@symbols/, {
                        cases: {
                            '@operators': 'operator',
                            '@default': ''
                        }
                    }],

                    [/\d*\.\d+([eE][\-+]?\d+)?/, 'number.float'],
                    [/16#[0-9a-fA-F]+/, 'number.hex'],
                    [/\d+#\d+/, 'number.other'],
                    [/\d+/, 'number'],

                    [/[;,.]/, 'delimiter'],

                    [/'/, { token: 'string.quote', bracket: '@open', next: '@string' }],
                ],

                string: [
                    [/[^\\']+/, 'string'],
                    [/@escapes/, 'string.escape'],
                    [/\\./, 'string.escape.invalid'],
                    [/'/, { token: 'string.quote', bracket: '@close', next: '@pop' }]
                ],

                whitespace: [
                    [/[ \t\r\n]+/, 'white'],
                    [/\(\*/, 'comment', '@comment_block1'],
                    [/\/\*/, 'comment', '@comment_block2'],
                    [/\/\/.*$/, 'comment'],
                ],

                comment_block1: [
                    [/[^\*]+/, 'comment'],
                    [/\*\)/, 'comment', '@pop'],
                    [/\*/, 'comment']
                ],

                comment_block2: [
                    [/[^\*]+/, 'comment'],
                    [/\*\//, 'comment', '@pop'],
                    [/\*/, 'comment']
                ],
            },
        });

        // Register Completion Item Provider (Intellisense)
        monaco.languages.registerCompletionItemProvider('iecst', {
            triggerCharacters: ['.'],
            provideCompletionItems: async function(model, position) {
                const word = model.getWordUntilPosition(position);
                const range = {
                    startLineNumber: position.lineNumber,
                    endLineNumber: position.lineNumber,
                    startColumn: word.startColumn,
                    endColumn: word.endColumn
                };

                const suggestions = await sendBridgeRequest('custom/completions', buildBridgeContext(model, position));

                const mapped = (suggestions || []).map(s => ({
                    label: s.label,
                    kind: s.kind,
                    insertText: s.insertText || s.label,
                    insertTextRules: s.insertTextRules || 0,
                    detail: s.detail || '',
                    sortText: s.sortText,
                    range: range
                }));

                return { suggestions: mapped };
            }
        });

        // Register Definition Provider (Go to Definition)
        //
        // This is a PURE lookup: it computes a Location and returns it, and must never navigate.
        // Monaco calls definition providers speculatively (word selection, the ctrl-hover
        // definition link, its internal goto-location machinery), so navigating as a side effect
        // here made a plain double-click jump to the definition. Monaco decides when to navigate;
        // the editor opener registered below performs the jumps Monaco cannot do on its own.
        monaco.languages.registerDefinitionProvider('iecst', {
            provideDefinition: async function(model, position) {
                const word = model.getWordAtPosition(position);
                if (!word) return null;

                const def = await sendBridgeRequest('custom/definition', buildBridgeContext(model, position));
                if (!def) return null;

                const targetWord = def.targetWord || word.word;
                const targetCompId = def.componentId || 'root';
                const isSameFile = def.uri && activeFileUri &&
                    def.uri.toLowerCase() === activeFileUri.toLowerCase();

                // Target inside the component that is already loaded: resolve it against the live
                // pane models so Monaco gets a real Location (which also feeds the ctrl-hover
                // preview). Declaration pane first — a variable's declaration always outranks its
                // usages in the implementation.
                if (isSameFile && targetCompId === activeComponentId) {
                    const hit = findWordInPanes(targetWord);
                    if (hit && hit.model === model) {
                        return { uri: model.uri, range: hit.range };
                    }
                    if (hit) {
                        // Sibling pane: the editor opener below does the jump, because Monaco's
                        // standalone handler only ever reveals inside the editor the action came
                        // from. Report a *collapsed* range: Monaco paints its 350 ms symbol
                        // highlight on that source editor using the range we return, so a full
                        // word range would flash a stray highlight in the pane the user just
                        // left. The opener widens it back to the whole word in the target pane.
                        return {
                            uri: hit.model.uri,
                            range: new monaco.Range(hit.range.startLineNumber, hit.range.startColumn,
                                hit.range.startLineNumber, hit.range.startColumn)
                        };
                    }
                }

                // Other component / other file: nothing here is backed by a Monaco model, so hand
                // back a synthetic location that says where to go (see GOTO_SCHEME).
                return {
                    uri: encodeGotoUri(def, targetWord),
                    range: new monaco.Range(1, 1, 1, 1)
                };
            }
        });

        // Perform the navigation for locations Monaco cannot open by itself: our synthetic
        // 'twincat:' targets, and models that live in the *other* pane of this webview (Monaco's
        // standalone handler only reveals inside the editor the action started from). Returning
        // false hands the location back to Monaco's built-in handler, which is what we want for a
        // target in the source pane's own model.
        if (typeof monaco.editor.registerEditorOpener === 'function') {
            monaco.editor.registerEditorOpener({
                openCodeEditor: function(source, resource, selectionOrPosition) {
                    if (resource.scheme === GOTO_SCHEME) {
                        openGotoTarget(decodeGotoUri(resource));
                        return true;
                    }
                    const ed = editorForModelUri(resource);
                    if (ed && ed !== source) {
                        const range = wordRangeAt(ed.getModel(), toRange(selectionOrPosition));
                        if (range) {
                            ed.setSelection(range);
                            ed.revealRangeInCenter(range);
                        }
                        ed.focus();
                        return true;
                    }
                    return false;
                }
            });
        } else {
            // Fail safe: without the opener, definitions outside the current pane simply do
            // nothing (no crash, no rogue navigation).
            console.error('[TwinCAT XML Viewer] monaco.editor.registerEditorOpener is unavailable; ' +
                'Go to Definition cannot navigate outside the current pane.');
        }

        // Register Reference Provider (Find References)
        monaco.languages.registerReferenceProvider('iecst', {
            provideReferences: async function(model, position) {
                const refs = await sendBridgeRequest('custom/references', buildBridgeContext(model, position));
                if (!refs) return [];
                // Only return locations backed by a live Monaco model (the active component's visible
                // panes). Returning a URI without a loaded model crashes Monaco's peek widget
                // ("Model not found"). Cross-file / other-component references are surfaced separately.
                const locations = [];
                for (const ref of refs) {
                    if (!ref.sameFile) continue;
                    if (ref.componentId !== activeComponentId) continue;
                    let ed = null;
                    if (ref.pane === 'decl' && paneDeclEl.style.display !== 'none') ed = declEditor;
                    else if (ref.pane === 'impl' && paneImplEl.style.display !== 'none') ed = implEditor;
                    if (!ed) continue;
                    const m = ed.getModel();
                    if (!m) continue;
                    locations.push({
                        uri: m.uri,
                        range: {
                            startLineNumber: ref.line + 1,
                            startColumn: ref.startCharacter + 1,
                            endLineNumber: ref.line + 1,
                            endColumn: ref.endCharacter + 1
                        }
                    });
                }
                // Always populate the "TwinCAT References" panel with the FULL result set, independent of
                // the peek. The peek (`locations` above) can only render hits in the active component's
                // visible panes, so without this the panel stayed empty whenever every hit was local —
                // which is the inconsistency being fixed. (This is the extra queryReferences pass noted in
                // HANDOFF; ~8 ms warm, and it is what the extension turns into the panel's item list.)
                vscode.postMessage({
                    type: 'showExternalReferences',
                    fileUri: activeFileUri,
                    componentId: activeComponentId,
                    pane: (model === declEditor.getModel()) ? 'decl' : 'impl',
                    position: { lineNumber: position.lineNumber, column: position.column }
                });
                return locations;
            }
        });

        // Initialize Monaco editors
        const editorOptions = {
            value: '',
            language: 'iecst',
            theme: 'vs-dark',
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            smoothScrolling: false,
            mouseWheelScrollSensitivity: 1.5,
            scrollbar: {
                useShadows: false,
                verticalScrollbarSize: 14,
                horizontalScrollbarSize: 14
            },
            fontSize: 13,
            fontFamily: "Consolas, 'Courier New', monospace",
            lineHeight: 19,
            tabSize: 4,
            insertSpaces: true,
            // Render context menu / suggest / hover widgets so they escape the panes'
            // `overflow: hidden`, otherwise they get cropped near a pane edge.
            fixedOverflowWidgets: true,
            gotoLocation: {
                // Monaco's default is to fall back to "Find All References" when Go to Definition
                // is invoked while the cursor already sits on the definition. Keep F12 meaning
                // exactly one thing here: navigate, or do nothing.
                alternativeDefinitionCommand: ''
            }
        };

        declEditor = monaco.editor.create(document.getElementById('editor-decl-container'), editorOptions);
        implEditor = monaco.editor.create(document.getElementById('editor-impl-container'), editorOptions);

        // Bind commands
        declEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => triggerManualSave());
        implEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => triggerManualSave());

        // Event hooks
        declEditor.onDidChangeModelContent(() => onEditorChange(declEditor, 'Declaration'));
        implEditor.onDidChangeModelContent(() => onEditorChange(implEditor, 'ST'));

        // Remember the pane the caret is in (see lastFocusedEditor). Both events are hooked: the
        // text one covers typing, the widget one covers a click that lands on the pane's gutter or
        // scrollbar without focusing the text area.
        declEditor.onDidFocusEditorText(() => { lastFocusedEditor = declEditor; });
        declEditor.onDidFocusEditorWidget(() => { lastFocusedEditor = declEditor; });
        implEditor.onDidFocusEditorText(() => { lastFocusedEditor = implEditor; });
        implEditor.onDidFocusEditorWidget(() => { lastFocusedEditor = implEditor; });

        // Handle Theme Synchronization Observer
        function syncTheme() {
            let theme = 'vs-dark';
            if (document.body.classList.contains('vscode-light')) {
                theme = 'vs';
            } else if (document.body.classList.contains('vscode-high-contrast')) {
                // VS Code marks a high-contrast LIGHT theme with both classes, so this branch has to
                // check the more specific one first — otherwise an HC-light user got hc-black, a
                // dark editor inside a light window.
                theme = document.body.classList.contains('vscode-high-contrast-light') ? 'hc-light' : 'hc-black';
            }
            monaco.editor.setTheme(theme);
        }
        syncTheme();
        const themeObserver = new MutationObserver(syncTheme);
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

        // Trigger VS Code ready callback
        vscode.postMessage({ type: 'ready' });
    });

    // Handle dropdown selection change
    selectEl.addEventListener('change', (e) => {
        loadComponent(e.target.value);
    });

    // Populate dropdown grouped by Folders
    function populateDropdown() {
        const currentSelected = selectEl.value || activeComponentId || 'root';
        selectEl.innerHTML = '';

        if (components.length <= 1) {
            selectEl.style.display = 'none';
            return;
        }
        selectEl.style.display = 'block';

        const rootComp = components.find(c => c.id === 'root');
        if (rootComp) {
            const opt = document.createElement('option');
            opt.value = rootComp.id;
            opt.textContent = `Main (${rootComp.type}: ${rootComp.name})`;
            selectEl.appendChild(opt);
        }

        const groups = {};
        components.forEach(c => {
            if (c.id === 'root') return;
            const folder = c.folderPath || 'Root / Ungrouped';
            if (!groups[folder]) groups[folder] = [];
            groups[folder].push(c);
        });

        for (const [folder, comps] of Object.entries(groups)) {
            const groupEl = document.createElement('optgroup');
            groupEl.label = folder.replace(/\\$/, '').replace(/\\/g, ' / ');
            
            comps.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id;
                opt.textContent = c.name;
                groupEl.appendChild(opt);
            });
            selectEl.appendChild(groupEl);
        }

        selectEl.value = currentSelected;
    }

    // Resize handlers
    function resizeEditors() {
        if (declEditor) declEditor.layout();
        if (implEditor) implEditor.layout();
    }
    window.addEventListener('resize', resizeEditors);

    // Standard Structured Text word separators so the fallback search matches whole words only
    // (e.g. 'Init' must not land inside 'InitDone'). Matches Monaco's default separator set.
    const WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';

    // ---------------------------------------------------------------------------------------
    // Go to Definition targets
    //
    // A definition can land in another component, another pane or another file — none of which
    // has a Monaco model in this webview. Monaco cannot open such a location itself, so the
    // definition provider encodes the destination into a synthetic URI:
    //
    //     twincat:/goto?file=<fileUri>&component=<id>&word=<name>[&sl=&sc=&el=&ec=]
    //
    // and the editor opener (registered next to the provider) decodes it and does the jump:
    // same file -> loadComponent + highlightTarget; other file -> 'openFile' to the extension.
    // sl/sc/el/ec carry the raw LSP range (0-indexed), which the extension host needs for the
    // generated `.st` navigation branch of `twincat.openComponent`.
    // ---------------------------------------------------------------------------------------
    const GOTO_SCHEME = 'twincat';

    /**
     * Encodes an LSP definition into a synthetic navigation URI.
     * @param {Object} def LSP definition { uri, componentId, range, targetWord }.
     * @param {string} targetWord The word to select once the target is shown.
     * @returns {Object} A monaco.Uri with the GOTO_SCHEME scheme.
     */
    function encodeGotoUri(def, targetWord) {
        const parts = [
            'file=' + encodeURIComponent(def.uri || activeFileUri),
            'component=' + encodeURIComponent(def.componentId || 'root'),
            'word=' + encodeURIComponent(targetWord || '')
        ];
        if (def.range && def.range.start && def.range.end) {
            parts.push('sl=' + def.range.start.line);
            parts.push('sc=' + def.range.start.character);
            parts.push('el=' + def.range.end.line);
            parts.push('ec=' + def.range.end.character);
        }
        return monaco.Uri.from({ scheme: GOTO_SCHEME, path: '/goto', query: parts.join('&') });
    }

    /**
     * Decodes a synthetic navigation URI produced by encodeGotoUri.
     * @param {Object} uri A monaco.Uri.
     * @returns {Object} { fileUri, componentId, targetWord, range } — range is the raw LSP range
     *                   ({ start:{line,character}, end:{...} }) or null when absent.
     */
    function decodeGotoUri(uri) {
        const q = {};
        (uri.query || '').split('&').forEach(pair => {
            if (!pair) return;
            const eq = pair.indexOf('=');
            const key = eq < 0 ? pair : pair.substring(0, eq);
            const val = eq < 0 ? '' : pair.substring(eq + 1);
            q[key] = decodeURIComponent(val);
        });
        const target = {
            fileUri: q.file || '',
            componentId: q.component || 'root',
            targetWord: q.word || '',
            range: null
        };
        if (q.sl !== undefined) {
            target.range = {
                start: { line: Number(q.sl), character: Number(q.sc) },
                end: { line: Number(q.el), character: Number(q.ec) }
            };
        }
        return target;
    }

    /**
     * Navigates to a decoded definition target. Called from the editor opener only — never from
     * the definition provider, which must stay a pure lookup.
     * @param {Object} target Result of decodeGotoUri.
     */
    function openGotoTarget(target) {
        const isSameFile = target.fileUri && activeFileUri &&
            target.fileUri.toLowerCase() === activeFileUri.toLowerCase();

        if (isSameFile) {
            // Another component (or the sibling pane) of the file already open here.
            if (target.componentId && target.componentId !== activeComponentId) {
                loadComponent(target.componentId);
            }
            // Let loadComponent's setValue settle before selecting inside the new models.
            setTimeout(() => highlightTarget(target.targetWord, null), 50);
            return;
        }

        // Different file: the extension host opens it and highlights the target on load.
        vscode.postMessage({
            type: 'openFile',
            fileUri: target.fileUri,
            componentId: target.componentId || 'root',
            range: target.range,
            targetWord: target.targetWord
        });
    }

    /**
     * Returns the editor whose model is identified by a URI, or null.
     * @param {Object} uri A monaco.Uri.
     */
    function editorForModelUri(uri) {
        const key = uri.toString();
        for (const ed of [declEditor, implEditor]) {
            if (!ed) continue;
            const model = ed.getModel();
            if (model && model.uri.toString() === key) return ed;
        }
        return null;
    }

    /**
     * Normalizes what Monaco's editor opener hands us (an IRange or an IPosition) to a Range.
     * @param {Object|undefined} selectionOrPosition
     * @returns {Object|null} A monaco.Range, or null when nothing was supplied.
     */
    function toRange(selectionOrPosition) {
        const s = selectionOrPosition;
        if (!s) return null;
        if (typeof s.endLineNumber === 'number' && typeof s.endColumn === 'number') {
            return new monaco.Range(s.startLineNumber, s.startColumn, s.endLineNumber, s.endColumn);
        }
        if (typeof s.lineNumber === 'number' && typeof s.column === 'number') {
            return new monaco.Range(s.lineNumber, s.column, s.lineNumber, s.column);
        }
        return null;
    }

    /**
     * Widens a collapsed range to the whole word sitting at it. Monaco collapses a definition's
     * range to its start before handing it to the editor opener, so this restores the selection
     * of the whole symbol instead of just placing the caret in front of it.
     * @param {Object} model The target model.
     * @param {Object|null} range A monaco.Range.
     * @returns {Object|null} The widened range, or the input unchanged when it is not collapsed
     *                        or no word sits at its start.
     */
    function wordRangeAt(model, range) {
        if (!model || !range) return range;
        const isCollapsed = range.startLineNumber === range.endLineNumber &&
            range.startColumn === range.endColumn;
        if (!isCollapsed) return range;
        const word = model.getWordAtPosition({ lineNumber: range.startLineNumber, column: range.startColumn });
        if (!word) return range;
        return new monaco.Range(range.startLineNumber, word.startColumn, range.startLineNumber, word.endColumn);
    }

    /**
     * Finds the first whole-word occurrence of a word in the visible panes — declaration pane
     * first, then implementation. Pure lookup: selects, reveals and focuses nothing.
     * @param {string} targetWord The word to look for.
     * @returns {Object|null} { editor, model, range } of the first match, or null.
     */
    function findWordInPanes(targetWord) {
        if (!targetWord) return null;
        const panes = [
            { ed: declEditor, el: paneDeclEl },
            { ed: implEditor, el: paneImplEl }
        ];
        for (const { ed, el } of panes) {
            if (!ed || el.style.display === 'none') continue;
            const model = ed.getModel();
            if (!model) continue;
            const matches = model.findMatches(targetWord, true, false, true, WORD_SEPARATORS, true);
            if (matches && matches.length > 0) {
                return { editor: ed, model: model, range: matches[0].range };
            }
        }
        return null;
    }

    /**
     * Selects and reveals an occurrence of a target word after a component has loaded.
     * When an exact location is supplied (pane + local line + start/end columns) it selects that
     * precise range; if no range is given, or the content at the range no longer matches the target
     * word (stale content), it falls back to a whole-word, case-insensitive search — declaration
     * pane first, then implementation. Consolidates what were two identical findMatches blocks
     * (the 'selectComponent' handler and the 'update' pendingTargetWord block).
     * @param {string} targetWord The word to highlight.
     * @param {Object|null} range Optional { pane, localLine, start:{character}, end:{character} }.
     */
    function highlightTarget(targetWord, range, attempt) {
        attempt = attempt || 0;

        // 1) Exact-location path: pick the pane by name and select the precise range.
        if (range && range.pane && range.localLine != null) {
            const ed = range.pane === 'decl' ? declEditor : implEditor;
            const paneEl = range.pane === 'decl' ? paneDeclEl : paneImplEl;

            // Monaco may not have been created yet when this fires on a freshly opened file. Waiting is
            // right; falling through to the word search would jump to the wrong occurrence.
            if ((!ed || !ed.getModel()) && attempt < 5) {
                setTimeout(() => highlightTarget(targetWord, range, attempt + 1), 40 * (attempt + 1));
                return;
            }

            if (ed && paneEl.style.display !== 'none') {
                const model = ed.getModel();
                if (model) {
                    const lineNumber = Math.min(range.localLine + 1, model.getLineCount());
                    const startColumn = (range.start ? range.start.character : 0) + 1;
                    const endColumn = (range.end ? range.end.character : 0) + 1;
                    const monacoRange = new monaco.Range(lineNumber, startColumn, lineNumber, endColumn);
                    const text = model.getValueInRange(monacoRange);
                    // Trust the range only if the content still matches (guards against stale locations).
                    if (!targetWord || text.toLowerCase() === String(targetWord).toLowerCase()) {
                        ed.setSelection(monacoRange);
                        ed.revealRangeInCenter(monacoRange);
                        ed.focus();
                        vscode.postMessage({ type: 'selectionApplied' });
                        return;
                    }

                    // The content did not match. Nearly always that means the pane has not been
                    // repopulated yet — loadComponent had only just been called — so give it a few
                    // more frames rather than guessing. A single fixed 50 ms wait was the old
                    // behaviour, and losing that race sent the caller straight to the fallback below,
                    // which jumps to the FIRST occurrence of the word: a different reference.
                    if (attempt < 5) {
                        setTimeout(() => highlightTarget(targetWord, range, attempt + 1), 40 * (attempt + 1));
                        return;
                    }

                    // Out of retries but the line is still trustworthy: find the word ON THAT LINE
                    // rather than anywhere in the file. Columns can legitimately shift (an unsaved edit
                    // earlier in the line); the line itself is what the reference identifies.
                    const lineText = model.getLineContent(lineNumber);
                    const col = lineText.toLowerCase().indexOf(String(targetWord || '').toLowerCase());
                    if (targetWord && col !== -1) {
                        const onLine = new monaco.Range(lineNumber, col + 1, lineNumber, col + 1 + targetWord.length);
                        ed.setSelection(onLine);
                        ed.revealRangeInCenter(onLine);
                        ed.focus();
                        vscode.postMessage({ type: 'selectionApplied' });
                        return;
                    }
                }
            }
        }

        // 2) Fallback whole-word search: declaration pane first, then implementation. This lands on the
        //    first occurrence, so it is a last resort — it is right only when the caller gave us no
        //    location at all.
        const hit = findWordInPanes(targetWord);
        if (hit) {
            hit.editor.setSelection(hit.range);
            hit.editor.revealRangeInCenter(hit.range);
            hit.editor.focus();
            vscode.postMessage({ type: 'selectionApplied' });
        }
    }

    // Load component details into the editors
    function loadComponent(id) {
        const comp = components.find(c => c.id === id);
        if (!comp) return;

        activeComponentId = id;
        selectEl.value = id;

        isUpdatingFromExtension = true;

        if (declEditor) {
            declEditor.setValue(comp.declaration || '');
        }
        
        if (comp.type === 'Action') {
            paneDeclEl.style.display = 'none';
            splitterEl.style.display = 'none';
            paneImplEl.style.display = 'flex';
            paneImplEl.style.flex = '1 1 100%';
            
            if (implEditor) {
                implEditor.setValue(comp.implementation || '');
            }
        } else if (comp.implementation !== null) {
            paneDeclEl.style.display = 'flex';
            paneImplEl.style.display = 'flex';
            splitterEl.style.display = 'block';
            
            const implPct = 100 - currentDeclPct;
            paneDeclEl.style.flex = `${currentDeclPct} ${currentDeclPct} 0%`;
            paneImplEl.style.flex = `${implPct} ${implPct} 0%`;
            
            if (implEditor) {
                implEditor.setValue(comp.implementation);
            }
        } else {
            paneDeclEl.style.display = 'flex';
            paneImplEl.style.display = 'none';
            splitterEl.style.display = 'none';
            paneDeclEl.style.flex = '1 1 100%';
        }

        updateDiagnostics();

        isUpdatingFromExtension = false;

        // Force refreshes
        setTimeout(resizeEditors, 10);
    }

    // Splitter Drag Resizing
    let isDragging = false;
    let animationFrameId = null;
    splitterEl.addEventListener('mousedown', function(e) {
        isDragging = true;
        splitterEl.classList.add('dragging');
        document.body.style.cursor = 'row-resize';
        e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
        if (!isDragging) return;

        const containerRect = containerEl.getBoundingClientRect();
        const topY = e.clientY - containerRect.top;
        const totalHeight = containerRect.height;
        
        let declPct = (topY / totalHeight) * 100;
        declPct = Math.max(10, Math.min(90, declPct));
        const implPct = 100 - declPct;

        currentDeclPct = declPct;

        paneDeclEl.style.flex = `${declPct} ${declPct} 0%`;
        paneImplEl.style.flex = `${implPct} ${implPct} 0%`;

        if (!animationFrameId) {
            animationFrameId = requestAnimationFrame(() => {
                resizeEditors();
                animationFrameId = null;
            });
        }
    });

    document.addEventListener('mouseup', function() {
        if (isDragging) {
            isDragging = false;
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
            splitterEl.classList.remove('dragging');
            document.body.style.cursor = 'default';
            resizeEditors();
            vscode.postMessage({
                type: 'saveSplitterRatio',
                ratio: currentDeclPct
            });
        }
    });

    function updateEditorValue(editor, newValue) {
        if (!editor) return;
        const val = newValue || '';
        if (editor.getValue() === val) {
            return;
        }

        const state = editor.saveViewState();
        editor.setValue(val);
        if (state) {
            editor.restoreViewState(state);
        }
    }

    // Handle incoming messages from Extension
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'custom/completionsResponse': {
                const resolve = pendingRequests.get(message.requestId);
                if (resolve) {
                    resolve(message.suggestions);
                    pendingRequests.delete(message.requestId);
                }
                break;
            }
            case 'custom/definitionResponse': {
                const resolve = pendingRequests.get(message.requestId);
                if (resolve) {
                    resolve(message.definition);
                    pendingRequests.delete(message.requestId);
                }
                break;
            }
            case 'custom/diagnosticsResponse': {
                const resolve = pendingRequests.get(message.requestId);
                if (resolve) {
                    resolve(message.diagnostics);
                    pendingRequests.delete(message.requestId);
                }
                break;
            }
            case 'custom/referencesResponse': {
                const resolve = pendingRequests.get(message.requestId);
                if (resolve) {
                    resolve(message.references);
                    pendingRequests.delete(message.requestId);
                }
                break;
            }
            case 'insertText': {
                // From the "TwinCAT Libraries" view's Insert at Cursor: a namespace, a qualified type
                // name, or a member name, dropped at the caret of the pane the user was last in.
                insertTextAtCursor(message.text, message.triggerSuggest);
                break;
            }
            case 'init': {
                activeFileUri = message.fileUri;
                objTypeEl.textContent = message.data.rootType;
                objNameEl.textContent = message.filename;
                components = message.data.components;
                typesMap = message.typesMap || {};
                currentDeclPct = message.splitterRatio !== undefined ? message.splitterRatio : 50;
                
                isAutoSync = message.isAutoSync !== false;
                toggleEl.checked = isAutoSync;
                if (isAutoSync) {
                    toggleWrapper.classList.add('active');
                    toggleText.textContent = 'Auto Sync';
                } else {
                    toggleWrapper.classList.remove('active');
                    toggleText.textContent = 'Manual Sync';
                }

                pendingEdits = message.cachedEdits || {};
                if (message.cachedEdits) {
                    for (const edit of Object.values(message.cachedEdits)) {
                        const comp = components.find(c => {
                            const ctx = c.xmlContext;
                            return ctx.subType === edit.context.subType &&
                                   ctx.subName === edit.context.subName &&
                                   ctx.accessorType === edit.context.accessorType;
                        });
                        if (comp) {
                            if (edit.blockType === 'Declaration') {
                                comp.declaration = edit.content;
                            } else {
                                comp.implementation = edit.content;
                            }
                        }
                    }
                }

                populateDropdown();
                const selectId = message.selectId || 'root';
                loadComponent(selectId);
                
                if (message.pendingRange || message.pendingTargetWord) {
                    setTimeout(() => highlightTarget(message.pendingTargetWord, message.pendingRange), 50);
                }

                updateStatusText();
                break;
            }
            case 'updateTypesMap': {
                typesMap = message.typesMap || {};
                break;
            }
            case 'refreshDiagnostics': {
                updateDiagnostics();
                break;
            }
            case 'setSyncMode': {
                isAutoSync = message.isAutoSync;
                toggleEl.checked = isAutoSync;
                if (isAutoSync) {
                    toggleWrapper.classList.add('active');
                    toggleText.textContent = 'Auto Sync';
                    flushPendingEdits();
                } else {
                    toggleWrapper.classList.remove('active');
                    toggleText.textContent = 'Manual Sync';
                    updateStatusText();
                }
                break;
            }
            case 'selectComponent': {
                loadComponent(message.id);
                if (message.range || message.targetWord) {
                    setTimeout(() => highlightTarget(message.targetWord, message.range), 50);
                }
                break;
            }
            case 'setSplitterRatio': {
                currentDeclPct = message.ratio;
                const activeComp = components.find(c => c.id === activeComponentId);
                if (activeComp && activeComp.type !== 'Action' && activeComp.implementation !== null) {
                    const implPct = 100 - currentDeclPct;
                    paneDeclEl.style.flex = `${currentDeclPct} ${currentDeclPct} 0%`;
                    paneImplEl.style.flex = `${implPct} ${implPct} 0%`;
                    resizeEditors();
                }
                break;
            }
            case 'update': {
                components = message.data.components;
                populateDropdown();

                const activeComp = components.find(c => c.id === activeComponentId);
                if (activeComp) {
                    isUpdatingFromExtension = true;
                    
                    if (!message.isSelfEdit) {
                        updateEditorValue(declEditor, activeComp.declaration);
                        if (activeComp.implementation !== null) {
                            updateEditorValue(implEditor, activeComp.implementation);
                        }
                    }
                    
                    isUpdatingFromExtension = false;
                } else {
                    loadComponent('root');
                }

                statusEl.textContent = 'Synced';
                statusEl.className = 'status-indicator';
                break;
            }
        }
    });
})();
