// 读微信、支付宝导出的账单文件：CSV（支付宝是 GBK 编码）或 Excel（.xlsx，新版微信导出的是这个）。
// 不用第三方库：xlsx 是个 zip，用浏览器自带的 DecompressionStream 解压，再读里面的 XML。
// 返回二维数组（每行是字符串数组）。

export async function readTable(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0x50 && buf[1] === 0x4b) return readXlsx(buf); // PK：zip，也就是 xlsx
  return parseCsv(decodeText(buf));
}

// 先当 UTF-8 读，读不通就是 GBK（支付宝的 CSV）
export function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('gbk').decode(buf);
  }
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

// ---------- xlsx ----------

async function unzip(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('这个 Excel 文件打不开（可能还是压缩包，先解压）');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    files[name] = { method, size, offset };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return async (name) => {
    const f = files[name];
    if (!f) return null;
    const start = f.offset + 30 + view.getUint16(f.offset + 26, true) + view.getUint16(f.offset + 28, true);
    const data = buf.subarray(start, start + f.size);
    if (f.method === 0) return new TextDecoder().decode(data);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  };
}

async function readXlsx(buf) {
  const read = await unzip(buf);
  const xml = (text) => new DOMParser().parseFromString(text, 'application/xml');
  const shared = [];
  const ss = await read('xl/sharedStrings.xml');
  if (ss) for (const si of xml(ss).getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
  // 第一个工作表：看 workbook 里的第一个 sheet 对应哪个文件，找不到就用 sheet1.xml
  let path = 'xl/worksheets/sheet1.xml';
  const wb = await read('xl/workbook.xml');
  const rels = await read('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const first = xml(wb).getElementsByTagName('sheet')[0];
    const rid = first?.getAttribute('r:id') || first?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const rel = [...xml(rels).getElementsByTagName('Relationship')].find((r) => r.getAttribute('Id') === rid);
    if (rel) path = `xl/${rel.getAttribute('Target').replace(/^\/?xl\//, '')}`;
  }
  const sheet = await read(path);
  if (!sheet) throw new Error('Excel 里没找到表格');
  const rows = [];
  for (const r of xml(sheet).getElementsByTagName('row')) {
    const row = [];
    for (const c of r.getElementsByTagName('c')) {
      const col = colIndex(c.getAttribute('r') || '') ?? row.length;
      const t = c.getAttribute('t');
      let v = '';
      if (t === 's') v = shared[Number(c.getElementsByTagName('v')[0]?.textContent)] ?? '';
      else if (t === 'inlineStr') v = [...c.getElementsByTagName('t')].map((x) => x.textContent).join('');
      else v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      row[col] = v.trim();
    }
    rows.push(Array.from(row, (x) => x ?? ''));
  }
  return rows;
}

function colIndex(ref) {
  const m = ref.match(/^([A-Z]+)/);
  if (!m) return null;
  return [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}
