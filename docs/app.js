import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// ===================================================================
//  Helpers
// ===================================================================
const $app = document.getElementById('app');

/** Tạo DOM an toàn (không dùng innerHTML → không bị XSS từ tên khách). */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'selected', 'disabled'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  return el;
}

function toast(msg, type = 'info') {
  const t = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? 6000 : 3000);
}

function openModal(title, body, actions = []) {
  const dlg = h('dialog', { class: 'modal' },
    h('form', { method: 'dialog', class: 'modal-inner', onsubmit: (e) => e.preventDefault() },
      h('div', { class: 'modal-head' },
        h('h2', null, title),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Đóng', onclick: () => close() }, '✕')),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-actions' }, actions) : null));
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  dlg.showModal();
  return close;
}

function confirmBox(message, okLabel = 'Đồng ý', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); close(); } };
    const close = openModal('Xác nhận', h('p', null, message), [
      h('button', { type: 'button', class: 'btn', onclick: () => finish(false) }, 'Huỷ'),
      h('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => finish(true) }, okLabel),
    ]);
  });
}

const todayStr = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD theo giờ máy
const fmtDate = (d) => { const [y, m, dd] = d.split('-'); return `${dd}/${m}/${y}`; };
const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';
const fmtDateTime = (ts) => new Date(ts).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
const norm = (s) => (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const hhmm = (t) => (t || '').slice(0, 5);

const STATUS = {
  registered: { label: 'Đã đăng ký', cls: 'st-reg' },
  checked_in: { label: 'Đã check-in', cls: 'st-in' },
  no_show:    { label: 'Vắng', cls: 'st-no' },
  cancelled:  { label: 'Đã huỷ', cls: 'st-cx' },
};
const statusBadge = (s) => h('span', { class: `badge ${STATUS[s].cls}` }, STATUS[s].label);

function errMsg(error) {
  if (!error) return 'Lỗi không xác định';
  if (error.code === '42501' && !/[À-ỹ]/.test(error.message)) return 'Bạn không có quyền thực hiện thao tác này';
  return error.message || String(error);
}

// ===================================================================
//  State
// ===================================================================
const S = {
  me: null, rooms: [], slots: [], settings: null,
  date: todayStr(), rows: [],
  tab: 'overview',
  filters: { room: '', slot: '', status: '', q: '' },
  staffRoom: null, staffSlot: null, staffQ: '',
  staffList: [], assignments: [], logs: [], meetings: [],
};

if (SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_ANON_KEY.includes('YOUR-')) {
  $app.replaceChildren(h('div', { class: 'center card narrow' },
    h('h1', null, 'Chưa cấu hình'),
    h('p', null, 'Mở file ', h('code', null, 'config.js'), ' và điền SUPABASE_URL cùng anon/publishable key của dự án.')));
  throw new Error('Missing config');
}

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const isAdmin = () => S.me?.role === 'admin';
const roomName = (id) => S.rooms.find((r) => r.id === id)?.name ?? `Phòng ${id}`;
const slotById = (id) => S.slots.find((s) => s.id === id);
const slotLabel = (id) => slotById(id)?.label ?? `#${id}`;
const capacity = () => S.settings?.capacity ?? 10;
/** Sức chứa của 1 phòng: riêng từng phòng, nếu không có thì dùng mức chung. */
const capOf = (roomId) => S.rooms.find((r) => r.id === roomId)?.capacity ?? capacity();
const meetingOf = (roomId, slotId) => S.meetings.find((m) => m.room_id === roomId && m.slot_id === slotId);
const meetingText = (m) => m ? (m.host ? `${m.title} · ${m.host}` : m.title) : '';
const activeCount = (rows) => rows.filter((r) => r.status !== 'cancelled').length;

// ===================================================================
//  Boot & auth
// ===================================================================
let booted = false;
let channel = null;

sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') { booted = false; teardown(); renderLogin(); }
  else if (session && !booted && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) { boot(); }
  else if (!session && event === 'INITIAL_SESSION') { renderLogin(); }
});

function teardown() {
  if (channel) { sb.removeChannel(channel); channel = null; }
  Object.assign(S, { me: null, rows: [], staffList: [], assignments: [], logs: [], meetings: [] });
}

async function boot() {
  booted = true;
  $app.replaceChildren(h('div', { class: 'center muted' }, 'Đang tải dữ liệu…'));
  const { data: me, error } = await sb.rpc('get_me');
  if (error) { booted = false; return renderFatal(errMsg(error)); }
  if (!me) return renderNoAccess();
  S.me = me;

  const [rooms, slots, settings] = await Promise.all([
    sb.from('rooms').select('*').order('sort_order'),
    sb.from('time_slots').select('*').order('start_time'),
    sb.from('settings').select('*').single(),
  ]);
  const err = rooms.error || slots.error || settings.error;
  if (err) { booted = false; return renderFatal(errMsg(err)); }
  S.rooms = rooms.data; S.slots = slots.data; S.settings = settings.data;
  S.date = pickDefaultDate();

  channel = sb.channel('attendees-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'attendees' }, () => scheduleRefresh())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'meetings' }, () => scheduleRefresh())
    .subscribe();

  await refresh();
}

function pickDefaultDate() {
  const dates = [...(S.settings.event_dates || [])].sort();
  if (!dates.length) return todayStr();
  const t = todayStr();
  return dates.includes(t) ? t : (dates.find((d) => d >= t) ?? dates[dates.length - 1]);
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 400);
}

async function refresh() {
  const [att, mt] = await Promise.all([
    sb.from('attendees').select('*').eq('event_date', S.date).order('slot_id').order('created_at').limit(5000),
    sb.from('meetings').select('*').eq('event_date', S.date),
  ]);
  if (att.error) { toast(errMsg(att.error), 'error'); return; }
  S.rows = att.data;
  S.meetings = mt.error ? [] : mt.data;
  if (isAdmin() && S.tab === 'staff') await loadStaff();
  if (isAdmin() && S.tab === 'log') await loadLogs();
  render();
}

function render() {
  // Giữ focus + vị trí con trỏ khi vẽ lại (vd. đang gõ ô tìm kiếm thì có cập nhật realtime)
  const active = document.activeElement;
  const keep = active?.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  const scroll = window.scrollY;
  $app.replaceChildren(isAdmin() ? AdminView() : StaffView());
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) { el.focus(); try { el.setSelectionRange(keep.start, keep.end); } catch { /* select/date */ } }
  }
  window.scrollTo(0, scroll);
}

// ===================================================================
//  Login
// ===================================================================
function renderLogin() {
  let email = '';
  const msg = h('p', { class: 'muted small' });
  const codeBox = h('div', { class: 'stack', hidden: true },
    h('label', { for: 'otp' }, 'Hoặc nhập mã 6 số trong email'),
    h('input', { id: 'otp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 10, placeholder: '123456' }),
    h('button', { type: 'button', class: 'btn primary', onclick: verifyCode }, 'Xác nhận mã'));

  async function send(e) {
    e.preventDefault();
    email = e.target.email.value.trim().toLowerCase();
    if (!email) return;
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    const { error } = await sb.auth.signInWithOtp({
      email, options: { emailRedirectTo: location.origin + location.pathname },
    });
    btn.disabled = false;
    if (error) return toast(errMsg(error), 'error');
    msg.textContent = `Đã gửi link đăng nhập tới ${email}. Mở email trên thiết bị này để đăng nhập.`;
    codeBox.hidden = false;
  }

  async function verifyCode() {
    const token = document.getElementById('otp').value.trim();
    if (!token) return;
    const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
    if (error) toast(errMsg(error), 'error');
  }

  $app.replaceChildren(h('div', { class: 'center' },
    h('div', { class: 'card narrow stack' },
      h('h1', null, 'Đăng nhập'),
      h('p', { class: 'muted' }, 'Dùng email đã được admin cấp quyền.'),
      h('form', { class: 'stack', onsubmit: send },
        h('label', { for: 'email' }, 'Email'),
        h('input', { id: 'email', name: 'email', type: 'email', required: true, autocomplete: 'email', placeholder: 'ten@congty.com' }),
        h('button', { class: 'btn primary', type: 'submit' }, 'Gửi link đăng nhập')),
      msg, codeBox)));
}

function renderNoAccess() {
  $app.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card narrow stack' },
    h('h1', null, 'Chưa được cấp quyền'),
    h('p', null, 'Tài khoản này chưa có trong danh sách nhân sự. Hãy liên hệ admin để được phân công phòng.'),
    h('button', { class: 'btn', onclick: () => sb.auth.signOut() }, 'Đăng xuất'))));
}

function renderFatal(message) {
  $app.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card narrow stack' },
    h('h1', null, 'Có lỗi xảy ra'), h('p', null, message),
    h('button', { class: 'btn', onclick: () => location.reload() }, 'Tải lại'),
    h('button', { class: 'btn', onclick: () => sb.auth.signOut() }, 'Đăng xuất'))));
}

