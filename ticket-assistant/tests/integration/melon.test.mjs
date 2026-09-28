import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Runner } from '../../server/automation.mjs';
import { melonSelectors, revealMelonDate } from '../../server/melon.mjs';
import { defaultPreferences } from '../../shared/model.mjs';
import { readLoginSignals } from '../../server/browser.mjs';
import { readPerformanceSchedule } from '../../server/schedule.mjs';

// Offline Chromium fixtures reproduce the public date/time DOM of product 213480.
// Login and seat responses are fixtures; this suite does not prove live seat booking.
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const config = () => ({ ...defaultPreferences(), selected: ['melon'], date: '2099-10-17', time: '19:30', zones: 'A구역', urls: { melon: 'https://ticket.melon.com/performance/index.htm?prodId=213480' } });

function timeRow(time = '19시 30분', day = '20991017', id = 'evening') {
  return `<li class="item_time" data-perfday="${day}" data-scheduleno="${id}"><button id="${id}"><span class="txt">${time}\n<span class="soldouttext"></span></span><p class="casting-name">출연 : 테스트 배우</p></button></li>`;
}
function markup({ delayed = false, canvas = false, duplicates = false, captcha = false } = {}) {
  const rows = timeRow('14시 30분', '20991017', 'matinee') + timeRow() + (duplicates ? timeRow('19시 30분', '20991017', 'duplicate') : '');
  return `<!doctype html><meta charset="utf-8"><button class="type_list">목록 보기</button>
    <div id="box_calendar"><button class="ticketCalendarBtn" data-perfday="20990917">17</button></div>
    <div id="box_list_date" hidden><ul id="list_date"><li class="item_date" data-perfday="20991017"><button id="date">10월 17일</button></li></ul></div>
    <ul id="list_time">${delayed ? '' : rows}</ul><button id="ticketReservation_Btn">예매하기</button>
    ${captcha ? '<div id="verification" hidden><h2>인증예매</h2><input placeholder="대소문자 구분없이 문자입력"><button id="manual-done">입력완료</button></div>' : ''}
    <div id="seat-map" hidden>${canvas ? '<canvas width="100" height="100"></canvas>' : '<button data-seat-id="seat-1" data-zone="A구역" data-row="3" data-seat-no="1" aria-selected="false">A구역 3열 1번</button>'}</div>
    <script>
      window.clicks = [];
      document.querySelector('.type_list').onclick = function() { window.clicks.push('list'); this.classList.add('show'); document.querySelector('#box_list_date').hidden = false; document.querySelector('#box_calendar').hidden = true; };
      document.querySelector('#date').onclick = () => { window.clicks.push('date'); ${delayed ? `setTimeout(() => document.querySelector('#list_time').innerHTML = ${JSON.stringify(rows)}, 100);` : ''} };
      document.querySelector('#list_time').onclick = event => { const button = event.target.closest('button'); if (button) window.clicks.push(button.id); };
      document.querySelector('#ticketReservation_Btn').onclick = () => { window.clicks.push('entry'); document.querySelector('#seat-map').hidden = false; ${captcha ? "document.querySelector('#verification').hidden = false;" : ''} };
      // A manual completion fixture only, with no actual CAPTCHA or verification request.
      document.querySelector('#manual-done')?.addEventListener('click', () => document.querySelector('#verification').hidden = true);
      document.querySelector('[data-seat-id]')?.addEventListener('click', event => { window.clicks.push('seat'); event.currentTarget.setAttribute('aria-selected', 'true'); });
    </script>`;
}
async function withPage(html, fn) {
  const context = await browser.newContext();
  try {
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
    const page = await context.newPage();
    await page.goto(config().urls.melon);
    await fn(page, context);
  } finally { await context.close(); }
}

test('기존 시간 검색은 멜론의 한국어 시간·출연진 버튼을 찾지 못하고 전용 검색은 정확한 회차만 찾는다', async () => {
  await withPage(markup(), async page => {
    assert.equal(await page.getByRole('button', { name: '19:30', exact: true }).count(), 0);
    assert.equal(await page.locator('[data-perfday="20991017"]').count(), 3);
    const locator = page.locator(melonSelectors(config()).time[0]);
    assert.equal(await locator.count(), 1);
    assert.equal(await locator.getAttribute('id'), 'evening');
  });
});

