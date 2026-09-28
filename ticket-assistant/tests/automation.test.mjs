import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Runner } from '../server/automation.mjs';
import { defaultPreferences } from '../shared/model.mjs';

const configFor = (selected = ['melon']) => ({
  ...defaultPreferences(), selected, date: '2099-10-17', time: '19:00', zones: 'A구역',
  urls: Object.fromEntries(selected.map(id => [id, id === 'melon' ? 'https://ticket.melon.com/performance' : 'https://ticket.yes24.com/performance'])),
  profiles: Object.fromEntries(selected.map(id => [id, { date: '#date', time: '#time', entry: '#entry', zone: '#zone', seat: '#seat' }])),
});
const seatData = (number = 1) => ({ index: number - 1, label: 'A구역 3열 ' + number + '번', zone: 'A구역', row: '3', number: String(number), selected: false, disabled: false, visible: true });

// These fixtures exercise the runner without launching or controlling a browser.
function fixture(id = 'melon') {
  const page = new EventEmitter();
  const state = { signals: {}, clicks: [], loads: 0, created: 0, closed: false, queries: [], missing: new Set(), delay: {}, seats: [seatData()], seatFailure: false };
  const frame = {
    url: () => page.address,
    evaluate: async () => state.signals,
    locator: selector => {
      state.queries.push(selector);
      const locator = {
        count: async () => {
          if (state.missing.has(selector)) return 0;
          if (state.delay[selector] > 0) { state.delay[selector]--; return 0; }
          return selector === '#seat' ? state.seats.length : 1;
        },
        evaluateAll: async () => state.seats.map(s => ({ ...s })),
        nth: index => ({
          isVisible: async () => true, isEnabled: async () => true,
          evaluate: async () => selector,
          evaluateAll: async () => state.replacement ? [state.replacement] : state.seats[index] ? [{ ...state.seats[index] }] : [],
          click: async () => {
            state.clicks.push(selector);
            state.onClick?.(selector);
            if (selector === '#seat') {
              if (state.seatFailure) throw new Error('click confirmation lost');
              state.seats[index].selected = true;
              state.afterSeat?.();
            }
          },
        }),
      };
      return locator;
    },
  };
  page.address = id === 'melon' ? 'https://ticket.melon.com/performance' : 'https://ticket.yes24.com/performance';
  page.url = () => page.address;
  page.frames = () => [frame];
  page.isClosed = () => state.closed;
  page.close = async () => { state.closed = true; page.emit('close'); };
  page.goto = async address => { page.address = address; state.loads++; state.onGoto?.(state.loads); };
  page.bringToFront = async () => { state.focused = (state.focused || 0) + 1; };
  const session = { suspended: false, context: { newPage: async () => { state.created++; return page; } } };
  return { page, frame, state, session };
}
function setup(ids = ['melon']) {
  const fixtures = Object.fromEntries(ids.map(id => [id, fixture(id)]));
  const checks = [];
  const browsers = {
    sessions: new Map(ids.map(id => [id, fixtures[id].session])),
    check: async (id, options) => { checks.push({ id, options }); return { status: 'verified' }; },
  };
  const runner = new Runner(browsers, () => {}, { elementWaitMs: 20, pollMs: 1, afterClickMs: 0, openingRefreshMs: 5, openingWaitMs: 1500, openingProbeMs: 20 });
  return { runner, fixtures, checks };
}

test('보안인증 창을 표시하고 인증 전 재개는 다시 대기하며 완료 후 같은 창에서 이어간다', async () => {
  const { runner, fixtures } = setup();
  const { state } = fixtures.melon;
  state.signals = { blocked: true };
  await runner.start(configFor());
  await runner.task;
  assert.equal(runner.state.jobs.melon.blockedBy, 'security');
  assert.equal(state.focused, 1);
  await runner.resume('melon', { runId: runner.state.runId, phase: 'date' });
  await runner.task;
  assert.equal(runner.state.status, 'waiting');
  assert.equal(runner.state.jobs.melon.blockedBy, 'security');
  assert.deepEqual(state.clicks, []);
  state.signals = {};
  await runner.resume('melon', { runId: runner.state.runId, phase: 'date' });
  await runner.task;
  assert.equal(runner.state.jobs.melon.status, 'selected');
  assert.equal(runner.state.jobs.melon.blockedBy, null);
  assert.equal(state.created, 1);
  assert.equal(state.loads, 1);
  assert.deepEqual(state.clicks, ['#date', '#time', '#entry', '#zone', '#seat']);
});

