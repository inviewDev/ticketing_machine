import { getProvider, allowedUrl } from './providers.mjs';
import { matchingPreference, validateSeatPreferences, seatKey } from './seat-map.mjs';
import { getVenue } from './venues.mjs';

export const defaultPreferences = () => ({ selected: [], title: '', date: '', time: '', sessionMode: 'official', quantity: 1, adjacent: true, zones: '', rows: '', urls: {}, venues: {}, scheduledAt: '', profiles: {}, seatPreferences: {} });
export const ACTIVE_RUN_STATES = ['validating', 'running', 'scheduled', 'waiting', 'stopping'];
export const PHASE_LABELS = { date: '관람 날짜 선택', time: '회차 선택', entry: '예매하기', zone: '구역·좌석 선택' };
const record = value => value && typeof value === 'object' && !Array.isArray(value);

export function validatePreferences(input, forRun = false, { preview = false } = {}) {
  if (!record(input)) throw new Error('올바른 설정을 입력해주세요.');
  const selected = Array.isArray(input.selected) ? [...new Set(input.selected)] : [];
  selected.forEach(getProvider);
  const quantity = Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 4) throw new Error('좌석 수는 1~4석으로 설정해주세요.');
  const result = { ...defaultPreferences(), selected, quantity, adjacent: input.adjacent !== false };
  result.sessionMode = input.sessionMode === 'opening' ? 'opening' : 'official';
  for (const key of ['title', 'date', 'time', 'zones', 'rows', 'scheduledAt']) {
    result[key] = typeof input[key] === 'string' ? input[key].trim().slice(0, 300) : '';
  }
  const urlIds = new Set([...selected, ...Object.keys(record(input.urls) ? input.urls : {})]);
  for (const id of urlIds) {
    getProvider(id);
    const url = typeof input.urls?.[id] === 'string' ? input.urls[id].trim() : '';
    if (url && !allowedUrl(url, getProvider(id))) throw new Error(getProvider(id).name + '의 공식 공연 주소를 입력해주세요.');
    if (forRun && selected.includes(id) && !url) throw new Error(getProvider(id).name + '의 공연 상세 URL이 필요합니다.');
    result.urls[id] = url;
  }
  if (record(input.venues)) for (const [id, venueId] of Object.entries(input.venues)) {
    getProvider(id);
    if (venueId) getVenue(venueId);
    result.venues[id] = venueId || '';
  }
  if (result.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(result.date) || !Number.isFinite(Date.parse(result.date)) || new Date(result.date).toISOString().slice(0, 10) !== result.date) throw new Error('유효한 관람 날짜를 입력해주세요.');
  }
  if (result.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(result.time)) throw new Error('회차 시간을 시:분으로 입력해주세요.');
  if (result.scheduledAt) {
    const value = result.scheduledAt.length === 16 ? result.scheduledAt + ':00' : result.scheduledAt;
    const instant = Date.parse(value + '+09:00');
    if (!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value) || !Number.isFinite(instant) || new Date(instant + 9 * 3600000).toISOString().slice(0, 19) !== value) throw new Error('예약 실행 시간을 확인해주세요.');
  }
  result.seatPreferences = validateSeatPreferences(input.seatPreferences);
  if (forRun && (!selected.length || !result.date || !result.time)) throw new Error('티켓처, 관람 날짜, 회차를 설정해주세요.');
  if (forRun && result.sessionMode === 'opening') {
    if (selected.length !== 1 || selected[0] !== 'melon') throw new Error('오픈 전 회차 직접 입력은 멜론티켓 단일 선택에서 사용할 수 있습니다.');
    if (!result.scheduledAt) throw new Error('오픈 전 준비에는 티켓 오픈 시각을 예약 실행에 입력해주세요.');
    if (input.profiles?.melon?.order === 'entry-first') throw new Error('멜론 오픈 전 준비는 날짜 → 회차 → 예매하기 순서로 설정해주세요.');
  }
  if (forRun && !preview) for (const id of selected) {
    const preference = matchingPreference(result, id);
    if (result.seatPreferences[id] && !preference) throw new Error(getProvider(id).name + ': 공연이나 회차가 바뀌었습니다. 해당 공연의 좌석도에서 선호 좌석을 다시 선택해주세요.');
    if (preference && preference.seats.length < quantity) throw new Error(getProvider(id).name + ': 예매 매수 이상의 선호 좌석을 선택해주세요.');
    if (!preference && !splitPreferences(result.zones).length) throw new Error(getProvider(id).name + ': 좌석도에서 선호 좌석을 선택하거나 선호 구역을 입력해주세요.');
  }
  if (forRun && new Date(result.date + 'T' + result.time + ':00+09:00') <= new Date()) throw new Error('이미 지난 관람 회차입니다.');
  if (forRun && result.scheduledAt && Date.parse(result.scheduledAt + '+09:00') <= Date.now()) throw new Error('예약 실행 시간은 현재보다 나중으로 설정해주세요.');
  if (record(input.profiles)) for (const [id, profile] of Object.entries(input.profiles)) {
    getProvider(id);
    result.profiles[id] = validateProfile(profile);
  }
  return result;
}

