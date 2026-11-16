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
    }

    /** Redraws the view. */
    refresh() { this._emitter.fire(undefined); }

    /**
     * @param {any} [element]
     * @returns {Array<any>}
     */
    getChildren(element) {
        if (!element) {
            return this.watch.list().map(r => ({
                kind: 'entry', path: r.path, label: r.path, text: r.text, type: r.type, value: r.value, dataType: r.dataType,
                state: r.state, expandable: r.state === 'ok' && r.value !== null && typeof r.value === 'object' && !(r.value instanceof Date)
                    && !isEnumValue(r.value)
            }));
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