// ===================================================================
//  Shared UI pieces
// ===================================================================
function TopBar(extra) {
  return h('header', { class: 'topbar' },
    h('div', { class: 'brand' },
      h('strong', null, S.settings.event_name),
      h('span', { class: 'muted small' }, isAdmin() ? 'Admin' : 'Trực phòng')),
    extra,
    h('div', { class: 'who' },
      h('span', { class: 'muted small ellipsis' }, S.me.full_name || S.me.email),
      h('button', { class: 'btn ghost small', onclick: () => sb.auth.signOut() }, 'Đăng xuất')));
}

function DatePicker() {
  const dates = [...(S.settings.event_dates || [])].sort();
  const onchange = async (e) => { S.date = e.target.value; S.staffSlot = null; await refresh(); };
  if (dates.length) {
    if (!dates.includes(S.date)) dates.push(S.date);
    return h('select', { id: 'date-pick', 'aria-label': 'Ngày', onchange, value: S.date },
      dates.sort().map((d) => h('option', { value: d }, `Ngày ${fmtDate(d)}`)));
  }
  return h('input', { id: 'date-pick', type: 'date', 'aria-label': 'Ngày', value: S.date, onchange });
}

async function updateAttendee(id, patch) {
  const { data, error } = await sb.from('attendees').update(patch).eq('id', id).select('id');
  if (error) { toast(errMsg(error), 'error'); return false; }
  if (!data?.length) { toast('Không có quyền sửa khách này', 'error'); return false; }
  await refresh();
  return true;
}

function AttendeeRow(r, { showPlace = false } = {}) {
  const checked = r.status === 'checked_in';
  const sub = [r.company, r.phone, r.email].filter(Boolean).join(' · ');
  return h('li', { class: `att ${r.status}` },
    h('div', { class: 'att-main' },
      h('div', { class: 'att-name' },
        r.full_name,
        r.is_walk_in ? h('span', { class: 'chip' }, 'Walk-in') : null),
      sub ? h('div', { class: 'muted small' }, sub) : null,
      r.note ? h('div', { class: 'small note' }, r.note) : null,
      h('div', { class: 'att-meta' },
        showPlace ? h('span', { class: 'chip' }, `${roomName(r.room_id)} · ${hhmm(slotById(r.slot_id)?.start_time)}`) : null,
        statusBadge(r.status),
        checked ? h('span', { class: 'muted small' }, `lúc ${fmtTime(r.checked_in_at)}`) : null)),
    h('div', { class: 'att-actions' },
      r.status === 'cancelled'
        ? h('button', { class: 'btn small', onclick: () => updateAttendee(r.id, { status: 'registered' }) }, 'Khôi phục')
        : h('button', {
            class: `btn small ${checked ? '' : 'primary'}`,
            onclick: () => updateAttendee(r.id, { status: checked ? 'registered' : 'checked_in' }),
          }, checked ? 'Bỏ check-in' : 'Check-in'),
      h('button', { class: 'btn small ghost', 'aria-label': `Sửa ${r.full_name}`, onclick: () => editAttendee(r) }, 'Sửa')));
}

function editAttendee(r) {
  const isNew = !r.id;
  const admin = isAdmin();
  const f = (name, label, attrs = {}) => h('label', { class: 'field' }, label,
    h('input', { name, value: r[name] ?? '', ...attrs }));

  const allowedRooms = admin ? S.rooms : S.rooms.filter((x) => staffRoomIds().includes(x.id));
  const form = h('div', { class: 'grid-form' },
    f('full_name', 'Họ tên *', { required: true, autocomplete: 'off' }),
    f('phone', 'Số điện thoại', { type: 'tel', autocomplete: 'off' }),
    f('email', 'Email', { type: 'email', autocomplete: 'off' }),
    f('company', 'Công ty', { autocomplete: 'off' }),
    h('label', { class: 'field wide' }, 'Ghi chú', h('textarea', { name: 'note', rows: 2, value: r.note ?? '' })),
    h('label', { class: 'field' }, 'Trạng thái',
      h('select', { name: 'status', value: r.status ?? 'registered' },
        Object.entries(STATUS).map(([k, v]) => h('option', { value: k }, v.label)))),
    h('label', { class: 'field checkbox' },
      h('input', { type: 'checkbox', name: 'is_walk_in', checked: !!r.is_walk_in }), 'Khách walk-in'),
    // Chỉ admin được đổi phòng/khung giờ/ngày của khách đã có. Người trực chỉ chọn khi thêm mới.
    (admin || isNew) ? [
      h('label', { class: 'field' }, 'Phòng',
        h('select', { name: 'room_id', value: String(r.room_id ?? allowedRooms[0]?.id) },
          allowedRooms.map((x) => h('option', { value: x.id }, x.name)))),
      h('label', { class: 'field' }, 'Khung giờ',
        h('select', { name: 'slot_id', value: String(r.slot_id ?? S.slots[0]?.id) },
          S.slots.map((s) => h('option', { value: s.id }, s.label)))),
      admin ? h('label', { class: 'field' }, 'Ngày',
        h('input', { type: 'date', name: 'event_date', value: r.event_date ?? S.date })) : null,
    ] : null);

  const save = async () => {
    const val = (n) => form.querySelector(`[name=${n}]`);
    const name = val('full_name').value.trim();
    if (!name) { val('full_name').focus(); return toast('Nhập họ tên khách', 'error'); }
    const payload = {
      full_name: name,
      phone: val('phone').value.trim() || null,
      email: val('email').value.trim() || null,
      company: val('company').value.trim() || null,
      note: val('note').value.trim() || null,
      status: val('status').value,
      is_walk_in: val('is_walk_in').checked,
    };
    if (val('room_id')) {
      payload.room_id = Number(val('room_id').value);
      payload.slot_id = Number(val('slot_id').value);
      payload.event_date = val('event_date')?.value || r.event_date || S.date;
    }
    if (isNew) {
      const { error } = await sb.from('attendees').insert(payload);
      if (error) return toast(errMsg(error), 'error');
      toast(`Đã thêm ${name}`, 'success');
      close(); await refresh();
    } else if (await updateAttendee(r.id, payload)) {
      toast('Đã lưu', 'success'); close();
    }
  };

  const actions = [
    !isNew && admin ? h('button', { type: 'button', class: 'btn danger left', onclick: async () => {
      if (!(await confirmBox(`Xoá hẳn "${r.full_name}" khỏi hệ thống? (Nhật ký vẫn lưu lại)`, 'Xoá', true))) return;
      const { error } = await sb.from('attendees').delete().eq('id', r.id);
      if (error) return toast(errMsg(error), 'error');
      toast('Đã xoá', 'success'); close(); await refresh();
    } }, 'Xoá hẳn') : null,
    h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Đóng'),
    h('button', { type: 'submit', class: 'btn primary', onclick: save }, isNew ? 'Thêm khách' : 'Lưu'),
  ].filter(Boolean);
  const close = openModal(isNew ? 'Thêm khách' : 'Sửa thông tin khách', form, actions);
  form.querySelector('[name=full_name]').focus();
}

// ===================================================================
//  STAFF VIEW (người trực phòng)
// ===================================================================
function staffRoomIds() {
  return [...new Set((S.me.assignments || [])
    .filter((a) => !a.event_date || a.event_date === S.date)
    .map((a) => a.room_id))].sort((a, b) => a - b);
}

function currentSlotId() {
  if (S.date !== todayStr()) return S.slots[0]?.id;
  const now = new Date().toTimeString().slice(0, 5);
  const cur = S.slots.find((s) => hhmm(s.start_time) <= now && now < hhmm(s.end_time))
    ?? S.slots.find((s) => hhmm(s.start_time) > now)
    ?? S.slots[S.slots.length - 1];
  return cur?.id;
}

