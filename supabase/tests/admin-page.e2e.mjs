// admin-page.e2e.mjs
// LOCAL TESTING ONLY. Opens the real admin page (admin/diesel-prices.html) in a real headless Chromium, as a file
// (the way it is used), and clicks through it against the local copy of Supabase (real Postgres, real PostgREST, both
// migrations). Only the sign-in service is a stand-in (see functions/rig.mjs).
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright  node --test supabase/tests/admin-page.e2e.mjs
//
// Needs Playwright with a Chromium browser. Without it, this test skips itself.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startRig } from './functions/rig.mjs';

const PAGE_FILE = process.env.PAGE_FILE || fileURLToPath(new URL('../../admin/diesel-prices.html', import.meta.url));
const ENTRY = process.env.ENTRY_MIGRATION || fileURLToPath(new URL('../migrations/20261009150000_diesel_price_entry.sql', import.meta.url));
const SHOTS = process.env.SHOTS_DIR || '';

let playwright = null;
try { playwright = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright'); } catch { /* not installed */ }

const ADMIN = randomUUID();
const PLAIN = randomUUID();
let rig, browser, context, page;
const rpcCalls = [];
const requests = [];   // every request the page makes to the stand-in Supabase: path, method, apikey header, authorization header
const stored = () => rig.sql('select monday, price_cents from public.fuel_prices order by monday').map(([m, c]) => `${m}:${c}`);
const text = (selector) => page.locator(selector).innerText();
// Wait until a box shows the final text (not the "Publishing..." that comes first).
const waitText = (selector, re) => page.waitForFunction(([sel, src, flags]) => new RegExp(src, flags).test(document.querySelector(sel).innerText), [selector, re.source, re.flags]);
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };

async function signIn(email, password) {
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('#signin-button');
}
async function enter(monday, price) {
  await page.fill('#monday', monday);
  await page.fill('#price', price);
  await page.click('#review-button');
}

