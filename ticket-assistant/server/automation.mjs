import { allowedUrl, allowedBookingUrl, getProvider } from '../shared/providers.mjs';
import { validatePreferences, chooseSeats, parseSeat, splitPreferences, ACTIVE_RUN_STATES, PHASE_LABELS } from '../shared/model.mjs';
import { inspectLoginPage } from './browser.mjs';
import { melonSelectors, revealMelonDate } from './melon.mjs';
import { nolSelectors, revealNolDate } from './nol.mjs';
import { matchingPreference, mapKey, seatKey } from '../shared/seat-map.mjs';
import { readPerformanceInfo } from './performance-info.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const escapeValue = value => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
const interpolate = (selector, config, zone = '') => selector.replaceAll('{date}', config.date).replaceAll('{dateCompact}', config.date.replaceAll('-', '')).replaceAll('{day}', String(Number(config.date.slice(-2)))).replaceAll('{time}', config.time).replaceAll('{zone}', escapeValue(zone));
const DEFAULT_SEATS = '[data-seat-id],[data-seat-no],[title*="열"][title*="번"],[aria-label*="열"][aria-label*="번"]';
const sameSeat = (a, b) => a.zone === b.zone && a.row === b.row && a.number === b.number;
const manualStep = (blockedBy, message) => Object.assign(new Error(message), { blockedBy });

