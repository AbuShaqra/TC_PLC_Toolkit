/**
 * @file _synthLibProject.js
 * @description Fixture for the library-declaration harnesses (R3.4): a PLC project that calls a
 * library, built in a temporary directory. EVERY library name, signature and type here is
 * SYNTHETIC — invented for this test, copied from no vendor library — because generated library
 * declarations must never reach the repository with real library content in them.
 *
 * Layout (the real one: the dump sits at the workspace root, above the project):
 *   <ws>/library-signatures.xml            the "Update Library Definitions" dump format
 *   <ws>/SynProj/SynProj_PLC/SynProj_PLC.plcproj   references "Synthetic Motion Library" as SynMotion
 *   <ws>/SynProj/SynProj_PLC/SynProj_PLC.tmc       library-owned types (Namespace="SynMotion")
 *   <ws>/SynProj/SynProj_PLC/POUs/*.TcPOU, GVLs/*.TcGVL   the project's own objects
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

/** The dump, in ProduceAllLibrarySignatures' format (see src/lsp/librarySignatures.js). */
const SIGNATURES = `<?xml version="1.0"?>
<LibrarySignatures>
  <Library>
    <LibraryName>Synthetic Motion Library</LibraryName><Version>9.9.9.9</Version><Distributor>Synthetic Co</Distributor>
    <TypeSignatures>
      <TypeSignature type="Function"><Name>F_SynAdd</Name><Comment>SYNTHETIC-DOC-TEXT-MUST-NOT-LEAK</Comment>
        <Inputs><Input><Name>nA</Name><DataType>DINT</DataType></Input><Input><Name>nB</Name><DataType>DINT</DataType></Input></Inputs>
        <Outputs><Output><Name>F_SynAdd</Name><DataType>DINT</DataType></Output></Outputs>
      </TypeSignature>
      <TypeSignature type="Function"><Name>F_SynDistance</Name>
        <Inputs><Input><Name>stFrom</Name><DataType>SynMotion.ST_SynPos</DataType></Input><Input><Name>stTo</Name><DataType>ST_SynPos</DataType></Input></Inputs>
        <Outputs><Output><Name>F_SynDistance</Name><DataType>LREAL</DataType></Output><Output><Name>bValid</Name><DataType>BOOL</DataType></Output></Outputs>
      </TypeSignature>
      <TypeSignature type="Function"><Name>F_SynLongTime</Name>
        <Inputs><Input><Name>tSpan</Name><DataType>LTIME</DataType></Input></Inputs>
        <Outputs><Output><Name>F_SynLongTime</Name><DataType>BOOL</DataType></Output></Outputs>
      </TypeSignature>
      <TypeSignature type="Function"><Name>F_SynBounded</Name>
        <Inputs><Input><Name>aData</Name><DataType>ARRAY [0..cSynMax] OF INT</DataType></Input></Inputs>
        <Outputs><Output><Name>F_SynBounded</Name><DataType>BOOL</DataType></Output></Outputs>
      </TypeSignature>
      <TypeSignature type="Function"><Name>CONCAT</Name>
        <Inputs><Input><Name>STR1</Name><DataType>STRING(255)</DataType></Input><Input><Name>STR2</Name><DataType>STRING(255)</DataType></Input></Inputs>
        <Outputs><Output><Name>CONCAT</Name><DataType>STRING(255)</DataType></Output></Outputs>
      </TypeSignature>
      <TypeSignature type="FunctionBlock"><Name>TON</Name>
        <Inputs><Input><Name>IN</Name><DataType>BOOL</DataType></Input><Input><Name>PT</Name><DataType>TIME</DataType></Input></Inputs>
        <Outputs><Output><Name>Q</Name><DataType>BOOL</DataType></Output><Output><Name>ET</Name><DataType>TIME</DataType></Output></Outputs>
      </TypeSignature>
      <TypeSignature type="FunctionBlock"><Name>FB_SynAxis</Name>
        <Inputs><Input><Name>bExecute</Name><DataType>BOOL</DataType></Input><Input><Name>fTarget</Name><DataType>LREAL</DataType></Input><Input><Name>sAxisName</Name><DataType>T_SynName</DataType></Input></Inputs>
        <Outputs><Output><Name>bDone</Name><DataType>BOOL</DataType></Output><Output><Name>eState</Name><DataType>E_SynState</DataType></Output></Outputs>
        <InOuts><InOut><Name>stPos</Name><DataType>ST_SynPos</DataType></InOut></InOuts>
      </TypeSignature>
      <TypeSignature type="FunctionBlock"><Name>FB_SynLogger</Name>
        <Inputs><Input><Name>sMessage</Name><DataType>STRING(80)</DataType></Input></Inputs>
        <Outputs><Output><Name>bBusy</Name><DataType>BOOL</DataType></Output></Outputs>
      </TypeSignature>
      <TypeSignature type="FunctionBlock"><Name>FB_UserOwnName</Name>
        <Inputs><Input><Name>bLibraryVersion</Name><DataType>BOOL</DataType></Input></Inputs>
      </TypeSignature>
      <TypeSignature type="Type"><Name>T_SynOpaque</Name></TypeSignature>
      <TypeSignature type="Interface"><Name>I_SynItf</Name></TypeSignature>
      <TypeSignature type="VarGlobal"><Name>GVL_SynConst</Name>
        <Constants><Constant><Name>cSynMax</Name><DataType>DINT</DataType></Constant><Constant><Name>cSynGain</Name><DataType>LREAL</DataType></Constant></Constants>
      </TypeSignature>
      <TypeSignature type="VarGlobal"><Name>E_SynDir</Name>
        <Constants><Constant><Name>eSynForward</Name><DataType>E_SynDir</DataType></Constant><Constant><Name>eSynBackward</Name><DataType>E_SynDir</DataType></Constant></Constants>
      </TypeSignature>
    </TypeSignatures>
  </Library>
  <Library>
    <LibraryName>Synthetic Other Library</LibraryName><Version>1.0.0.0</Version><Distributor>Synthetic Co</Distributor>
    <TypeSignatures>
      <TypeSignature type="Function"><Name>F_SynOtherOnly</Name>
        <Inputs><Input><Name>n</Name><DataType>INT</DataType></Input></Inputs>
        <Outputs><Output><Name>F_SynOtherOnly</Name><DataType>INT</DataType></Output></Outputs>
      </TypeSignature>
    </TypeSignatures>
  </Library>
</LibrarySignatures>
`;

