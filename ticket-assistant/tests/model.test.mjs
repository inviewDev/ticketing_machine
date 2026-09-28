import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedUrl, allowedBookingUrl, getProvider } from '../shared/providers.mjs';
import { classifyLogin, chooseSeats, parseSeat, defaultPreferences, validatePreferences } from '../shared/model.mjs';

test('공식 URL만 허용하고 위장 호스트와 사용자 정보는 거부한다', () => {
  const melon = getProvider('melon');
  assert.equal(allowedUrl('https://ticket.melon.com/performance/index.htm?prodId=123', melon), true);
  for (const url of ['https://ticket.melon.com.evil.com/', 'https://ticket.melon.com@evil.com/', 'http://ticket.melon.com/', 'https://ticket.melon.com:444/', 'https://user:pass@ticket.melon.com/', 'javascript:alert(1)', 'http://localhost/']) assert.equal(allowedUrl(url, melon), false, url);
  assert.equal(allowedUrl('https://nol.yanolja.com/ticket', getProvider('nol')), true);
  const charlotte = getProvider('charlotte');
  assert.equal(allowedUrl('https://facility.ticketlink.co.kr/product/list', charlotte), false);
  assert.equal(allowedBookingUrl('https://facility.ticketlink.co.kr/product/list', charlotte), true);
  assert.equal(allowedBookingUrl('https://facility.ticketlink.co.kr.evil.com/product/list', charlotte), false);
});
test('로그인 화면 접속이나 마이페이지 링크만으로 로그인 성공을 표시하지 않는다', () => {
  assert.equal(classifyLogin({ trusted: true }).status, 'unknown');
  assert.equal(classifyLogin({ trusted: true, loginVisible: true }).status, 'required');
  assert.equal(classifyLogin({ trusted: true, logoutVisible: true }).status, 'verified');
  assert.equal(classifyLogin({ trusted: false, logoutVisible: true }).status, 'unknown');
  assert.equal(classifyLogin({ trusted: true, sessionAuthenticated: true }).status, 'verified');
  assert.equal(classifyLogin({ trusted: false, sessionAuthenticated: true }).status, 'unknown');
  assert.equal(classifyLogin({ trusted: true, sessionAuthenticated: false }).status, 'required');
});
test('보안 확인과 비밀번호 입력 화면은 이전 로그아웃 표시보다 우선한다', () => {
  assert.equal(classifyLogin({ trusted: true, logoutVisible: true, passwordVisible: true }).status, 'required');
  assert.equal(classifyLogin({ trusted: true, logoutVisible: true, blocked: true }).status, 'challenge');
  assert.equal(classifyLogin({ trusted: true, sessionAuthenticated: true, loginVisible: true }).status, 'required');
});
test('티켓처의 접근 제한 화면은 로그인 필요와 구분한다', () => {
  assert.equal(classifyLogin({ accessRestricted: true, loginVisible: true }).status, 'restricted');
});
test('URL 없이 설정을 저장할 수 있지만 실제 실행은 거부한다', () => {
  const draft = { ...defaultPreferences(), selected: ['melon', 'yes24'], zones: '1층 A구역' };
  assert.deepEqual(validatePreferences(draft).selected, ['melon', 'yes24']);
  assert.throws(() => validatePreferences(draft, true), /URL/);
  assert.throws(() => validatePreferences({ ...draft, urls: { melon: 'https://evil.com/' } }), /공식/);
});
test('잘못된 날짜, 시간, 좌석 수를 거부한다', () => {
  for (const patch of [{ date: '2026-02-30' }, { time: '24:70' }, { quantity: 0 }, { quantity: 5 }, { quantity: 1.5 }, { selected: ['unknown'] }]) assert.throws(() => validatePreferences({ ...defaultPreferences(), ...patch }));
});
test('선택을 해제한 티켓처의 URL도 저장하고 날짜가 넘어가는 예약 시간은 거부한다', () => {
  const urls = { melon: 'https://ticket.melon.com/performance', yes24: 'https://ticket.yes24.com/performance' };
  assert.deepEqual(validatePreferences({ ...defaultPreferences(), selected: ['melon'], urls }).urls, urls);
  for (const scheduledAt of ['2099-02-30T19:00', '2099-10-17T24:00', '2099-10-17T19:60']) {
    assert.throws(() => validatePreferences({ ...defaultPreferences(), scheduledAt }), /예약/);
  }
  assert.equal(validatePreferences({ ...defaultPreferences(), scheduledAt: '2099-10-17T19:00' }).scheduledAt, '2099-10-17T19:00');
});
const seat = (zone, row, number, extra = {}) => ({ zone, row, number, available: true, selected: false, ...extra });
test('오픈 전 회차는 멜론 단일 선택과 미래 예약 실행이 필요하며 저장 후 유지된다', () => {
  const input = { ...defaultPreferences(), selected: ['melon'], urls: { melon: 'https://ticket.melon.com/performance' }, date: '2099-10-17', time: '19:00', zones: 'A구역', sessionMode: 'opening', scheduledAt: '2099-09-22T11:00' };
  assert.equal(validatePreferences(input, true).sessionMode, 'opening');
  assert.equal(validatePreferences(JSON.parse(JSON.stringify(input))).sessionMode, 'opening');
  assert.throws(() => validatePreferences({ ...input, scheduledAt: '' }, true), /오픈 시각/);
  assert.throws(() => validatePreferences({ ...input, selected: ['melon', 'nol'], urls: { ...input.urls, nol: 'https://nol.yanolja.com/ticket' } }, true), /단일 선택/);
  assert.throws(() => validatePreferences({ ...input, profiles: { melon: { order: 'entry-first' } } }, true), /날짜/);
});
test('구역 우선순위를 지키고 판매된 좌석과 다른 열을 제외한 연석을 선택한다', () => {
  const seats = [seat('B구역', '1', 1), seat('B구역', '1', 2), seat('A구역', '3', 1), seat('A구역', '3', 2, { available: false }), seat('A구역', '3', 3), seat('A구역', '3', 4), seat('A구역', '4', 5)];
  assert.deepEqual(chooseSeats(seats, { quantity: 2, adjacent: true, zones: 'A구역, B구역', rows: '' }).map(s => s.number), [3, 4]);
  assert.equal(chooseSeats(seats, { quantity: 3, adjacent: true, zones: 'A구역', rows: '' }).length, 0);
  assert.equal(chooseSeats(seats, { quantity: 1, adjacent: true, zones: 'A구역', rows: '4' })[0].number, 5);
});
test('비연석 허용 시에도 이미 선택된 좌석은 제외한다', () => {
  const seats = [seat('A구역', '1', 1, { selected: true }), seat('A구역', '1', 3), seat('A구역', '2', 7)];
  assert.deepEqual(chooseSeats(seats, { quantity: 2, adjacent: false, zones: 'A구역', rows: '' }).map(s => s.number), [3, 7]);
});
test('정확한 구역명을 사용하여 A구역이 AA구역과 잘못 매칭되지 않는다', () => {
  assert.equal(chooseSeats([seat('AA구역', '1', 1)], { quantity: 1, adjacent: false, zones: 'A구역', rows: '' }).length, 0);
});
test('좌석 텍스트에서 구역, 열, 번호를 읽고 알 수 없는 캔버스는 거부한다', () => {
  assert.deepEqual(parseSeat('VIP 1층 A구역 3열 12번'), { zone: '1층 A구역', row: '3', number: 12, valid: true });
  assert.equal(parseSeat('좌석').valid, false);
  assert.equal(parseSeat('', { zone: 'A구역', row: '2', number: '7' }).valid, true);
});

