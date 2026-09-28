import { useEffect, useRef, useState } from 'react';
import './resume.css';
import './status.css';
import { Activity, ArrowRight, CalendarDays, Check, CheckCircle2, ChevronRight, CircleHelp, Clock3, ExternalLink, Globe2, Layers3, Link2, LoaderCircle, LogIn, Monitor, Pause, Play, Plus, RefreshCw, Save, Settings2, ShieldCheck, Ticket, X, Minus } from 'lucide-react';
import { PROVIDERS, LOGIN_LABELS } from '../shared/providers.mjs';
import { defaultPreferences, validatePreferences, splitPreferences, ACTIVE_RUN_STATES, PHASE_LABELS } from '../shared/model.mjs';
import { matchingPreference } from '../shared/seat-map.mjs';
import SeatMapPreferences from './SeatMapPreferences.jsx';
import { API_REVISION } from '../shared/app-version.mjs';

const MENU = [{ id: 'prepare', label: '예매 준비', icon: Ticket }, { id: 'login', label: '로그인 연결', icon: ShieldCheck }, { id: 'profiles', label: '화면 연결', icon: Settings2 }, { id: 'logs', label: '실행 기록', icon: Activity }];
const timeOf = value => value ? new Date(value).toLocaleTimeString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' }) : '—';
const RUN_LABELS = { idle: '준비 대기', validating: '실행 전 로그인 확인 중', scheduled: '예약 시간까지 대기', running: '예매 진행 중', prepared: '좌석도 준비됨', waiting: '직접 확인 후 이어가기', stopping: '중지 처리 중', stopped: '실행 중지됨', attention: '진행하지 못함 · 실행 기록 확인', error: '실행 오류 · 실행 기록 확인', review: '좌석 확인 필요' };
const validateConfiguration = config => { try { validatePreferences(config, true); return ''; } catch (error) { return error.message; } };
const profileFields = [{ key: 'entry', label: '예매하기 버튼', hint: '예: #ticketBooking' }, { key: 'date', label: '관람 날짜', hint: '예: [data-date="{date}"]' }, { key: 'time', label: '회차', hint: '예: [data-time="{time}"]' }, { key: 'zone', label: '구역', hint: '예: [data-zone="{zone}"]' }, { key: 'seat', label: '개별 좌석', hint: '예: [data-seat-id]' }];

