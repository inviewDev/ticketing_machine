import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chromium } from 'playwright';
import { createApp } from '../../server/app.mjs';
import { defaultPreferences, validatePreferences } from '../../shared/model.mjs';

test('오픈 전 회차 없이 직접 입력·저장·예약 대기·중지를 PC와 모바일 화면에서 진행한다', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  let runtime, server;
  try {
    const ticketContext = await browser.newContext();
    const requests = [];
    await ticketContext.route('**/*', route => {
      requests.push(route.request().url());
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<p>11:00 티켓오픈! (남은시간)</p>' });
    });
    let saved = { ...defaultPreferences(), selected: ['melon'], date: '2099-10-17', zones: 'A구역', urls: { melon: 'https://ticket.melon.com/performance/index.htm?prodId=213480' } };
    let scheduleCalls = 0;
    const browsers = {
      sessions: new Map([['melon', { context: ticketContext }]]),
      snapshot: () => ({ melon: { status: 'verified' } }),
      check: async () => ({ status: 'verified' }), close: async () => {},
      schedule: async () => { scheduleCalls++; throw new Error('아직 날짜 선택 화면이 열리지 않았습니다.'); },
    };
    runtime = createApp({ browsers, load: async () => saved, save: async input => (saved = validatePreferences(input)) });
    runtime.runner.elementWaitMs = 100;
    runtime.app.use(express.static(fileURLToPath(new URL('../../dist', import.meta.url))));
    const proxy = express();
    proxy.use('/api', (req, _res, next) => { req.headers.origin = 'http://127.0.0.1:5174'; next(); });
    proxy.use(runtime.app);
    server = proxy.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.getByText('아직 날짜 선택 화면이 열리지 않았습니다.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '좌석 선택 실행', exact: true }).isEnabled(), false);
    await page.getByLabel('회차 입력 방식', { exact: true }).selectOption('opening');
    await page.getByLabel('관람 회차 직접 입력', { exact: true }).fill('19:30');
    await page.getByLabel('예매 실행 시간 (한국 시간)', { exact: true }).fill(new Date(Date.now() + 9 * 3600000 + 25000).toISOString().slice(0, 19));
    assert.equal(await page.getByRole('button', { name: '예약 실행 대기', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: '설정 저장', exact: true }).click();
    await page.getByText('이 PC에 예매 설정을 저장했습니다.').waitFor();
    assert.equal(saved.sessionMode, 'opening');
    assert.equal(saved.time, '19:30');
    await mkdir('.local/audit', { recursive: true });
    await page.getByLabel('회차 입력 방식', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.local/audit/opening-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByLabel('관람 회차 직접 입력', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.local/audit/opening-mobile.png' });
    const callsBeforeReload = scheduleCalls;
    await page.reload();
    await page.getByLabel('관람 회차 직접 입력', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('관람 회차 직접 입력', { exact: true }).inputValue(), '19:30');
    await page.getByRole('button', { name: '예약 실행 대기', exact: true }).click();
    await page.locator('.job-content').getByText('아직 날짜·회차를 선택할 수 없습니다.', { exact: false }).waitFor();
    assert.equal(runtime.runner.state.status, 'scheduled');
    assert.equal(runtime.runner.state.jobs.melon.status, 'waiting_open');
    assert.equal(scheduleCalls, callsBeforeReload);
    assert.equal(requests.length, 1);
    await page.screenshot({ path: '.local/audit/opening-wait-mobile.png' });
    await page.getByRole('button', { name: '실행 중지', exact: true }).click();
    await page.locator('.run-state').getByText('실행 중지됨', { exact: true }).waitFor();
    assert.equal(runtime.runner.state.jobs.melon.canResume, false);
    assert.equal(requests.length, 1);
    assert.deepEqual(errors, []);
  } finally {
    await runtime?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await browser.close();
  }
});