function StaffView() {
  const roomIds = staffRoomIds();
  if (!roomIds.includes(S.staffRoom)) S.staffRoom = roomIds[0] ?? null;
  if (!S.slots.some((s) => s.id === S.staffSlot)) S.staffSlot = currentSlotId();

  const header = TopBar(h('div', { class: 'toolbar' },
    DatePicker(),
    roomIds.length > 1
      ? h('select', { id: 'room-pick', 'aria-label': 'Phòng', value: String(S.staffRoom),
          onchange: (e) => { S.staffRoom = Number(e.target.value); render(); } },
          roomIds.map((id) => h('option', { value: id }, roomName(id))))
      : null));

  if (!roomIds.length) {
    return h('div', null, header, h('main', { class: 'wrap' }, h('div', { class: 'card empty' },
      `Bạn không được phân công phòng nào vào ngày ${fmtDate(S.date)}.`)));
  }

  const roomRows = S.rows.filter((r) => r.room_id === S.staffRoom);
  const cap = capOf(S.staffRoom);
  const tabs = h('nav', { class: 'slot-tabs', 'aria-label': 'Khung giờ' }, S.slots.map((s) => {
    const rs = roomRows.filter((r) => r.slot_id === s.id);
    const n = activeCount(rs);
    const inN = rs.filter((r) => r.status === 'checked_in').length;
    return h('button', {
      class: `slot-tab ${s.id === S.staffSlot ? 'active' : ''} ${n >= cap ? 'full' : ''}`,
      'aria-pressed': String(s.id === S.staffSlot),
      onclick: () => { S.staffSlot = s.id; render(); },
    }, h('span', { class: 'slot-time' }, hhmm(s.start_time)),
      meetingOf(S.staffRoom, s.id) ? h('span', { class: 'slot-title' }, meetingOf(S.staffRoom, s.id).title) : null,
      h('span', { class: 'slot-count' }, `${inN}/${n}`));
  }));

  const slotRows = roomRows.filter((r) => r.slot_id === S.staffSlot);
  const n = activeCount(slotRows);
  const inN = slotRows.filter((r) => r.status === 'checked_in').length;
  const q = norm(S.staffQ);
  const shown = slotRows
    .filter((r) => !q || norm(`${r.full_name} ${r.phone} ${r.company} ${r.email}`).includes(q))
    .sort(sortForCheckin);

  const list = h('ul', { class: 'att-list' }, shown.map((r) => AttendeeRow(r)));
  return h('div', null, header, h('main', { class: 'wrap stack' },
    h('div', { class: 'room-head' },
      h('h1', null, roomName(S.staffRoom)),
      h('span', { class: 'muted' }, slotLabel(S.staffSlot)),
      meetingOf(S.staffRoom, S.staffSlot) ? h('span', { class: 'meeting-tag' }, meetingText(meetingOf(S.staffRoom, S.staffSlot))) : null),
    tabs,
    h('div', { class: 'stats' },
      Stat('Đã check-in', `${inN}/${n}`),
      Stat('Sức chứa', `${n}/${cap}`, n > cap ? 'over' : n >= cap ? 'full' : ''),
      Stat('Chưa đến', slotRows.filter((r) => r.status === 'registered').length)),
    h('div', { class: 'toolbar' },
      h('input', { id: 'staff-q', type: 'search', placeholder: 'Tìm tên, SĐT, công ty…', value: S.staffQ,
        oninput: (e) => { S.staffQ = e.target.value; render(); } }),
      h('button', { class: 'btn primary', disabled: n >= cap,
        title: n >= cap ? 'Đã đủ chỗ — liên hệ admin' : null,
        onclick: () => editAttendee({ room_id: S.staffRoom, slot_id: S.staffSlot, event_date: S.date, is_walk_in: true }) },
        '+ Thêm khách')),
    shown.length ? list : h('div', { class: 'card empty' }, slotRows.length ? 'Không tìm thấy khách phù hợp.' : 'Chưa có khách trong khung giờ này.')));
}

const ORDER = { registered: 0, checked_in: 1, no_show: 2, cancelled: 3 };
const sortForCheckin = (a, b) => ORDER[a.status] - ORDER[b.status] || a.full_name.localeCompare(b.full_name, 'vi');

function Stat(label, value, cls = '') {
  return h('div', { class: `stat ${cls}` }, h('div', { class: 'stat-val' }, String(value)), h('div', { class: 'muted small' }, label));
}

// ===================================================================
//  ADMIN VIEW
// ===================================================================
const TABS = [
  ['overview', 'Tổng quan'], ['list', 'Danh sách khách'], ['staff', 'Nhân sự'], ['log', 'Nhật ký'], ['settings', 'Cài đặt'],
];

function AdminView() {
  const nav = h('nav', { class: 'tabs', role: 'tablist' }, TABS.map(([k, label]) =>
    h('button', { role: 'tab', 'aria-selected': String(S.tab === k), class: S.tab === k ? 'active' : '',
      onclick: async () => {
        S.tab = k;
        if (k === 'staff') await loadStaff();
        if (k === 'log') await loadLogs();
        render();
      } }, label)));
  const body = { overview: Overview, list: AdminList, staff: StaffAdmin, log: LogView, settings: SettingsView }[S.tab]();
  return h('div', null, TopBar(h('div', { class: 'toolbar' }, DatePicker())), nav, h('main', { class: 'wrap stack' }, body));
}

function Overview() {
  const live = S.rows.filter((r) => r.status !== 'cancelled');
  const totalIn = S.rows.filter((r) => r.status === 'checked_in').length;
  const walkIns = live.filter((r) => r.is_walk_in).length;

  const table = h('table', { class: 'grid' },
    h('thead', null, h('tr', null, h('th', null, 'Phòng'),
      S.slots.map((s) => h('th', null, hhmm(s.start_time))), h('th', null, 'Tổng'))),
    h('tbody', null, S.rooms.map((room) => {
      const rr = S.rows.filter((r) => r.room_id === room.id);
      const cap = capOf(room.id);
      return h('tr', null,
        h('th', { scope: 'row' }, room.name, room.capacity ? h('div', { class: 'muted small' }, `${room.capacity} chỗ`) : null),
        S.slots.map((s) => {
          const cell = rr.filter((r) => r.slot_id === s.id);
          const n = activeCount(cell);
          const inN = cell.filter((r) => r.status === 'checked_in').length;
          const m = meetingOf(room.id, s.id);
          const cls = n > cap ? 'over' : n === cap ? 'full' : (n === 0 && !m) ? 'zero' : '';
          return h('td', null, h('button', { class: `cell ${cls}`,
            title: `${room.name} · ${s.label}${m ? ' · ' + meetingText(m) : ''}: ${n} khách, ${inN} đã check-in`,
            onclick: () => { Object.assign(S.filters, { room: String(room.id), slot: String(s.id), status: '', q: '' }); S.tab = 'list'; render(); } },
            m ? h('span', { class: 'cell-title' }, m.title) : null,
            h('span', { class: 'cell-n' }, `${n}/${cap}`), h('span', { class: 'cell-in' }, `✓ ${inN}`)));
        }),
        h('td', { class: 'num' }, `${activeCount(rr)}`));
    })));

  return [
    h('div', { class: 'stats' },
      Stat('Khách đăng ký', live.length),
      Stat('Đã check-in', `${totalIn} (${live.length ? Math.round(totalIn * 100 / live.length) : 0}%)`),
      Stat('Walk-in', walkIns),
      Stat('Đã huỷ', S.rows.filter((r) => r.status === 'cancelled').length),
      Stat('Cuộc họp', S.meetings.length),
      Stat('Sức chứa ngày', `${live.length}/${S.rooms.reduce((t, r) => t + capOf(r.id), 0) * S.slots.length}`)),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, `Lịch ngày ${fmtDate(S.date)}`),
        h('span', { class: 'muted small' }, 'Bấm vào ô để xem/sửa danh sách')),
      h('div', { class: 'scroll-x' }, table)),
  ];
}

function filteredAdminRows() {
  const { room, slot, status, q } = S.filters;
  const nq = norm(q);
  return S.rows.filter((r) =>
    (!room || r.room_id === Number(room)) &&
    (!slot || r.slot_id === Number(slot)) &&
    (!status || r.status === status) &&
    (!nq || norm(`${r.full_name} ${r.phone} ${r.company} ${r.email} ${r.note}`).includes(nq)))
    .sort((a, b) => a.room_id - b.room_id || a.slot_id - b.slot_id || sortForCheckin(a, b));
}