export function validateProfile(profile) {
  if (!record(profile)) throw new Error('화면 설정을 확인해주세요.');
  const result = {};
  for (const key of ['entry', 'date', 'time', 'zone', 'seat', 'selected', 'next']) {
    const selector = typeof profile[key] === 'string' ? profile[key].trim() : '';
    if (selector.length > 500) throw new Error('화면 선택자가 너무 깁니다.');
    result[key] = selector;
  }
  result.order = profile.order === 'entry-first' ? 'entry-first' : 'date-first';
  return result;
}

export function classifyLogin(signals) {
  if (signals.accessRestricted) return { status: 'restricted', detail: '티켓처가 전용 브라우저의 접속을 제한했습니다. 일반 브라우저에서 직접 접속해주세요.' };
  if (signals.blocked) return { status: 'challenge', detail: '보안 확인 또는 대기 화면입니다. 브라우저에서 직접 진행해주세요.' };
  if (signals.sessionAuthenticated === false || signals.passwordVisible || signals.loginVisible) return { status: 'required', detail: '로그인이 필요한 화면입니다. 열린 브라우저에서 직접 로그인해주세요.' };
  if (signals.sessionAuthenticated === true && signals.trusted) return { status: 'verified', detail: '공식 NOL 마이페이지의 로그인 세션 응답을 확인했습니다.' };
  if (signals.logoutVisible && signals.trusted) return { status: 'verified', detail: '공식 티켓처 화면에서 로그아웃 메뉴를 확인했습니다.' };
  return { status: 'unknown', detail: '로그인 성공을 판별할 수 없습니다. 티켓처의 계정 메뉴를 열고 다시 확인해주세요.' };
}

export const splitPreferences = text => [...new Set(String(text ?? '').split(/[\n,]/).map(s => s.trim()).filter(Boolean))];
export const normalize = text => String(text).normalize('NFKC').replace(/\s+/g, ' ').trim();
const normalizeRow = row => normalize(row).replace(/\s*열$/, '').trim();

export function chooseSeats(seats, { quantity, adjacent, zones, rows, preferredSeats }) {
  if (preferredSeats?.length) {
    const normalizedZone = seat => normalize(seat.zone);
    const compatibleZone = (seat, wanted) => {
      const actual = normalizedZone(seat);
      const preferred = normalizedZone(wanted);
      return actual === preferred || actual.startsWith(preferred + ' ') || preferred.startsWith(actual + ' ');
    };
    const preferredRank = seat => preferredSeats.findIndex(wanted => normalizeRow(seat.row) === normalizeRow(wanted.row) && seat.number === wanted.number && compatibleZone(seat, wanted));
    const available = seats.filter(seat => seat.available && !seat.selected).map(seat => ({ seat, rank: preferredRank(seat) })).filter(item => item.rank >= 0);
    if (quantity === 1 || !adjacent) {
      const chosen = available.sort((a, b) => a.rank - b.rank).slice(0, quantity).map(item => item.seat);
      return chosen.length === quantity ? chosen : [];
    }
    const groups = [];
    const ranks = new Map(available.map(item => [item.seat, item.rank]));
    const ordered = available.map(item => item.seat).sort((a, b) => a.zone.localeCompare(b.zone) || a.row.localeCompare(b.row) || a.number - b.number);
    for (let i = 0; i <= ordered.length - quantity; i++) {
      const group = ordered.slice(i, i + quantity);
      if (group.every((seat, offset) => seat.zone === group[0].zone && seat.row === group[0].row && seat.number === group[0].number + offset)) groups.push(group);
    }
    return groups.sort((a, b) => Math.min(...a.map(seat => ranks.get(seat))) - Math.min(...b.map(seat => ranks.get(seat))))[0] || [];
  }
  const wantedZones = splitPreferences(zones).map(normalize);
  const wantedRows = splitPreferences(rows).map(normalizeRow);
  const zoneRank = seat => wantedZones.indexOf(normalize(seat.zone));
  const rowRank = seat => wantedRows.indexOf(normalizeRow(seat.row));
  const candidates = seats.filter(s => s.available && !s.selected && zoneRank(s) >= 0 && (!wantedRows.length || rowRank(s) >= 0));
  candidates.sort((a, b) => zoneRank(a) - zoneRank(b) || rowRank(a) - rowRank(b) || normalizeRow(a.row).localeCompare(normalizeRow(b.row), 'ko', { numeric: true }) || a.number - b.number);
  if (quantity === 1 || !adjacent) return candidates.slice(0, quantity).length === quantity ? candidates.slice(0, quantity) : [];
  let group = [];
  for (const seat of candidates) {
    const previous = group.at(-1);
    if (!previous || normalize(previous.zone) !== normalize(seat.zone) || normalizeRow(previous.row) !== normalizeRow(seat.row) || seat.number !== previous.number + 1) group = [];
    group.push(seat);
    if (group.length === quantity) return group;
  }
  return [];
}

export function parseSeat(label, attributes = {}) {
  const text = normalize(label);
  const zone = attributes.zone || text.match(/((?:\d+층\s*)?[A-Za-z0-9가-힣]+(?:-[A-Za-z0-9가-힣]+)*\s*구역)/)?.[1] || text.match(/(\d+층)/)?.[1] || '';
  const row = normalizeRow(attributes.row || text.match(/([A-Za-z0-9]+|[가-힣])\s*열/)?.[1] || '');
  const number = Number(attributes.number || text.match(/(\d+)\s*번/)?.[1]);
  return { zone: normalize(zone), row, number, valid: Boolean(zone && row && Number.isInteger(number) && number > 0) };
}
