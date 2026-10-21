'use strict';

/**
 * Обработка файлов (xlsx, csv, txt) без привязки к странице.
 * api: { anonymizeMany(texts), anonymizeForced(items), restore(texts) } — методы хранилища.
 */
const KZCore = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const TOKEN_RE = /\[\s*(?:ПЕРСОНА|ИИН|БИН|ТЕЛЕФОН|EMAIL|IBAN|ОРГАНИЗАЦИЯ)\s*_\s*\d+\s*\]/g;
  const LABEL = { PERSON: 'ФИО', IIN: 'ИИН', BIN: 'БИН', ID: 'ИИН/БИН', PHONE: 'телефон', EMAIL: 'email', IBAN: 'IBAN', ORG: 'организация' };

  const unesc = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e];
  });
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const TARGET = /^xl\/(sharedStrings\.xml|worksheets\/[^/]+\.xml|comments[^/]*\.xml)$/;
  const META = /^docProps\/(core|app)\.xml$/;
  const BLOCK_RE = /<(si|is|text)((?:\s[^>]*)?)>([\s\S]*?)<\/\1>/g;
  const T_RE = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  const NUM_CELL_RE = /<c\b([^>]*)>\s*<v>(\d{10,13})<\/v>\s*<\/c>/g;
  const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const PH_RE = /\u0001(\d+)\u0002/g;
  const FPH_RE = /\u0003(\d+)\u0004/g;
  const PH = (i) => `\u0001${i}\u0002`;

  /** Заменяет текстовые блоки метками-заглушками; сами тексты копит в texts, а сборщики — в builders. */
  function prepare(xml, isSheet, mode, texts, builders) {
    xml = xml.replace(BLOCK_RE, (m, tag, attrs, inner) => {
      inner = inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').replace(/<phoneticPr\b[^>]*\/>/g, '');
      const ts = [...inner.matchAll(T_RE)];
      if (!ts.length) return m;
      const text = ts.map((t) => unesc(t[1])).join('');
      if (!text.trim()) return m;
      const i = texts.push(text) - 1;
      builders[i] = (res) => {
        let first = true;
        const ni = inner.replace(T_RE, () => {
          if (first) { first = false; return `<t xml:space="preserve">${esc(res)}</t>`; }
          return '<t></t>';
        });
        return `<${tag}${attrs}>${ni}</${tag}>`;
      };
      return PH(i);
    });
    if (isSheet && mode === 'anon') { // ИИН и телефоны, записанные в Excel как числа
      xml = xml.replace(NUM_CELL_RE, (m, attrs, v) => {
        if (/\bt="/.test(attrs) && !/\bt="n"/.test(attrs)) return m;
        const i = texts.push(v) - 1;
        builders[i] = (res) => (res === v ? m
          : `<c${attrs.replace(/\s+t="n"/, '')} t="inlineStr"><is><t xml:space="preserve">${esc(res)}</t></is></c>`);
        return PH(i);
      });
    }
    return xml;
  }

  const cleanMeta = (xml) => xml.replace(/<(dc:creator|cp:lastModifiedBy|Company|Manager)>[\s\S]*?<\/\1>/g, '<$1></$1>');

  // ---------- Режим «по столбцам» ----------
  const HDR = [
    ['BIN', /(?<![\p{L}])(бин|бсн)(?![\p{L}])/u],
    ['IIN', /(?<![\p{L}])(иин|жсн)(?![\p{L}])/u],
    ['PHONE', /(?<![\p{L}])(телефон|тел(?![\p{L}])|моб|сотов|phone|байланыс)/u],
    ['EMAIL', /(e-?mail|почт|пошта)/u],
    ['IBAN', /(iban|(расчетный|банковский|текущий)\s+счет|иик|(?<![\p{L}])шот(?![\p{L}]))/u],
    ['PERSON', /(?<![\p{L}])(фио|ф\.\s?и\.\s?о|фамили|имя(?![\p{L}])|отчество|заемщик|должник|сотрудник|работник|аты-?жөні|тегі|аты(?![\p{L}]))/u],
    ['ORG', /(?<![\p{L}])(организаци|компани|контрагент|ұйым|юридическ|тоо(?![\p{L}]))/u],
  ];

  function headerType(h) {
    const s = h.toLowerCase().replace(/ё/g, 'е');
    if (s.length > 60) return null;
    const hit = HDR.filter(([, re]) => re.test(s)).map(([t]) => t);
    if (hit.includes('BIN') && hit.includes('IIN')) return 'ID';
    return hit[0] || null;
  }

  function parseSst(xml) {
    return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      [...m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(T_RE)].map((t) => unesc(t[1])).join(''));
  }

  function blankSst(xml, idxs) {
    const set = new Set(idxs);
    let i = 0;
    return xml.replace(/<si>[\s\S]*?<\/si>/g, (m) => (set.has(i++) ? '<si><t></t></si>' : m));
  }

  function cellInfo(attrs, inner, sst) {
    const ref = attrs.match(/\br="([A-Z]+)(\d+)"/);
    if (!ref) return null;
    const t = (attrs.match(/\bt="([^"]*)"/) || [])[1];
    let value = '', sstIdx = -1;
    if (inner) {
      if (t === 's') {
        const v = inner.match(/<v>(\d+)<\/v>/);
        if (v) { sstIdx = +v[1]; value = sst[sstIdx] || ''; }
      } else if (t === 'inlineStr') {
        value = [...inner.matchAll(T_RE)].map((x) => unesc(x[1])).join('');
      } else {
        const v = inner.match(/<v>([^<]*)<\/v>/);
        value = v ? unesc(v[1]) : '';
      }
    }
    return { col: ref[1], row: +ref[2], value: value.trim(), sstIdx };
  }

  function columnPass(xml, sst, forced, keep, gone, report) {
    const rows = {};
    for (const m of xml.matchAll(CELL_RE)) {
      const c = cellInfo(m[1], m[2], sst);
      if (!c || !c.value) continue;
      if (c.row > 15) break;
      const r = (rows[c.row] = rows[c.row] || { hits: {}, filled: 0, names: {} });
      r.filled++;
      const type = headerType(c.value);
      if (type) { r.hits[c.col] = type; r.names[c.col] = c.value; }
    }
    let best = 0, bestScore = 0;
    for (const [row, r] of Object.entries(rows)) {
      const n = Object.keys(r.hits).length;
      if (!n) continue;
      const score = n * 100 + r.filled;
      if (score > bestScore) { bestScore = score; best = +row; }
    }
    if (!best) return xml;
    const cols = rows[best].hits;
    for (const [col, type] of Object.entries(cols)) report.push(`«${rows[best].names[col]}» (столбец ${col}) → ${LABEL[type]}`);

    return xml.replace(CELL_RE, (full, attrs, inner) => {
      const c = cellInfo(attrs, inner, sst);
      if (!c || c.row <= best) return full;
      const type = cols[c.col];
      const isForced = type && c.value && /[\p{L}\p{N}]/u.test(c.value) && !/^\[[^\]]+_\d+\]$/.test(c.value);
      if (!isForced) {
        if (c.sstIdx >= 0) keep.add(c.sstIdx);
        return full;
      }
      if (c.sstIdx >= 0) gone.add(c.sstIdx);
      const i = forced.push({ text: c.value.replace(/\s+/g, ' '), type }) - 1;
      return `<c${attrs.replace(/\s+t="[^"]*"/, '')} t="inlineStr">\u0003${i}\u0004</c>`;
    });
  }

  // ---------- Форматы ----------
  async function processXlsx(buf, mode, opts, api) {
    const entries = ZipLib.read(new Uint8Array(buf));
    const files = [];
    for (const e of entries) {
      if (TARGET.test(e.name)) {
        files.push({ e, xml: dec.decode(await ZipLib.getData(e)) });
      } else if (mode === 'anon' && META.test(e.name)) {
        await ZipLib.setData(e, enc.encode(cleanMeta(dec.decode(await ZipLib.getData(e)))));
      }
    }

    const forced = [], report = [];
    if (mode === 'anon' && opts.cols) {
      const sstFile = files.find((f) => /sharedStrings\.xml$/.test(f.e.name));
      const sst = sstFile ? parseSst(sstFile.xml) : [];
      const keep = new Set(), gone = new Set();
      for (const f of files) {
        if (f.e.name.startsWith('xl/worksheets/')) f.xml = columnPass(f.xml, sst, forced, keep, gone, report);
      }
      if (sstFile && gone.size) sstFile.xml = blankSst(sstFile.xml, [...gone].filter((i) => !keep.has(i)));
    }

    const texts = [], builders = [];
    for (const f of files) f.xml = prepare(f.xml, f.e.name.startsWith('xl/worksheets/'), mode, texts, builders);

    let r = { texts: [], count: 0, added: 0, total: 0 };
    if (texts.length) r = await (mode === 'anon' ? api.anonymizeMany(texts) : api.restore(texts));
    let rf = { texts: [], count: 0, added: 0 };
    if (forced.length) rf = await api.anonymizeForced(forced);

    for (const { e, xml } of files) {
      const final = xml
        .replace(PH_RE, (m, i) => builders[i](r.texts[i] === undefined ? texts[i] : r.texts[i]))
        .replace(FPH_RE, (m, i) => `<is><t xml:space="preserve">${esc(rf.texts[i])}</t></is>`);
      await ZipLib.setData(e, enc.encode(final));
    }

    const changes = [];
    forced.forEach((f, i) => { if (changes.length < 8) changes.push([f.text, rf.texts[i]]); });
    texts.forEach((t, i) => { if (r.texts[i] !== t && changes.length < 15) changes.push([t, r.texts[i]]); });
    const total = { ...r, count: (r.count || 0) + forced.length, added: (r.added || 0) + (rf.added || 0) };
    return { blob: ZipLib.write(entries), r: total, texts: r.texts, changes, report, forcedCount: forced.length };
  }

  async function processText(text, mode, api) {
    const lines = text.split('\n');
    const r = await (mode === 'anon' ? api.anonymizeMany(lines) : api.restore(lines));
    const changes = [];
    lines.forEach((t, i) => { if (r.texts[i] !== t && changes.length < 15) changes.push([t, r.texts[i]]); });
    return { text: r.texts.join('\n'), r, texts: r.texts, changes, report: [], forcedCount: 0 };
  }

  function outName(name, mode) {
    const i = name.lastIndexOf('.');
    const base = i > 0 ? name.slice(0, i) : name, ext = i > 0 ? name.slice(i) : '';
    return mode === 'anon' ? `${base}_обезличено${ext}` : `${base.replace(/_обезличено$/, '')}_восстановлено${ext}`;
  }

  return { processXlsx, processText, outName, TOKEN_RE };
})();