test('선호 열을 입력한 순서대로 선택하고 열 접미사와 전각 숫자를 해석한다', () => {
  const seats = [seat('A구역', '3', 1), seat('A구역', '3', 2), seat('A구역', '5', 7), seat('A구역', '5', 8)];
  assert.deepEqual(chooseSeats(seats, { quantity: 2, adjacent: true, zones: 'A구역', rows: '５열, 3열' }).map(s => s.number), [7, 8]);
  assert.equal(chooseSeats(seats, { quantity: 1, adjacent: false, zones: 'A구역', rows: '5, 3' })[0].row, '5');
});

test('영문과 숫자가 섞인 구역을 다른 구역으로 잘라서 읽지 않는다', () => {
  assert.deepEqual(parseSeat('VIP 1층 A1구역 3열 12번'), { zone: '1층 A1구역', row: '3', number: 12, valid: true });
  assert.deepEqual(parseSeat('B-2구역 가열 4번'), { zone: 'B-2구역', row: '가', number: 4, valid: true });
  assert.equal(parseSeat('', { zone: 'A구역', row: ' ３열 ', number: 4 }).row, '3');
});

test('쉼표만 입력된 선호 구역으로 실행하지 않는다', () => {
  assert.throws(() => validatePreferences({ ...defaultPreferences(), selected: ['melon'], date: '2099-10-17', time: '19:00', zones: ',, ,', urls: { melon: 'https://ticket.melon.com/performance' } }, true), /선호 구역/);
});
