import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getProvider, allowedUrl, allowedBookingUrl } from '../shared/providers.mjs';
import { classifyLogin } from '../shared/model.mjs';
import { readPerformanceSchedule } from './schedule.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function findSystemChrome(environment = process.env, exists = existsSync) {
  const candidates = [
    environment.PROGRAMFILES && join(environment.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    environment['PROGRAMFILES(X86)'] && join(environment['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    environment.LOCALAPPDATA && join(environment.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  return candidates.find(candidate => exists(candidate)) || '';
}

export function findSystemEdge(environment = process.env, exists = existsSync) {
  const candidates = [
    environment.PROGRAMFILES && join(environment.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    environment['PROGRAMFILES(X86)'] && join(environment['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    environment.LOCALAPPDATA && join(environment.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  return candidates.find(candidate => exists(candidate)) || '';
}

export function findSystemBrowser(environment = process.env, exists = existsSync) {
  const preferred = String(environment.TICKET_ASSISTANT_BROWSER || 'chrome').toLowerCase();
  const finders = preferred === 'edge' ? [findSystemEdge, findSystemChrome] : [findSystemChrome, findSystemEdge];
  return finders.map(find => find(environment, exists)).find(Boolean) || '';
}

export function readLoginSignals() {
  const visible = el => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none');
  const controls = [...document.querySelectorAll('a,button,[role="button"],input[type="button"],input[type="submit"]')].filter(visible);
  const names = controls.map(el => (el.getAttribute('aria-label') || el.textContent?.trim() || el.querySelector('img[alt]')?.getAttribute('alt') || el.getAttribute('value') || '').replace(/\s+/g, '').toLowerCase());
  // Read only visibility and labels, never login input values or cookies.
  const passwordVisible = [...document.querySelectorAll('input[type="password"]')].some(visible);
  const bodyText = document.body?.innerText || '';
  const address = typeof location === 'undefined' ? '' : location.href;
  const blocked = [...document.querySelectorAll('input[id*="captcha" i],input[name*="captcha" i],iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],input[placeholder*="보안문자"],input[aria-label*="보안문자"],input[placeholder*="대소문자"][placeholder*="문자"]')].some(visible);
  const accessRestricted = /비정상적인\s*접근으로\s*일시적으로\s*서비스\s*접속이\s*제한/.test(bodyText)
    || /restricted\s+access\s+to\s+service/i.test(bodyText) && /policy\s+violations|code:\s*12/i.test(bodyText);
  const netFunnelInvalid = /facility\.ticketlink\.co\.kr\/error\/popup\/none/i.test(address) && /error\.netfunnel\.invalid\.key/i.test(address)
    || /비정상적인\s*접근으로\s*이용이\s*일시\s*제한/.test(bodyText) && /정상적인\s*방법으로\s*예매/.test(bodyText);
  const queueVisible = [...document.querySelectorAll('[id*="netfunnel" i],[id*="waiting" i],[class*="queue" i],[role="dialog"]')]
    .some(el => visible(el) && /접속\s*대기|대기\s*(순서|순번|인원)|예상\s*대기\s*시간/.test(el.innerText || ''));
  const logoutVisible = names.some(name => /^(로그아웃|logout|signout)$/.test(name)) || controls.some(el => /logout|logoff/i.test(el.getAttribute('href') || '') && !/로그인/.test(el.textContent || ''));
  const loginVisible = names.some(name => /^(로그인|login|signin|로그인하기|회원로그인|로그인또는회원가입하기|카카오계정로그인|카카오qr코드로그인|멜론아이디로그인)$/.test(name));
  return { passwordVisible, blocked, accessRestricted, netFunnelInvalid, queueVisible, logoutVisible, loginVisible };
}

export async function inspectLoginPage(page, provider) {
  const signals = { trusted: false, logoutVisible: false, loginVisible: false, passwordVisible: false, blocked: false, accessRestricted: false, netFunnelInvalid: false, queueVisible: false };
  const pageUrl = page.url();
  if (/^https:\/\/cdn-botmanager\.stclab\.com\//.test(page.url())) {
    try {
      const observed = await page.evaluate(readLoginSignals);
      return { ...signals, blocked: !observed.accessRestricted, accessRestricted: observed.accessRestricted };
    } catch { return { ...signals, blocked: true }; }
  }
  if (!allowedBookingUrl(page.url(), provider, true)) return signals;
  for (const frame of page.frames()) {
    if (!allowedBookingUrl(frame.url(), provider, true)) continue;
    try {
      if (frame.parentFrame?.() && !await (await frame.frameElement()).isVisible()) continue;
      const frameUrl = frame.url();
      const observed = await frame.evaluate(readLoginSignals);
      if (page.url() !== pageUrl || frame.url() !== frameUrl) continue;
      const trusted = allowedUrl(frame.url(), provider);
      signals.logoutVisible ||= trusted && observed.logoutVisible;
      signals.trusted ||= trusted;
      signals.passwordVisible ||= observed.passwordVisible;
      signals.blocked ||= observed.blocked;
      signals.accessRestricted ||= observed.accessRestricted;
      signals.netFunnelInvalid ||= observed.netFunnelInvalid;
      signals.queueVisible ||= observed.queueVisible;
      signals.loginVisible ||= observed.loginVisible;
    } catch { /* A navigating frame cannot supply login evidence. */ }
  }
  return signals;
}

export class BrowserManager {
  constructor({ driver = chromium, dataDir = join(process.env.LOCALAPPDATA || homedir(), 'TicketAssistant', 'profiles'), emit = () => {}, settleMs = 4000, browserExecutable = findSystemBrowser() } = {}) {
    Object.assign(this, { driver, dataDir, emit, settleMs, browserExecutable });
    this.sessions = new Map();
    this.opening = new Map();
    this.checking = new Map();
    this.states = new Map();
    this.closed = false;
  }

  setState(id, patch) {
    const next = { ...(this.states.get(id) || {}), ...patch, checkedAt: new Date().toISOString() };
    if (next.status !== 'verified') next.verifiedAt = null;
    this.states.set(id, next);
    this.emit({ type: 'login', provider: id, ...next });
    return next;
  }

  snapshot() { return Object.fromEntries(this.states); }

  queueCheck(id, session) {
    clearTimeout(session.eventTimer);
    session.eventTimer = setTimeout(async () => {
      try {
        // A navigation can happen during an inspection. Read the new page after
        // that inspection finishes, rather than returning its outdated result.
        const pending = this.checking.get(id);
        if (pending) await pending.task;
        if (this.sessions.get(id) === session && !session.suspended) await this.check(id);
      } catch { /* The periodic check will retry a closing or navigating page. */ }
    }, 150);
    session.eventTimer.unref?.();
  }

  watch(id, session, page) {
    const observe = () => {
      if (session.transientPages?.has(page)) return;
      if (!allowedUrl(page.url(), session.provider, true)) return;
      session.observedPage = page;
      if (!allowedUrl(page.url(), session.provider)) session.freshAt = null;
      this.queueCheck(id, session);
    };
    observe();
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) observe();
    });
    if (id === 'nol') page.on('response', response => {
      this.captureNolLoginEvidence(id, session, page, response).catch(() => {});
    });
    page.on('close', () => {
      if (session.transientPages?.has(page)) return;
      if (session.observedPage !== page) return;
      session.observedPage = null;
      // SSO popups can close without reloading their opener. Refresh the official
      // verification page before accepting any older tab's login display.
      session.refreshNeeded = true;
      session.freshAt = null;
      this.queueCheck(id, session);
    });
  }

  async captureNolLoginEvidence(id, session, page, response) {
    let url;
    try { url = new URL(response.url()); } catch { return; }
    if (url.origin !== 'https://nol.yanolja.com' || url.pathname !== '/api/v2/member-site/mypage/home/v2' || response.status() < 200 || response.status() >= 300) return;
    const payload = await response.json();
    if (typeof payload?.isLogin !== 'boolean' || this.sessions.get(id) !== session || page.isClosed()) return;
    // Retain only the official Boolean login result. User fields in the response,
    // credentials, input values and cookies are never stored or emitted.
    session.loginEvidence ||= new WeakMap();
    session.loginEvidence.set(page, { authenticated: payload.isLogin, pageUrl: page.url() });
    session.nolAuthentication = { authenticated: payload.isLogin, checkedAt: Date.now() };
    if (!session.suspended) this.queueCheck(id, session);
  }

  poll(id, session) {
    if (session.timer) return;
    session.timer = setInterval(() => { if (!session.suspended) this.check(id).catch(() => {}); }, 3500);
    session.timer.unref?.();
  }

  async open(id) {
    getProvider(id);
    if (this.closed) return this.setState(id, { status: 'closed', origin: '', detail: '프로그램이 종료되어 브라우저 연결을 중지했습니다.' });
    if (this.opening.has(id)) return this.opening.get(id);
    const operation = this.openInternal(id).finally(() => this.opening.delete(id));
    this.opening.set(id, operation);
    return operation;
  }

  async openInternal(id) {
    const provider = getProvider(id);
    let session = this.sessions.get(id);
    try {
      if (!session?.context.pages().some(p => !p.isClosed())) {
        if (session) {
          clearInterval(session.timer);
          clearTimeout(session.eventTimer);
          this.sessions.delete(id);
          const previous = session;
          session = null;
          await previous.context.close();
        }
        this.setState(id, { status: 'opening', origin: '', detail: '공식 티켓처의 로그인 상태를 확인합니다.' });
        const profile = join(this.dataDir, id);
        await mkdir(profile, { recursive: true });
        if (this.closed) return this.setState(id, { status: 'closed', origin: '', detail: '프로그램이 종료되어 브라우저 연결을 중지했습니다.' });
        const launchOptions = { headless: false, viewport: null, locale: 'ko-KR', timezoneId: 'Asia/Seoul', args: ['--start-maximized'] };
        // Playwright adds --no-sandbox by default. Chrome warns about it and it is
        // unnecessary on Windows, so run the installed browser without that flag.
        if (process.platform === 'win32') launchOptions.ignoreDefaultArgs = ['--no-sandbox'];
        if (this.browserExecutable) launchOptions.executablePath = this.browserExecutable;
        const context = await this.driver.launchPersistentContext(profile, launchOptions);
        if (this.closed) {
          await context.close();
          return this.setState(id, { status: 'closed', origin: '', detail: '프로그램이 종료되어 브라우저 연결을 중지했습니다.' });
        }
        context.setDefaultTimeout(4000);
        session = { context, provider, timer: null, suspended: false, loginEvidence: new WeakMap(), nolAuthentication: null, transientPages: new WeakSet() };
        this.sessions.set(id, session);
        const owned = session;
        context.on('close', () => {
          clearInterval(owned.timer);
          clearTimeout(owned.eventTimer);
          if (this.sessions.get(id) !== owned) return;
          this.sessions.delete(id);
          this.setState(id, { status: 'closed', origin: '', detail: '브라우저가 닫혔습니다. 티켓처를 다시 연결해주세요.' });
        });
        context.on('page', page => this.watch(id, owned, page));
        for (const page of context.pages()) this.watch(id, owned, page);
      }
      this.poll(id, session);
      let result = await this.check(id, { fresh: true });
      const page = session.verificationPage;
      if (page && !page.isClosed()) await page.bringToFront();
      if (result.status === 'required' && page) {
        for (const role of ['link', 'button']) {
          const login = page.getByRole(role, { name: /^(로그인|로그인하기|회원로그인|Login|Sign in)$/i });
          const count = await login.count();
          for (let i = 0; i < Math.min(count, 4); i++) {
            if (!await login.nth(i).isVisible()) continue;
            await login.nth(i).click({ timeout: 3000 });
            return this.check(id, { settle: true });
          }
        }
      }
      return result;
    } catch (error) {
      if (session && this.sessions.get(id) !== session) return this.states.get(id);
      const detail = error.message.includes("Executable doesn't exist") ? '전용 브라우저가 설치되지 않았습니다. 브라우저 설치.cmd를 실행해주세요.' : error.message;
      return this.setState(id, { status: 'error', detail: detail.slice(0, 350) });
    }
  }

  async check(id, options = {}) {
    getProvider(id);
    const pending = this.checking.get(id);
    if (pending) {
      if ((!options.fresh || pending.fresh) && (!options.settle || pending.settle)) return pending.task;
      await pending.task;
      return this.check(id, options);
    }
    const entry = { fresh: Boolean(options.fresh), settle: Boolean(options.fresh || options.settle) };
    entry.task = this.checkInternal(id, options).finally(() => {
      if (this.checking.get(id) === entry) this.checking.delete(id);
    });
    this.checking.set(id, entry);
    return entry.task;
  }

  async checkInternal(id, { fresh = false, maxAgeMs = 0, settle = false } = {}) {
    const provider = getProvider(id);
    const session = this.sessions.get(id);
    if (!session) return this.states.get(id) || { status: 'idle', detail: '티켓처를 선택해주세요.' };
    const commit = patch => this.sessions.get(id) === session ? this.setState(id, patch) : this.states.get(id);
    const pages = session.context.pages().filter(p => !p.isClosed());
    if (!pages.length) return commit({ status: 'closed', detail: '열린 티켓처 창이 없습니다.' });
    try {
      if (session.observedPage?.isClosed()) {
        session.observedPage = null;
        session.refreshNeeded = true;
        session.freshAt = null;
      }
      let page = session.observedPage || pages.at(-1);
      const recent = session.verificationPage === page && session.freshAt && Date.now() - session.freshAt <= maxAgeMs;
      const refresh = session.refreshNeeded || (fresh && !recent);
      if (refresh) {
        commit({ status: 'checking', detail: '공식 사이트를 새로 열어 로그인 유효 여부를 확인합니다.' });
        if (provider.id === 'nol') session.nolAuthentication = null;
        page = session.verificationPage && !session.verificationPage.isClosed() ? session.verificationPage : pages.find(p => p.url() === 'about:blank') || await session.context.newPage();
        session.verificationPage = page;
        session.observedPage = page;
        session.freshAt = null;
        session.refreshNeeded = false;
        const response = await page.goto(provider.account || provider.home, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (response && response.status() >= 400) throw new Error('공식 사이트가 HTTP ' + response.status() + ' 응답을 반환했습니다.');
        session.freshAt = Date.now();
      }
      const deadline = Date.now() + (fresh || refresh || settle ? this.settleMs : 0);
      let result;
      do {
        const signals = await inspectLoginPage(page, provider);
        const evidence = session.loginEvidence?.get(page);
        if (provider.id === 'nol' && allowedUrl(page.url(), provider)) {
          if (evidence?.pageUrl === page.url()) signals.sessionAuthenticated = evidence.authenticated;
          else if (typeof session.nolAuthentication?.authenticated === 'boolean') signals.sessionAuthenticated = session.nolAuthentication.authenticated;
        }
        result = classifyLogin(signals);
        if (result.status !== 'unknown' || Date.now() >= deadline || page.isClosed() || this.sessions.get(id) !== session) break;
        await wait(250);
      } while (true);
      if (page.isClosed()) return commit({ status: 'unknown', detail: '확인하던 창이 닫혔습니다. 열린 로그인 창에서 다시 확인해주세요.' });
      if (session.observedPage && !session.observedPage.isClosed() && session.observedPage !== page) return commit({ status: 'checking', detail: '이동한 로그인 화면을 확인하고 있습니다.' });
      const origin = allowedUrl(page.url(), provider, true) ? new URL(page.url()).origin : '';
      return commit({ ...result, origin, verifiedAt: result.status === 'verified' ? new Date().toISOString() : null, refreshedAt: session.freshAt ? new Date(session.freshAt).toISOString() : null });
    } catch (error) {
      return commit({ status: 'error', detail: '로그인 확인 실패: ' + error.message.slice(0, 280) });
    }
  }

  async focus(id, { allowOpen = true, verification = false } = {}) {
    const session = this.sessions.get(id);
    let page = session?.observedPage && !session.observedPage.isClosed() ? session.observedPage : session?.context.pages().filter(p => !p.isClosed()).at(-1);
    const onAuthPage = page && allowedUrl(page.url(), getProvider(id), true) && !allowedUrl(page.url(), getProvider(id));
    if (verification && !onAuthPage && session?.verificationPage && !session.verificationPage.isClosed()) page = session.verificationPage;
    if (page) await page.bringToFront();
    else if (allowOpen) await this.open(id);
    else throw new Error('티켓처 창이 닫혔습니다. 실행을 중지하고 다시 연결해주세요.');
  }

  async schedule(id, { url, date } = {}) {
    const provider = getProvider(id);
    const address = typeof url === 'string' ? url.trim() : '';
    if (!allowedUrl(address, provider)) throw new Error(`${provider.name}의 공식 공연 상세 URL을 입력해주세요.`);
    const dateValue = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(date + 'T00:00:00Z') : Number.NaN;
    if (!Number.isFinite(dateValue) || new Date(dateValue).toISOString().slice(0, 10) !== date) throw new Error('유효한 관람 날짜를 선택해주세요.');
    const session = this.sessions.get(id);
    if (!session) throw new Error(`${provider.name} 브라우저를 먼저 연결해주세요.`);
    const previousSuspended = session.suspended;
    session.suspended = true;
    const page = await session.context.newPage();
    session.transientPages ||= new WeakSet();
    session.transientPages.add(page);
    try {
      const response = await page.goto(address, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (response && response.status() >= 400) throw new Error(`공식 공연 페이지가 HTTP ${response.status()} 응답을 반환했습니다.`);
      const signals = await inspectLoginPage(page, provider);
      if (signals.accessRestricted) throw new Error('티켓처가 현재 브라우저의 공연 페이지 접근을 제한했습니다.');
      if (signals.blocked) throw new Error('공식 페이지의 보안 확인을 직접 완료한 뒤 회차를 다시 불러와주세요.');
      return { provider: id, url: address, ...await readPerformanceSchedule({ page, id, date }) };
    } finally {
      try { await page.close(); } catch { /* A site-closed temporary tab needs no cleanup. */ }
      session.suspended = previousSuspended;
    }
  }

  async close() {
    this.closed = true;
    if (!this.closing) this.closing = (async () => {
      await Promise.allSettled([...this.sessions.values()].map(s => { clearInterval(s.timer); clearTimeout(s.eventTimer); return s.context.close(); }));
      await Promise.allSettled([...this.opening.values()]);
    })();
    return this.closing;
  }
}