/**
 * One function-block parameter as the `.tmc` writes it.
 * @param {string} name
 * @param {string} type
 * @param {string} itemType Input / Output / InOut.
 * @param {string} [typeAttrs]
 * @returns {string}
 */
function io(name, type, itemType, typeAttrs = '') {
    return `<SubItem><Name>${name}</Name><Type${typeAttrs}>${type}</Type><BitSize>8</BitSize>` +
        `<Properties><Property><Name>ItemType</Name><Value>${itemType}</Value></Property></Properties></SubItem>`;
}

/** The `.tmc`: library-owned types carry Namespace="SynMotion"; the project's own type does not. */
const TMC = `<?xml version="1.0" encoding="utf-8"?><TcModuleClass><DataTypes>` +
    `<DataType><Name Namespace="SynMotion">ST_SynPos</Name><Comment><![CDATA[ SYNTHETIC-DOC-TEXT-MUST-NOT-LEAK ]]></Comment><BitSize>128</BitSize>` +
    `<SubItem><Name>fX</Name><Type>LREAL</Type><BitSize>64</BitSize><BitOffs>0</BitOffs></SubItem>` +
    `<SubItem><Name>fY</Name><Type>LREAL</Type><BitSize>64</BitSize><BitOffs>64</BitOffs></SubItem>` +
    `<SubItem><Name>aTags</Name><Type>BYTE</Type><ArrayInfo><LBound>0</LBound><Elements>4</Elements></ArrayInfo><BitSize>32</BitSize></SubItem></DataType>` +
    `<DataType><Name Namespace="SynMotion">ST_SynPose</Name><BitSize>192</BitSize><ExtendsType Namespace="SynMotion">ST_SynPos</ExtendsType>` +
    `<SubItem><Name>fAngle</Name><Type>LREAL</Type><BitSize>64</BitSize><BitOffs>128</BitOffs></SubItem></DataType>` +
    `<DataType><Name Namespace="SynMotion">E_SynState</Name><BitSize>16</BitSize><BaseType>INT</BaseType>` +
    `<EnumInfo><Text>eSynIdle</Text><Enum>0</Enum></EnumInfo><EnumInfo><Text>eSynMoving</Text><Enum>1</Enum></EnumInfo><EnumInfo><Text>eSynFault</Text><Enum>9</Enum></EnumInfo></DataType>` +
    `<DataType><Name Namespace="SynMotion">T_SynName</Name><BitSize>256</BitSize><BaseType>STRING(31)</BaseType></DataType>` +
    `<DataType><Name Namespace="SynMotion">GVL_SynConst</Name>` +
    `<SubItem><Name Static="true">cSynMax</Name><Type>DINT</Type><BitSize>32</BitSize><Default><Value>15</Value></Default></SubItem>` +
    `<SubItem><Name Static="true">cSynGain</Name><Type>LREAL</Type><BitSize>64</BitSize><Default><Value>2.5</Value></Default></SubItem>` +
    `<SubItem><Name Static="true">sSynBanner</Name><Type>STRING(20)</Type><BitSize>168</BitSize><Default><String>SYNTHETIC-DOC-TEXT-MUST-NOT-LEAK</String></Default></SubItem>` +
    `<Properties><Property><Name>qualified_only</Name></Property></Properties></DataType>` +
    `<DataType><Name Namespace="SynMotion">ST_SynLimits</Name><BitSize>128</BitSize>` +
    `<SubItem><Name>fMin</Name><Type>LREAL</Type><BitSize>64</BitSize><BitOffs>0</BitOffs></SubItem>` +
    `<SubItem><Name>fMax</Name><Type>LREAL</Type><BitSize>64</BitSize><BitOffs>64</BitOffs></SubItem></DataType>` +
    `<DataType><Name Namespace="SynMotion">FB_SynAxis</Name><BitSize>512</BitSize>` +
    io('bExecute', 'BOOL', 'Input') + io('fTarget', 'LREAL', 'Input') + io('sAxisName', 'T_SynName', 'Input', ' Namespace="SynMotion"') +
    io('bDone', 'BOOL', 'Output') + io('eState', 'E_SynState', 'Output', ' Namespace="SynMotion"') + io('stPos', 'ST_SynPos', 'InOut', ' Namespace="SynMotion"') +
    `<SubItem><Name>nInternal</Name><Type>DINT</Type><BitSize>32</BitSize></SubItem>` +
    `<Action><Name>ActSynHome</Name></Action>` +
    `<Method><Name>MSynReset</Name><ReturnType>BOOL</ReturnType><Parameter><Name>bHard</Name><Type>BOOL</Type><BitSize>8</BitSize></Parameter></Method>` +
    `<Method><Name>__getnSynCount</Name><ReturnType>DINT</ReturnType><Properties><Property><Name>property</Name></Property></Properties></Method>` +
    `<Properties><Property><Name>PouType</Name><Value>FunctionBlock</Value></Property></Properties></DataType>` +
    `<DataType><Name Namespace="SynMotion">I_SynItf</Name><Method><Name>MSynRun</Name><ReturnType>BOOL</ReturnType></Method>` +
    `<Properties><Property><Name>TcPlcInterfaceType</Name></Property></Properties></DataType>` +
    `<DataType><Name>FB_UserOwn</Name><SubItem><Name>nCount</Name><Type>INT</Type><BitSize>16</BitSize></SubItem>` +
    `<Properties><Property><Name>PouType</Name><Value>FunctionBlock</Value></Property></Properties></DataType>` +
    `</DataTypes></TcModuleClass>`;