test('현재 달에 없는 날짜는 사이트 목록 보기로 전환하여 정확한 연월일을 선택한다', async () => {
  await withPage(markup(), async page => {
    await revealMelonDate(page.frames(), config());
    await page.locator(melonSelectors(config()).date[0]).click();
    await revealMelonDate(page.frames(), config());
    assert.deepEqual(await page.evaluate(() => window.clicks), ['list', 'date']);
  });
});

test('시간을 표시하는 텍스트만 비교하며 다른 날짜·분·시간 일부가 일치하는 버튼을 제외한다', async () => {
  const html = '<ul id="list_time">' + timeRow('19시 00분') + timeRow('119시 30분', '20991017', 'wrong-hour') + timeRow('19시 30분', '20991018', 'wrong-date') + timeRow('19:30', '20991017', 'wanted') + '</ul>';
  await withPage(html, async page => {
    assert.deepEqual(await page.locator(melonSelectors(config()).time[0]).evaluateAll(els => els.map(el => el.id)), ['wanted']);
  });
});

test('한 자리 시각과 선예매·매진임박 부가표시를 가진 회차도 읽는다', async () => {
  await withPage('<ul id="list_time">' + timeRow('9시 5분<span>선예매</span>') + '</ul>', async page => {
    assert.equal(await page.locator(melonSelectors({ ...config(), time: '09:05' }).time[0]).count(), 1);
  });
});

async function exercise(options, fn) {
  await withPage(markup(options), async (originalPage, context) => {
    const browsers = { sessions: new Map([['melon', { context }]]), check: async () => ({ status: 'verified' }) };
    const runner = new Runner(browsers, () => {}, { elementWaitMs: 300, pollMs: 15, afterClickMs: 0 });
    await runner.start(config());
    await runner.task;
    await fn(runner, runner.pages('melon')[0], originalPage);
  });
}

test('관람 시간 입력 전에도 멜론 날짜를 선택하여 실제 회차를 조회한다', async () => {
  await withPage(markup({ delayed: true }), async page => {
    const result = await readPerformanceSchedule({ page, id: 'melon', date: config().date, timeoutMs: 1000 });
    assert.deepEqual(result.sessions.map(s => s.time), ['14:30', '19:30']);
    assert.ok(result.sessions.every(s => s.casting === '테스트 배우'));
    assert.deepEqual(await page.evaluate(() => window.clicks), ['list', 'date']);
  });
});

test('실제 Chromium 클릭으로 목록→날짜→지연 회차→예매→DOM 좌석 선택을 진행한다', async () => {
  await exercise({ delayed: true }, async (runner, page, originalPage) => {
    assert.equal(runner.state.jobs.melon.status, 'selected');
    assert.deepEqual(await page.evaluate(() => window.clicks), ['list', 'date', 'evening', 'entry', 'seat']);
    assert.deepEqual(await originalPage.evaluate(() => window.clicks), []);
  });
});

test('같은 시각의 회차가 여러 개라면 임의로 하나를 선택하지 않고 회차 단계에서 멈춘다', async () => {
  await exercise({ duplicates: true }, async (runner, page) => {
    assert.equal(runner.state.jobs.melon.phase, 'time');
    assert.equal(runner.state.jobs.melon.status, 'waiting');
    assert.deepEqual(await page.evaluate(() => window.clicks), ['list', 'date']);
  });
});

test('읽을 수 없는 캔버스 좌석도를 성공으로 표시하지 않는다', async () => {
  await exercise({ canvas: true }, async (runner, page) => {
    assert.equal(runner.state.jobs.melon.status, 'waiting');
    assert.match(runner.state.jobs.melon.message, /캔버스/);
    assert.deepEqual(await page.evaluate(() => window.clicks), ['list', 'date', 'evening', 'entry']);
  });
});