test('예매 진입 후 로그인 화면으로 돌아오면 예매하기부터 다시 이어갈 수 있다', async () => {
  const { runner, fixtures } = setup();
  const { state, page } = fixtures.melon;
  state.onClick = selector => { if (selector === '#entry') page.address = 'https://accounts.melon.com/login/login.htm'; };
  await runner.start(configFor());
  await runner.task;
  assert.equal(runner.state.jobs.melon.blockedBy, 'login');
  assert.deepEqual(runner.state.jobs.melon.resumeSteps, ['entry', 'zone']);
  state.onClick = null;
  page.address = configFor().urls.melon;
  await runner.resume('melon', { runId: runner.state.runId, phase: 'entry' });
  await runner.task;
  assert.equal(runner.state.jobs.melon.status, 'selected');
  assert.equal(state.loads, 1);
  assert.deepEqual(state.clicks, ['#date', '#time', '#entry', '#entry', '#zone', '#seat']);
});

test('인증 대기에서 중지한 뒤에는 인증을 끝내도 실행을 재개하지 않는다', async () => {
  const { runner, fixtures } = setup();
  fixtures.melon.state.signals = { blocked: true };
  await runner.start(configFor());
  await runner.task;
  runner.stop();
  fixtures.melon.state.signals = {};
  await assert.rejects(runner.resume('melon', { runId: runner.state.runId, phase: 'date' }), /이어갈/);
  assert.equal(runner.state.status, 'stopped');
  assert.deepEqual(fixtures.melon.state.clicks, []);
});

test('요소가 늦게 나타나도 로딩을 기다려 선택하고 성공 상태를 읽는다', async () => {
  const { runner, fixtures, checks } = setup();
  fixtures.melon.state.delay['#date'] = 2;
  await runner.start(configFor());
  await runner.task;
  assert.deepEqual(fixtures.melon.state.clicks, ['#date', '#time', '#entry', '#zone', '#seat']);
  assert.equal(runner.state.jobs.melon.status, 'selected');
  assert.equal(runner.state.status, 'review');
  assert.ok(checks.every(check => check.options.fresh));
});

test('인증 후 같은 예매창에서 사용자가 지정한 다음 단계부터 이어간다', async () => {
  const { runner, fixtures } = setup();
  fixtures.melon.state.signals = { blocked: true };
  await runner.start(configFor());
  await runner.task;
  assert.equal(runner.state.status, 'waiting');
  assert.equal(runner.state.jobs.melon.phase, 'date');
  assert.deepEqual(fixtures.melon.state.clicks, []);
  await assert.rejects(runner.start(configFor()), /이미 실행/);
  fixtures.melon.state.signals = {};
  await runner.resume('melon', { runId: runner.state.runId, phase: 'time' });
  await runner.task;
  assert.deepEqual(fixtures.melon.state.clicks, ['#time', '#entry', '#zone', '#seat']);
  assert.equal(fixtures.melon.state.created, 1);
  assert.equal(fixtures.melon.state.loads, 1);
});

test('멈춘 실행의 잘못된 단계, 중복 이어가기, 중지 뒤 이어가기를 거부한다', async () => {
  const { runner, fixtures } = setup();
  fixtures.melon.state.signals = { blocked: true };
  await runner.start(configFor());
  await runner.task;
  await assert.rejects(runner.resume('melon', { runId: runner.state.runId - 1, phase: 'date' }), /이어갈/);
  await assert.rejects(runner.resume('melon', { runId: runner.state.runId, phase: 'payment' }), /이어갈/);
  const resuming = runner.resume('melon', { runId: runner.state.runId, phase: 'date' });
  await assert.rejects(runner.resume('melon', { runId: runner.state.runId, phase: 'date' }), /이어갈/);
  await resuming;
  await runner.task;
  runner.stop();
  assert.equal(runner.state.status, 'stopped');
  await assert.rejects(runner.resume('melon', { runId: runner.state.runId, phase: 'date' }), /이어갈/);
});

