import { deflateRawSync } from 'zlib';

const GUEST_HEADERS = ['שם פרטי', 'שם משפחה', 'טלפון', 'אישור הגעה', 'תינוקות', 'הערות', 'נשלח בוואטסאפ', 'שולח', 'סכום מתנה', 'קישור תשלום', 'מוזמנים נוספים (+1)'];
const GUEST_SAMPLE = ['דנה', 'כהן', '0501234567', '', '', '', '', 'אמא של הכלה', '', '', ''];
const RESPONSE_HEADERS = ['שם', 'טלפון', 'סטטוס הגעה', 'מספר אורחים', 'תינוקות', 'טבעוני/צמחוני', 'הערות', 'מועד עדכון'];
const RESPONSE_SAMPLE = ['דנה כהן', '0501234567', 'מגיעים', '2', '0', '1', 'ללא גלוטן', '14.10.26 18:00'];

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i += 1) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return ~c >>> 0;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = deflateRawSync(file.data);
    const crc = crc32(file.data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0),
      u32(crc), u32(data.length), u32(file.data.length),
      u16(name.length), u16(0), name, data,
    ]);
    locals.push(local);
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0),
      u32(crc), u32(data.length), u32(file.data.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(central.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, central, end]);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function colName(index) {
  return String.fromCharCode(65 + index);
}

function cellXml(col, row, value, style) {
  return `<c r="${col}${row}" t="inlineStr" s="${style}"><is><t>${xmlEscape(value)}</t></is></c>`;
}

function sheetXml(headers, sample) {
  const headerCells = headers.map((title, index) => cellXml(colName(index), 1, title, 1)).join('');
  const sampleCells = sample.map((value, index) => cellXml(colName(index), 2, value, 2)).join('');
  const cols = headers.map((_, index) => {
    const width = Math.min(28, Math.max(14, String(headers[index]).length + 6));
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols}</cols>
<sheetData><row r="1" ht="22" customHeight="1">${headerCells}</row><row r="2">${sampleCells}</row></sheetData>
</worksheet>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="12"/><color rgb="FF3D3630"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF3E6D8"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFFBF7"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/></border>
<border><left style="thin"><color rgb="FFE4D5C4"/></left><right style="thin"><color rgb="FFE4D5C4"/></right><top style="thin"><color rgb="FFE4D5C4"/></top><bottom style="thin"><color rgb="FFE4D5C4"/></bottom></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" readingOrder="2"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" readingOrder="2"/></xf>
</cellXfs>
</styleSheet>`;
}

function workbook(sheetName, headers, sample) {
  const files = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    },
    { name: 'xl/styles.xml', data: Buffer.from(stylesXml()) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml(headers, sample)) },
  ];
  return zipStore(files);
}

/** Example guest workbook the user can upload to Google Sheets. */
export function buildExampleWorkbook() {
  return workbook('אורחים', GUEST_HEADERS, GUEST_SAMPLE);
}

/** Example answers workbook matching the RSVP response columns. */
export function buildExampleResponsesWorkbook() {
  return workbook('תשובות', RESPONSE_HEADERS, RESPONSE_SAMPLE);
}