const PLCPROJ = (objects) => `<?xml version="1.0" encoding="utf-8"?>
<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup><Name>SynProj_PLC</Name></PropertyGroup>
  <ItemGroup>
${objects.map(o => `    <Compile Include="${o.replace(/\//g, '\\')}"><SubType>Code</SubType></Compile>`).join('\n')}
  </ItemGroup>
  <ItemGroup>
    <PlaceholderReference Include="Synthetic Motion Library">
      <DefaultResolution>Synthetic Motion Library, * (Synthetic Co)</DefaultResolution>
      <Namespace>SynMotion</Namespace>
    </PlaceholderReference>
  </ItemGroup>
</Project>
`;

/**
 * The names a synthetic `.compiled-library` archive holds (a ZIP whose string-table entry lists
 * them, the shape libsymbols.js harvests). Names only: an archive gives no signatures.
 */
const ARCHIVE_NAMES = ['SynMotion', 'F_SynAdd', 'F_SynDistance', 'F_SynLongTime', 'F_SynBounded', 'FB_SynAxis', 'FB_SynLogger',
    'bExecute', 'fTarget', 'sAxisName', 'bDone', 'eState', 'stPos', 'nA', 'nB', 'stFrom', 'stTo', 'bValid', 'sMessage', 'bBusy',
    'GVL_SynConst', 'cSynMax', 'cSynGain', 'E_SynDir', 'eSynForward', 'eSynBackward', 'T_SynOpaque', 'F_SynArchiveOnly'];