test('직접 지정한 선택자가 없으면 다른 기본 버튼을 임의로 클릭하지 않는다', async () => {
  const { runner, fixtures } = setup();
  fixtures.melon.state.missing.add('#date');
  await runner.start(configFor());
  await runner.task;
  assert.deepEqual(fixtures.melon.state.clicks, []);
  assert.ok(fixtures.melon.state.queries.every(selector => selector === '#date'));
  assert.equal(runner.state.status, 'waiting');
});

test('다중 티켓처가 동시에 좌석을 찾더라도 한 곳에서만 클릭한다', async () => {
  const { runner, fixtures } = setup(['melon', 'yes24']);
  await runner.start(configFor(['melon', 'yes24']));
  await runner.task;
  const clicked = Object.values(fixtures).flatMap(f => f.state.clicks).filter(selector => selector === '#seat');
  assert.equal(clicked.length, 1);
  assert.equal(Object.values(runner.state.jobs).filter(job => job.status === 'selected').length, 1);
});

test('좌석 클릭 결과가 불확실하면 이어가기를 막고 현재 선택을 직접 확인하게 한다', async () => {
  const { runner, fixtures } = setup();
  fixtures.melon.state.seatFailure = true;
  await runner.start(configFor());
  await runner.task;
  assert.equal(runner.state.status, 'review');
  assert.equal(runner.state.jobs.melon.canResume, false);
  assert.equal(fixtures.melon.state.clicks.filter(s => s === '#seat').length, 1);
  await assert.rejects(runner.resume('melon', { runId: runner.state.runId, phase: 'zone' }), /이어갈/);
});

test('읽은 좌석의 위치가 바뀌면 다른 좌석을 클릭하지 않는다', async () => {
  const { runner, fixtures } = setup();
  fixtures.melon.state.replacement = seatData(9);
  await runner.start(configFor());
  await runner.task;
  assert.equal(fixtures.melon.state.clicks.includes('#seat'), false);
  assert.match(runner.state.jobs.melon.message, /변경/);
});

test('첫 좌석 클릭 후 중지하면 두 번째 좌석을 클릭하지 않는다', async () => {
  const { runner, fixtures } = setup();
  fixtures.melon.state.seats.push(seatData(2));
  fixtures.melon.state.afterSeat = () => runner.stop();
  await runner.start({ ...configFor(), quantity: 2 });
  await runner.task;
  assert.equal(fixtures.melon.state.clicks.filter(s => s === '#seat').length, 1);
  assert.equal(runner.state.status, 'stopped');
});

test('중복된 좌석 표시는 선택 범위 오류로 멈춘다', async () => {
  const { runner, fixtures } = setup();
  fixtures.melon.state.seats.push(seatData());
  await runner.start(configFor());
  await runner.task;
  assert.equal(fixtures.melon.state.clicks.includes('#seat'), false);
  assert.match(runner.state.jobs.melon.message, /여러 개/);
});

test('예매 팝업이 열리면 원래 상세 페이지의 같은 버튼과 중복 판정하지 않는다', async () => {
  const { runner, fixtures } = setup();
  const popup = fixture();
  popup.page.address = 'https://ticket.melon.com/reservation/';
  fixtures.melon.state.onClick = selector => { if (selector === '#entry') fixtures.melon.page.emit('popup', popup.page); };
  await runner.start(configFor());
  await runner.task;
  assert.deepEqual(fixtures.melon.state.clicks, ['#date', '#time', '#entry']);
  assert.deepEqual(popup.state.clicks, ['#zone', '#seat']);
  assert.equal(runner.state.jobs.melon.status, 'selected');
});

test('샤롯데 TicketLINK 키 오류 팝업을 닫고 원문 페이지에서 예매하기부터 재개한다', async () => {
  const { runner, fixtures } = setup(['charlotte']);
  const config = configFor(['charlotte']);
  config.urls.charlotte = 'https://www.charlottetheater.co.kr/performence/current.asp';
  const popup = fixture('charlotte');
  popup.page.address = 'https://facility.ticketlink.co.kr/error/popup/none?errorCode=error.netfunnel.invalid.key';
  popup.state.signals = { netFunnelInvalid: true };
  fixtures.charlotte.state.onClick = selector => { if (selector === '#entry') fixtures.charlotte.page.emit('popup', popup.page); };
  await runner.start(config);
  await runner.task;
  assert.equal(runner.state.jobs.charlotte.blockedBy, 'queue');
  assert.deepEqual(runner.state.jobs.charlotte.resumeSteps, ['entry', 'zone']);
  assert.equal(popup.state.closed, true);
  fixtures.charlotte.state.onClick = null;
  await runner.resume('charlotte', { runId: runner.state.runId, phase: 'entry' });
  await runner.task;
  assert.equal(runner.state.jobs.charlotte.status, 'selected');
  assert.deepEqual(fixtures.charlotte.state.clicks, ['#date', '#time', '#entry', '#entry', '#zone', '#seat']);
});