export default function App() {
  const [config, setConfig] = useState(defaultPreferences);
  const [tab, setTab] = useState('prepare');
  const [multi, setMulti] = useState(true);
  const [connected, setConnected] = useState(false);
  const [serverRevision, setServerRevision] = useState('');
  const [status, setStatus] = useState({ logins: {}, run: { status: 'idle', jobs: {} }, logs: [] });
  const [busy, setBusy] = useState({});
  const [message, setMessage] = useState(null);
  const [now, setNow] = useState(new Date());
  const token = useRef('');
  const [performanceInfo, setPerformanceInfo] = useState({});
  const [performanceSchedules, setPerformanceSchedules] = useState({});
  const inspectionUrls = useRef({});
  const manualVenueUrls = useRef({});
  const scheduleRequests = useRef({});
  const requestBusy = useRef(new Set());
  const active = Boolean(busy.run) || ACTIVE_RUN_STATES.includes(status.run.status);
  const checkingLocked = busy.run || ['validating', 'running', 'scheduled', 'stopping'].includes(status.run.status);
  const selected = PROVIDERS.filter(p => config.selected.includes(p.id));
  const verified = selected.filter(p => status.logins[p.id]?.status === 'verified');
  const scheduleEntries = selected.flatMap(provider => {
    const result = performanceSchedules[provider.id];
    return result?.date === config.date && result?.url === config.urls[provider.id]?.trim() && Array.isArray(result.sessions) ? [{ provider, result }] : [];
  });
  const actualSessions = [...new Set(scheduleEntries.flatMap(entry => entry.result.sessions.map(session => session.time)))].sort().map(time => ({
    time,
    details: scheduleEntries.flatMap(({ provider, result }) => result.sessions.filter(session => session.time === time).map(session => ({ provider, ...session }))),
  }));
  const selectedActualSession = actualSessions.find(session => session.time === config.time);
  const schedulePending = selected.some(provider => busy['schedule-' + provider.id]);
  const scheduleErrors = selected.flatMap(provider => performanceSchedules[provider.id]?.date === config.date && performanceSchedules[provider.id]?.error ? [{ provider, message: performanceSchedules[provider.id].error }] : []);
  const openingMode = config.sessionMode === 'opening';
  const actualSessionError = !openingMode && selected.length && config.date && selected.some(provider => config.urls[provider.id]?.trim()) && !selectedActualSession ? '공식 공연 페이지에서 실제 회차를 불러와 선택해주세요.' : '';
  const configurationError = validateConfiguration(config) || actualSessionError || (openingMode && serverRevision !== API_REVISION ? '오픈 전 준비를 사용하려면 실행 창을 닫고 프로그램을 다시 실행해주세요.' : '');
  const configured = !configurationError;
  const connecting = selected.some(p => busy[p.id]);
  const ready = configured && verified.length === selected.length && connected && !active && !connecting && !schedulePending;
  const runLabel = RUN_LABELS[busy.run && !ACTIVE_RUN_STATES.includes(status.run.status) ? 'validating' : status.run.status] || status.run.status;
  const runBlocker = !connected ? '로컬 프로그램에 연결한 뒤 실행할 수 있습니다.' : active ? '' : configurationError || (schedulePending ? '진행 중인 회차 확인을 마칠 때까지 기다려주세요.' : connecting ? '티켓처 연결 확인을 마칠 때까지 기다려주세요.' : verified.length !== selected.length ? '로그인 연결에서 선택한 티켓처의 로그인을 확인해주세요.' : '');
  const zones = splitPreferences(config.zones);
  const venueMapsAvailable = serverRevision === API_REVISION;

  async function api(path, data, method = data === undefined ? 'GET' : 'POST') {
    const response = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Ticket-Token': token.current }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    let result;
    try { result = await response.json(); } catch { throw new Error('프로그램 연결을 확인해주세요.'); }
    if (!response.ok) throw Object.assign(new Error(result.error || '요청을 처리하지 못했습니다.'), { status: response.status });
    return result;
  }

  useEffect(() => {
    let disposed = false;
    let timer;
    async function initialize() {
      try {
        const result = await api('/bootstrap');
        if (disposed) return;
        token.current = result.token;
        setServerRevision(result.revision || 'legacy');
        if (result.settings) setConfig(result.settings);
        if (result.settingsError) setMessage({ type: 'error', text: result.settingsError });
        setConnected(true);
        await poll();
      } catch (error) { if (!disposed) { setConnected(false); setMessage({ type: 'error', text: error.message }); timer = setTimeout(initialize, 4000); } }
    }
    async function poll() {
      try { const result = await api('/status'); if (!disposed) { setStatus(result); setConnected(true); } }
      catch {
        if (!disposed) {
          setConnected(false);
          try {
            const bootstrap = await api('/bootstrap');
            if (!disposed) { token.current = bootstrap.token; setServerRevision(bootstrap.revision || 'legacy'); }
          } catch { /* Retry the connection without replacing unsaved settings. */ }
        }
      }
      if (!disposed) timer = setTimeout(poll, 2000);
    }
    initialize();
    return () => { disposed = true; clearTimeout(timer); };
  }, []);
  useEffect(() => { const interval = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(interval); }, []);

  const patch = values => setConfig(current => ({ ...current, ...values }));
  async function action(key, fn) {
    if (requestBusy.current.has(key)) return;
    requestBusy.current.add(key);
    setBusy(prev => ({ ...prev, [key]: true }));
    try { await fn(); } catch (error) { setMessage({ type: 'error', text: error.message }); }
    finally { requestBusy.current.delete(key); setBusy(prev => ({ ...prev, [key]: false })); }
  }
  async function connect(id) {
    await action(id, async () => {
      setStatus(prev => ({ ...prev, logins: { ...prev.logins, [id]: { status: 'opening', detail: '공식 로그인 화면을 여는 중입니다.' } } }));
      try {
        const result = await api('/providers/' + id + '/open', {});
        setStatus(prev => ({ ...prev, logins: { ...prev.logins, [id]: result } }));
      } catch (error) {
        setStatus(prev => ({ ...prev, logins: { ...prev.logins, [id]: { status: 'error', detail: error.message } } }));
        throw error;
      }
    });
  }
  function toggleProvider(id) {
    if (active || !connected) return;
    const removing = config.selected.includes(id);
    patch({ selected: removing ? config.selected.filter(p => p !== id) : multi ? [...config.selected, id] : [id] });
    if (!removing) connect(id);
  }
  const save = () => action('save', async () => { await api('/settings', config); setMessage({ type: 'success', text: '이 PC에 예매 설정을 저장했습니다.' }); });
  const start = () => action('run', async () => { setMessage(null); setTab('logs'); const run = await api('/run', config); setStatus(prev => ({ ...prev, run })); });
  const resume = (id, phase) => action(id, async () => { const run = await api('/providers/' + id + '/resume', { runId: status.run.runId, phase }); setStatus(prev => ({ ...prev, run })); });
  const stop = () => action('stop', async () => { await api('/stop', {}); setMessage({ type: 'success', text: '중지를 요청했습니다. 현재 화면과 로그인은 유지됩니다.' }); });
  const changeProfile = (id, key, value) => patch({ profiles: { ...config.profiles, [id]: { ...config.profiles[id], [key]: value } } });
  const setSeatPreference = (id, value) => setConfig(previous => ({ ...previous, seatPreferences: { ...previous.seatPreferences, [id]: value } }));
  function changePerformanceUrl(id, value) {
    inspectionUrls.current[id] = value.trim();
    delete manualVenueUrls.current[id];
    delete scheduleRequests.current[id];
    setPerformanceInfo(previous => { const next = { ...previous }; delete next[id]; return next; });
    setPerformanceSchedules(previous => { const next = { ...previous }; delete next[id]; return next; });
    setConfig(previous => {
      if (previous.urls[id] === value) return previous;
      const seatPreferences = { ...previous.seatPreferences };
      delete seatPreferences[id];
      return { ...previous, time: '', urls: { ...previous.urls, [id]: value }, venues: { ...previous.venues, [id]: '' }, seatPreferences };
    });
  }
  function changeDate(date) {
    scheduleRequests.current = {};
    setPerformanceSchedules({});
    setConfig(previous => ({ ...previous, date, time: '' }));
  }
  function changeTime(time) {
    setConfig(previous => ({ ...previous, time }));
  }
  function changeVenue(id, venueId, manual = true) {
    if (manual) {
      if (venueId) manualVenueUrls.current[id] = inspectionUrls.current[id] || config.urls[id].trim();
      else delete manualVenueUrls.current[id];
    }
    setConfig(previous => {
      if (previous.venues[id] === venueId) return previous;
      const seatPreferences = { ...previous.seatPreferences };
      delete seatPreferences[id];
      return { ...previous, venues: { ...previous.venues, [id]: venueId }, seatPreferences };
    });
  }
  const inspectVenue = (id, address = config.urls[id]) => {
    const expectedUrl = address.trim();
    inspectionUrls.current[id] = expectedUrl;
    return action('inspect-' + id, async () => {
    setMessage(null);
    const result = await api('/providers/' + id + '/performance/inspect', { url: expectedUrl });
    if (inspectionUrls.current[id] !== expectedUrl) return;
    setPerformanceInfo(previous => ({ ...previous, [id]: result }));
    if (result.venueId && manualVenueUrls.current[id] !== expectedUrl) changeVenue(id, result.venueId, false);
    if (result.title) setConfig(previous => previous.title ? previous : { ...previous, title: result.title });
    });
  };

  async function loadSchedule(provider, url, date, force = false) {
    const key = `${url}|${date}`;
    const busyKey = 'schedule-' + provider.id;
    if ((!force && scheduleRequests.current[provider.id] === key) || requestBusy.current.has(busyKey)) return;
    scheduleRequests.current[provider.id] = key;
    requestBusy.current.add(busyKey);
    setBusy(previous => ({ ...previous, [busyKey]: true }));
    setPerformanceSchedules(previous => ({ ...previous, [provider.id]: { provider: provider.id, url, date, sessions: [], loading: true } }));
    try {
      const result = await api('/providers/' + provider.id + '/performance/schedule', { url, date });
      if (scheduleRequests.current[provider.id] === key) setPerformanceSchedules(previous => ({ ...previous, [provider.id]: result }));
    } catch (error) {
      if (scheduleRequests.current[provider.id] === key) setPerformanceSchedules(previous => ({ ...previous, [provider.id]: { provider: provider.id, url, date, sessions: [], error: error.message } }));
    } finally {
      requestBusy.current.delete(busyKey);
      setBusy(previous => ({ ...previous, [busyKey]: false }));
    }
  }
  async function loadSchedules(force = false) {
    const targets = selected.filter(provider => config.urls[provider.id]?.trim() && status.logins[provider.id]?.status === 'verified');
    if (!targets.length) {
      if (force) setMessage({ type: 'error', text: '공연 URL을 입력하고 티켓처 로그인을 확인한 뒤 회차를 불러와주세요.' });
      return;
    }
    await Promise.all(targets.map(provider => loadSchedule(provider, config.urls[provider.id].trim(), config.date, force)));
  }

  const scheduleTargetKey = selected.map(provider => `${provider.id}:${config.urls[provider.id] || ''}:${status.logins[provider.id]?.status || ''}`).join('|');
  useEffect(() => {
    if (!connected || active || !config.date || openingMode) return undefined;
    const timer = setTimeout(() => { loadSchedules(); }, 350);
    return () => clearTimeout(timer);
  }, [connected, active, config.date, scheduleTargetKey, openingMode]);

  function loginCard(provider) {
    const info = status.logins[provider.id] || { status: 'idle', detail: '연결하면 공식 사이트에서 로그인 상태를 확인합니다.' };
    return <article className="login-card" key={provider.id}>
      <div className="login-card-top"><span className="provider-logo" style={{ '--brand': provider.color }}>{provider.short}</span><div><h3>{provider.name}</h3><span className={'login-state ' + info.status}><i />{LOGIN_LABELS[info.status] || info.status}</span></div><button className="icon-button" aria-label={provider.name + ' 브라우저 보기'} disabled={!connected || busy[provider.id]} onClick={() => action(provider.id, () => api('/providers/' + provider.id + '/focus', { view: 'login' }))}><ExternalLink size={17} /></button></div>
      <p>{info.detail}</p><div className="login-evidence"><span>화면 상태 확인</span><b>{timeOf(info.checkedAt)}</b></div>{info.refreshedAt && <div className="login-evidence"><span>공식 페이지 갱신</span><b>{timeOf(info.refreshedAt)}</b></div>}{info.origin && <small>{info.origin}</small>}
      <div className="login-card-actions"><button className="button secondary" disabled={active || !connected || busy[provider.id]} onClick={() => connect(provider.id)}>{busy[provider.id] ? <LoaderCircle className="spin" size={14} /> : <LogIn size={14} />} {info.status === 'verified' ? '브라우저 보기' : '로그인 창 열기'}</button><button className="button ghost" disabled={checkingLocked || !connected || busy[provider.id]} onClick={() => action(provider.id, async () => { const result = await api('/providers/' + provider.id + '/check', {}); setStatus(prev => ({ ...prev, logins: { ...prev.logins, [provider.id]: result } })); })}><RefreshCw size={13} /> 새로 확인</button></div>
    </article>;
  }

  return <div className="app">
    <aside className="sidebar"><a className="brand" href="#" onClick={e => { e.preventDefault(); setTab('prepare'); }}><span className="brand-icon"><Ticket size={23} strokeWidth={1.7} /></span><span>TICKET<span className="brand-light">PILOT</span><small>나의 티켓팅 도우미</small></span></a><div className="workspace-label">MY WORKSPACE</div><nav aria-label="프로그램 메뉴">{MENU.map(({ id, label, icon: Icon }) => <button key={id} className={'nav-item ' + (tab === id ? 'active' : '')} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><Icon size={18} />{label}{id === 'login' && <span>{verified.length}/{selected.length}</span>}{tab === id && <ChevronRight size={14} className="nav-arrow" />}</button>)}</nav><div className="sidebar-note"><Layers3 size={20} /><strong>여러 티켓처를, 한 곳에서.</strong><p>원하는 공연의 예매 조건을<br />미리 준비해두세요.</p><span>5개 티켓처 연결</span></div><div className="local-info"><span className={'connection-dot ' + (connected ? 'online' : '')} /><div><strong>{connected ? '내 PC에 연결됨' : '프로그램 연결 중'}</strong><small>로그인 세션은 이 PC에 저장</small></div></div></aside>
    <div className="workspace"><header className="topbar"><div><span>내 작업 공간</span><ChevronRight size={13} /><b>{MENU.find(m => m.id === tab).label}</b></div><div className="clock"><Clock3 size={14} /><span>{timeOf(now)}</span><small>KST · PC 시계</small></div></header>
      <main><div className="page-heading"><div><p className="overline">READY FOR YOUR NEXT TICKET</p><h1>{tab === 'prepare' ? '예매를 준비해볼까요?' : tab === 'login' ? '티켓처 로그인 연결' : tab === 'profiles' ? '공연별 화면 연결' : '티켓팅 실행 기록'}</h1><p>{tab === 'prepare' ? '티켓처부터 원하는 좌석까지, 한 번에 설정하세요.' : tab === 'login' ? '공식 티켓처에서 로그인한 상태를 직접 확인합니다.' : tab === 'profiles' ? '실제 공연 페이지에 맞춰 날짜·회차·좌석 항목을 연결합니다.' : '실제 실행 단계와 확인이 필요한 내용을 보여드립니다.'}</p></div><button className="button secondary save-button" disabled={!connected || busy.save || active} onClick={save}>{busy.save ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} 설정 저장</button></div>
      {message && <div className={'notice ' + message.type} role={message.type === 'error' ? 'alert' : 'status'}>{message.type === 'success' ? <CheckCircle2 size={17} /> : <CircleHelp size={17} />}<span>{message.text}</span><button aria-label="알림 닫기" onClick={() => setMessage(null)}><X size={15} /></button></div>}
      {!connected && <div className="notice error" role="alert">로컬 프로그램에 연결되지 않았습니다. 실행 창을 확인해주세요.</div>}

      {(tab === 'prepare' || tab === 'login') && <section className="panel providers-panel"><div className="panel-heading"><div className="section-label"><span className="step-number">01</span><h2>티켓처 선택</h2><span className="count-pill">{selected.length}개 선택</span></div><div className="segmented" aria-label="티켓처 선택 방식"><button aria-pressed={!multi} className={!multi ? 'selected' : ''} disabled={active} onClick={() => { setMulti(false); if (config.selected.length > 1) patch({ selected: config.selected.slice(0, 1) }); }}>단일 선택</button><button aria-pressed={multi} className={multi ? 'selected' : ''} disabled={active} onClick={() => setMulti(true)}>다중 선택</button></div></div><p className="panel-description">티켓처를 선택하면 전용 브라우저가 열리고 로그인 상태를 확인합니다.</p><div className="providers-grid">{PROVIDERS.map(p => { const checked = config.selected.includes(p.id); const login = status.logins[p.id]?.status || 'idle'; return <button key={p.id} className={'provider-card ' + (checked ? 'chosen' : '')} style={{ '--brand': p.color }} disabled={!connected || active} aria-pressed={checked} onClick={() => toggleProvider(p.id)}><span className="select-check">{checked && <Check size={12} />}</span><span className="provider-logo">{p.short}</span><strong>{p.name}</strong><span className={'provider-state ' + login}>{busy[p.id] ? <LoaderCircle size={11} className="spin" /> : <i />}{checked ? LOGIN_LABELS[login] === '선택 안 함' ? '연결 필요' : LOGIN_LABELS[login] : '선택하여 연결'}</span></button>; })}</div><div className="panel-footnote"><ShieldCheck size={13} /><span>로그인은 티켓처 공식 창에서 진행합니다. 아이디와 비밀번호를 프로그램에 입력하지 않습니다.</span><button onClick={() => setTab('login')}>연결 상태 보기 <ArrowRight size={12} /></button></div></section>}

      {tab === 'prepare' && <div className="preparation-grid"><div className="form-stack"><section className="panel"><div className="panel-heading"><div className="section-label"><span className="step-number">02</span><h2>공연과 회차</h2></div><span className="muted-tag">공연 URL은 나중에 입력 가능</span></div><fieldset disabled={active}><label className="field">공연 이름 <span className="optional">선택</span><input value={config.title} onChange={e => patch({ title: e.target.value })} placeholder="예매할 뮤지컬 이름을 입력하세요" maxLength={100} /></label><div className="url-fields">{selected.length ? selected.map(p => <label className="field" key={p.id}><span className="field-with-dot"><i style={{ background: p.color }} />{p.name} 공연 URL</span><div className="input-icon"><Link2 size={15} /><input type="url" value={config.urls[p.id] || ''} onChange={e => changePerformanceUrl(p.id, e.target.value)} onBlur={e => { const address = e.currentTarget.value.trim(); if (address && performanceInfo[p.id]?.url !== address && !busy['inspect-' + p.id]) inspectVenue(p.id, address); }} placeholder={p.hint} /></div></label>) : <div className="inline-empty"><Globe2 size={17} /> 위에서 티켓처를 선택하면 공연 주소 입력란이 나타납니다.</div>}</div><label className="field">회차 입력 방식<select aria-label="회차 입력 방식" value={config.sessionMode || 'official'} onChange={e => patch({ sessionMode: e.target.value })}><option value="official">공식 회차 불러오기</option><option value="opening" disabled={selected.length !== 1 || selected[0]?.id !== 'melon'}>멜론 오픈 전 회차 직접 입력</option></select></label>{openingMode && <p className="subtle-note">공연 공지의 관람 날짜와 회차 시간을 입력하세요. 아래 예약 실행에는 티켓 오픈 시각을 입력합니다. 오픈 후 공식 화면에서 일치하는 날짜·회차만 선택합니다.</p>}<div className="form-row"><label className="field">관람 날짜<div className="input-icon"><CalendarDays size={15} /><input aria-label="관람 날짜" type="date" value={config.date} onChange={e => changeDate(e.target.value)} /></div></label><label className="field">관람 회차<div className="input-icon"><Clock3 size={15} />{openingMode ? <input aria-label="관람 회차 직접 입력" type="time" step="60" value={config.time} onChange={e => changeTime(e.target.value)} /> : <select aria-label="관람 회차" value={selectedActualSession ? config.time : ''} disabled={active || schedulePending || !actualSessions.length} onChange={e => changeTime(e.target.value)}><option value="">{!config.date ? '날짜를 먼저 선택하세요' : schedulePending ? '공식 회차 확인 중...' : actualSessions.length ? '실제 회차를 선택하세요' : '불러온 회차가 없습니다'}</option>{actualSessions.map(session => <option key={session.time} value={session.time}>{session.time}</option>)}</select>}</div></label></div><div className="schedule-actions"><div className="helper-line"><CircleHelp size={13} /> {openingMode ? '입력한 회차는 오픈 후 확인합니다. 이미 공개된 회차는 버튼으로 다시 불러올 수 있습니다.' : '관람 날짜를 선택하면 공식 공연 페이지에서 실제 회차와 캐스팅을 확인합니다.'}</div><button type="button" className="button ghost" disabled={!config.date || schedulePending || active} onClick={() => loadSchedules(true)}>{schedulePending ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} 회차 다시 불러오기</button></div>{selectedActualSession && <div className="casting-card"><strong><Clock3 size={14} /> {selectedActualSession.time} 회차 정보</strong>{selectedActualSession.details.map(detail => <div key={detail.provider.id}><span className="provider-logo small" style={{ '--brand': detail.provider.color }}>{detail.provider.short}</span><p><b>{detail.provider.name}</b><span>{detail.casting || '공식 페이지에 캐스팅 정보가 없습니다.'}</span></p></div>)}</div>}{!openingMode && scheduleErrors.map(({ provider, message: error }) => <div className="schedule-error" key={provider.id}><span>{provider.name}</span>{error}</div>)}</fieldset></section>
      <section className="panel"><div className="panel-heading"><div className="section-label"><span className="step-number">03</span><h2>공연장 좌석도에서 선택</h2></div><span className="muted-tag">공연장 기준 희망 좌석</span></div>
        <SeatMapPreferences providers={selected} config={config} busy={busy} connected={connected} supported={venueMapsAvailable} locked={active} performanceInfo={performanceInfo} onInspect={inspectVenue} onVenueChange={changeVenue} onChange={setSeatPreference} />
        <fieldset disabled={active}><div className="form-row seat-options"><div className="field">예매 매수<div className="stepper"><button type="button" aria-label="매수 줄이기" disabled={config.quantity <= 1 || active} onClick={() => patch({ quantity: config.quantity - 1 })}><Minus size={15} /></button><span><b>{config.quantity}</b> 매</span><button type="button" aria-label="매수 늘리기" disabled={config.quantity >= 4 || active} onClick={() => patch({ quantity: config.quantity + 1 })}><Plus size={15} /></button></div></div></div>
        <label className="toggle-row"><span><strong>연석만 선택</strong><small>선호 좌석 중 같은 구역·같은 열의 연속된 좌석을 선택합니다.</small></span><input className="switch-input" type="checkbox" checked={config.adjacent} onChange={e => patch({ adjacent: e.target.checked })} /><span className={'switch ' + (config.adjacent ? 'on' : '')} aria-hidden="true" /></label>
        <details className="manual-seat-settings"><summary>기존 구역·열 직접 입력</summary><p className="subtle-note">좌석도에서 선택한 티켓처는 해당 선호 좌석만 사용합니다. 직접 입력으로 돌아가려면 아래 버튼으로 좌석도 선택을 해제하세요.</p><button type="button" className="button ghost" onClick={() => patch({ seatPreferences: {} })}>좌석도 선택 해제 · 직접 입력 사용</button><label className="field">선호 구역<textarea rows={2} value={config.zones} onChange={e => patch({ zones: e.target.value })} placeholder="공식 좌석도에 표시된 구역명" /></label><label className="field">선호 열<input value={config.rows} onChange={e => patch({ rows: e.target.value })} placeholder="예: 3, 4, 5" /></label></details></fieldset>
      </section>
      <section className="panel scheduling"><div className="section-label"><Clock3 size={18} /><h2>예약 실행</h2><span className="optional">선택</span></div><label className="field"><span className="sr-only">예매 실행 시간 (한국 시간)</span><input type="datetime-local" step="1" disabled={active} value={config.scheduledAt} onChange={e => patch({ scheduledAt: e.target.value })} /></label><p>티켓 오픈 시각을 입력하세요. 5분 전에 공연 페이지를 준비하고, 날짜·회차가 아직 없으면 오픈 대기로 유지합니다. 멜론은 정각부터 화면을 재확인하며 최대 60초·10회까지, 2초 이상 간격으로 갱신합니다. 비워두면 즉시 실행합니다.</p></section></div>
      <aside className="summary-stack"><section className="panel summary-panel"><div className="summary-title"><span className="overline">YOUR TICKETING PLAN</span><Ticket size={20} /></div><h2>준비한 예매 조건</h2><div className="summary-show"><small>공연</small><strong>{config.title || '아직 설정하지 않았어요'}</strong></div><dl><div><dt>티켓처</dt><dd>{selected.length ? selected.map(p => p.name).join(', ') : '선택 전'}</dd></div><div><dt>관람 날짜</dt><dd>{config.date || '선택 전'}</dd></div><div><dt>회차</dt><dd>{config.time || '선택 전'}</dd></div><div><dt>좌석 수</dt><dd>{config.quantity}매 <span>{config.adjacent && config.quantity > 1 ? '· 연석' : ''}</span></dd></div><div><dt>선호 좌석</dt><dd>{selected.map(p => matchingPreference(config, p.id)?.seats.length ? p.name + ': ' + matchingPreference(config, p.id).seats.length + '석' : null).filter(Boolean).join(', ') || (zones.length ? zones.join(' → ') : '선택 전')}</dd></div></dl><div className="readiness"><div><span className={selected.length && verified.length === selected.length ? 'done' : ''}><Check size={12} /></span><p>티켓처 로그인 확인</p><b>{verified.length}/{selected.length}</b></div><div><span className={configured ? 'done' : ''}><Check size={12} /></span><p>공연 · 회차 · 구역 설정</p></div><div><span><Monitor size={11} /></span><p>실제 공연 화면 연결 확인</p></div></div><button className="button primary run-button" disabled={!ready || busy.run} onClick={start}>{busy.run ? <LoaderCircle size={16} className="spin" /> : <Play size={15} fill="currentColor" />}{config.scheduledAt ? '예약 실행 대기' : '좌석 선택 실행'}<ArrowRight size={16} /></button>{runBlocker && <p className="run-blocker" role="status">{runBlocker}</p>}{active && <button className="button stop-button" onClick={stop} disabled={busy.stop}><Pause size={14} /> 실행 중지</button>}<p className="run-note">좌석 선택 후 멈춥니다.<br />선택 상태 확인과 결제는 직접 진행해주세요.</p></section><section className="tip-panel"><CircleHelp size={18} /><div><h3>처음 사용하는 공연이라면</h3><p>예매 화면은 티켓처·공연마다 다릅니다. 자동으로 읽히지 않는 항목은 화면 연결이 필요합니다.</p><button onClick={() => setTab('profiles')}>화면 연결 설정 <ArrowRight size={13} /></button></div></section><section className="status-mini"><span className="overline">LIVE STATUS</span><div className="status-mini-title"><span className={'connection-dot ' + (active ? 'online' : '')} /><strong>{runLabel}</strong></div><p>{active ? '실행 기록에서 티켓처별 진행 상태를 확인하세요.' : '조건을 설정하고 로그인을 완료하면 시작할 수 있습니다.'}</p><button onClick={() => setTab('logs')}>실행 기록 보기 <ArrowRight size={13} /></button></section></aside></div>}

      {tab === 'login' && <><div className="login-intro"><ShieldCheck size={19} /><div><strong>실제 화면에서 확인된 로그인만 인정합니다.</strong><p>로그인 창 접속과 계정 로그인 성공은 다릅니다. 로그아웃 표시 등 성공 근거가 없으면 확인됨으로 표시하지 않습니다.</p></div></div><div className="login-grid">{(selected.length ? selected : PROVIDERS).map(loginCard)}</div><p className="subtle-note">‘새로 확인’은 공식 페이지를 다시 불러옵니다. 계정 메뉴 안에 로그아웃이 있다면 갱신된 창에서 메뉴를 열고 자동 확인을 기다려주세요. 실행 전에도 로그인 상태를 재확인합니다.</p></>}

      {tab === 'profiles' && <><div className="notice neutral"><Monitor size={18} /><span>공연 URL을 받은 뒤 실제 예매 화면에서 연결을 검증합니다. 현재 5개 티켓처의 공연별 좌석 선택은 실사이트 검증 전입니다.</span></div><p className="subtle-note">기본 자동 탐색으로 날짜·회차를 찾지 못할 때 사용하는 고급 설정입니다. 로그인·보안문자·결제 동작은 설정 대상이 아닙니다.</p><div className="profile-list">{(selected.length ? selected : PROVIDERS).map(p => <section className="panel profile-card" key={p.id}><div className="panel-heading"><div className="section-label"><span className="provider-logo small" style={{ '--brand': p.color }}>{p.short}</span><h2>{p.name}</h2></div><span className="muted-tag">실제 공연에서 확인 필요</span></div><fieldset disabled={active}><label className="field">진행 순서<select value={config.profiles[p.id]?.order || 'date-first'} onChange={e => changeProfile(p.id, 'order', e.target.value)}><option value="date-first">날짜 → 회차 → 예매하기 → 구역 → 좌석</option><option value="entry-first">예매하기 → 날짜 → 회차 → 구역 → 좌석</option></select></label><div className="profile-fields">{profileFields.map(field => <label className="field" key={field.key}>{field.label}<input value={config.profiles[p.id]?.[field.key] || ''} onChange={e => changeProfile(p.id, field.key, e.target.value)} placeholder={field.hint} spellCheck={false} /></label>)}</div></fieldset></section>)}</div><div className="notice neutral"><CircleHelp size={17} /><span>화면 구조가 불명확하거나 캔버스 좌석도이면 자동 클릭을 멈춥니다. 화면에 없는 좌석이나 임의 좌표를 추측해 선택하지 않습니다.</span></div></>}

      {tab === 'logs' && <section className="panel logs-panel"><div className="panel-heading"><div className="section-label"><Activity size={19} /><h2>실행 현황</h2><span className="run-state" role="status">{runLabel}</span></div>{active && <button className="button stop-button" onClick={stop} disabled={busy.stop || status.run.status === 'stopping'}><Pause size={14} /> {status.run.status === 'stopping' ? '중지 처리 중' : '실행 중지'}</button>}</div><div className="job-list">{Object.entries(status.run.jobs).map(([id, job]) => <RunJob now={now} key={id + ':' + status.run.runId + ':' + job.phase} id={id} job={job} resumable={status.run.status === 'waiting' && connected && !busy[id]} onResume={phase => resume(id, phase)} onFocus={() => action(id, () => api('/providers/' + id + '/focus', {}))} />)}</div>{!status.logs.length && !Object.keys(status.run.jobs).length && !active ? <div className="empty"><Activity size={30} /><h3>아직 실행 기록이 없어요</h3><p>예매 조건을 설정하고 시작하면 실제 진행 내용이 여기에 표시됩니다.</p><button className="button secondary" onClick={() => setTab('prepare')}>예매 준비로 돌아가기 <ArrowRight size={14} /></button></div> : <div className="log-list" aria-live="polite">{[...status.logs].reverse().map(log => <div className="log-line" key={log.id}><time>{timeOf(log.at)}</time><span>{PROVIDERS.find(p => p.id === log.provider)?.name || '프로그램'}</span><p>{log.message || (log.type === 'complete' ? log.status === 'waiting' ? '직접 확인 후 이어갈 단계를 선택해주세요.' : '실행이 끝났습니다. 티켓처 화면의 상태를 확인해주세요.' : log.status)}</p></div>)}</div>}</section>}
      <footer className="app-footer"><span><Monitor size={12} /> 이 PC에서 실행되는 개인용 티켓팅 도우미</span><span>로그인 · 보안 확인 · 결제는 공식 티켓처에서</span></footer>
      </main>
    </div>
  </div>;
}

