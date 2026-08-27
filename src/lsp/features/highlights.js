/**
 * @file features/highlights.js
 * @description Document highlights for the active document.
 */

/**
 * Highlights all occurrences in the active document.
 * @param {string} code 
 * @param {Object} position { line, character }
 * @returns {Array<Object>} LSP DocumentHighlights
 */
function provideDocumentHighlights(code, position) {
    const lines = code.split('\n');
    const lineText = lines[position.line] || '';
    const col = position.character;

    let start = col;
    while (start > 0 && /[a-zA-Z0-9_]/.test(lineText[start - 1])) {
        start--;
    }
    let end = col;
    while (end < lineText.length && /[a-zA-Z0-9_]/.test(lineText[end])) {
        end++;
    }
    const word = lineText.substring(start, end);
    if (!word) return [];

    const highlights = [];
    const regex = new RegExp(`\\b${word}\\b`, 'g');

    // Named `scanLine`, not `lineText`: that name is already taken above by the CARET's line, which
    // is what the word under the cursor was read from. One name for two different lines in one
    // function is exactly the confusion no-shadow exists to prevent.
    lines.forEach((scanLine, lineIdx) => {
        let match;
        while ((match = regex.exec(scanLine)) !== null) {
            highlights.push({
                range: {
                    start: { line: lineIdx, character: match.index },
                    end: { line: lineIdx, character: match.index + word.length }
                },
                kind: 1 // Read/Write
            });
        }
    });

    return highlights;
}

module.exports = {
    provideDocumentHighlights
};
