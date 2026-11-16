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
    }

    /**
     * Redraws the view. With `path` (a new value of one entry), only that row is redrawn: a full redraw
     * reloads the whole tree, and VS Code shows its progress bar each time, so a value changing every
     * cycle made the bar flash (user report, 2026-11-16).
     * @param {string} [path]
     */
    refresh(path) {
        const row = path ? this._rows.get(String(path).toLowerCase()) : undefined;
        if (row) {
            const fresh = this.watch.list().find(r => r.path.toLowerCase() === row.path.toLowerCase());
            const next = fresh ? this._rowOf(fresh) : null;
            if (next && next.expandable === row.expandable) {
                Object.assign(row, next);
                this._emitter.fire(row);
                return;
            }
        }
        this._emitter.fire(undefined);
    }

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

module.exports = { WatchTreeProvider };
