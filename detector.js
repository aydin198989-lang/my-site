'use strict';

/**
 * Поиск персональных данных. Только регулярные выражения и эвристики, без внешних библиотек.
 * ИИН/БИН намеренно НЕ проверяются по контрольной цифре: лучше замаскировать лишнее,
 * чем пропустить номер с опечаткой. На восстановление это не влияет.
 */
const KZDetect = (() => {
  const LABELS = {
    PERSON: 'ПЕРСОНА', IIN: 'ИИН', BIN: 'БИН', PHONE: 'ТЕЛЕФОН',
    EMAIL: 'EMAIL', IBAN: 'IBAN', ORG: 'ОРГАНИЗАЦИЯ',
  };

  const STOP = new Set((
    'иин бин жсн бсн тоо жшс ао ақ ип гр тел email iban ' +
    'договор договора соглашение приложение статья кодекс закон суд районный областной городской ' +
    'республика республики казахстан казахстана российская федерация алматы астана шымкент ' +
    'гражданин гражданина гражданину гражданка гражданки господин госпожа истец истца ответчик ответчика ' +
    'заявитель заявителя директор директора нотариус адвокат юрист представитель свидетель потерпевший ' +
    'подозреваемый обвиняемый подсудимый заказчик исполнитель покупатель продавец арендатор арендодатель ' +
    'работник работодатель банк клиент должник кредитор сторона стороны председатель судья прокурор ' +
    'қазақстан республикасы сот'
  ).split(' '));

  const CASE_END = '(?:а|у|ым|ом|ем|е|ой|ою|ых|ы)?';
  const SURN = new RegExp(`^\\p{L}{2,}(?:[оеё]в|[иы]н)${CASE_END}$`, 'u');
  const STRONG = new RegExp(`^\\p{L}{2,}[оеё]в${CASE_END}$`, 'u');
  const PATR = new RegExp(
    '^\\p{L}{2,}(?:[ео]вич|ьич|[ео]вн|инич|ичн|[ұу]лы|[қк]ызы|оглы)(?:а|у|ем|е|ы|ой|ою|ом)?$', 'u');

  const RE = {
    email: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}/g,
    iban: /(?<![A-Za-z0-9])KZ\d{2}(?: ?[A-Z0-9]{4}){4}(?![A-Za-z0-9])/gi,
    org: /(?<![\p{L}\p{N}])(?:ТОО|ЖШС|АО|АҚ)[ \t\u00A0]*(?:«[^»\n]{1,100}»|"[^"\n]{1,100}"|“[^”\n]{1,100}”|\p{Lu}[\p{L}\p{N}\-]*(?:[ \t\u00A0]+\p{Lu}[\p{L}\p{N}\-]*)?)/gu,
    id12: /(?<!\d)\d{12}(?!\d)/g,
    phone: /(?<![\d\p{L}])(?:\+7|8)[ \-\u00A0]?\(?\d{3}\)?[ \-\u00A0]?\d{3}[ \-\u00A0]?\d{2}[ \-\u00A0]?\d{2}(?!\d)/gu,
    surInit: /(?<![\p{L}\p{N}\-])\p{Lu}[\p{L}\-]{2,}[ \t\u00A0]+\p{Lu}\.[ \t\u00A0]?(?:\p{Lu}\.)?/gu,
    initSur: /(?<![\p{L}\p{N}])\p{Lu}\.[ \t\u00A0]?(?:\p{Lu}\.[ \t\u00A0]?)?\p{Lu}[\p{L}\-]{2,}/gu,
    run: /(?<![\p{L}\p{N}\-])\p{Lu}\p{L}+(?:-\p{Lu}\p{L}+)?(?:[ \t\u00A0]+\p{Lu}\p{L}+(?:-\p{Lu}\p{L}+)?)*/gu,
  };

  function wordInfo(s, e, raw) {
    const low = raw.toLowerCase();
    const tail = low.split('-').pop();
    const pat = PATR.test(tail);
    return { s, e, stop: STOP.has(low), pat, sur: !pat && SURN.test(tail), strong: !pat && STRONG.test(tail) };
  }

  function personSpans(ws) {
    const n = ws.length, used = Array(n).fill(false), spans = [];
    const take = (s, e) => { for (let k = s; k <= e; k++) used[k] = true; spans.push([ws[s].s, ws[e].e]); };
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const w = ws[i];
      if (w.pat) {
        const s = i > 0 && !used[i - 1] ? i - 1 : i;
        let e = i;
        if (i + 1 < n && !used[i + 1] && ws[i + 1].sur) e = i + 1;
        take(s, e);
      } else if (w.sur) {
        let s = i, e = i;
        if (i + 1 < n && !used[i + 1]) {
          e = i + 1;
          if (ws[e].pat) { if (e + 1 < n && !used[e + 1] && ws[e + 1].sur) e = e + 1; }
          else if (i + 2 < n && !used[i + 2] && ws[i + 2].pat) e = i + 2;
        } else if (i > 0 && !used[i - 1]) {
          s = i - 1;
        }
        if (s !== e || w.strong) take(s, e);
      }
    }
    return spans;
  }

  function find(text) {
    const taken = [], found = [];
    const free = (a, b) => !taken.some(([x, y]) => a < y && b > x);
    const add = (a, b, type) => {
      if (b > a && free(a, b)) { taken.push([a, b]); found.push({ start: a, end: b, type, value: text.slice(a, b) }); }
    };
    const each = (re, fn) => { for (const m of text.matchAll(re)) fn(m, m.index, m.index + m[0].length); };

    each(RE.email, (m, a, b) => add(a, b, 'EMAIL'));
    each(RE.iban, (m, a, b) => add(a, b, 'IBAN'));

    each(RE.org, (m, a) => {
      let val = m[0];
      if (!/[«"“]/.test(val)) {
        const parts = val.split(/([ \t\u00A0]+)/);
        while (parts.length > 3 && STOP.has(parts[parts.length - 1].toLowerCase())) parts.splice(-2, 2);
        val = parts.join('');
      }
      add(a, a + val.length, 'ORG');
    });

    each(RE.id12, (m, a, b) => {
      const ctx = text.slice(Math.max(0, a - 14), a).toUpperCase();
      const last = (...keys) => Math.max(...keys.map((k) => ctx.lastIndexOf(k)));
      const bin = last('БИН', 'БСН', 'BIN'), iin = last('ИИН', 'ЖСН', 'IIN');
      const type = bin > iin ? 'BIN' : iin > bin ? 'IIN'
        : (/^\d{2}(?:0[1-9]|1[0-2])[4-6]/.test(m[0]) ? 'BIN' : 'IIN');
      add(a, b, type);
    });

    each(RE.phone, (m, a, b) => add(a, b, 'PHONE'));

    each(RE.surInit, (m, a) => {
      const t = m[0].trimEnd();
      if (!STOP.has(t.split(/[ \t\u00A0]/)[0].toLowerCase())) add(a, a + t.length, 'PERSON');
    });
    each(RE.initSur, (m, a, b) => {
      if (!STOP.has(m[0].split(/[ \t\u00A0.]+/).pop().toLowerCase())) add(a, b, 'PERSON');
    });

    each(RE.run, (m, a) => {
      const wre = /[^ \t\u00A0]+/g;
      let w, chunk = [];
      const flush = () => { personSpans(chunk).forEach(([s, e]) => add(s, e, 'PERSON')); chunk = []; };
      while ((w = wre.exec(m[0]))) {
        const info = wordInfo(a + w.index, a + w.index + w[0].length, w[0]);
        if (info.stop) flush(); else chunk.push(info);
      }
      flush();
    });

    return found.sort((x, y) => x.start - y.start);
  }

  return { find, LABELS };
})();
