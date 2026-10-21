'use strict';

/**
 * Зашифрованное хранилище соответствий «значение <-> токен».
 * Шифр: AES-GCM-256, новый случайный IV при каждой записи.
 * Ключ: PBKDF2-SHA256, 600 000 итераций, соль 16 байт. Ключ живёт только в памяти страницы.
 * store: { get(key), set(key, value), remove(key) } — асинхронное хранилище (IndexedDB).
 */
function createVault(storageKey, store) {
  const ITER = 600000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const SEP = '\u0000';
  const TOKEN_RE = new RegExp(`\\[\\s*(${Object.values(KZDetect.LABELS).join('|')})\\s*_\\s*(\\d+)\\s*\\]`, 'g');
  let cachedKey = null;
  let chain = Promise.resolve();

  const toB64 = (buf) => {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const exclusive = (fn) => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };

  async function deriveKey(password, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const raw = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256);
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  const readBlob = async () => (await store.get(storageKey)) || null;
  async function decryptBlob(key, blob) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct));
    return JSON.parse(dec.decode(pt));
  }
  async function saveBlob(key, meta, data) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data)));
    await store.set(storageKey, { v: 1, kdf: 'PBKDF2-SHA256', iter: meta.iter, salt: meta.salt, iv: toB64(iv), ct: toB64(ct) });
  }

  const lock = () => { cachedKey = null; };
  async function load() {
    if (!cachedKey) throw new Error('LOCKED');
    const blob = await readBlob();
    if (!blob) { lock(); throw new Error('LOCKED'); }
    try { return { key: cachedKey, blob, data: await decryptBlob(cachedKey, blob) }; }
    catch { lock(); throw new Error('LOCKED'); }
  }

  const unlock = (password) => exclusive(async () => {
    if (!password) throw new Error('EMPTY_PASSWORD');
    const blob = await readBlob();
    let key;
    if (!blob) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      key = await deriveKey(password, salt, ITER);
      await saveBlob(key, { salt: toB64(salt), iter: ITER }, { counters: {}, items: [] });
    } else {
      key = await deriveKey(password, fromB64(blob.salt), blob.iter || ITER);
      try { await decryptBlob(key, blob); } catch { throw new Error('WRONG_PASSWORD'); }
    }
    cachedKey = key;
  });

  const maps = (data) => {
    const fwd = new Map(), rev = new Map();
    for (const it of data.items) { fwd.set(it.k + SEP + it.v, it.t); rev.set(it.t, it.v); }
    return { fwd, rev };
  };

  // Выдаёт токен для пары (тип, значение): одинаковое значение -> всегда один и тот же токен.
  function tokenFor(data, fwd, type, value) {
    const k = type + SEP + value;
    let tok = fwd.get(k), isNew = false;
    if (!tok) {
      const n = (data.counters[type] || 0) + 1;
      data.counters[type] = n;
      tok = `[${KZDetect.LABELS[type]}_${n}]`;
      data.items.push({ k: type, v: value, t: tok });
      fwd.set(k, tok);
      isNew = true;
    }
    return { tok, isNew };
  }

  // Пакетная замена: массив строк -> массив строк. Одна загрузка и одна запись таблицы на весь файл.
  const anonymizeMany = (texts) => exclusive(async () => {
    const { key, blob, data } = await load();
    const { fwd } = maps(data);
    let count = 0, added = 0;
    const out = texts.map((text) => {
      const ents = KZDetect.find(text);
      let res = '', pos = 0;
      for (const e of ents) {
        const t = tokenFor(data, fwd, e.type, e.value);
        if (t.isNew) added++;
        res += text.slice(pos, e.start) + t.tok;
        pos = e.end;
      }
      count += ents.length;
      return res + text.slice(pos);
    });
    if (added) await saveBlob(key, blob, data);
    return { texts: out, count, added };
  });

  // Принудительная замена: значение целиком получает токен заданного типа (режим «по столбцам»).
  const anonymizeForced = (items) => exclusive(async () => {
    const { key, blob, data } = await load();
    const { fwd } = maps(data);
    let added = 0;
    const out = items.map(({ text, type }) => {
      let t = type;
      if (t === 'ID') t = /^\d{2}(?:0[1-9]|1[0-2])[4-6]/.test(text) ? 'BIN' : 'IIN';
      if (!KZDetect.LABELS[t]) return text;
      const r = tokenFor(data, fwd, t, text);
      if (r.isNew) added++;
      return r.tok;
    });
    if (added) await saveBlob(key, blob, data);
    return { texts: out, count: items.length, added };
  });

  const anonymize = async (text) => {
    const r = await anonymizeMany([text]);
    return { text: r.texts[0], count: r.count, added: r.added };
  };

  // count — число подстановок в texts[0]; total — во всех строках.
  const restore = (texts) => exclusive(async () => {
    const { data } = await load();
    const { rev } = maps(data);
    let count = 0, total = 0;
    const out = texts.map((t, i) => t.replace(TOKEN_RE, (m, label, n) => {
      const v = rev.get(`[${label}_${n}]`);
      if (v === undefined) return m;
      total++;
      if (i === 0) count++;
      return v;
    }));
    return { texts: out, count, total };
  });

  const reset = () => exclusive(async () => { await store.remove(storageKey); lock(); });
  const exists = async () => !!(await readBlob());
  const isUnlocked = async () => !!cachedKey && !!(await readBlob());
  const exportBlob = () => readBlob();
  const importBlob = (b) => exclusive(async () => {
    const ok = b && typeof b === 'object' && ['salt', 'iv', 'ct'].every((k) => typeof b[k] === 'string') && Number.isInteger(b.iter);
    if (!ok) throw new Error('BAD_BACKUP');
    await store.set(storageKey, { v: 1, kdf: 'PBKDF2-SHA256', iter: b.iter, salt: b.salt, iv: b.iv, ct: b.ct });
    lock();
  });

  return { unlock, lock, anonymize, anonymizeMany, anonymizeForced, restore, reset, exists, isUnlocked, exportBlob, importBlob };
}