/** LEB128, as the archive string table writes lengths and ids. */
function varint(value) {
    const bytes = [];
    let v = value;
    do { let b = v & 0x7f; v >>>= 7; if (v > 0) b |= 0x80; bytes.push(b); } while (v > 0);
    return Buffer.from(bytes);
}

/**
 * A one-entry ZIP archive holding a string table of `names`.
 * @param {string[]} names
 * @returns {Buffer}
 */
function archiveOf(names) {
    const table = Buffer.concat([varint(names.length), ...names.flatMap((n, i) => { const b = Buffer.from(n, 'utf8'); return [varint(i), varint(b.length), b]; })]);
    const nameBuf = Buffer.from('__shared_data_storage_string_table__.auxiliary', 'utf8');
    const body = zlib.deflateRawSync(table);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(table.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(table.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    const centralBuf = Buffer.concat([central, nameBuf]);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(30 + nameBuf.length + body.length, 16);
    return Buffer.concat([local, nameBuf, body, centralBuf, eocd]);
}

const cdata = (t) => `<![CDATA[${t}]]>`;
/**
 * A TcPOU file.
 * @param {string} name
 * @param {string} decl
 * @param {string} impl
 * @returns {string}
 */
function pouXml(name, decl, impl) {
    return `<?xml version="1.0" encoding="utf-8"?>\r\n<TcPlcObject Version="1.1.0.1">\r\n  <POU Name="${name}" Id="{00000000-0000-0000-0000-0000000000a1}" SpecialFunc="None">\r\n` +
        `    <Declaration>${cdata(decl)}</Declaration>\r\n    <Implementation><ST>${cdata(impl)}</ST></Implementation>\r\n  </POU>\r\n</TcPlcObject>`;
}
/**
 * A TcGVL file.
 * @param {string} name
 * @param {string} decl
 * @returns {string}
 */
function gvlXml(name, decl) {
    return `<?xml version="1.0" encoding="utf-8"?>\r\n<TcPlcObject Version="1.1.0.1">\r\n  <GVL Name="${name}" Id="{00000000-0000-0000-0000-0000000000b1}">\r\n` +
        `    <Declaration>${cdata(decl)}</Declaration>\r\n  </GVL>\r\n</TcPlcObject>`;
}

const L = (...lines) => lines.join('\r\n');

/** MAIN: correct calls into the synthetic library, every form the check must accept. */
const MAIN_DECL = L(
    'PROGRAM MAIN',
    'VAR',
    '\tfbAxis : FB_SynAxis;',
    '\tfbAxis2 : SynMotion.FB_SynAxis;',
    '\tfbLog : FB_SynLogger;',
    '\tfbTimer : TON;',
    '\tfbStd : SynMotion.TON;',
    '\tstPos : ST_SynPos;',
    '\tstPose : ST_SynPose;',
    '\tstLimits : ST_SynLimits;',
    '\teState : E_SynState;',
    '\teDir : E_SynDir;',
    '\tsName : T_SynName;',
    '\tnSum : DINT;',
    '\tfDist : LREAL;',
    '\tbOk : BOOL;',
    '\taBuf : ARRAY [0..cSynMax] OF INT;',
    'END_VAR');
const MAIN_IMPL = L(
    'nSum := F_SynAdd(nA := 1, nB := 2);',
    'nSum := SynMotion.F_SynAdd(nA := nSum, nB := GVL_SynConst.cSynMax);',
    'fDist := F_SynDistance(stFrom := stPos, stTo := stPos, bValid => bOk);',
    'fbAxis(bExecute := TRUE, fTarget := 10.0, sAxisName := sName, stPos := stPos);',
    'bOk := fbAxis.bDone;',
    'bOk := fbAxis.MSynReset(bHard := FALSE);',
    'nSum := fbAxis.nSynCount;',
    'fbAxis.ActSynHome();',
    'IF fbAxis.eState = E_SynState.eSynMoving THEN eState := eSynFault; END_IF',
    'eDir := E_SynDir.eSynForward;',
    'fbLog(sMessage := \'synthetic\');',
    'fbTimer(IN := bOk, PT := T#1S);',
    'stPose.fX := stPose.fAngle * cSynGain;',
    'stLimits.fMax := fDist;',
    'bOk := F_SynBounded(aData := aBuf);',
    'nSum := nUserGlobal;');
const GVL_DECL = L('VAR_GLOBAL', '\tnUserGlobal : DINT;', 'END_VAR');
const OWN_DECL = L('FUNCTION_BLOCK FB_UserOwnName', 'VAR_INPUT', '\tbMine : BOOL;', 'END_VAR');
/** A library type the sources name but cannot describe (opaque in the dump, absent from the .tmc). */
const OPAQUE_DECL = L('PROGRAM P_Opaque', 'VAR', '\toOpaque : T_SynOpaque;', '\tbFlag : BOOL;', 'END_VAR');
const OPAQUE_IMPL = L('bFlag := F_SynLongTime(tSpan := T#1S);');

/**
 * Builds the workspace. `edit(objectName, {decl, impl})` may change an object before it is written.
 * @param {{edit?: (name: string, o: {decl: string, impl: string}) => {decl: string, impl: string}, withDump?: boolean, root?: string}} [options]
 * @returns {{ws: string, projectDir: string, files: string[], cleanup: () => void}}
 */
function buildSynthLibProject(options = {}) {
    const ws = fs.mkdtempSync(path.join(options.root || os.tmpdir(), 'tc_synlib_'));
    const projectDir = path.join(ws, 'SynProj', 'SynProj_PLC');
    fs.mkdirSync(path.join(projectDir, 'POUs'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'GVLs'), { recursive: true });
    const edit = options.edit || ((_n, o) => o);
    const main = edit('MAIN', { decl: MAIN_DECL, impl: MAIN_IMPL });
    const own = edit('FB_UserOwnName', { decl: OWN_DECL, impl: '' });
    const opaque = edit('P_Opaque', { decl: OPAQUE_DECL, impl: OPAQUE_IMPL });
    const files = [
        [path.join(projectDir, 'POUs', 'MAIN.TcPOU'), pouXml('MAIN', main.decl, main.impl)],
        [path.join(projectDir, 'POUs', 'FB_UserOwnName.TcPOU'), pouXml('FB_UserOwnName', own.decl, own.impl)],
        [path.join(projectDir, 'POUs', 'P_Opaque.TcPOU'), pouXml('P_Opaque', opaque.decl, opaque.impl)],
        [path.join(projectDir, 'GVLs', 'GVL_User.TcGVL'), gvlXml('GVL_User', GVL_DECL)]
    ];
    for (const [file, text] of files) fs.writeFileSync(file, text);
    fs.writeFileSync(path.join(projectDir, 'SynProj_PLC.plcproj'), PLCPROJ(['POUs/MAIN.TcPOU', 'POUs/FB_UserOwnName.TcPOU', 'POUs/P_Opaque.TcPOU', 'GVLs/GVL_User.TcGVL']));
    fs.writeFileSync(path.join(projectDir, 'SynProj_PLC.tmc'), TMC);
    if (options.withDump !== false) fs.writeFileSync(path.join(ws, 'library-signatures.xml'), SIGNATURES);
    const archiveDir = path.join(projectDir, '_Libraries', 'synthetic co', 'synthetic motion library', '9.9.9.9');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, 'SynMotion.compiled-library'), archiveOf(ARCHIVE_NAMES));
    return { ws, projectDir, files: files.map(f => f[0]), cleanup: () => fs.rmSync(ws, { recursive: true, force: true }) };
}

module.exports = { buildSynthLibProject, SIGNATURES, TMC, ARCHIVE_NAMES, MAIN_DECL, MAIN_IMPL, pouXml, gvlXml, LEAK_MARKER: 'SYNTHETIC-DOC-TEXT-MUST-NOT-LEAK' };