function AdminList() {
  const F = S.filters;
  const sel = (id, key, label, opts) => h('select', { id, 'aria-label': label, value: F[key],
    onchange: (e) => { F[key] = e.target.value; render(); } },
    h('option', { value: '' }, label), opts);
  const rows = filteredAdminRows();
  const showPlace = !(F.room && F.slot);

  return [
    h('div', { class: 'toolbar wrap-row' },
      h('input', { id: 'admin-q', type: 'search', placeholder: 'Tìm tên, SĐT, công ty…', value: F.q,
        oninput: (e) => { F.q = e.target.value; render(); } }),
      sel('f-room', 'room', 'Tất cả phòng', S.rooms.map((r) => h('option', { value: r.id }, r.name))),
      sel('f-slot', 'slot', 'Tất cả khung giờ', S.slots.map((s) => h('option', { value: s.id }, s.label))),
      sel('f-status', 'status', 'Mọi trạng thái', Object.entries(STATUS).map(([k, v]) => h('option', { value: k }, v.label))),
      (F.room || F.slot || F.status || F.q) ? h('button', { class: 'btn ghost', onclick: () => {
        Object.assign(F, { room: '', slot: '', status: '', q: '' }); render(); } }, 'Xoá bộ lọc') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => importFile() }, 'Nhập Excel/CSV'),
      h('button', { class: 'btn', onclick: () => exportCsv(rows) }, 'Xuất CSV'),
      h('button', { class: 'btn primary', onclick: () => editAttendee({
        room_id: Number(F.room) || S.rooms[0]?.id, slot_id: Number(F.slot) || S.slots[0]?.id, event_date: S.date }) }, '+ Thêm khách')),
    F.room && F.slot ? h('div', { class: 'room-head' },
      h('h2', null, `${roomName(Number(F.room))} · ${slotLabel(Number(F.slot))}`),
      meetingOf(Number(F.room), Number(F.slot)) ? h('span', { class: 'meeting-tag' }, meetingText(meetingOf(Number(F.room), Number(F.slot)))) : null,
      h('span', { class: 'muted' }, `${activeCount(rows)}/${capOf(Number(F.room))} khách`),
      h('button', { class: 'btn small ghost', onclick: () => editMeeting(Number(F.room), Number(F.slot)) },
        meetingOf(Number(F.room), Number(F.slot)) ? 'Sửa cuộc họp' : '+ Đặt tên cuộc họp')) : null,
    h('p', { class: 'muted small' }, `${rows.length} kết quả`),
    rows.length ? h('ul', { class: 'att-list' }, rows.map((r) => AttendeeRow(r, { showPlace })))
      : h('div', { class: 'card empty' }, 'Không có khách phù hợp.'),
  ];
}

// ---------- Nhân sự ----------
async function loadStaff() {
  const [st, as] = await Promise.all([
    sb.from('staff').select('*').order('role').order('email'),
    sb.from('room_assignments').select('*').order('room_id'),
  ]);
  if (st.error || as.error) return toast(errMsg(st.error || as.error), 'error');
  S.staffList = st.data; S.assignments = as.data;
}

async function staffMutate(promise, okMsg) {
  const { error } = await promise;
  if (error) { toast(errMsg(error), 'error'); return false; }
  if (okMsg) toast(okMsg, 'success');
  await loadStaff();
  // nếu admin sửa chính mình thì nạp lại quyền
  const { data: me } = await sb.rpc('get_me');
  if (me) S.me = me; else return location.reload();
  render();
  return true;
}

function StaffAdmin() {
  const dates = [...(S.settings.event_dates || [])].sort();
  const addForm = h('form', { class: 'toolbar wrap-row', onsubmit: async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const email = fd.get('email').trim().toLowerCase();
    if (!email) return;
    const ok = await staffMutate(sb.from('staff').insert({ email, full_name: fd.get('full_name').trim() || null, role: fd.get('role') }),
      `Đã thêm ${email}`);
    if (ok && fd.get('room')) {
      await staffMutate(sb.from('room_assignments').insert({ email, room_id: Number(fd.get('room')), event_date: null }));
    }
  } },
    h('input', { name: 'email', type: 'email', required: true, placeholder: 'email@congty.com', 'aria-label': 'Email' }),
    h('input', { name: 'full_name', placeholder: 'Họ tên', 'aria-label': 'Họ tên' }),
    h('select', { name: 'role', 'aria-label': 'Vai trò' }, h('option', { value: 'staff' }, 'Trực phòng'), h('option', { value: 'admin' }, 'Admin')),
    h('select', { name: 'room', 'aria-label': 'Phòng' }, h('option', { value: '' }, '— Phân công sau —'),
      S.rooms.map((r) => h('option', { value: r.id }, `${r.name} (mọi ngày)`))),
    h('button', { class: 'btn primary', type: 'submit' }, '+ Thêm nhân sự'));

  // Phòng nào chưa có người trực trong ngày đang xem
  const covered = new Set(S.assignments.filter((a) => !a.event_date || a.event_date === S.date)
    .filter((a) => S.staffList.find((s) => s.email === a.email)?.active).map((a) => a.room_id));
  const uncovered = S.rooms.filter((r) => !covered.has(r.id));

  const rows = S.staffList.map((s) => {
    const mine = S.assignments.filter((a) => a.email === s.email);
    const roomSel = h('select', { 'aria-label': 'Phòng' }, S.rooms.map((r) => h('option', { value: r.id }, r.name)));
    const dateSel = h('select', { 'aria-label': 'Ngày' }, h('option', { value: '' }, 'Mọi ngày'),
      dates.map((d) => h('option', { value: d }, fmtDate(d))));
    return h('li', { class: `staff-row ${s.active ? '' : 'inactive'}` },
      h('div', { class: 'staff-main' },
        h('div', null, h('strong', null, s.full_name || s.email), ' ',
          h('span', { class: `badge ${s.role === 'admin' ? 'st-in' : 'st-reg'}` }, s.role === 'admin' ? 'Admin' : 'Trực phòng'),
          s.active ? null : h('span', { class: 'badge st-cx' }, 'Đã khoá')),
        h('div', { class: 'muted small' }, s.email),
        s.role === 'admin' ? h('div', { class: 'muted small' }, 'Xem được toàn bộ') :
        h('div', { class: 'chips' }, mine.length ? mine.map((a) => h('span', { class: 'chip' },
          `${roomName(a.room_id)} · ${a.event_date ? fmtDate(a.event_date) : 'mọi ngày'}`,
          h('button', { class: 'chip-x', 'aria-label': 'Bỏ phân công', onclick: () =>
            staffMutate(sb.from('room_assignments').delete().eq('id', a.id), 'Đã bỏ phân công') }, '×')))
          : h('span', { class: 'muted small' }, 'Chưa phân công phòng'))),
      h('div', { class: 'staff-actions' },
        s.role === 'admin' ? null : h('div', { class: 'toolbar' }, roomSel, dateSel,
          h('button', { class: 'btn small', onclick: () => staffMutate(
            sb.from('room_assignments').insert({ email: s.email, room_id: Number(roomSel.value), event_date: dateSel.value || null }),
            'Đã phân công') }, 'Phân công')),
        h('div', { class: 'toolbar' },
          s.email === S.me.email ? null : h('button', { class: 'btn small ghost', onclick: () =>
            staffMutate(sb.from('staff').update({ active: !s.active }).eq('email', s.email), s.active ? 'Đã khoá' : 'Đã mở khoá') },
            s.active ? 'Khoá' : 'Mở khoá'),
          s.email === S.me.email ? null : h('button', { class: 'btn small ghost danger-text', onclick: async () => {
            if (await confirmBox(`Xoá ${s.email} khỏi danh sách nhân sự?`, 'Xoá', true))
              staffMutate(sb.from('staff').delete().eq('email', s.email), 'Đã xoá');
          } }, 'Xoá'))));
  });

  return [
    h('div', { class: 'card stack' }, h('h2', null, 'Thêm nhân sự'),
      h('p', { class: 'muted small' }, 'Người trực đăng nhập bằng đúng email này. Họ chỉ thấy khách của phòng được phân công.'),
      addForm),
    uncovered.length ? h('div', { class: 'card warn' },
      `Ngày ${fmtDate(S.date)} chưa có người trực: ${uncovered.map((r) => r.name).join(', ')}`) : null,
    h('ul', { class: 'staff-list' }, rows),
  ];
}

// ---------- Nhật ký ----------
async function loadLogs() {
  const { data, error } = await sb.from('attendee_log').select('*').order('changed_at', { ascending: false }).limit(300);
  if (error) return toast(errMsg(error), 'error');
  S.logs = data;
}

const LOG_FIELDS = { full_name: 'Tên', phone: 'SĐT', email: 'Email', company: 'Công ty', note: 'Ghi chú',
  status: 'Trạng thái', room_id: 'Phòng', slot_id: 'Khung giờ', event_date: 'Ngày', is_walk_in: 'Walk-in' };
const logVal = (k, v) => v == null || v === '' ? '∅'
  : k === 'status' ? STATUS[v]?.label ?? v : k === 'room_id' ? roomName(v) : k === 'slot_id' ? slotLabel(v)
  : k === 'is_walk_in' ? (v ? 'có' : 'không') : String(v);

function LogView() {
  if (!S.logs.length) return h('div', { class: 'card empty' }, 'Chưa có thay đổi nào.');
  return h('ul', { class: 'log-list' }, S.logs.map((l) => {
    const d = l.new_data || l.old_data || {};
    let detail;
    if (l.action === 'update') {
      const ch = Object.keys(LOG_FIELDS).filter((k) => JSON.stringify(l.old_data?.[k]) !== JSON.stringify(l.new_data?.[k]));
      detail = ch.map((k) => `${LOG_FIELDS[k]}: ${logVal(k, l.old_data[k])} → ${logVal(k, l.new_data[k])}`).join('; ');
    } else {
      detail = `${roomName(d.room_id)} · ${hhmm(slotById(d.slot_id)?.start_time)} · ${d.event_date ? fmtDate(d.event_date) : ''}`;
    }
    const verb = { insert: 'Thêm', update: 'Sửa', delete: 'Xoá' }[l.action];
    return h('li', null,
      h('span', { class: 'muted small log-time' }, fmtDateTime(l.changed_at)),
      h('span', { class: `badge log-${l.action}` }, verb),
      h('strong', null, d.full_name ?? '—'),
      h('span', { class: 'small' }, detail),
      h('span', { class: 'muted small' }, l.changed_by ?? 'hệ thống'));
  }));
}