// A single browser round trip reads all candidates without thousands of locator calls.
export function readSeatElements(elements) {
  return elements.map((el, index) => ({
    index,
    visible: Boolean(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none'),
    label: el.getAttribute('title') || el.getAttribute('aria-label') || el.querySelector('title')?.textContent || el.textContent || '',
    zone: el.getAttribute('data-zone') || el.getAttribute('data-block') || '',
    row: el.getAttribute('data-row') || '', number: el.getAttribute('data-seat-no') || '',
    disabled: el.matches(':disabled,[aria-disabled="true"],[data-available="false"]') || /(?:^|\s)(disabled|sold|unavailable|reserved)(?:\s|$)/i.test(el.getAttribute('class') || ''),
    selected: el.matches('[aria-selected="true"],[aria-pressed="true"],[data-selected="true"]') || /(?:^|\s)(selected|on)(?:\s|$)/i.test(el.getAttribute('class') || ''),
    x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y,
    width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height,
  }));
}

export class Runner {
  constructor(browsers, emit = () => {}, { elementWaitMs = 6000, pollMs = 200, afterClickMs = 350, prepareAheadMs = 5 * 60 * 1000, openingWaitMs = 60000, openingProbeMs = 300, openingRefreshMs = 2000, openingMaxRefreshes = 10 } = {}) {
    Object.assign(this, { browsers, emit, elementWaitMs, pollMs, afterClickMs, prepareAheadMs, openingWaitMs, openingProbeMs, openingRefreshMs, openingMaxRefreshes });
    this.state = { status: 'idle', jobs: {}, winner: null, runId: 0 };
    this.stopped = false;
    this.generation = 0;
    this.jobPages = new Map();
    this.contexts = new Map();
    this.starting = false;
    this.seatMaps = new Map();
  }
  snapshot() { return this.state; }
  update(id, status, message, extra = {}) {
    this.state.jobs[id] = { ...this.state.jobs[id], status, message, ...extra };
    this.emit({ type: 'progress', provider: id, status, message, ...extra });
  }
  guard(generation, id) {
    if (this.stopped || generation !== this.generation) throw new Error('실행이 중지되었습니다.');
    if (id && this.state.winner && this.state.winner !== id) throw new Error('다른 티켓처에서 좌석을 선택하여 멈췄습니다.');
  }
  stop() {
    this.stopped = true;
    for (const [id, job] of Object.entries(this.state.jobs)) {
      if (job.canResume) this.update(id, 'stopped', '실행을 중지했습니다. 현재 예매창은 유지됩니다.', { canResume: false });
    }
    if (this.state.status === 'waiting') this.state.status = 'stopped';
    else if (['validating', 'running', 'scheduled'].includes(this.state.status)) this.state.status = 'stopping';
    this.emit({ type: 'log', message: '중지를 요청했습니다. 진행 중인 작업이 끝나면 추가 클릭을 멈춥니다.' });
  }

  async start(input, { preview = false } = {}) {
    if (this.starting || ACTIVE_RUN_STATES.includes(this.state.status)) throw new Error('이미 실행 중입니다. 먼저 중지해주세요.');
    const config = validatePreferences(preview ? { ...input, scheduledAt: '' } : input, true, { preview });
    const generation = ++this.generation;
    this.starting = true;
    this.stopped = false;
    this.config = config;
    this.contexts.clear();
    this.jobPages.clear();
    this.state = { status: 'validating', jobs: {}, winner: null, runId: generation, mode: preview ? 'map' : 'booking' };
    try {
      for (const id of config.selected) {
        this.guard(generation);
        this.update(id, 'checking', '실행 전 공식 사이트의 로그인 상태를 다시 확인합니다.');
        const login = await this.browsers.check(id, { fresh: true, maxAgeMs: 30000 });
        this.guard(generation);
        if (login?.status !== 'verified') {
          this.update(id, 'attention', '로그인 연결에서 로그인 상태를 확인해주세요.');
          throw new Error(getProvider(id).name + ': 실제 로그인 상태를 먼저 확인해주세요.');
        }
      }
    } catch (error) {
      this.state.status = this.stopped ? 'stopped' : 'attention';
      throw error;
    } finally { this.starting = false; }
    this.state.status = config.scheduledAt ? 'scheduled' : 'running';
    this.task = this.execute(config, generation).catch(error => {
      if (this.stopped) this.finish();
      else this.state.status = 'error';
      this.emit({ type: 'log', message: error.message });
    });
    return this.state;
  }

  finish() {
    this.state.status = this.stopped ? 'stopped' : this.state.winner ? 'review' : Object.values(this.state.jobs).some(job => job.canResume) ? 'waiting' : this.state.mode === 'map' && Object.values(this.state.jobs).every(job => job.status === 'mapped') ? 'prepared' : 'attention';
    if (this.stopped) for (const [id, job] of Object.entries(this.state.jobs)) {
      if (!['selected', 'review', 'attention', 'stopped'].includes(job.status)) this.update(id, 'stopped', '실행을 중지했습니다. 현재 예매창은 유지됩니다.', { canResume: false });
    }
    if (this.state.winner) for (const [id, job] of Object.entries(this.state.jobs)) {
      if (job.canResume) this.update(id, 'stopped', '좌석 선택이 시작되어 추가 실행을 멈췄습니다.', { canResume: false });
    }
    this.emit({ type: 'complete', status: this.state.status, winner: this.state.winner });
  }

  async execute(config, generation) {
    const at = config.scheduledAt ? Date.parse(config.scheduledAt + '+09:00') : Date.now();
    const scheduled = at > Date.now();
    for (const id of config.selected) this.update(id, scheduled ? 'scheduled' : 'ready', scheduled ? '공연 화면을 미리 준비할 시간까지 대기합니다. (한국 시간)' : '예매 화면을 준비합니다.');
    if (scheduled) {
      const prepareAt = Math.max(Date.now(), at - this.prepareAheadMs);
      while (Date.now() < prepareAt) { this.guard(generation); await wait(Math.min(250, prepareAt - Date.now())); }
      this.guard(generation);
      await Promise.allSettled(config.selected.map(id => this.runProvider(id, config, generation, false, { stopBefore: 'entry', prepareUntil: at })));
      this.guard(generation);
      this.state.status = 'scheduled';
    }
    while (Date.now() < at) { this.guard(generation); await wait(Math.min(100, at - Date.now())); }
    this.guard(generation);
    this.state.status = 'running';
    await Promise.allSettled(config.selected.map(async id => {
      const context = this.contexts.get(id);
      const canResume = Boolean(context && this.pages(id).length);
      if (scheduled && id === 'melon' && canResume && context.phases[0] === 'date') {
        if (this.state.jobs[id]?.blockedBy) return;
        return this.runMelonOpening(id, config, generation, at);
      }
      if (scheduled && canResume && !context.prepared && !this.state.jobs[id]?.blockedBy) {
        const page = this.pages(id)[0];
        try {
          this.update(id, 'opening', '오픈 시각이 되어 공연 페이지를 한 번 갱신합니다.', { canResume: false, blockedBy: null });
          context.index = 0;
          const response = await page.goto(config.urls[id], { waitUntil: 'domcontentloaded', timeout: 30000 });
          if (response && response.status() >= 400) throw new Error('공연 페이지가 HTTP ' + response.status() + ' 응답을 반환했습니다.');
        } catch (error) {
          this.update(id, this.stopped ? 'stopped' : 'waiting', error.message, { canResume: !this.stopped, resumeSteps: context.phases.slice(context.index), phase: context.phases[context.index], blockedBy: null });
          return;
        }
      }
      return this.runProvider(id, config, generation, canResume);
    }));
    this.finish();
  }

  async runMelonOpening(id, config, generation, at) {
    const context = this.contexts.get(id);
    const originalPage = context.productPage;
    const deadline = at + this.openingWaitMs;
    let refreshes = 0;
    let lastRefresh = 0;
    try {
      while (Date.now() < deadline) {
        this.guard(generation, id);
        await this.checkBlockers(id, generation);
        if (this.pages(id)[0] !== originalPage || originalPage.url() !== context.productUrl) throw new Error('예매 화면이 이동하여 오픈 재탐색을 멈췄습니다. 현재 화면을 확인해주세요.');
        // First inspect the existing page: Melon may reveal the controls itself.
        await this.runProvider(id, config, generation, true, { openingDeadline: deadline });
        this.guard(generation, id);
        if (!context.openingRetry || context.entryAttempted || this.state.jobs[id]?.blockedBy) return;
        if (refreshes >= this.openingMaxRefreshes || Date.now() >= deadline) break;
        const nextRefresh = lastRefresh + this.openingRefreshMs;
        if (Date.now() < nextRefresh) {
          await wait(Math.max(0, Math.min(this.pollMs, nextRefresh - Date.now(), deadline - Date.now())));
          continue;
        }
        this.guard(generation, id);
        if (Date.now() >= deadline) break;
        await this.checkBlockers(id, generation);
        if (this.pages(id)[0] !== originalPage || originalPage.url() !== context.productUrl || !allowedUrl(originalPage.url(), getProvider(id))) throw new Error('예매 화면이 이동하여 자동 갱신을 멈췄습니다. 현재 화면을 확인해주세요.');
        // Reload clears both selections, even if only the time was missing.
        context.index = 0;
        context.prepared = false;
        refreshes++;
        lastRefresh = Date.now();
        this.update(id, 'opening', `오픈 화면을 확인하고 있습니다. 공연 페이지 갱신 ${refreshes}/${this.openingMaxRefreshes}회`, { phase: 'date', canResume: false, refreshes });
        const response = await originalPage.goto(config.urls[id], { waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.min(10000, deadline - Date.now())) });
        this.guard(generation, id);
        if (response && response.status() >= 400) throw new Error('공연 페이지가 HTTP ' + response.status() + ' 응답을 반환했습니다. 자동 갱신을 멈췄습니다.');
      }
      throw new Error(`오픈 확인 제한에 도달했습니다. (${Math.round(this.openingWaitMs / 1000)}초 이내, 최대 ${this.openingMaxRefreshes}회 갱신) 날짜·회차와 공식 화면을 확인한 뒤 이어가세요.`);
    } catch (error) {
      this.update(id, this.stopped ? 'stopped' : 'waiting', error.message, {
        canResume: !this.stopped && !this.state.winner, blockedBy: error.blockedBy || null,
        phase: context.phases[context.index], resumeSteps: context.phases.slice(context.index), refreshes,
      });
    }
  }

  async resume(id, { runId, phase } = {}) {
    getProvider(id);
    const job = this.state.jobs[id];
    if (this.state.status !== 'waiting' || this.stopped || this.state.winner || runId !== this.generation || !job?.canResume || !job.resumeSteps?.includes(phase)) throw new Error('현재 실행에서 이어갈 수 있는 단계를 선택해주세요.');
    if (![...(this.jobPages.get(id) || [])].some(page => !page.isClosed())) throw new Error('예매창이 닫혔습니다. 실행을 중지한 뒤 다시 시작해주세요.');
    this.state.status = 'running';
    const context = this.contexts.get(id);
    context.index = context.phases.indexOf(phase);
    this.update(id, 'ready', '기존 예매창을 다시 확인하고 ' + PHASE_LABELS[phase] + '부터 이어갑니다.', { canResume: false, blockedBy: null });
    this.task = this.runProvider(id, this.config, this.generation, true).then(() => this.finish());
    return this.state;
  }

  pages(id) { return [...(this.jobPages.get(id) || [])].reverse().filter(p => !p.isClosed()); }
  frames(id) {
    const provider = getProvider(id);
    const page = this.pages(id)[0];
    return page && allowedBookingUrl(page.url(), provider) ? page.frames().filter(f => allowedBookingUrl(f.url(), provider)) : [];
  }
  async visibleFrames(id) {
    const frames = [];
    for (const frame of this.frames(id)) {
      try {
        if (frame.parentFrame?.() && !await (await frame.frameElement()).isVisible()) continue;
        frames.push(frame);
      } catch { /* Detached frames cannot supply a clickable target. */ }
    }
    return frames;
  }
  async focus(id) {
    const page = this.pages(id)[0];
    if (page) return page.bringToFront();
    return this.browsers.focus(id, { allowOpen: !ACTIVE_RUN_STATES.includes(this.state.status) });
  }
  async checkBlockers(id, generation) {
    this.guard(generation, id);
    const page = this.pages(id)[0];
    if (!page) throw new Error('예매창이 닫혔습니다.');
    const deadline = Date.now() + this.elementWaitMs;
    while (page.url() === 'about:blank' && Date.now() < deadline && !page.isClosed()) {
      this.guard(generation, id);
      await wait(this.pollMs);
    }
    const provider = getProvider(id);
    const signals = await inspectLoginPage(page, provider);
    this.guard(generation, id);
    if (page.isClosed()) throw new Error('예매창이 닫혔습니다.');
    if (signals.accessRestricted) throw manualStep('restricted', '티켓처의 접근 제한 화면입니다. 자동 진행을 멈췄습니다. 공식 화면을 확인해주세요.');
    if (signals.queueVisible) throw manualStep('waiting-room', '공식 대기열에 진입했습니다. 새로고침 없이 기다린 뒤 현재 단계부터 이어가세요.');
    if (signals.netFunnelInvalid) throw manualStep('queue', 'TicketLINK 대기열 연결 키가 거부되었습니다. 오류 팝업을 닫고 샤롯데 공연 상세 페이지를 유지했습니다. 광고·추적 차단, VPN 또는 보안 DNS가 켜져 있다면 해제한 뒤 예매하기 단계부터 이어가세요.');
    if (signals.blocked) throw manualStep('security', '보안인증 대기 중입니다. 공식 예매창에서 보안문자를 입력하고 인증을 완료한 뒤, 인증 완료 후 이어가기를 눌러주세요.');
    if (signals.passwordVisible || (allowedUrl(page.url(), provider, true) && !allowedUrl(page.url(), provider))) throw manualStep('login', '로그인이 필요합니다. 공식 창에서 완료한 뒤 이어갈 단계를 선택해주세요.');
    if (!allowedBookingUrl(page.url(), provider)) throw new Error('공식 예매 화면으로 돌아온 뒤 이어갈 단계를 선택해주세요.');
  }

  async clickOne(id, selectors, generation, optional = false, beforeSearch = null, { until = Infinity, beforeClick = () => {} } = {}) {
    const deadline = Math.min(until, Date.now() + (optional ? Math.min(1000, this.elementWaitMs) : this.elementWaitMs));
    do {
      this.guard(generation, id);
      await this.checkBlockers(id, generation);
      if (beforeSearch) {
        await beforeSearch();
        this.guard(generation, id);
      }
      for (const selector of selectors.filter(Boolean)) {
        const matches = [];
        for (const frame of await this.visibleFrames(id)) {
          const nodes = frame.locator(selector);
          const count = await nodes.count();
          if (count > 100) throw new Error('선택 범위가 너무 넓습니다. 화면 연결 설정을 확인해주세요.');
          for (let i = 0; i < count; i++) if (await nodes.nth(i).isVisible() && await nodes.nth(i).isEnabled()) matches.push(nodes.nth(i));
        }
        if (matches.length > 1) throw new Error('선택할 항목이 여러 개입니다. 브라우저에서 직접 선택한 뒤 다음 단계부터 이어가세요.');
        if (matches.length === 1) {
          const text = await matches[0].evaluate(el => [el.textContent, el.getAttribute('aria-label'), el.getAttribute('value')].filter(Boolean).join(' '));
          if (/결제|구매\s*확정|동의|약관|pay\s*now|checkout/i.test(text)) throw new Error('결제 또는 동의 단계입니다. 직접 진행해주세요.');
          this.guard(generation, id);
          beforeClick();
          await matches[0].click({ timeout: 4000 });
          await wait(this.afterClickMs);
          this.guard(generation, id);
          return true;
        }
      }
      if (Date.now() >= deadline) break;
      await wait(this.pollMs);
    } while (true);
    if (!optional) throw Object.assign(new Error('지정한 항목이 나타나지 않았습니다. 브라우저에서 직접 진행한 뒤 다음 단계부터 이어가세요.'), { code: 'TARGET_MISSING' });
    return false;
  }

  async scanSeats(id, config) {
    const profile = config.profiles[id] || {};
    const seats = [];
    const keys = new Set();
    let frameIndex = 0;
    for (const frame of await this.visibleFrames(id)) {
      const panel = String(frameIndex++);
      const items = frame.locator(profile.seat || DEFAULT_SEATS);
      if (await items.count() > 3000) throw new Error('좌석 선택 범위가 너무 넓습니다. 화면 설정을 확인해주세요.');
      for (const data of await items.evaluateAll(readSeatElements)) {
        if (!data.visible) continue;
        const parsed = parseSeat(data.label, data);
        if (!parsed.valid) continue;
        const key = JSON.stringify([parsed.zone, parsed.row, parsed.number]);
        if (keys.has(key)) throw new Error('같은 좌석을 나타내는 항목이 여러 개입니다. 좌석 선택 범위를 확인해주세요.');
        keys.add(key);
        seats.push({ ...parsed, locator: items.nth(data.index), available: !data.disabled && !/매진|선택불가|판매완료/.test(data.label), selected: data.selected, label: data.label, panel, x: data.x, y: data.y, width: data.width, height: data.height });
      }
    }
    return seats;
  }

  async captureSeatMap(id, config = this.config, generation = this.generation) {
    await this.checkBlockers(id, generation);
    const found = await this.waitForSeats(id, config, generation);
    this.guard(generation, id);
    const seats = found.filter(seat => [seat.x, seat.y, seat.width, seat.height].every(Number.isFinite) && seat.width > 0 && seat.height > 0);
    if (!seats.length) throw new Error('현재 화면에서 좌석 이름과 배치를 읽지 못했습니다. 공식 창에서 원하는 층·구역을 연 뒤 다시 읽어주세요. 이미지나 캔버스만 있는 좌석도는 아직 불러올 수 없습니다.');
    const map = {
      key: mapKey(config.urls[id], config.date, config.time), provider: id,
      url: config.urls[id], date: config.date, time: config.time,
      title: this.contexts.get(id)?.performance?.title || config.title || '', venue: this.contexts.get(id)?.performance?.venue || '',
      capturedAt: new Date().toISOString(), scope: 'visible',
      seats: seats.map(({ zone, row, number, available, selected, panel, x, y, width, height }) => ({ key: seatKey({ zone, row, number }), zone, row, number, available, selected, panel, x, y, width, height })),
    };
    this.seatMaps.set(id, map);
    return map;
  }

  async refreshSeatMap(id) {
    getProvider(id);
    if (this.stopped || this.state.mode !== 'map' || !['prepared', 'waiting'].includes(this.state.status) || !this.state.jobs[id] || !this.pages(id).length) throw new Error('공연의 좌석도 불러오기를 먼저 실행해주세요.');
    const generation = this.generation;
    this.state.status = 'running';
    this.task = (async () => {
      try {
        const map = await this.captureSeatMap(id, this.config, generation);
        this.update(id, 'mapped', '좌석도를 읽었습니다. 예매 준비에서 선호 좌석을 선택해주세요.', { canResume: false, blockedBy: null, mapKey: map.key, capturedAt: map.capturedAt });
      } catch (error) {
        this.update(id, this.stopped ? 'stopped' : 'waiting', error.message, { canResume: !this.stopped, phase: 'zone', resumeSteps: ['zone'], blockedBy: error.blockedBy || null });
      }
      this.finish();
    })();
    await this.task;
    return this.state;
  }

  async waitForSeats(id, config, generation) {
    const deadline = Date.now() + this.elementWaitMs;
    do {
      await this.checkBlockers(id, generation);
      const found = await this.scanSeats(id, config);
      if (found.length || Date.now() >= deadline) return found;
      await wait(this.pollMs);
    } while (true);
  }

  async selectSeats(id, config, generation) {
    const preference = matchingPreference(config, id);
    if (config.seatPreferences?.[id] && !preference) throw new Error('공연·회차와 선호 좌석이 일치하지 않습니다. 좌석도를 다시 불러와주세요.');
    if (preference) config = { ...config, zones: [...new Set(preference.seats.map(seat => seat.zone))].join(', '), rows: '', preferredSeats: preference.seats };
    const profile = config.profiles[id] || {};
    await this.checkBlockers(id, generation);
    const currentSeats = await this.scanSeats(id, config);
    this.guard(generation, id);
    if (currentSeats.some(seat => seat.selected)) {
      this.state.winner = id;
      throw new Error('이미 선택된 좌석이 있습니다. 브라우저에서 현재 좌석을 확인해주세요.');
    }
    for (const zone of splitPreferences(config.zones)) {
      this.guard(generation, id);
      const escaped = escapeValue(zone);
      const selectors = profile.zone ? [interpolate(profile.zone, config, zone)] : ['role=button[name="' + escaped + '"s]', 'role=link[name="' + escaped + '"s]', '[data-zone="' + escaped + '"]:not([data-seat-id],[data-seat-no],[data-row],[title*="열"],[aria-label*="열"])'];
      // A full seat map may already expose this zone without a separate zone control.
      const visibleChoices = profile.zone ? [] : chooseSeats(await this.scanSeats(id, config), { ...config, zones: zone });
      if (!visibleChoices.length) await this.clickOne(id, selectors, generation, !profile.zone);
      const found = await this.waitForSeats(id, config, generation);
      this.guard(generation, id);
      if (found.some(s => s.selected)) {
        this.state.winner = id;
        throw new Error('이미 선택된 좌석이 있습니다. 브라우저에서 현재 좌석을 확인해주세요.');
      }
      const choices = chooseSeats(found, { ...config, zones: zone });
      if (!choices.length) continue;
      this.guard(generation, id);
      this.state.winner = id;
      this.update(id, 'selecting', '조건에 맞는 좌석을 선택합니다.', { canResume: false });
      for (const seat of choices) {
        await this.checkBlockers(id, generation);
        const data = (await seat.locator.evaluateAll(readSeatElements))[0];
        if (!data?.visible || data.disabled || data.selected || /매진|선택불가|판매완료/.test(data.label) || !sameSeat(seat, parseSeat(data.label, data))) throw new Error('좌석 상태나 위치가 변경되었습니다. 브라우저에서 선택 상태를 확인해주세요.');
        this.guard(generation, id);
        await seat.locator.click({ timeout: 4000 });
        await wait(150);
        this.guard(generation, id);
      }
      const selected = (await this.scanSeats(id, config)).filter(s => s.selected);
      this.guard(generation, id);
      const verified = selected.length === choices.length && choices.every(s => selected.some(t => sameSeat(s, t)));
      this.update(id, verified ? 'selected' : 'review', verified ? '좌석 선택 상태를 확인했습니다. 브라우저에서 최종 확인하고 직접 결제해주세요.' : '좌석 클릭 후 선택 상태를 확인하지 못했습니다. 브라우저에서 직접 확인해주세요.', { seats: choices.map(s => s.label) });
      await this.focus(id);
      return;
    }
    throw new Error('조건에 맞는 좌석을 읽지 못했습니다. 좌석이 없거나 화면 연결이 필요합니다. 캔버스 좌석도는 직접 선택해주세요.');
  }

  async runProvider(id, config, generation, resume = false, { stopBefore = '', prepareUntil = Infinity, openingDeadline = Infinity } = {}) {
    const session = this.browsers.sessions.get(id);
    const profile = config.profiles[id] || {};
    let context = this.contexts.get(id);
    try {
      this.guard(generation, id);
      if (context) context.openingRetry = false;
      if (!session) throw new Error('티켓처 브라우저를 다시 연결해주세요.');
      if (!resume) {
        if ((await this.browsers.check(id, { fresh: true, maxAgeMs: 30000 }))?.status !== 'verified') throw new Error('로그인이 만료되었거나 확인되지 않습니다. 다시 로그인해주세요.');
        this.guard(generation, id);
        session.suspended = true;
        const page = await session.context.newPage();
        const pages = new Set();
        const track = opened => { pages.add(opened); opened.on('popup', track); };
        track(page);
        this.jobPages.set(id, pages);
        this.guard(generation, id);
        this.update(id, 'opening', '설정한 공연 상세 페이지를 엽니다.', { requestKey: mapKey(config.urls[id], config.date, config.time) });
        context = { index: 0, phases: profile.order === 'entry-first' ? ['entry', 'date', 'time', 'zone'] : ['date', 'time', 'entry', 'zone'] };
        this.contexts.set(id, context);
        const response = await page.goto(config.urls[id], { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (response && response.status() >= 400) throw new Error('공연 페이지가 HTTP ' + response.status() + ' 응답을 반환했습니다. 공연 주소와 티켓처 접속 상태를 확인해주세요.');
        context.productPage = page;
        context.productUrl = page.url();
        if (allowedUrl(page.url(), getProvider(id))) {
          try { context.performance = await page.evaluate(readPerformanceInfo); } catch { /* Public metadata is optional. */ }
        }
      }
      session.suspended = true;
      const compact = config.date.replaceAll('-', '');
      const defaults = id === 'melon' ? melonSelectors(config) : id === 'nol' ? nolSelectors(config) : {};
      const selectors = {
        entry: profile.entry ? [profile.entry] : defaults.entry || ['role=button[name="예매하기"s]', 'role=link[name="예매하기"s]', 'role=button[name="일반예매"s]'],
        date: profile.date ? [interpolate(profile.date, config)] : defaults.date || ['[data-date="' + config.date + '"]', '[data-date="' + compact + '"]', '[data-perfday="' + compact + '"]', '[aria-label="' + config.date + '"]'],
        time: profile.time ? [interpolate(profile.time, config)] : defaults.time || ['role=button[name="' + config.time + '"s]', 'role=link[name="' + config.time + '"s]', '[data-time="' + config.time + '"]'],
      };
      for (; context.index < context.phases.length; context.index++) {
        const phase = context.phases[context.index];
        this.guard(generation, id);
        if (phase === stopBefore) {
          context.prepared = true;
          this.update(id, 'armed', '공연 페이지에서 날짜와 회차를 선택했습니다. 지정 시각에 예매하기부터 진행합니다.', { phase, canResume: false, blockedBy: null, preparedAt: new Date().toISOString() });
          return;
        }
        this.update(id, phase, PHASE_LABELS[phase] + ' 중입니다.', { phase, canResume: false, blockedBy: null });
        if (phase === 'zone' && this.state.mode === 'map') {
          const map = await this.captureSeatMap(id, config, generation);
          this.update(id, 'mapped', '좌석도를 읽었습니다. 예매 준비에서 선호 좌석을 선택해주세요.', { canResume: false, mapKey: map.key, capturedAt: map.capturedAt });
        } else if (phase === 'zone') await this.selectSeats(id, config, generation);
        else {
          const beforeDate = phase === 'date' && !profile.date
            ? id === 'melon'
              ? async () => revealMelonDate(await this.visibleFrames(id), config, () => this.guard(generation, id))
              : id === 'nol'
                ? async () => revealNolDate(await this.visibleFrames(id), config, () => this.guard(generation, id))
                : null
            : null;
          const until = Math.min(prepareUntil, openingDeadline, Number.isFinite(openingDeadline) ? Date.now() + this.openingProbeMs : Infinity);
          await this.clickOne(id, selectors[phase], generation, false, beforeDate, {
            until,
            beforeClick: () => {
              if (Date.now() >= Math.min(prepareUntil, openingDeadline)) throw Object.assign(new Error('오픈 대기 단계로 전환합니다.'), { code: 'TARGET_MISSING' });
              if (phase === 'entry') context.entryAttempted = true;
            },
          });
        }
      }
    } catch (error) {
      const canResume = !this.stopped && !this.state.winner && context && this.pages(id).length > 0;
      // A verification overlay may appear while Playwright waits for a click.
      // Classify the current screen instead of exposing a generic click timeout.
      if (canResume && !error.blockedBy) {
        try { await this.checkBlockers(id, generation); }
        catch (blocker) { if (blocker.blockedBy) error = blocker; }
      }
      if (canResume && error.code === 'TARGET_MISSING' && !error.blockedBy && !context.entryAttempted && id === 'melon' && context.phases[0] === 'date') {
        if (stopBefore) {
          this.update(id, 'waiting_open', '아직 날짜·회차를 선택할 수 없습니다. 예약 시각에 오픈 화면을 다시 확인합니다.', { phase: context.phases[context.index], canResume: false, blockedBy: null, targetAt: prepareUntil });
          return;
        }
        if (Number.isFinite(openingDeadline)) {
          context.openingRetry = true;
          this.update(id, 'opening', '설정한 날짜·회차와 예매 버튼이 열리는지 확인 중입니다.', { phase: context.phases[context.index], canResume: false, blockedBy: null });
          return;
        }
      }
      // Login can return to the product page after the booking-entry click.
      // Keep that step available so the user can reopen booking in the same tab.
      const entryIndex = context?.phases.indexOf('entry');
      const retryEntry = ['login', 'queue'].includes(error.blockedBy);
      const resumeIndex = retryEntry && entryIndex >= 0 ? Math.min(context.index, entryIndex) : context?.index;
      if (error.blockedBy === 'queue' && id === 'charlotte') {
        const failed = this.pages(id)[0];
        if (failed && !allowedUrl(failed.url(), getProvider(id)) && typeof failed.close === 'function') {
          try { await failed.close(); } catch { /* A popup already closed by the site needs no cleanup. */ }
        }
      }
      this.update(id, this.stopped ? 'stopped' : this.state.winner === id ? 'review' : this.state.winner ? 'stopped' : canResume ? 'waiting' : 'attention', error.message, {
        canResume: Boolean(canResume), resumeSteps: canResume ? context.phases.slice(resumeIndex) : [],
        blockedBy: error.blockedBy || null,
        phase: context?.phases[context.index] || null,
      });
      if (canResume && error.blockedBy) {
        try { await this.focus(id); } catch { /* The user can reopen the visible window from the run card. */ }
      }
    } finally { if (session) session.suspended = false; }
  }
}