test('인증예매 화면에서는 좌석을 클릭하지 않고 사용자가 완료한 뒤 같은 창에서 이어간다', async () => {
  await exercise({ captcha: true }, async (runner, page) => {
    assert.equal(runner.state.status, 'waiting');
    assert.equal(runner.state.jobs.melon.blockedBy, 'security');
    assert.equal(runner.state.jobs.melon.phase, 'zone');
    assert.deepEqual(await page.evaluate(() => window.clicks), ['list', 'date', 'evening', 'entry']);
    const url = page.url();
    await runner.resume('melon', { runId: runner.state.runId, phase: 'zone' });
    await runner.task;
    assert.equal(runner.state.status, 'waiting');
    assert.equal(await page.locator('[data-seat-id]').getAttribute('aria-selected'), 'false');
    await page.locator('#manual-done').click();
    await runner.resume('melon', { runId: runner.state.runId, phase: 'zone' });
    await runner.task;
    assert.equal(runner.pages('melon')[0], page);
    assert.equal(page.url(), url);
    assert.equal(runner.state.jobs.melon.status, 'selected');
    assert.deepEqual(await page.evaluate(() => window.clicks), ['list', 'date', 'evening', 'entry', 'seat']);
  });
});

test('숨겨진 보안문자 폼은 인증 대기로 오인하지 않으며 입력값은 읽거나 반환하지 않는다', async () => {
  await withPage('<input id="captcha" hidden value="private-test-value"><input placeholder="대소문자 구분없이 문자입력" hidden>', async page => {
    assert.equal((await page.evaluate(readLoginSignals)).blocked, false);
    await page.locator('#captcha').evaluate(el => {
      el.hidden = false;
      Object.defineProperty(el, 'value', { get() { throw new Error('input value must not be read'); } });
    });
    const signals = await page.evaluate(readLoginSignals);
    assert.equal(signals.blocked, true);
    assert.equal(JSON.stringify(signals).includes('private-test-value'), false);
  });
});

for (const mode of ['reload', 'dynamic', 'queue']) {
  test(`카운트다운에서 예약 오픈 전환: ${mode}`, { timeout: 15000 }, async () => {
    const context = await browser.newContext();
    let runner;
    try {
      const scheduledAt = new Date(Date.now() + 9 * 3600000 + 3000).toISOString().slice(0, 19);
      const at = Date.parse(scheduledAt + '+09:00');
      const requests = [];
      const countdown = '<!doctype html><meta charset="utf-8"><p>11:00 티켓오픈! (남은시간)</p>';
      await context.route('**/*', async route => {
        requests.push(Date.now());
        let html = countdown;
        if (mode === 'reload' && requests.length >= 4) html = markup({ delayed: true });
        if (mode === 'dynamic') html += `<script>setTimeout(() => { document.open(); document.write(${JSON.stringify(markup({ delayed: true })).replaceAll('<', '\\u003c')}); document.close(); }, Math.max(0, ${at} - Date.now()));</script>`;
        if (mode === 'queue' && requests.length >= 2) html = '<div id="NetFunnel_Loading_Popup">접속 대기 중입니다. 대기 순번 123</div>';
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      });
      const browsers = { sessions: new Map([['melon', { context }]]), check: async () => ({ status: 'verified' }) };
      runner = new Runner(browsers, () => {}, { elementWaitMs: 250, pollMs: 20, afterClickMs: 0, openingProbeMs: 150, openingRefreshMs: 400, openingWaitMs: 5000 });
      await runner.start({ ...config(), sessionMode: 'opening', scheduledAt });
      await runner.task;
      assert.ok(requests.slice(1).every(time => time >= at));
      if (mode === 'queue') {
        assert.equal(requests.length, 2);
        assert.equal(runner.state.jobs.melon.blockedBy, 'waiting-room');
      } else {
        assert.equal(requests.length, mode === 'reload' ? 4 : 1);
        assert.equal(runner.state.jobs.melon.status, 'selected');
        assert.deepEqual(await runner.pages('melon')[0].evaluate(() => window.clicks), ['list', 'date', 'evening', 'entry', 'seat']);
      }
    } finally {
      runner?.stop();
      await runner?.task;
      await context.close();
    }
  });
}