describe('the admin page, in a real browser', { skip: playwright ? false : 'Playwright is not installed' }, () => {
  before(async () => {
    rig = await startRig({ extraMigrations: [ENTRY], withFunction: false });
    rig.sql(`insert into auth.users (id) values ('${ADMIN}'), ('${PLAIN}'); insert into public.platform_admins (user_id) values ('${ADMIN}');`);
    rig.registerLogin('admin@example.test', 'correct horse', ADMIN);
    rig.registerLogin('plain@example.test', 'battery staple', PLAIN);
    rig.registerLogin('expired@example.test', 'old token', ADMIN, { exp: Math.floor(Date.now() / 1000) - 60 });
    browser = await playwright.chromium.launch();
    context = await browser.newContext({ viewport: { width: 760, height: 900 } });
    await context.addInitScript((config) => { window.DIESEL_ADMIN_CONFIG = config; }, { url: rig.gatewayUrl, key: 'test-publishable-key' });
    page = await context.newPage();
    page.setDefaultTimeout(Number(process.env.PAGE_TIMEOUT_MS) || 30000);   // shorter when deliberately broken copies are tried
    page.on('request', (r) => { if (r.url().includes('/rpc/publish_diesel_price')) rpcCalls.push(JSON.parse(r.postData())); });
    page.on('request', (r) => { if (r.url().startsWith(rig.gatewayUrl)) requests.push({ path: new URL(r.url()).pathname, method: r.method(), apikey: r.headers().apikey, authorization: r.headers().authorization }); });
    await page.goto(pathToFileURL(PAGE_FILE).href);
  });
  after(async () => { await browser?.close(); await rig?.stop(); });

  test('1. it opens on the sign-in form and the rest is hidden', async () => {
    assert.equal(await page.locator('#signin').isVisible(), true);
    assert.equal(await page.locator('#app').isVisible(), false);
    await shot('1-signin');
  });

  test('2. a wrong password shows the sign-in error and keeps the form', async () => {
    await signIn('admin@example.test', 'wrong');
    await waitText('#signin-msg', /Sign-in failed/);
    assert.match(await text('#signin-msg'), /Sign-in failed: Invalid login credentials/);
    assert.equal(await page.inputValue('#password'), '', 'the password box is emptied');
    assert.equal(await page.locator('#app').isVisible(), false);
  });

  test('3. the right password opens the app; no prices yet; the Monday box starts on this week\'s Monday', async () => {
    await signIn('admin@example.test', 'correct horse');
    await page.waitForSelector('#app', { state: 'visible' });
    assert.match(await text('#who'), /Signed in as admin@example.test/);
    await page.waitForSelector('#prices-empty', { state: 'visible' });   // the list loads a moment after the app opens
    const monday = await page.inputValue('#monday');
    assert.equal(new Date(monday + 'T00:00:00Z').getUTCDay(), 1, `${monday} is a Monday`);
    assert.ok(new Date(monday + 'T00:00:00') <= new Date(), 'and not in the future');
    await shot('3-app');
  });

  test('4. a mistyped price is stopped in the page: nothing is sent', async () => {
    for (const bad of ['abc', '1534.705', '', '12345678', '15,3,4']) {
      await enter('2026-09-21', bad);
      assert.match(await text('#result'), /Type the price in EUR per 1000 litres with at most 2 decimals/, `for "${bad}"`);
      assert.equal(await page.locator('#review').isVisible(), false);
    }
    assert.equal(rpcCalls.length, 0);
  });

  test('5. a comma price is understood; review shows the exact sentence; publishing creates the first price', async () => {
    await enter('2026-09-21', '1 431,50');
    await page.waitForSelector('#review', { state: 'visible' });
    assert.equal(await text('#review-text'), 'Publish EUR 1,431.50 per 1000 L (EUR 1.4315 per litre) as the price in force on Monday 21 September 2026?');
    await shot('5-review');
    await page.click('#publish');
    await waitText('#result', /Published:/);
    assert.match(await text('#result'), /Published: EUR 1,431\.50 per 1000 L for Monday 21 September 2026\./);
    assert.deepEqual(rpcCalls.at(-1), { p_monday: '2026-09-21', p_eur_per_1000l: '1431.50', p_replace: false, p_accept_big_move: false }, 'the price travels as text');
    assert.deepEqual(stored(), ['2026-09-21:143150']);
    await waitText('#prices', /21 September 2026\s+1,431\.50\s+1\.4315/);   // the list refreshes a moment after the result box
  });

  test('6. Cancel in the review sends nothing', async () => {
    const before = rpcCalls.length;
    await enter('2026-09-28', '1500');
    await page.click('#cancel');
    assert.equal(await page.locator('#review').isVisible(), false);
    assert.equal(rpcCalls.length, before);
  });

  test('7. a big move is refused with the server\'s sentence; the override button publishes it and says so', async () => {
    await enter('2026-09-28', '1534.70');
    await page.click('#publish');
    await waitText('#result', /Nothing was published/);
    const refused = await text('#result');
    assert.match(refused, /1534\.70 is \+7\.21 % compared with 1431\.50 on 2026-09-21\. The limit is 5 %\./);
    assert.match(refused, /Nothing was published\./);
    assert.doesNotMatch(refused, /accept_big_move/, 'the page speaks to people, not to programs');
    assert.equal(await page.locator('#result .msg.warn').count(), 1, 'a refusal you can override is shown as a warning');
    assert.deepEqual(stored(), ['2026-09-21:143150']);
    await shot('7-big-move');
    await page.click('text=I checked the bulletin, publish anyway');
    await waitText('#result', /Published:/);
    const done = await text('#result');
    assert.match(done, /Published: EUR 1,534\.70 per 1000 L for Monday 28 September 2026\./);
    assert.match(done, /Compared with 21 September 2026 \(EUR 1,431\.50\): \+7\.21 %\./);
    assert.match(done, /more than 5 % away and you confirmed it/);
    assert.deepEqual(rpcCalls.at(-1), { p_monday: '2026-09-28', p_eur_per_1000l: '1534.70', p_replace: false, p_accept_big_move: true });
    assert.deepEqual(stored(), ['2026-09-21:143150', '2026-09-28:153470']);
    await waitText('#prices', /28 September 2026\s+1,534\.70\s+1\.5347\s+\+7\.21 %/);
    await shot('7-after');
  });

  test('8. a Monday that already has another price: the page offers "Replace", and a replacement of a small size goes through', async () => {
    await enter('2026-09-28', '1500');
    await page.click('#publish');
    await waitText('#result', /already has the price/);
    assert.match(await text('#result'), /2026-09-28 already has the price 1534\.70\./);
    assert.doesNotMatch(await text('#result'), /replace = true|accept_big_move|p_replace/, 'the page speaks to people, not to programs');
    assert.deepEqual(stored(), ['2026-09-21:143150', '2026-09-28:153470']);
    await page.click('text=Replace the stored price');
    await waitText('#result', /Replaced:/);
    assert.match(await text('#result'), /Replaced: EUR 1,500\.00 per 1000 L for Monday 28 September 2026\./);
    assert.deepEqual(rpcCalls.at(-1), { p_monday: '2026-09-28', p_eur_per_1000l: '1500', p_replace: true, p_accept_big_move: false });
    assert.deepEqual(stored(), ['2026-09-21:143150', '2026-09-28:150000']);
  });

  test('9. replacing with a big move needs both confirmations, one after the other', async () => {
    await enter('2026-09-28', '1700');
    await page.click('#publish');
    await page.waitForSelector('text=Replace the stored price');
    await page.click('text=Replace the stored price');
    await page.waitForSelector('text=I checked the bulletin, publish anyway');
    await page.click('text=I checked the bulletin, publish anyway');
    await waitText('#result', /Replaced:/);
    assert.deepEqual(rpcCalls.at(-1), { p_monday: '2026-09-28', p_eur_per_1000l: '1700', p_replace: true, p_accept_big_move: true });
    assert.deepEqual(stored(), ['2026-09-21:143150', '2026-09-28:170000']);
  });

  test('10. a date that is not a Monday: the server\'s sentence is shown and there is no override button', async () => {
    await enter('2026-09-29', '1500');
    await page.click('#publish');
    await waitText('#result', /is not a Monday/);
    assert.match(await text('#result'), /2026-09-29 is not a Monday\./);
    assert.equal(await page.locator('#result button').count(), 0);
    assert.equal(await page.locator('#result .msg.bad').count(), 1, 'a refusal you cannot override is shown as an error');
  });

  test('11. the same price again says "nothing changed"', async () => {
    await enter('2026-09-28', '1700.00');
    await page.click('#publish');
    await waitText('#result', /Already published/);
    assert.match(await text('#result'), /Already published with exactly this price, nothing changed/);
  });

  test('11b. a lower price shows a negative change in the list: 1650.00 after 1700.00 is -2.94 %', async () => {
    // (165000 - 170000) / 170000 = -5000 / 170000 = -0.029412 -> -294 bp
    await enter('2026-10-05', '1650');
    await page.click('#publish');
    await waitText('#result', /Published:/);
    await waitText('#prices', /5 October 2026\s+1,650\.00\s+1\.6500\s+-2\.94 %/);
    assert.deepEqual(stored(), ['2026-09-21:143150', '2026-09-28:170000', '2026-10-05:165000']);
  });

  test('12. sign out empties the screen, and nothing was ever stored in the browser', async () => {
    const storage = await page.evaluate(() => localStorage.length + sessionStorage.length);
    assert.equal(storage, 0);
    assert.deepEqual(await context.cookies(), []);
    await page.click('#signout');
    assert.equal(await page.locator('#app').isVisible(), false);
    assert.equal(await page.locator('#signin').isVisible(), true);
    assert.match(await text('#signin-msg'), /Signed out\./);
    assert.equal(await page.evaluate(() => token), null, 'the sign-in token is forgotten');
  });

  test('13. a signed-in user who is not a platform admin can look but not publish: the server\'s refusal is shown', async () => {
    await signIn('plain@example.test', 'battery staple');
    await page.waitForSelector('#app', { state: 'visible' });
    await waitText('#prices', /28 September 2026\s+1,700\.00/);
    await enter('2026-10-12', '1650');
    await page.click('#publish');
    await waitText('#result', /Only Manifest/);
    assert.match(await text('#result'), /Only Manifest platform admins can publish diesel prices\./);
    assert.equal(await page.locator('#result .msg.bad').count(), 1);
    assert.deepEqual(stored(), ['2026-09-21:143150', '2026-09-28:170000', '2026-10-05:165000']);
    await page.click('#signout');
  });

  test('14. an expired sign-in sends the person back to the sign-in form with an explanation', async () => {
    await signIn('expired@example.test', 'old token');
    await waitText('#signin-msg', /expired/);
    assert.match(await text('#signin-msg'), /Your sign-in has expired\. Please sign in again\./);
    assert.equal(await page.locator('#app').isVisible(), false);
  });

  test('14b. a sign-in that runs out while the person is reviewing is caught when they publish: back to sign-in, nothing published', async () => {
    // PostgREST still accepts a token for 30 seconds after its expiry time (measured: 29 s accepted, 31 s refused).
    // So a token that expired 25 seconds ago works for sign-in and for loading the list, and stops working about 6 seconds later.
    const exp = Math.floor(Date.now() / 1000) - 25;
    rig.registerLogin('short@example.test', 'short lived', ADMIN, { exp });
    await signIn('short@example.test', 'short lived');
    await page.waitForSelector('#app', { state: 'visible' });
    await enter('2026-10-12', '1650');
    await page.waitForSelector('#review', { state: 'visible' });
    const wait = (exp + 31) * 1000 + 700 - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    const before = stored();
    await page.click('#publish');
    await waitText('#signin-msg', /expired/);
    assert.match(await text('#signin-msg'), /Your sign-in has expired\. Please sign in again\./);
    assert.equal(await page.locator('#app').isVisible(), false);
    assert.deepEqual(stored(), before);
  });

  test('15. the page never puts server text into the page as HTML, and loads nothing from anywhere else', () => {
    const html = readFileSync(PAGE_FILE, 'utf8');
    assert.equal(/innerHTML|insertAdjacentHTML|document\.write|outerHTML/.test(html), false, 'text only goes in with textContent');
    assert.equal(/<script[^>]+src=|<link[^>]+href=|@import|<img|<iframe/i.test(html), false, 'no outside scripts, styles, images or frames');
    assert.equal(/localStorage|sessionStorage|document\.cookie|indexedDB/.test(html), false, 'no browser storage');
  });

  test('16. every request carries the project key; sign-in requests carry no token; every data request carries one', () => {
    assert.ok(requests.length > 20, `saw ${requests.length} requests`);
    for (const r of requests) assert.equal(r.apikey, 'test-publishable-key', `${r.method} ${r.path} carries the project key`);
    const signIns = requests.filter((r) => r.path === '/auth/v1/token');
    assert.ok(signIns.length >= 5, `saw ${signIns.length} sign-in requests`);
    for (const r of signIns) assert.equal(r.authorization, undefined, 'a sign-in request never carries an old token');
    const data = requests.filter((r) => r.path.startsWith('/rest/v1/'));
    assert.ok(data.length > 10);
    for (const r of data) assert.match(r.authorization || '', /^Bearer .+/, `${r.method} ${r.path} carries the token`);
  });
});
