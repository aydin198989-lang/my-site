'use strict';

const $ = (id) => document.getElementById(id);
const ERR = {
  WRONG_PASSWORD: 'Неверный пароль.',
  EMPTY_PASSWORD: 'Введите пароль.',
  LOCKED: 'Хранилище заблокировано. Введите пароль.',
  NOT_ZIP: 'Файл повреждён или это не .xlsx.',
  BAD_ZIP: 'Файл повреждён.',
  ENCRYPTED: 'Файл защищён паролем. Снимите защиту в Excel и повторите.',
  BAD_BACKUP: 'Это не резервная копия хранилища.',
};
const say = (id, t, bad = false) => { $(id).textContent = t; $(id).className = 'msg' + (bad ? ' bad' : ''); };

// ---------- Хранилище браузера (IndexedDB) ----------
const idb = (() => {
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open('kzanon', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => { db.close(); res(req.result); };
      t.onerror = () => { db.close(); rej(t.error); };
    });
  };
  return {
    get: (k) => tx('readonly', (s) => s.get(k)).then((v) => v || null),
    set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
    remove: (k) => tx('readwrite', (s) => s.delete(k)),
  };
})();

const vault = createVault('kzVault', idb);

async function refresh() {
  const exists = await vault.exists();
  const unlocked = await vault.isUnlocked();
  $('lock-card').hidden = unlocked;
  $('work').hidden = !unlocked;
  $('pw2').hidden = exists;
  $('unlock').textContent = exists ? 'Разблокировать' : 'Создать хранилище';
  $('state').textContent = exists ? '🔒 Хранилище заблокировано' : 'Хранилище не создано. Придумайте пароль.';
}

// ---------- Пароль ----------
$('unlock').addEventListener('click', async () => {
  const pw = $('pw').value;
  const exists = await vault.exists();
  if (!exists) {
    if (pw.length < 8) return say('lock-msg', 'Пароль — минимум 8 символов.', true);
    if (pw !== $('pw2').value) return say('lock-msg', 'Пароли не совпадают.', true);
  }
  $('unlock').disabled = true;
  say('lock-msg', 'Вычисляю ключ…');
  try {
    await vault.unlock(pw);
    $('pw').value = ''; $('pw2').value = '';
    say('lock-msg', '');
    if (!exists) say('smsg', 'Хранилище создано. Пароль восстановить нельзя — не теряйте его.');
  } catch (e) {
    say('lock-msg', ERR[e.message] || `Ошибка: ${e.message}`, true);
  }
  $('unlock').disabled = false;
  refresh();
});
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('unlock').click(); });
$('pw2').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('unlock').click(); });

$('lock').addEventListener('click', () => { vault.lock(); say('smsg', ''); refresh(); });

let resetArmed = false;
$('reset').addEventListener('click', async () => {
  if (!resetArmed) {
    resetArmed = true;
    $('reset').textContent = 'Точно удалить? Нажмите ещё раз';
    setTimeout(() => { resetArmed = false; $('reset').textContent = 'Удалить хранилище'; }, 4000);
    return;
  }
  resetArmed = false;
  $('reset').textContent = 'Удалить хранилище';
  await vault.reset();
  say('smsg', 'Хранилище удалено вместе со всеми соответствиями.');
  refresh();
});