// ---------- Cài đặt ----------
function SettingsView() {
  const st = S.settings;
  const general = h('form', { class: 'grid-form', onsubmit: async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { error } = await sb.from('settings').update({
      event_name: fd.get('event_name').trim() || 'Sự kiện', capacity: Number(fd.get('capacity')),
    }).eq('id', true);
    if (error) return toast(errMsg(error), 'error');
    await reloadConfig('Đã lưu cài đặt');
  } },
    h('label', { class: 'field' }, 'Tên sự kiện', h('input', { name: 'event_name', value: st.event_name })),
    h('label', { class: 'field' }, 'Số khách tối đa / khung giờ', h('input', { name: 'capacity', type: 'number', min: 1, max: 500, value: st.capacity })),
    h('div', { class: 'field wide' }, h('button', { class: 'btn primary', type: 'submit' }, 'Lưu')));

  const saveDates = async (arr) => {
    const { error } = await sb.from('settings').update({ event_dates: [...new Set(arr)].sort() }).eq('id', true);
    if (error) return toast(errMsg(error), 'error');
    await reloadConfig('Đã cập nhật ngày');
  };
  const newDate = h('input', { type: 'date', 'aria-label': 'Ngày mới' });
  const dates = h('div', { class: 'stack' },
    h('div', { class: 'chips' }, (st.event_dates || []).length
      ? [...st.event_dates].sort().map((d) => h('span', { class: 'chip' }, fmtDate(d),
          h('button', { class: 'chip-x', 'aria-label': `Bỏ ngày ${fmtDate(d)}`, onclick: () => saveDates(st.event_dates.filter((x) => x !== d)) }, '×')))
      : h('span', { class: 'muted small' }, 'Chưa khai báo — sẽ cho chọn ngày tự do')),
    h('div', { class: 'toolbar' }, newDate,
      h('button', { class: 'btn', onclick: () => newDate.value && saveDates([...(st.event_dates || []), newDate.value]) }, '+ Thêm ngày')));

  const rooms = h('form', { class: 'grid-form', onsubmit: async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const upd = S.rooms.map((r) => ({ id: r.id, name: fd.get(`room-${r.id}`).trim() || r.name, sort_order: r.sort_order,
      capacity: Number(fd.get(`cap-${r.id}`)) || null }));
    const { error } = await sb.from('rooms').upsert(upd);
    if (error) return toast(errMsg(error), 'error');
    await reloadConfig('Đã lưu phòng');
  } },
    S.rooms.map((r) => h('div', { class: 'field room-edit' }, `Phòng #${r.id}`,
      h('div', { class: 'toolbar' },
        h('input', { name: `room-${r.id}`, value: r.name, 'aria-label': 'Tên phòng' }),
        h('input', { name: `cap-${r.id}`, type: 'number', min: 1, max: 1000, value: r.capacity ?? '', placeholder: String(capacity()),
          'aria-label': 'Sức chứa', class: 'cap-input', title: 'Sức chứa (trống = dùng mức chung)' }),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Xoá ${r.name}`, title: 'Xoá phòng', onclick: async () => {
          if (!(await confirmBox(`Xoá ${r.name}? Chỉ xoá được khi phòng chưa có khách.`, 'Xoá', true))) return;
          const { error } = await sb.from('rooms').delete().eq('id', r.id);
          if (error) return toast(/foreign key|violates/i.test(error.message) ? 'Phòng đang có khách, không xoá được.' : errMsg(error), 'error');
          await reloadConfig(`Đã xoá ${r.name}`);
        } }, '✕')))),
    h('div', { class: 'field wide' }, h('button', { class: 'btn primary', type: 'submit' }, 'Lưu phòng')));

  const slots = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const upd = S.slots.map((s) => {
      const start = fd.get(`s-${s.id}-start`), end = fd.get(`s-${s.id}-end`);
      return { id: s.id, start_time: start, end_time: end, label: `${start} – ${end}` };
    });
    const { error } = await sb.from('time_slots').upsert(upd);
    if (error) return toast(errMsg(error), 'error');
    await reloadConfig('Đã lưu khung giờ');
  } },
    S.slots.map((s) => h('div', { class: 'toolbar' }, h('span', { class: 'slot-idx' }, `#${s.id}`),
      h('input', { type: 'time', name: `s-${s.id}-start`, value: hhmm(s.start_time), 'aria-label': 'Bắt đầu' }), '→',
      h('input', { type: 'time', name: `s-${s.id}-end`, value: hhmm(s.end_time), 'aria-label': 'Kết thúc' }))),
    h('div', null, h('button', { class: 'btn primary', type: 'submit' }, 'Lưu khung giờ')));

  return [
    h('div', { class: 'card stack' }, h('h2', null, 'Chung'), general),
    h('div', { class: 'card stack' }, h('h2', null, 'Ngày diễn ra sự kiện'), dates),
    h('div', { class: 'card stack' }, h('h2', null, 'Phòng & sức chứa'),
      h('p', { class: 'muted small' }, 'Ô số là sức chứa riêng của phòng; để trống thì dùng mức chung ở trên.'), rooms),
    h('div', { class: 'card stack' }, h('h2', null, 'Khung giờ'), slots),
  ];
}

function editMeeting(roomId, slotId) {
  const m = meetingOf(roomId, slotId);
  const form = h('div', { class: 'grid-form' },
    h('label', { class: 'field' }, 'Cuộc họp (vd. GMD 1)', h('input', { name: 'title', value: m?.title ?? '' })),
    h('label', { class: 'field' }, 'Người chủ trì', h('input', { name: 'host', value: m?.host ?? '' })));
  const save = async () => {
    const title = form.querySelector('[name=title]').value.trim();
    const host = form.querySelector('[name=host]').value.trim() || null;
    let res;
    if (!title) res = m ? await sb.from('meetings').delete().eq('id', m.id) : { error: null };
    else if (m) res = await sb.from('meetings').update({ title, host }).eq('id', m.id);
    else res = await sb.from('meetings').insert({ event_date: S.date, room_id: roomId, slot_id: slotId, title, host });
    if (res.error) return toast(errMsg(res.error), 'error');
    close(); toast('Đã lưu cuộc họp', 'success'); await refresh();
  };
  const close = openModal(`${roomName(roomId)} · ${slotLabel(slotId)}`, form, [
    h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Đóng'),
    h('button', { type: 'submit', class: 'btn primary', onclick: save }, 'Lưu')]);
}

async function reloadConfig(msg) {
  const [rooms, slots, settings] = await Promise.all([
    sb.from('rooms').select('*').order('sort_order'),
    sb.from('time_slots').select('*').order('start_time'),
    sb.from('settings').select('*').single(),
  ]);
  S.rooms = rooms.data ?? S.rooms; S.slots = slots.data ?? S.slots; S.settings = settings.data ?? S.settings;
  toast(msg, 'success');
  render();
}

// ===================================================================
//  CSV import / export
// ===================================================================
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function downloadCsv(filename, rows) {
  const blob = new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const CSV_HEADER = ['ngay', 'phong', 'khung_gio', 'ho_ten', 'sdt', 'email', 'cong_ty', 'ghi_chu'];

function exportCsv(rows) {
  downloadCsv(`khach-${S.date}.csv`, [
    [...CSV_HEADER, 'trang_thai', 'walk_in', 'checkin_luc'],
    ...rows.map((r) => [r.event_date, roomName(r.room_id), hhmm(slotById(r.slot_id)?.start_time), r.full_name, r.phone, r.email,
      r.company, r.note, STATUS[r.status].label, r.is_walk_in ? 'x' : '', r.checked_in_at ? fmtDateTime(r.checked_in_at) : '']),
  ]);
}

function matchRoom(v) {
  const s = norm(v).trim();
  if (!s) return null;
  const byName = S.rooms.find((r) => norm(r.name) === s);
  if (byName) return byName.id;
  const num = Number(s.replace(/\D/g, ''));
  return S.rooms.find((r) => r.id === num)?.id ?? null;
}
function matchSlot(v) {
  const s = norm(v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?:[:h.](\d{2})?)?/);
  if (!m) return null;
  const key = `${m[1].padStart(2, '0')}:${m[2] ?? '00'}`;
  return S.slots.find((x) => hhmm(x.start_time) === key)?.id
    ?? (Number(s) >= 1 && Number(s) <= S.slots.length && !s.includes(':') && !s.includes('h') ? S.slots[Number(s) - 1].id : null);
}
function matchDate(v) {
  const s = (v || '').trim();
  if (!s) return S.date;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // dd/mm/yyyy
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// ---------- Excel (.xlsx) ----------
// Thư viện SheetJS chỉ tải khi admin mở chức năng nhập file.
let xlsxLib = null;
function loadXlsx() {
  if (!xlsxLib) {
    xlsxLib = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => { xlsxLib = null; reject(new Error('Không tải được thư viện đọc Excel, kiểm tra mạng.')); };
      document.head.append(s);
    });
  }
  return xlsxLib;
}