test('숨겨진 예매 iframe의 버튼과 좌석을 선택하지 않는다', async () => {
  const { runner, fixtures } = setup();
  const hidden = fixture();
  hidden.frame.parentFrame = () => fixtures.melon.frame;
  hidden.frame.frameElement = async () => ({ isVisible: async () => false });
  fixtures.melon.page.frames = () => [fixtures.melon.frame, hidden.frame];
  await runner.start(configFor());
  await runner.task;
  assert.equal(runner.state.jobs.melon.status, 'selected');
  assert.deepEqual(hidden.state.queries, []);
});

test('마지막 좌석 클릭 직후 중지한 실행을 성공으로 덮어쓰지 않는다', async () => {
  const { runner, fixtures } = setup();
  const events = [];
  runner.emit = event => events.push(event);
  fixtures.melon.state.afterSeat = () => runner.stop();
  await runner.start(configFor());
  await runner.task;
  assert.equal(runner.state.status, 'stopped');
  assert.equal(runner.state.jobs.melon.status, 'stopped');
  assert.equal(events.some(event => event.status === 'selected'), false);
});

test('예상한 매수보다 더 많은 좌석이 선택되면 성공 대신 직접 확인을 요청한다', async () => {
  const { runner, fixtures } = setup();
  fixtures.melon.state.afterSeat = () => fixtures.melon.state.seats.push({ ...seatData(9), selected: true });
  await runner.start(configFor());
  await runner.task;
  assert.equal(runner.state.jobs.melon.status, 'review');
});

test('예약 대기 중지 시 티켓처 작업도 대기 상태에서 벗어난다', async () => {
  const { runner } = setup();
  await runner.start({ ...configFor(), scheduledAt: '2099-10-17T18:00:00' });
  runner.stop();
  await runner.task;
  assert.equal(runner.state.status, 'stopped');
  assert.equal(runner.state.jobs.melon.status, 'stopped');
});

test('예약 실행은 공연 페이지에서 날짜와 회차를 미리 선택하고 예매하기 직전에 대기한다', async () => {
  const { runner, fixtures } = setup();
  const at = Date.now() + 2500;
  const scheduledAt = new Date(at + 9 * 3600000).toISOString().slice(0, 19);
  await runner.start({ ...configFor(), scheduledAt });
  const deadline = Date.now() + 1000;
  while (runner.state.jobs.melon?.status !== 'armed' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runner.state.status, 'scheduled');
  assert.equal(runner.state.jobs.melon.status, 'armed');
  assert.deepEqual(fixtures.melon.state.clicks, ['#date', '#time']);
  assert.equal(fixtures.melon.state.loads, 1);
  await runner.task;
  assert.deepEqual(fixtures.melon.state.clicks, ['#date', '#time', '#entry', '#zone', '#seat']);
  assert.equal(fixtures.melon.state.loads, 1);
});