// ---------- Резервная копия ----------
function download(blob, name, linkId) {
  const url = URL.createObjectURL(blob);
  const a = linkId ? $(linkId) : document.createElement('a');
  a.href = url; a.download = name;
  if (linkId) { a.textContent = `⬇ Скачать ещё раз: ${name}`; a.hidden = false; }
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

$('export').addEventListener('click', async () => {
  const b = await vault.exportBlob();
  if (!b) return say('smsg', 'Нечего сохранять.', true);
  download(new Blob([JSON.stringify(b)], { type: 'application/json' }), 'kz-vault-backup.json');
  say('smsg', 'Резервная копия скачана. Она зашифрована тем же паролем.');
});
const pickBackup = () => $('backup-file').click();
$('import').addEventListener('click', pickBackup);
$('import-lock').addEventListener('click', pickBackup);
$('backup-file').addEventListener('change', async () => {
  const f = $('backup-file').files[0];
  $('backup-file').value = '';
  if (!f) return;
  if (!confirm('Текущая таблица соответствий в этом браузере будет заменена копией из файла. Продолжить?')) return;
  try {
    await vault.importBlob(JSON.parse(await f.text()));
    say('lock-msg', 'Копия загружена. Введите пароль, с которым она была создана.');
  } catch (e) {
    say('lock-msg', ERR[e.message] || 'Не удалось прочитать файл.', true);
  }
  refresh();
});

// ---------- Файлы ----------
const getMode = () => document.querySelector('input[name=mode]:checked').value;

$('run').addEventListener('click', async () => {
  const f = $('file').files[0];
  const mode = getMode();
  $('prev').hidden = true; $('dl').hidden = true;
  if (!f) return say('msg', 'Сначала выберите файл.', true);
  if (/\.xls$/i.test(f.name)) return say('msg', 'Формат .xls не поддерживается. Сохраните файл как .xlsx.', true);
  if (!(await vault.isUnlocked())) { refresh(); return; }

  $('run').disabled = true;
  say('msg', 'Обрабатываю…');
  await new Promise((r) => setTimeout(r, 30));
  try {
    const isX = /\.xlsx$/i.test(f.name);
    const isCsv = /\.csv$/i.test(f.name);
    let res, blob;
    if (isX) {
      res = await KZCore.processXlsx(await f.arrayBuffer(), mode, { cols: $('cols').checked }, vault);
      blob = res.blob;
    } else {
      res = await KZCore.processText(await f.text(), mode, vault);
      blob = new Blob([(isCsv ? '\uFEFF' : '') + res.text], { type: 'text/plain;charset=utf-8' });
    }
    const name = KZCore.outName(f.name, mode);
    if (mode === 'anon') {
      let t = `Готово. Заменено значений: ${res.r.count} (новых токенов: ${res.r.added}).`;
      if (isX && $('cols').checked) {
        t += res.report.length
          ? `\nРаспознанные столбцы (${res.forcedCount} ячеек заменено целиком):\n• ${res.report.join('\n• ')}`
          : '\nЗаголовки столбцов не распознаны — использован обычный поиск по тексту.';
      }
      if (isX) t += '\nМетаданные файла (автор, организация) очищены.';
      t += '\nПросмотрите файл глазами перед отправкой ИИ: поиск эвристический.';
      say('msg', t);
    } else {
      const left = (res.texts.join('\n').match(KZCore.TOKEN_RE) || []).length;
      say('msg', `Готово. Восстановлено токенов: ${res.r.total}.` +
        (left ? `\nВНИМАНИЕ: в файле осталось ${left} неизвестных токенов (ИИ мог изменить их или они из другой таблицы).` : ''));
    }
    if (res.changes.length) {
      $('prevtxt').textContent = res.changes.map(([a, b]) => `${a.slice(0, 80)}\n  → ${b.slice(0, 80)}`).join('\n\n');
      $('prev').hidden = false;
    }
    download(blob, name, 'dl');
  } catch (e) {
    say('msg', ERR[e.message] || `Ошибка: ${e.message}`, true);
  } finally {
    $('run').disabled = false;
  }
});

// ---------- Текст ----------
async function textRun(mode) {
  const text = $('tin').value;
  if (!text.trim()) return say('tmsg', 'Вставьте текст.', true);
  try {
    const r = await KZCore.processText(text, mode, vault);
    $('tout').value = r.text;
    say('tmsg', mode === 'anon'
      ? `Заменено значений: ${r.r.count} (новых токенов: ${r.r.added}).`
      : `Восстановлено токенов: ${r.r.total}.`);
  } catch (e) {
    say('tmsg', ERR[e.message] || `Ошибка: ${e.message}`, true);
    if (e.message === 'LOCKED') refresh();
  }
}
$('t-anon').addEventListener('click', () => textRun('anon'));
$('t-rest').addEventListener('click', () => textRun('restore'));
$('t-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('tout').value); }
  catch { $('tout').select(); document.execCommand('copy'); }
  say('tmsg', 'Скопировано в буфер обмена.');
});

// ---------- Самотест (отдельное хранилище в памяти, реальные данные не затрагиваются) ----------
$('selftest').addEventListener('click', async () => {
  const log = [];
  try {
    const mem = new Map();
    const v = createVault('t', {
      get: async (k) => mem.get(k) || null,
      set: async (k, x) => { mem.set(k, x); },
      remove: async (k) => { mem.delete(k); },
    });
    await v.unlock('self-test-password');
    const src = 'Шактаев Айдын, ИИН 900101300123';
    const a = await v.anonymize(src);
    const a2 = await v.anonymize(src);
    const back = (await v.restore([a.text])).texts[0];
    const ok1 = a.text === '[ПЕРСОНА_1], ИИН [ИИН_1]' && a2.text === a.text && back === src;
    log.push(`${ok1 ? '✅' : '❌'} Основная фраза\n${src}\n→ ${a.text}\n← ${back}`);
    const big = 'Шактаев Айдын Серикович, ИИН 900101300123, тел. +7 (701) 123-45-67, e-mail a.shaktaev@mail.kz, ' +
      'ТОО «Ромашка», БИН 050140001234, IBAN KZ86125KZT5004100100. Шактаев А.Б. подписал договор.';
    const b = await v.anonymize(big);
    const bb = (await v.restore([b.text])).texts[0];
    log.push(`${bb === big ? '✅' : '❌'} Расширенный пример (возврат без потерь)\n→ ${b.text}`);
  } catch (e) {
    log.push('❌ Ошибка: ' + e.message);
  }
  $('log').hidden = false;
  $('log').textContent = log.join('\n\n');
});

refresh();
