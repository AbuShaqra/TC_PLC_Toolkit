/**
 * @file test_enum_ranges.js
 * @description Regression: implicit (inline) enum members must be registered at their OWN
 * source position, not at the enclosing variable's name range. Go to Definition / References
 * on an enum member must land on the member token itself.
 */

const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { provideDefinition, provideReferences } = require('../src/lsp/features');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

function wordPos(lines, lineIdx, word) {
    const ch = lines[lineIdx].indexOf(word);
    return { line: lineIdx, character: ch + 1 }; // cursor inside the word
}

// --- Single-line implicit enum ---
const code = [
    'PROGRAM MAIN',
    'VAR',
    '\tstate : (Idle, Running, Stopped);',
    '\tn : INT;',
    'END_VAR',
    '',
    'state := Idle;',
    'IF state = Running THEN',
    '\tn := 1;',
    'END_IF',
    'END_PROGRAM',
    ''
].join('\n');
const lines = code.split('\n');

clearWorkspaceIndex();
const uri = 'file:///c:/fake/MAIN.TcPOU';
parseAndIndexDocument(code, uri);

// The declaration line (idx 2): "\tstate : (Idle, Running, Stopped);"
// Real 0-based columns of the member tokens:
const declLine = 2;
const idleCol = lines[declLine].indexOf('Idle');       // 10
const runningCol = lines[declLine].indexOf('Running'); // 16
const stateCol = lines[declLine].indexOf('state');     // 1 (the variable — must NOT be used)

const defIdle = provideDefinition(code, wordPos(lines, 6, 'Idle'), getWorkspaceSymbolIndex(), uri);
assert(defIdle && defIdle.range.start.line === declLine, 'Idle definition on the declaration line');
assert(defIdle && defIdle.range.start.character === idleCol,
    `Idle definition startCol is the member column (${idleCol}), got ${defIdle && defIdle.range.start.character}`);
assert(defIdle && defIdle.range.start.character !== stateCol,
    'Idle definition does NOT point at the enclosing "state" variable');
assert(defIdle && defIdle.range.end.character === idleCol + 'Idle'.length,
    'Idle definition endCol matches member name length');

const defRunning = provideDefinition(code, wordPos(lines, 7, 'Running'), getWorkspaceSymbolIndex(), uri);
assert(defRunning && defRunning.range.start.character === runningCol,
    `Running definition startCol is the member column (${runningCol}), got ${defRunning && defRunning.range.start.character}`);

// References for Idle must include the declaration occurrence at the member column.
const refs = provideReferences(code, wordPos(lines, 6, 'Idle'), getWorkspaceSymbolIndex(), uri);
const hasDecl = refs.some(r => r.range.start.line === declLine && r.range.start.character === idleCol);
assert(hasDecl, 'References for Idle include the declaration occurrence at the member column');

// --- Multi-line implicit enum with an explicit value (:= must be skipped) ---
const code2 = [
    'FUNCTION_BLOCK FB_Multi',
    'VAR',
    '\tmode : (',
    '\t\tAuto := 10,',
    '\t\tManual,',
    '\t\tOff',
    '\t);',
    'END_VAR',
    'mode := Manual;',
    'END_FUNCTION_BLOCK',
    ''
].join('\n');
const lines2 = code2.split('\n');

clearWorkspaceIndex();
const uri2 = 'file:///c:/fake/FB_Multi.TcPOU';
parseAndIndexDocument(code2, uri2);

const autoLine = 3, manualLine = 4, offLine = 5;
const autoCol = lines2[autoLine].indexOf('Auto');
const manualCol = lines2[manualLine].indexOf('Manual');
const offCol = lines2[offLine].indexOf('Off');

const defAuto = provideDefinition(code2, wordPos(lines2, 3, 'Auto'), getWorkspaceSymbolIndex(), uri2);
assert(defAuto && defAuto.range.start.line === autoLine && defAuto.range.start.character === autoCol,
    `Auto member at line ${autoLine} col ${autoCol}, got ${defAuto && defAuto.range.start.line}:${defAuto && defAuto.range.start.character}`);

const defManual = provideDefinition(code2, wordPos(lines2, 8, 'Manual'), getWorkspaceSymbolIndex(), uri2);
assert(defManual && defManual.range.start.line === manualLine && defManual.range.start.character === manualCol,
    `Manual member at line ${manualLine} col ${manualCol}, got ${defManual && defManual.range.start.line}:${defManual && defManual.range.start.character}`);

// The value "10" after := must NOT be registered as a member (would resolve to nothing).
const idx = getWorkspaceSymbolIndex();
const fbNode = Object.values(idx).find(n => n.uri === uri2);
const memberNames = (fbNode ? fbNode.variables : []).filter(v => v.type === 'Enum').map(v => v.name);
assert(memberNames.includes('Auto') && memberNames.includes('Manual') && memberNames.includes('Off'),
    `enum members registered: ${memberNames.join(', ')}`);
assert(!memberNames.includes('10'), 'enum value token "10" is NOT registered as a member');
// Correct offset for Off too.
assert(offCol >= 0, `Off column found (${offCol})`);

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll enum-range assertions passed.');
