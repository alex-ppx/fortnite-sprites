#!/usr/bin/env node
/*
 * Еженедельная проверка новых духов.
 *
 * Источник закрыт Cloudflare Turnstile: curl и headless-браузер получают челлендж,
 * поэтому запускаем обычный Chrome с окном и постоянным профилем — так проверка
 * проходится сама. Значит скрипт работает только на маке, где стоит Chrome,
 * и только когда мак включён.
 *
 * Что делает:
 *   1. читает страницу со списком духов;
 *   2. сверяет с data.js;
 *   3. новых дописывает В КОНЕЦ (порядок = порядок битов в кодах коллекций, ломать нельзя);
 *   4. обновляет изменившиеся шансы выпадения у старых;
 *   5. качает арты новых;
 *   6. коммитит и пушит — GitHub Pages подхватывает сам.
 *
 * Запуск вручную:  node tools/update-sprites.js
 * Проверка без записи:  node tools/update-sprites.js --dry
 */
const { chromium } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const SRC = 'https://fortnite.gg/sprites';
const DRY = process.argv.includes('--dry');
const log = (...a) => console.log(new Date().toISOString().slice(0, 16).replace('T', ' '), ...a);

function readData() {
  global.window = {};
  eval(fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8'));
  return global.window.SPRITES;
}

function writeData(list) {
  const js =
    '// Fortnite Sprites — 117 духов, данные и порядок 1:1 с fortnite.gg/sprites\n'.replace('117', String(list.length)) +
    '// ВАЖНО: порядок элементов = порядок битов в коде коллекции. Не менять и не сортировать этот массив.\n' +
    'window.SPRITES = ' + JSON.stringify(list) + ';\n';
  fs.writeFileSync(path.join(ROOT, 'data.js'), js);
}

function download(url, dest) {
  return new Promise((ok, err) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: SRC } }, res => {
      if (res.statusCode !== 200) return err(new Error('HTTP ' + res.statusCode + ' ' + url));
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => f.close(() => ok()));
    }).on('error', err);
  });
}

async function scrape() {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.chrome'), {
    channel: 'chrome', headless: false, viewport: { width: 1400, height: 1000 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(SRC, { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 45; i++) {                       // ждём, пока Cloudflare пропустит
      if (!/just a moment|attention required/i.test(await page.title().catch(() => ''))) break;
      await page.waitForTimeout(1000);
    }
    await page.waitForSelector('.sprite-card', { timeout: 30000 });
    return await page.$$eval('.sprite-card', cards => cards.map(c => {
      const pills = c.querySelectorAll('.sprite-pill');
      return {
        id: +c.dataset.sprite,
        n: c.querySelector('.sprite-name').textContent.trim(),
        p: c.dataset.parent,
        v: c.dataset.variant,
        r: c.dataset.rarity,
        d: parseFloat((pills[1] ? pills[1].textContent : '0').replace('%', '')) || 0,
        s: (c.querySelector('a[href*="/sprites/"]').getAttribute('href') || '').split('/').pop(),
        img: c.querySelector('img').getAttribute('src'),
      };
    }));
  } finally { await ctx.close(); }
}

(async () => {
  const have = readData();
  const known = new Set(have.map(s => s.id));
  log('в data.js:', have.length);

  let fresh;
  try { fresh = await scrape(); }
  catch (e) { log('НЕ УДАЛОСЬ прочитать источник:', e.message); process.exit(1); }
  log('на сайте:', fresh.length);

  if (fresh.length < 50) { log('подозрительно мало карточек — выхожу, ничего не трогаю'); process.exit(1); }

  // имя семейства = имя базового варианта
  const famName = {};
  fresh.forEach(s => { if (s.v === 'base') famName[s.p] = s.n; });

  const added = fresh.filter(s => !known.has(s.id));
  let changed = 0;
  have.forEach(old => {
    const cur = fresh.find(s => s.id === old.id);
    if (!cur) return;
    if (old.d !== cur.d || old.n !== cur.n || old.r !== cur.r) {
      old.d = cur.d; old.n = cur.n; old.r = cur.r; changed++;
    }
  });

  if (!added.length && !changed) { log('новых духов нет, менять нечего'); return; }
  log('новых:', added.length, '| обновлено у старых:', changed);
  added.forEach(s => log('  +', s.n, '(' + s.r + ', ' + s.d + '%)'));

  if (DRY) { log('--dry: ничего не записываю'); return; }

  for (const s of added) {                                // арты новых
    const dest = path.join(ROOT, 'img', s.id + '.webp');
    await download('https://fortnite.gg' + s.img, dest);
    if (fs.statSync(dest).size < 1000) throw new Error('битая картинка у ' + s.n);
  }

  // дописываем строго в конец — коды коллекций остаются валидными
  added.forEach(s => have.push({
    id: s.id, n: s.n, p: s.p, pn: famName[s.p] || s.n, v: s.v, r: s.r, d: s.d, s: s.s,
  }));
  writeData(have);

  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  if (!git('status', '--porcelain').trim()) { log('git не видит изменений'); return; }
  const msg = added.length
    ? 'Новые духи: ' + added.map(s => s.n).join(', ')
    : 'Обновлены шансы выпадения';
  git('add', '-A');
  git('-c', 'user.name=alex-ppx', '-c', 'user.email=zorinvl.all@gmail.com', 'commit', '-m', msg);
  git('push', 'origin', 'main');
  log('запушено:', msg, '| всего духов:', have.length);
})().catch(e => { log('ОШИБКА:', e.message); process.exit(1); });
