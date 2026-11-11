/**
 * @file test_pragma_hover.js
 * @description Hover help for pragmas (`src/lsp/features/hover.js`), on the LSP path and through the
 * live-path mapping the webview's hover takes (`mapHoverToLocal` in `src/livePath.js`).
 *
 * Also pins the licence decision behind the hover text: the catalogue carries names, syntax forms and
 * documentation page ids only, and the hover's prose is this project's own. A catalogue entry that
 * grows a description field fails here, because that is the shape copied documentation would take.
 */

const { provideHover } = require('../src/lsp/features/hover');
const { isDocumentationUrl } = require('../src/lsp/pragmas');
const { assembleSt, localToAbsolute, mapHoverToLocal } = require('../src/livePath');
const catalog = require('../src/lsp/pragmaCatalog.json');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const at = (code, line, character) => provideHover(code, { line, character });
const text = (h) => (h && h.contents && h.contents.value) || '';

// ---------------------------------------------------------------- attributes
{
    const h = at("    {attribute 'qualified_only'}\nVAR_GLOBAL", 0, 10);
    assert(!!h && h.contents.kind === 'markdown', 'a documented attribute has a markdown hover');
    assert(/attribute 'qualified_only'/.test(text(h)) && /`\{attribute 'qualified_only'\}`/.test(text(h)),
        'it names the attribute and shows its syntax');
    assert(/\(https:\/\/infosys\.beckhoff\.com\/content\/1033\/tc3_plc_intro\/\d+\.html\)/.test(text(h)),
        'it links the attribute\'s own Infosys page');
    assert(h && h.range.start.line === 0 && h.range.start.character === 4 && h.range.end.character === 32,
        `the range is the whole pragma, columns 4-32 (got ${JSON.stringify(h && h.range)})`);

    const withValue = at("{attribute 'pack_mode' := '1'}", 0, 3);
    assert(/`\{attribute 'pack_mode' := '<value>'\}`/.test(text(withValue)), 'a valued attribute shows the := form');

    const observed = at("{attribute 'TcGenerated'}", 0, 3);
    assert(/Not on an Infosys page/.test(text(observed)) && !/\]\(http/.test(text(observed)),
        'an observed (uncatalogued-by-Infosys) attribute says so and links nothing');
    assert(!/measured|archives|real project/i.test(text(observed)), 'and shows no measurement notes meant for maintainers');

    const user = at("{attribute 'MyCompany_Flag'}", 0, 3);
    assert(/Not in the catalogue/.test(text(user)) && /user-defined/.test(text(user)),
        'an unknown attribute gets a neutral hover, never a warning');
    assert(!/error|invalid|unknown attribute/i.test(text(user)), 'with no wording that reads as a problem');

    assert(/attribute 'QUALIFIED_ONLY'|attribute 'qualified_only'/.test(text(at("{attribute 'QUALIFIED_ONLY'}", 0, 3))),
        'the lookup is case-insensitive');
}

// ---------------------------------------------------------------- directives
{
    const cases = [
        ["{warning 'check this'}", /\*\*\{warning\}\*\*/, /warning/],
        ["{info 'note'}", /\*\*\{info\}\*\*/, /information/],
        ["{text 'x'}", /\*\*\{text\}\*\*/, /message list/],
        ["{error 'stop'}", /\*\*\{error\}\*\*/, /error/],
        ['{IF defined(Variant1)}', /\*\*\{IF\}\*\*/, /defined\(<identifier>\)/],
        ['{ELSIF hasvalue(V, \'2\')}', /\*\*\{ELSIF\}\*\*/, /hasvalue/],
        ['{ELSE}', /\*\*\{ELSE\}\*\*/, /no earlier/],
        ['{END_IF}', /\*\*\{END_IF\}\*\*/, /closes/],
        ["{define Variant1 '1'}", /\*\*\{define\}\*\*/, /defines a name/],
        ['{undefine Variant1}', /\*\*\{undefine\}\*\*/, /removes/],
        ['{region "Inputs"}', /\*\*\{region\}\*\*/, /foldable/],
        ['{endregion}', /\*\*\{endregion\}\*\*/, /closes/],
        ['{warning disable C0371}', /\*\*\{warning disable\}\*\*/, /off/],
        ['{warning restore C0371}', /\*\*\{warning restore\}\*\*/, /back on/]
    ];
    for (const [code, title, body] of cases) {
        const h = at(code, 0, 2);
        assert(title.test(text(h)) && body.test(text(h)) && /\(https:\/\/infosys\.beckhoff\.com\//.test(text(h)),
            `${code}: titled, described, linked`);
    }
}

// ---------------------------------------------------------------- no hover
{
    assert(at('{foo bar}', 0, 2) === null, 'a pragma whose head matches no category gets no hover');
    assert(at("nX := 1; {attribute 'hide'}", 0, 2) === null, 'code on a pragma line gets no hover');
    assert(at("(* {attribute 'hide'} *)", 0, 5) === null, 'a pragma inside a comment gets none');
    assert(at("(* (* x *) {attribute 'hide'} *)", 0, 13) === null, '…including the outer part of a nested comment');
    assert(at("s := '{attribute ''hide''}';", 0, 8) === null, 'nor a pragma-looking string');
    assert(at("// {warning 'x'}", 0, 5) === null, 'nor one in a line comment');
    assert(at('nX := 1;', 0, 2) === null, 'nor plain code');
    assert(at('nX := 1;', 5, 0) === null, 'a position past the end answers null, not a throw');
    const half = at("{attribute 'hide'\nVAR", 0, 3);
    assert(/attribute 'hide'/.test(text(half)) && half.range.end.character === 17, 'a half-typed pragma still hovers, up to the end of its line');
}

// ---------------------------------------------------------------- the live path (webview bridge)
const XML = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.0">
  <POU Name="FB_Hover" Id="{eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Hover
VAR
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[;]]></ST>
    </Implementation>
    <Method Name="M_Run" Id="{eeeeeeee-0001-0001-0001-eeeeeeeeeeee}">
      <Declaration><![CDATA[{attribute 'object_name' := 'Run'}
METHOD M_Run : BOOL
VAR_INPUT
    {attribute 'hide'}
    bIn : BOOL;
END_VAR]]></Declaration>
      <Implementation>
        <ST><![CDATA[{warning 'todo'}
M_Run := bIn;]]></ST>
      </Implementation>
    </Method>
  </POU>