/** Giá trị ô Excel -> chuỗi. Ô ngày -> yyyy-mm-dd, ô giờ -> HH:MM. */
function cellStr(v) {
  if (v == null) return '';
  if (v instanceof Date) {
    const d = new Date(Math.round(v.getTime() / 60000) * 60000); // làm tròn phút (SheetJS lệch vài giây)
    if (d.getFullYear() < 1901) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return d.toLocaleDateString('sv');
  }
  if (typeof v === 'number' && v > 0 && v < 1) { // giờ lưu dạng phân số ngày
    const m = Math.round(v * 1440);
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }
  return String(v).trim();
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Định dạng "mỗi phòng 1 sheet": ô Tên phòng / Người trực (email) / Tên người trực / Ngày + bảng khách. */
function parseRoomSheet(sheetName, rows) {
  const errors = [];
  const meta = { name: '', emails: [], staffName: '', date: '' };
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const label = norm(cellStr(rows[i][0])).replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
    const val = cellStr(rows[i][1]);
    if (label.startsWith('ten phong')) meta.name = val;
    else if (label.startsWith('ten nguoi truc')) meta.staffName = val;
    else if (label.startsWith('nguoi truc')) meta.emails = val.split(/[,;\s]+/).map((x) => x.toLowerCase()).filter(Boolean);
    else if (label.startsWith('ngay')) meta.date = val;
    if (rows[i].some((c) => norm(cellStr(c)) === 'ho ten')) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return null; // không phải sheet phòng

  const where = `Sheet "${sheetName}"`;
  const room_id = matchRoom(sheetName) ?? matchRoom(meta.name);
  if (!room_id) { errors.push(`${where}: không xác định được phòng (đặt tên sheet P1…P${S.rooms.length})`); return { errors, guests: [], room: null }; }
  const date = matchDate(meta.date);
  if (!date) errors.push(`${where}: ngày "${meta.date}" không hợp lệ (dùng dd/mm/yyyy)`);
  const badEmails = meta.emails.filter((e) => !EMAIL_RE.test(e));
  if (badEmails.length) errors.push(`${where}: email người trực không hợp lệ: ${badEmails.join(', ')}`);

  const head = rows[headerIdx].map((c) => norm(cellStr(c)));
  const col = (...names) => head.findIndex((x) => names.includes(x));
  const idx = { slot: col('khung gio', 'gio', 'thoi gian'), name: col('ho ten'), phone: col('sdt', 'so dien thoai', 'dien thoai'),
    email: col('email'), company: col('cong ty'), note: col('ghi chu') };
  const get = (r, i) => (i >= 0 ? cellStr(r[i]) : '');
  const guests = [];
  let lastSlot = '';
  rows.slice(headerIdx + 1).forEach((r, n) => {
    const slotText = get(r, idx.slot) || lastSlot; // ô khung giờ gộp/để trống -> lấy khung phía trên
    lastSlot = slotText;
    const name = get(r, idx.name);
    if (!name) return; // dòng trống
    const slot_id = matchSlot(slotText);
    if (!slot_id) { errors.push(`${where} dòng ${headerIdx + n + 2}: khung giờ "${slotText}" không có`); return; }
    if (date) guests.push({ event_date: date, room_id, slot_id, full_name: name, phone: get(r, idx.phone) || null,
      email: get(r, idx.email) || null, company: get(r, idx.company) || null, note: get(r, idx.note) || null });
  });
  return { errors, guests, room: { room_id, sheetName, name: meta.name, emails: meta.emails.filter((e) => EMAIL_RE.test(e)),
    staffName: meta.staffName, date: meta.date ? date : null, count: guests.length } };
}

/** Định dạng "1 bảng phẳng": cột phong, khung_gio, ho_ten, ... (CSV hoặc 1 sheet Excel). */
function parseFlatRows(rows, label) {
  const head = rows[0].map((x) => norm(cellStr(x)).replace(/\s+/g, '_'));
  const col = (...names) => head.findIndex((x) => names.includes(x));
  const idx = {
    date: col('ngay', 'date', 'event_date'), room: col('phong', 'room', 'room_id'),
    slot: col('khung_gio', 'khung', 'gio', 'slot', 'time'), name: col('ho_ten', 'ten', 'name', 'full_name', 'ho_va_ten'),
    phone: col('sdt', 'so_dien_thoai', 'phone', 'dien_thoai'), email: col('email'),
    company: col('cong_ty', 'company'), note: col('ghi_chu', 'note'),
  };
  if (idx.room < 0 || idx.slot < 0 || idx.name < 0) return null;
  const get = (r, i) => (i >= 0 ? cellStr(r[i]) : '');
  const errors = [], guests = [];
  rows.slice(1).forEach((r, n) => {
    if (!r.some((c) => cellStr(c))) return;
    const rec = {
      event_date: matchDate(get(r, idx.date)), room_id: matchRoom(get(r, idx.room)), slot_id: matchSlot(get(r, idx.slot)),
      full_name: get(r, idx.name), phone: get(r, idx.phone) || null, email: get(r, idx.email) || null,
      company: get(r, idx.company) || null, note: get(r, idx.note) || null,
    };
    const bad = [!rec.full_name && 'thiếu tên', !rec.room_id && `phòng "${get(r, idx.room)}"`,
      !rec.slot_id && `khung giờ "${get(r, idx.slot)}"`, !rec.event_date && `ngày "${get(r, idx.date)}"`].filter(Boolean);
    if (bad.length) errors.push(`${label} dòng ${n + 2}: ${bad.join(', ')}`); else guests.push(rec);
  });
  return { errors, guests, room: null };
}

/** Định dạng "master": hàng tiêu đề "Room 6 (60) | Room 5 (40) …", mỗi khối cột = 1 ngày,
 *  cột bên trái mỗi khối là giờ. Ô ở hàng giờ = tên cuộc họp ("GMD 1 - VY"), các dòng dưới = khách. */
const colLetter = (n) => { let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const ROOM_HEAD_RE = /^(room|phong)\s*(\d+)\s*(?:\((\d+)\))?/;
const TIME_RE = /^\d{1,2}:\d{2}$/;

function splitGuest(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.*\S)(?:\s+-\s*|\s*-\s+)(\S.*)$/); // tách ở dấu " - " cuối cùng
  if (m && !/^\d+\s*attendees?$/i.test(m[2])) return { full_name: m[1].trim(), company: m[2].trim() };
  if (m) return { full_name: t, company: m[1].trim() };            // "KTX - 1 attendee"
  const g = t.match(/^(.*?)\s*\(\d+\s*attendees?\)$/i);           // "Comgest (2 attendees)"
  return { full_name: t, company: g ? g[1].trim() : null };
}
function splitMeeting(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.*\S)\s+-\s+(\S.*)$/);
  return m ? { title: m[1].trim(), host: m[2].trim() } : { title: t, host: null };
}
function findDateIn(text) {
  const m = (text || '').match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})|(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  return m[1] ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : `${m[4]}-${m[5].padStart(2, '0')}-${m[6].padStart(2, '0')}`;
}