test('미리 선택할 수 없던 회차는 오픈 시각에 공연 페이지만 한 번 갱신해 다시 찾는다', async () => {
  const { runner, fixtures } = setup();
  fixtures.melon.state.missing.add('#date');
  fixtures.melon.state.onGoto = loads => { if (loads === 2) fixtures.melon.state.missing.delete('#date'); };
  const at = Date.now() + 2500;
  const scheduledAt = new Date(at + 9 * 3600000).toISOString().slice(0, 19);
  await runner.start({ ...configFor(), scheduledAt });
  const deadline = Date.now() + 1000;
  while (runner.state.jobs.melon?.status !== 'waiting_open' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(fixtures.melon.state.clicks, []);
  assert.equal(fixtures.melon.state.loads, 1);
  await runner.task;
  assert.equal(fixtures.melon.state.loads, 2);
  assert.deepEqual(fixtures.melon.state.clicks, ['#date', '#time', '#entry', '#zone', '#seat']);
});

async function prepareOpening(customize) {
  const data = setup();
  const scheduledAt = new Date(Date.now() + 9 * 3600000 + 1800).toISOString().slice(0, 19);
  const at = Date.parse(scheduledAt + '+09:00');
  customize(data, at);
  await data.runner.start({ ...configFor(), scheduledAt });
  return { ...data, at };
}

test('오픈이 두 번 늦어도 정각 전 갱신 없이 기다리고 열린 뒤 한 번만 진입한다', async () => {
  const loadsAt = [];
  const { runner, fixtures, at } = await prepareOpening(({ runner, fixtures }) => {
    runner.openingRefreshMs = 60;
    fixtures.melon.state.missing.add('#date');
    fixtures.melon.state.onGoto = loads => {
      loadsAt.push(Date.now());
      if (loads === 4) fixtures.melon.state.missing.delete('#date');
    };
  });
  await runner.task;
  assert.equal(fixtures.melon.state.loads, 4);
  assert.ok(loadsAt.slice(1).every(time => time >= at));
  assert.ok(loadsAt.slice(2).every((time, index) => time - loadsAt[index + 1] >= 60));
  assert.deepEqual(fixtures.melon.state.clicks, ['#date', '#time', '#entry', '#zone', '#seat']);
  assert.equal(runner.state.jobs.melon.status, 'selected');
});

test('날짜만 미리 선택한 경우 갱신 후 날짜부터 다시 선택한다', async () => {
  const { runner, fixtures } = await prepareOpening(({ fixtures }) => {
    fixtures.melon.state.missing.add('#time');
    fixtures.melon.state.onGoto = loads => { if (loads === 2) fixtures.melon.state.missing.delete('#time'); };
  });
  await runner.task;
  assert.deepEqual(fixtures.melon.state.clicks, ['#date', '#date', '#time', '#entry', '#zone', '#seat']);
});

test('예약 정각에 화면이 자체 전환되면 새로고침 없이 진행한다', async () => {
  const { runner, fixtures } = await prepareOpening(({ runner, fixtures }) => {
    fixtures.melon.state.missing.add('#date');
    const run = runner.runMelonOpening.bind(runner);
    runner.runMelonOpening = (...args) => { fixtures.melon.state.missing.delete('#date'); return run(...args); };
  });
  await runner.task;
  assert.equal(fixtures.melon.state.loads, 1);
  assert.equal(runner.state.jobs.melon.status, 'selected');
});

test('오픈 재탐색은 횟수 제한 후 이어가기 상태로 멈춘다', async () => {
  const { runner, fixtures } = await prepareOpening(({ runner, fixtures }) => {
    runner.openingMaxRefreshes = 2;
    fixtures.melon.state.missing.add('#date');
  });
  await runner.task;
  assert.equal(fixtures.melon.state.loads, 3);
  assert.equal(runner.state.status, 'waiting');
  assert.equal(runner.state.jobs.melon.canResume, true);
  assert.match(runner.state.jobs.melon.message, /제한/);
  fixtures.melon.state.missing.delete('#date');
  await runner.resume('melon', { runId: runner.state.runId, phase: 'date' });
  await runner.task;
  assert.equal(fixtures.melon.state.loads, 3);
  assert.equal(runner.state.jobs.melon.status, 'selected');
});

test('오픈 갱신 도중 중지하면 추가 갱신과 클릭을 하지 않는다', async () => {
  const { runner, fixtures } = await prepareOpening(({ runner, fixtures }) => {
    fixtures.melon.state.missing.add('#date');
    fixtures.melon.state.onGoto = loads => { if (loads === 2) runner.stop(); };
  });
  await runner.task;
  assert.equal(runner.state.status, 'stopped');
  assert.equal(fixtures.melon.state.loads, 2);
  assert.deepEqual(fixtures.melon.state.clicks, []);
});

for (const [signal, blockedBy] of [['queueVisible', 'waiting-room'], ['blocked', 'security'], ['accessRestricted', 'restricted'], ['passwordVisible', 'login']]) {
  test(`오픈 확인 중 ${signal} 감지 후 갱신하지 않는다`, async () => {
    const { runner, fixtures } = await prepareOpening(({ fixtures }) => {
      fixtures.melon.state.missing.add('#date');
      fixtures.melon.state.onGoto = loads => { if (loads === 2) fixtures.melon.state.signals = { [signal]: true }; };
    });
    await runner.task;
    assert.equal(fixtures.melon.state.loads, 2);
    assert.equal(runner.state.jobs.melon.blockedBy, blockedBy);
    assert.deepEqual(fixtures.melon.state.clicks, []);
  });
}

test('예매 버튼 클릭 후 응답을 잃어도 재클릭하거나 갱신하지 않는다', async () => {
  const { runner, fixtures } = await prepareOpening(({ fixtures }) => {
    fixtures.melon.state.onClick = selector => { if (selector === '#entry') throw new Error('response lost'); };
  });
  await runner.task;
  assert.equal(fixtures.melon.state.loads, 1);
  assert.equal(fixtures.melon.state.clicks.filter(s => s === '#entry').length, 1);
  assert.equal(runner.state.status, 'waiting');
});

test('같은 탭이 다른 멜론 주소로 이동해도 공연 페이지로 되돌리지 않는다', async () => {
  const { runner, fixtures } = await prepareOpening(({ runner, fixtures }) => {
    fixtures.melon.state.missing.add('#date');
    const run = runner.runMelonOpening.bind(runner);
    runner.runMelonOpening = (...args) => {
      fixtures.melon.page.address = 'https://ticket.melon.com/reservation/';
      return run(...args);
    };
  });
  await runner.task;
  assert.equal(fixtures.melon.state.loads, 1);
  assert.equal(runner.state.status, 'waiting');
  assert.match(runner.state.jobs.melon.message, /이동/);
  assert.deepEqual(fixtures.melon.state.clicks, []);
});

test('시간 제한에 도달하면 남은 갱신 횟수가 있어도 재탐색을 종료한다', async () => {
  const { runner, fixtures } = await prepareOpening(({ runner, fixtures }) => {
    runner.openingWaitMs = 50;
    runner.openingRefreshMs = 1000;
    fixtures.melon.state.missing.add('#date');
  });
  await runner.task;
  assert.ok(fixtures.melon.state.loads <= 2);
  assert.equal(runner.state.status, 'waiting');
  assert.match(runner.state.jobs.melon.message, /제한/);
});

test('공연 페이지 응답 오류를 클릭 시도 전에 알리고 같은 창에서 재개할 수 있다', async () => {
  const { runner, fixtures } = setup();
  fixtures.melon.page.goto = async () => ({ status: () => 503 });
  await runner.start(configFor());
  await runner.task;
  assert.deepEqual(fixtures.melon.state.clicks, []);
  assert.match(runner.state.jobs.melon.message, /HTTP 503/);
  assert.equal(runner.state.jobs.melon.canResume, true);
});

test('이미 선택한 좌석이 있으면 구역 전환으로 지우지 않고 직접 확인을 요청한다', async () => {
  const { runner, fixtures } = setup();
  fixtures.melon.state.seats[0].selected = true;
  fixtures.melon.state.onClick = selector => { if (selector === '#zone') fixtures.melon.state.seats[0].selected = false; };
  await runner.start(configFor());
  await runner.task;
  assert.equal(fixtures.melon.state.clicks.includes('#zone'), false);
  assert.equal(fixtures.melon.state.clicks.includes('#seat'), false);
  assert.equal(fixtures.melon.state.seats[0].selected, true);
  assert.equal(runner.state.jobs.melon.status, 'review');
});

test('조건에 맞는 좌석이 이미 보이면 기본 구역 버튼 검색 대기를 생략한다', async () => {
  const { runner, fixtures } = setup();
  const config = configFor();
  config.profiles.melon.zone = '';
  await runner.start(config);
  await runner.task;
  assert.equal(runner.state.jobs.melon.status, 'selected');
  assert.deepEqual(fixtures.melon.state.clicks, ['#date', '#time', '#entry', '#seat']);
  assert.equal(fixtures.melon.state.queries.some(selector => selector.startsWith('role=') || selector.startsWith('[data-zone=')), false);
});
