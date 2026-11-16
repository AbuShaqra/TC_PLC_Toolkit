/**
 * @file watchTree.js
 * @description Online monitoring (R15): the "PLC Watch" view. Renders src/online/watchList.js's rows:
 * one root item per watched path with its value and online type, struct/FB/array members expandable
 * from the entry's decoded value (no extra notification per member). Context values drive the menus
 * in package.json: `watchEntry` (Remove, Copy Path), `watchMember` (Copy Path), plus ` scalar` where
 * a Write value… applies.
 */

'use strict';

const vscode = require('vscode');
const { childRows } = require('./watchList');
const { isScalar } = require('./values');

/** The shortest gap between two redraws sent to VS Code (above its 200 ms wait for a pause). */
const REDRAW_MS = 300;

class WatchTreeProvider {
    /**
     * @param {ReturnType<typeof import('./watchList').createWatchList>} watch
     */
    constructor(watch) {
        this.watch = watch;
        this._emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._emitter.event;
        /** The root rows of the latest reload, by lower-case path, so one row can be redrawn alone. */
        /** @type {Map<string, any>} */
        this._rows = new Map();
        /** Rows waiting for the next batched redraw, and whether the whole view must reload. */
        /** @type {Set<string>} */
        this._pendingPaths = new Set();
        this._pendingAll = false;
        /** @type {ReturnType<typeof setTimeout>|null} */
        this._timer = null;
        this._lastFire = 0;
    }

    /**
     * Redraws the view. With `path` (a new value of one entry), only that row is redrawn: a full redraw
     * reloads the whole tree, and VS Code shows its progress bar each time, so a value changing every
     * cycle made the bar flash (user report, 2026-11-16).
     *
     * Redraws are batched and sent at most every REDRAW_MS: VS Code waits for a 200 ms pause in a
     * tree's change events before it redraws, so several entries changing every 200 ms never left one
     * and the view updated only every few seconds (user report; reproduced in VS Code 1.146 with four
     * entries: no update in 3 s).
     * @param {string} [path]
     */
    refresh(path) {
        if (path) this._pendingPaths.add(String(path).toLowerCase());
        else this._pendingAll = true;
        if (this._timer) return;
        const wait = Math.max(0, this._lastFire + REDRAW_MS - Date.now());
        this._timer = setTimeout(() => this._flush(), wait);
    }

    /** Sends the batched redraw: the changed rows, or the whole view. */
    _flush() {
        this._timer = null;
        this._lastFire = Date.now();
        const all = this._pendingAll;
        const paths = [...this._pendingPaths];
        this._pendingAll = false;
        this._pendingPaths.clear();
        if (!all) {
            const list = this.watch.list();
            const rows = [];
            let needAll = false;
            for (const k of paths) {
                const row = this._rows.get(k);
                const fresh = row ? list.find(r => r.path.toLowerCase() === k) : null;
                const next = fresh ? this._rowOf(fresh) : null;
                if (!row || !next || next.expandable !== row.expandable) { needAll = true; break; }
                Object.assign(row, next);
                rows.push(row);
            }
            if (!needAll) { if (rows.length) this._emitter.fire(rows); return; }
        }
        this._emitter.fire(undefined);
    }

    /** Stops a pending redraw (the view is going away). */
    dispose() { if (this._timer) clearTimeout(this._timer); this._timer = null; }

    /** @param {any} r A watch list row. @returns {any} */
    _rowOf(r) {
        return {
            kind: 'entry', path: r.path, label: r.path, text: r.text, type: r.type, value: r.value, dataType: r.dataType,
            state: r.state, expandable: r.state === 'ok' && r.value !== null && typeof r.value === 'object' && !(r.value instanceof Date)
                && !isEnumValue(r.value)
        };
    }

    /**
     * @param {any} [element]
     * @returns {Array<any>}
     */
    getChildren(element) {
        if (!element) {
            const rows = new Map();
            const out = this.watch.list().map(r => {
                const k = r.path.toLowerCase();
                // A NEW object per reload: VS Code loses an element object that it saw in an earlier reload,
                // and a later one-row redraw of it then never shows (measured in VS Code 1.95 and 1.146:
                // the value stayed at its first reading). refresh(path) redraws the latest object.
                const row = this._rowOf(r);
                rows.set(k, row);
                return row;
            });
            this._rows = rows;
            return out;
        }
        return childRows(element.path, element.value, element.dataType).map(c => ({
            kind: 'member', path: c.path, label: c.label, text: c.text, type: c.type, value: c.value, dataType: c.dataType,
            state: 'ok', expandable: c.expandable
        }));
    }

    /**
     * @param {any} element
     * @returns {vscode.TreeItem}
     */
    getTreeItem(element) {
        const item = new vscode.TreeItem(element.label,
            element.expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.description = element.text + (element.type ? `  ${element.type}` : '');
        item.tooltip = `${element.path}\n${element.type || ''}\n${element.text}`;
        const scalar = element.state === 'ok' && !element.expandable && (element.kind === 'member' || isScalar(element.dataType));
        item.contextValue = (element.kind === 'entry' ? 'watchEntry' : 'watchMember') + (scalar ? ' scalar' : '');
        item.id = `${element.kind}:${element.path}`;
        return item;
    }
}

/** @param {any} v @returns {boolean} */
function isEnumValue(v) {
    return !!v && typeof v === 'object' && 'name' in v && 'value' in v && Object.keys(v).length === 2;
}

module.exports = { WatchTreeProvider, REDRAW_MS };