function parseMasterGrid(sheetName, rows) {
  const hr = rows.findIndex((r, i) => i < 40 && r.filter((c) => ROOM_HEAD_RE.test(norm(cellStr(c)))).length >= 2);
  if (hr < 0) return null;
  // Nhóm các cột phòng liền nhau thành khối (mỗi khối = 1 ngày)
  const blocks = [];
  rows[hr].forEach((c, col) => {
    const m = norm(cellStr(c)).match(ROOM_HEAD_RE);
    if (!m) return;
    let b = blocks[blocks.length - 1];
    if (!b || col !== b.cols[b.cols.length - 1].col + 1) { b = { index: blocks.length, cols: [] }; blocks.push(b); }
    b.cols.push({ col, room_id: Number(m[2]), capacity: m[3] ? Number(m[3]) : null,
      name: cellStr(c).replace(/\(\s*\d+\s*\)\s*$/, '').trim() });
  });
  const out = { errors: [], guests: [], meetings: [], rooms: [], roomDefs: [], blocks: [] };
  const where = `Sheet "${sheetName}"`;

  for (const b of blocks) {
    const first = b.cols[0].col, last = b.cols[b.cols.length - 1].col;
    const timeCol = first - 1;
    if (timeCol < 0) { out.errors.push(`${where}: khối ${colLetter(first)} không có cột giờ bên trái`); continue; }
    // Nhãn ngày: ô (gộp) phía trên hàng tiêu đề
    let label = '';
    for (let r = 0; r < hr && !label; r++) for (let c = timeCol; c <= last && !label; c++) label = cellStr(rows[r][c]);
    const timeRows = [];
    for (let r = hr + 1; r < rows.length; r++) if (TIME_RE.test(cellStr(rows[r][timeCol]))) timeRows.push(r);
    // Dòng email người trực (tuỳ chọn): ô cột giờ ghi "Trực phòng" / "Email" / "Staff", trước khung giờ đầu tiên
    const emails = new Map();
    for (let r = hr + 1; r < (timeRows[0] ?? rows.length); r++) {
      if (!/email|truc|staff|access/.test(norm(cellStr(rows[r][timeCol])))) continue;
      for (const rc of b.cols) {
        const list = cellStr(rows[r][rc.col]).split(/[,;\s]+/).map((x) => x.toLowerCase()).filter(Boolean);
        list.filter((e) => !EMAIL_RE.test(e)).forEach((e) => out.errors.push(`${where} ô ${colLetter(rc.col)}${r + 1}: email "${e}" không hợp lệ`));
        emails.set(rc.room_id, [...(emails.get(rc.room_id) || []), ...list.filter((e) => EMAIL_RE.test(e))]);
      }
    }
    const blk = { index: b.index, label, range: `${colLetter(timeCol)}–${colLetter(last)}`, guests: 0, meetings: 0, defaultDate: findDateIn(label) };
    out.blocks.push(blk);
    const counts = new Map();

    timeRows.forEach((tr, k) => {
      const end = timeRows[k + 1] ?? rows.length;
      const time = cellStr(rows[tr][timeCol]);
      const slot_id = matchSlot(time);
      for (const rc of b.cols) {
        const titleText = cellStr(rows[tr][rc.col]);
        const names = [];
        for (let r = tr + 1; r < end; r++) {
          const v = cellStr(rows[r][rc.col]);
          if (v && !/^\d+$/.test(v)) names.push(v);
        }
        if (!titleText && !names.length) continue;
        if (!slot_id) { out.errors.push(`${where} ${colLetter(rc.col)}${tr + 1}: khung giờ ${time} không có trong Cài đặt → bỏ qua ${names.length} khách`); continue; }
        if (titleText) { out.meetings.push({ _block: b.index, room_id: rc.room_id, slot_id, ...splitMeeting(titleText) }); blk.meetings++; }
        for (const n of names) {
          out.guests.push({ _block: b.index, room_id: rc.room_id, slot_id, ...splitGuest(n), phone: null, email: null, note: null });
          blk.guests++; counts.set(rc.room_id, (counts.get(rc.room_id) || 0) + 1);
        }
      }
    });
    for (const rc of b.cols) {
      out.rooms.push({ _block: b.index, room_id: rc.room_id, sheetName: `${sheetName} ${blk.range}`, name: rc.name,
        emails: emails.get(rc.room_id) || [], staffName: '', date: null, count: counts.get(rc.room_id) || 0 });
    }
    b.cols.forEach((rc, i) => {
      if (!out.roomDefs.some((d) => d.id === rc.room_id)) out.roomDefs.push({ id: rc.room_id, name: rc.name, capacity: rc.capacity, sort_order: i + 1 });
    });
  }
  return out;
}

async function parseImportFile(f) {
  const out = { rooms: [], guests: [], errors: [], meetings: [], roomDefs: [], blocks: [] };
  const add = (res) => {
    if (!res) return;
    out.errors.push(...res.errors); out.guests.push(...res.guests);
    if (res.room) out.rooms.push(res.room);
    for (const k of ['rooms', 'meetings', 'roomDefs', 'blocks']) if (Array.isArray(res[k])) out[k].push(...res[k]);
  };
  if (/\.csv$/i.test(f.name) || f.type === 'text/csv') {
    const rows = parseCsv(await f.text());
    const res = rows.length > 1 ? parseFlatRows(rows, 'CSV') : null;
    if (!res) out.errors.push('CSV cần có cột: phong, khung_gio, ho_ten.');
    add(res);
    return out;
  }
  const XLSX = await loadXlsx();
  const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: true });
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
    if (!rows.length || /^huong dan/.test(norm(name))) continue;
    add(parseMasterGrid(name, rows) ?? parseRoomSheet(name, rows) ?? parseFlatRows(rows, `Sheet "${name}"`));
  }
  // khối của nhiều sheet: đánh lại số thứ tự cho duy nhất
  if (!out.guests.length && !out.rooms.length && !out.errors.length) out.errors.push('Không nhận ra định dạng file. Dùng file mẫu.');
  return out;
}

const keyText = (t) => norm(t).replace(/\s+/g, ' ').trim();
// Trùng = cùng ngày, phòng, khung giờ, họ tên VÀ công ty ("Alex - East Cap" khác "Alex - Fiera")
const guestKey = (g) => `${g.event_date}|${g.room_id}|${g.slot_id}|${keyText(g.full_name)}|${keyText(g.company)}`;

async function runImport(data, blockDates, removeRooms) {
  const report = { guests: 0, dup: 0, staff: 0, assign: 0, meetings: 0, roomsRemoved: 0, roomsKept: [] };
  const fail = (step, error) => { throw new Error(`${step}: ${errMsg(error)}`); };
  const withDate = (x) => (x._block == null ? x : (({ _block, ...rest }) => ({ ...rest, event_date: blockDates[_block], ...(x.emails ? { date: blockDates[_block] } : {}) }))(x));
  const guests = data.guests.map(withDate);
  const meetings = data.meetings.map(withDate);
  const rooms = data.rooms.map(withDate);

  // 1. Phòng: tạo/đổi tên/sức chứa theo file
  if (data.roomDefs.length) {
    const { error } = await sb.from('rooms').upsert(data.roomDefs);
    if (error) fail('Cập nhật phòng', error);
    if (removeRooms) {
      for (const r of S.rooms.filter((x) => !data.roomDefs.some((d) => d.id === x.id))) {
        const { error: e } = await sb.from('rooms').delete().eq('id', r.id);
        if (e) report.roomsKept.push(r.name); else report.roomsRemoved++;
      }
    }
  } else {
    const renames = rooms.filter((r) => r.name && r.name !== roomName(r.room_id));
    if (renames.length) {
      const map = new Map(renames.map((r) => [r.room_id, r.name]));
      const { error } = await sb.from('rooms').upsert(S.rooms.filter((r) => map.has(r.id)).map((r) => ({ ...r, name: map.get(r.id) })));
      if (error) fail('Đổi tên phòng', error);
    }
  }

  // 2. Thêm ngày mới vào danh sách ngày sự kiện
  const dates = [...new Set([...guests, ...meetings].map((g) => g.event_date))];
  const newDates = dates.filter((d) => !(S.settings.event_dates || []).includes(d));
  if (newDates.length) {
    const { error } = await sb.from('settings').update({ event_dates: [...(S.settings.event_dates || []), ...newDates].sort() }).eq('id', true);
    if (error) fail('Thêm ngày', error);
  }

  // 3. Người trực: tạo tài khoản (nếu chưa có) + phân công phòng
  if (rooms.some((r) => r.emails.length)) {
    const [st, as] = await Promise.all([sb.from('staff').select('*'), sb.from('room_assignments').select('*')]);
    if (st.error || as.error) fail('Đọc nhân sự', st.error || as.error);
    const known = new Set(st.data.map((s) => s.email));
    const assigned = new Set(as.data.map((a) => `${a.email}|${a.room_id}|${a.event_date ?? ''}`));
    for (const r of rooms) {
      for (const email of r.emails) {
        if (!known.has(email)) {
          const { error } = await sb.from('staff').insert({ email, full_name: r.staffName || null, role: 'staff' });
          if (error) fail(`Thêm ${email}`, error);
          known.add(email); report.staff++;
        }
        const key = `${email}|${r.room_id}|${r.date ?? ''}`;
        if (!assigned.has(key)) {
          const { error } = await sb.from('room_assignments').insert({ email, room_id: r.room_id, event_date: r.date });
          if (error) fail(`Phân công ${email}`, error);
          assigned.add(key); report.assign++;
        }
      }
    }
  }

  // 4. Cuộc họp: thêm mới hoặc cập nhật tên/người chủ trì
  if (meetings.length) {
    const existing = new Map();
    for (const d of new Set(meetings.map((m) => m.event_date))) {
      const { data: rows, error } = await sb.from('meetings').select('*').eq('event_date', d);
      if (error) fail('Đọc cuộc họp', error);
      rows.forEach((m) => existing.set(`${m.event_date}|${m.room_id}|${m.slot_id}`, m));
    }
    const fresh = [];
    for (const m of meetings) {
      const old = existing.get(`${m.event_date}|${m.room_id}|${m.slot_id}`);
      if (!old) { fresh.push(m); existing.set(`${m.event_date}|${m.room_id}|${m.slot_id}`, m); continue; }
      if (old.title !== m.title || (old.host ?? null) !== (m.host ?? null)) {
        const { error } = await sb.from('meetings').update({ title: m.title, host: m.host }).eq('id', old.id);
        if (error) fail('Cập nhật cuộc họp', error);
        report.meetings++;
      }
    }
    if (fresh.length) {
      const { error } = await sb.from('meetings').insert(fresh);
      if (error) fail('Thêm cuộc họp', error);
      report.meetings += fresh.length;
    }
  }

  // 5. Khách: bỏ qua người đã có (cùng ngày, phòng, khung giờ, họ tên)
  const existing = new Set();
  for (const d of dates) {
    const { data: rows, error } = await sb.from('attendees').select('*').eq('event_date', d).limit(10000);
    if (error) fail('Đọc danh sách hiện có', error);
    rows.forEach((g) => existing.add(guestKey(g)));
  }
  const fresh = [];
  for (const g of guests) {
    const k = guestKey(g);
    if (existing.has(k)) { report.dup++; continue; }
    existing.add(k); fresh.push(g);
  }
  for (let i = 0; i < fresh.length; i += 500) {
    const { error } = await sb.from('attendees').insert(fresh.slice(i, i + 500));
    if (error) fail(`Nhập khách (lô ${i / 500 + 1})`, error);
  }
  report.guests = fresh.length;
  return report;
}