function RunJob({ id, job, resumable, onResume, onFocus, now }) {
  const provider = PROVIDERS.find(p => p.id === id);
  const [phase, setPhase] = useState(job.phase || 'zone');
  const security = job.blockedBy === 'security';
  return <div className="job">
    <span className="provider-logo small" style={{ '--brand': provider.color }}>{provider.short}</span>
    <div className="job-content">
      <strong>{provider.name}</strong><p>{job.message}</p>{job.status === 'waiting_open' && job.targetAt > now.getTime() && <small>오픈까지 {Math.ceil((job.targetAt - now.getTime()) / 1000)}초 · PC 시계 기준</small>}
      {job.seats && <small>{job.seats.join(' · ')}</small>}
      {security && <div className="verification-notice" role="status"><ShieldCheck size={17} /><span>보안인증은 공식 예매창에서 직접 완료해주세요. 입력한 문자나 인증번호를 이 프로그램에 전달할 필요는 없습니다.</span></div>}
      {job.canResume && <div className="resume-controls">
        <p>{security ? '공식 창에서 입력완료를 누른 뒤 아래 버튼을 누르세요. 인증창이 남아 있으면 다시 대기하며, 새로고침 없이 같은 예매창을 사용합니다.' : '브라우저에서 직접 완료한 단계가 있으면 그 다음 단계를 선택하세요.'}</p>
        <label className="field">{provider.name} 이어갈 단계
          <select value={phase} disabled={!resumable} onChange={event => setPhase(event.target.value)}>
            {job.resumeSteps.map(step => <option key={step} value={step}>{PHASE_LABELS[step]}{step === job.phase ? ' (멈춘 단계부터)' : ''}</option>)}
          </select>
        </label>
        <button className="button secondary" disabled={!resumable} onClick={() => onResume(phase)}><Play size={14} /> {security ? '인증 완료 후 이어가기' : '이 단계부터 이어가기'}</button>
      </div>}
    </div>
    <button className="button ghost" onClick={onFocus}>{security ? '인증 화면 보기' : '화면 보기'} <ExternalLink size={13} /></button>
  </div>;
}