</TcPlcObject>`;
{
    const unit = assembleSt(XML, null);
    const methodId = Object.keys(unit.lineMap).find(k => /M_Run/.test(k));
    assert(!!methodId, 'live path: the method is in the line map');

    // decl line 4, column 9 (1-based, Monaco) is inside `{attribute 'hide'}`.
    const abs = localToAbsolute(unit.lineMap, methodId, 'decl', 4, 9);
    const mapped = mapHoverToLocal(provideHover(unit.stText, abs), abs, 4);
    assert(!!mapped && /attribute 'hide'/.test(mapped.contents), 'live path: the method decl pane hovers its attribute');
    assert(mapped && mapped.range.startLineNumber === 4 && mapped.range.startColumn === 5 && mapped.range.endColumn === 23,
        `live path: mapped back to pane line 4, columns 5-23 (got ${JSON.stringify(mapped && mapped.range)})`);

    const absImpl = localToAbsolute(unit.lineMap, methodId, 'impl', 1, 3);
    const implHover = mapHoverToLocal(provideHover(unit.stText, absImpl), absImpl, 1);
    assert(!!implHover && /\{warning\}/.test(implHover.contents) && implHover.range.startColumn === 1,
        'live path: the implementation pane hovers {warning …} at its own line');

    assert(mapHoverToLocal(null, abs, 4) === null, 'mapHoverToLocal: no hover maps to null');
    const offLine = { contents: { value: 'x' }, range: { start: { line: abs.line + 1, character: 0 }, end: { line: abs.line + 1, character: 2 } } };
    assert(mapHoverToLocal(offLine, abs, 4) === null, 'mapHoverToLocal: a hover on another line is dropped, not shown at a guessed place');
}

// ---------------------------------------------------------------- links the host will open
{
    assert(isDocumentationUrl(catalog.docBase + '2529561739.html'), 'isDocumentationUrl: a catalogue page is openable');
    assert(!isDocumentationUrl('https://example.com/2529561739.html'), 'isDocumentationUrl: another host is not');
    assert(!isDocumentationUrl(catalog.docBase + '../../x.html'), 'isDocumentationUrl: a path escape is not');
    assert(!isDocumentationUrl(catalog.docBase + '1.html?x=javascript:'), 'isDocumentationUrl: a query is not');
}

// ---------------------------------------------------------------- provenance
{
    const extra = (o, allowed) => Object.keys(o).filter(k => !allowed.includes(k));
    const attrExtra = catalog.attributes.flatMap(a => extra(a, ['name', 'doc']));
    const dirExtra = catalog.directives.flatMap(d => extra(d, ['name', 'kind', 'syntax', 'doc']));
    const opExtra = catalog.conditionalOperators.flatMap(o => extra(o, ['name', 'syntax', 'doc']));
    assert(attrExtra.length + dirExtra.length + opExtra.length === 0,
        `the generated catalogue carries names, syntax and page ids only — no documentation text (extra keys: ${[...attrExtra, ...dirExtra, ...opExtra].join(', ') || 'none'})`);
}

console.log(errors === 0 ? '\nAll pragma hover tests passed.' : `\n${errors} test(s) failed.`);
process.exit(errors === 0 ? 0 : 1);