function addDays(d, n) { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return x.toLocaleDateString('sv'); }

function importFile() {
  const file = h('input', { type: 'file', accept: '.xlsx,.xls,.csv' });
  const preview = h('div', { class: 'stack' });
  let parsed = null;
  let dateInputs = [];
  let removeBox = null;

  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    importBtn.disabled = true;
    preview.replaceChildren(h('p', { class: 'muted' }, 'Đang đọc file…'));
    try { parsed = await parseImportFile(f); }
    catch (e) { preview.replaceChildren(h('p', { class: 'error' }, e.message)); return; }

    // Khối ngày (định dạng master): chọn ngày cho từng khối
    const evDates = [...(S.settings.event_dates || [])].sort();
    dateInputs = parsed.blocks.map((b, i) => h('input', { type: 'date', required: true, 'aria-label': `Ngày của khối ${i + 1}`,
      value: b.defaultDate || evDates[i] || addDays(S.date, i) }));
    const blockTable = parsed.blocks.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'preview' },
      h('thead', null, h('tr', null, h('th', null, 'Khối'), h('th', null, 'Cột'), h('th', null, 'Ngày'), h('th', null, 'Cuộc họp'), h('th', null, 'Khách'))),
      h('tbody', null, parsed.blocks.map((b, i) => h('tr', null,
        h('td', null, b.label || `Ngày ${i + 1}`), h('td', null, b.range), h('td', null, dateInputs[i]),
        h('td', { class: 'num' }, b.meetings), h('td', { class: 'num' }, b.guests)))))) : null;

    const roomDefsTable = parsed.roomDefs.length ? h('p', { class: 'small' }, h('strong', null, 'Phòng: '),
      parsed.roomDefs.map((d) => `${d.name}${d.capacity ? ` (${d.capacity} chỗ)` : ''}`).join(', ')) : null;
    const extra = parsed.roomDefs.length ? S.rooms.filter((r) => !parsed.roomDefs.some((d) => d.id === r.id)) : [];
    removeBox = extra.length ? h('input', { type: 'checkbox', checked: true }) : null;

    const roomTable = !parsed.blocks.length && parsed.rooms.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'preview' },
      h('thead', null, h('tr', null, h('th', null, 'Sheet'), h('th', null, 'Phòng'), h('th', null, 'Người trực'), h('th', null, 'Ngày'), h('th', null, 'Khách'))),
      h('tbody', null, parsed.rooms.map((r) => h('tr', null,
        h('td', null, r.sheetName),
        h('td', null, r.name || roomName(r.room_id)),
        h('td', null, r.emails.length ? r.emails.join(', ') : h('span', { class: 'error' }, 'chưa điền')),
        h('td', null, r.date ? fmtDate(r.date) : `${fmtDate(S.date)} (đang chọn)`),
        h('td', { class: 'num' }, r.count)))))) : null;
    const staffEmails = [...new Set(parsed.rooms.flatMap((r) => r.emails))];

    preview.replaceChildren(...[
      h('p', null, h('strong', null, `${parsed.guests.length} khách`),
        parsed.meetings.length ? `, ${parsed.meetings.length} cuộc họp` : '',
        parsed.blocks.length ? ` trong ${parsed.blocks.length} ngày` : parsed.rooms.length ? ` trong ${parsed.rooms.length} phòng` : '',
        '. Khách đã có sẵn (trùng tên + công ty trong cùng phòng, khung giờ) sẽ được bỏ qua.'),
      parsed.blocks.length ? h('p', { class: 'small' }, 'Chọn ngày cho từng khối cột:') : null,
      blockTable, roomDefsTable,
      removeBox ? h('label', { class: 'field checkbox' }, removeBox,
        `Xoá phòng không có trong file: ${extra.map((r) => r.name).join(', ')} (chỉ khi phòng chưa có khách)`) : null,
      roomTable,
      staffEmails.length ? h('p', { class: 'small muted' },
        `Người trực sẽ được thêm vào Nhân sự và phân công đúng phòng: ${staffEmails.join(', ')}`) :
        parsed.blocks.length ? h('p', { class: 'small muted' },
          'File không có dòng email người trực — phân công người trực ở tab Nhân sự sau khi nhập.') : null,
      parsed.errors.length ? h('details', { open: parsed.errors.length < 6 },
        h('summary', { class: 'error' }, `${parsed.errors.length} cảnh báo (phần lỗi sẽ bỏ qua)`),
        h('ul', { class: 'small' }, parsed.errors.slice(0, 100).map((e) => h('li', null, e)))) : null,
    ].filter(Boolean));
    importBtn.disabled = !parsed.guests.length && !parsed.meetings.length && !parsed.rooms.some((r) => r.emails.length);
  });

  const importBtn = h('button', { type: 'button', class: 'btn primary', disabled: true, onclick: async () => {
    const blockDates = dateInputs.map((i) => i.value);
    if (blockDates.some((d) => !d)) return toast('Chọn ngày cho tất cả các khối', 'error');
    if (new Set(blockDates).size !== blockDates.length) return toast('Mỗi khối phải là một ngày khác nhau', 'error');
    importBtn.disabled = true;
    importBtn.textContent = 'Đang nhập…';
    try {
      const r = await runImport(parsed, blockDates, removeBox?.checked);
      toast(`Đã nhập ${r.guests} khách` + (r.dup ? `, bỏ qua ${r.dup} trùng` : '') +
        (r.meetings ? `, ${r.meetings} cuộc họp` : '') +
        (r.staff ? `, thêm ${r.staff} người trực` : '') + (r.assign ? `, ${r.assign} phân công` : '') +
        (r.roomsRemoved ? `, xoá ${r.roomsRemoved} phòng thừa` : '') +
        (r.roomsKept.length ? ` (giữ ${r.roomsKept.join(', ')} vì đang có khách)` : ''), 'success');
      close();
      if (blockDates.length && !blockDates.includes(S.date)) S.date = [...blockDates].sort()[0];
      await reloadConfig('Đã cập nhật phòng & ngày');
      await refresh();
    } catch (e) {
      toast(e.message, 'error');
      importBtn.disabled = false; importBtn.textContent = 'Nhập dữ liệu';
      await refresh();
    }
  } }, 'Nhập dữ liệu');

  const close = openModal('Nhập danh sách từ Excel / CSV', h('div', { class: 'stack' },
    h('p', { class: 'small' }, 'Nhận 2 kiểu file: ', h('strong', null, 'file master'),
      ' (hàng tiêu đề "Room 6 (60) | Room 5 (40) …", mỗi khối cột là 1 ngày, ô ở hàng giờ là tên cuộc họp, bên dưới là khách) hoặc ',
      h('strong', null, 'file mẫu mỗi phòng 1 sheet'), '.'),
    h('div', { class: 'toolbar wrap-row' },
      h('a', { class: 'btn small', href: 'mau-master.xlsx', download: true }, 'Mẫu dạng master'),
      h('a', { class: 'btn small', href: 'mau-danh-sach.xlsx', download: true }, 'Mẫu mỗi phòng 1 sheet'),
      h('a', { class: 'btn small', href: 'du-lieu-mau.xlsx', download: true }, 'Dữ liệu giả để chạy thử')),
    file, preview), [h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Đóng'), importBtn]);
}
