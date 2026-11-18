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
  staffList: [], assignments: [], logs: [],
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
  Object.assign(S, { me: null, rows: [], staffList: [], assignments: [], logs: [] });
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
  const { data, error } = await sb.from('attendees').select('*')
    .eq('event_date', S.date).order('slot_id').order('created_at').limit(5000);
  if (error) { toast(errMsg(error), 'error'); return; }
  S.rows = data;
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
  const cap = capacity();
  const tabs = h('nav', { class: 'slot-tabs', 'aria-label': 'Khung giờ' }, S.slots.map((s) => {
    const rs = roomRows.filter((r) => r.slot_id === s.id);
    const n = activeCount(rs);
    const inN = rs.filter((r) => r.status === 'checked_in').length;
    return h('button', {
      class: `slot-tab ${s.id === S.staffSlot ? 'active' : ''} ${n >= cap ? 'full' : ''}`,
      'aria-pressed': String(s.id === S.staffSlot),
      onclick: () => { S.staffSlot = s.id; render(); },
    }, h('span', { class: 'slot-time' }, hhmm(s.start_time)), h('span', { class: 'slot-count' }, `${inN}/${n}`));
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
      h('span', { class: 'muted' }, slotLabel(S.staffSlot))),
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
  const cap = capacity();
  const live = S.rows.filter((r) => r.status !== 'cancelled');
  const totalIn = S.rows.filter((r) => r.status === 'checked_in').length;
  const walkIns = live.filter((r) => r.is_walk_in).length;

  const table = h('table', { class: 'grid' },
    h('thead', null, h('tr', null, h('th', null, 'Phòng'),
      S.slots.map((s) => h('th', null, hhmm(s.start_time))), h('th', null, 'Tổng'))),
    h('tbody', null, S.rooms.map((room) => {
      const rr = S.rows.filter((r) => r.room_id === room.id);
      return h('tr', null,
        h('th', { scope: 'row' }, room.name),
        S.slots.map((s) => {
          const cell = rr.filter((r) => r.slot_id === s.id);
          const n = activeCount(cell);
          const inN = cell.filter((r) => r.status === 'checked_in').length;
          const cls = n > cap ? 'over' : n === cap ? 'full' : n === 0 ? 'zero' : '';
          return h('td', null, h('button', { class: `cell ${cls}`,
            title: `${room.name} · ${s.label}: ${n} khách, ${inN} đã check-in`,
            onclick: () => { Object.assign(S.filters, { room: String(room.id), slot: String(s.id), status: '', q: '' }); S.tab = 'list'; render(); } },
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
      Stat('Sức chứa ngày', `${live.length}/${cap * S.rooms.length * S.slots.length}`)),
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
      h('button', { class: 'btn', onclick: () => importCsv() }, 'Nhập CSV'),
      h('button', { class: 'btn', onclick: () => exportCsv(rows) }, 'Xuất CSV'),
      h('button', { class: 'btn primary', onclick: () => editAttendee({
        room_id: Number(F.room) || S.rooms[0]?.id, slot_id: Number(F.slot) || S.slots[0]?.id, event_date: S.date }) }, '+ Thêm khách')),
    F.room && F.slot ? h('div', { class: 'room-head' },
      h('h2', null, `${roomName(Number(F.room))} · ${slotLabel(Number(F.slot))}`),
      h('span', { class: 'muted' }, `${activeCount(rows)}/${capacity()} khách`)) : null,
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
    const upd = S.rooms.map((r) => ({ id: r.id, name: fd.get(`room-${r.id}`).trim() || r.name, sort_order: r.sort_order }));
    const { error } = await sb.from('rooms').upsert(upd);
    if (error) return toast(errMsg(error), 'error');
    await reloadConfig('Đã lưu tên phòng');
  } },
    S.rooms.map((r) => h('label', { class: 'field' }, `Phòng #${r.id}`, h('input', { name: `room-${r.id}`, value: r.name }))),
    h('div', { class: 'field wide' }, h('button', { class: 'btn primary', type: 'submit' }, 'Lưu tên phòng')));

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
    h('div', { class: 'card stack' }, h('h2', null, 'Tên phòng'), rooms),
    h('div', { class: 'card stack' }, h('h2', null, 'Khung giờ'), slots),
  ];
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

function importCsv() {
  const file = h('input', { type: 'file', accept: '.csv,text/csv' });
  const preview = h('div', { class: 'stack' });
  let parsed = [];

  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    const rows = parseCsv(await f.text());
    if (rows.length < 2) { preview.replaceChildren(h('p', { class: 'error' }, 'File không có dữ liệu.')); return; }
    const head = rows[0].map((x) => norm(x).trim().replace(/\s+/g, '_'));
    const col = (...names) => head.findIndex((x) => names.includes(x));
    const idx = {
      date: col('ngay', 'date', 'event_date'), room: col('phong', 'room', 'room_id'),
      slot: col('khung_gio', 'khung', 'gio', 'slot', 'time'), name: col('ho_ten', 'ten', 'name', 'full_name', 'ho_va_ten'),
      phone: col('sdt', 'so_dien_thoai', 'phone', 'dien_thoai'), email: col('email'),
      company: col('cong_ty', 'company'), note: col('ghi_chu', 'note'),
    };
    if (idx.room < 0 || idx.slot < 0 || idx.name < 0) {
      preview.replaceChildren(h('p', { class: 'error' }, 'Cần có cột: phong, khung_gio, ho_ten. Tải file mẫu để xem định dạng.'));
      return;
    }
    const get = (r, i) => (i >= 0 ? (r[i] ?? '').trim() : '');
    const errors = [];
    parsed = [];
    rows.slice(1).forEach((r, n) => {
      const line = n + 2;
      const rec = {
        event_date: matchDate(get(r, idx.date)), room_id: matchRoom(get(r, idx.room)), slot_id: matchSlot(get(r, idx.slot)),
        full_name: get(r, idx.name), phone: get(r, idx.phone) || null, email: get(r, idx.email) || null,
        company: get(r, idx.company) || null, note: get(r, idx.note) || null,
      };
      const bad = [!rec.full_name && 'thiếu tên', !rec.room_id && `phòng "${get(r, idx.room)}"`,
        !rec.slot_id && `khung giờ "${get(r, idx.slot)}"`, !rec.event_date && `ngày "${get(r, idx.date)}"`].filter(Boolean);
      if (bad.length) errors.push(`Dòng ${line}: ${bad.join(', ')}`); else parsed.push(rec);
    });
    const byDate = {};
    parsed.forEach((p) => { byDate[p.event_date] = (byDate[p.event_date] || 0) + 1; });
    preview.replaceChildren(
      h('p', null, h('strong', null, `${parsed.length} khách hợp lệ`), ' — ',
        Object.entries(byDate).map(([d, c]) => `${fmtDate(d)}: ${c}`).join(', ')),
      errors.length ? h('details', { open: errors.length < 6 }, h('summary', { class: 'error' }, `${errors.length} dòng lỗi (sẽ bỏ qua)`),
        h('ul', { class: 'small' }, errors.slice(0, 100).map((e) => h('li', null, e)))) : null);
    importBtn.disabled = !parsed.length;
  });

  const importBtn = h('button', { type: 'button', class: 'btn primary', disabled: true, onclick: async () => {
    importBtn.disabled = true;
    for (let i = 0; i < parsed.length; i += 500) {
      const { error } = await sb.from('attendees').insert(parsed.slice(i, i + 500));
      if (error) { importBtn.disabled = false; return toast(`Lỗi ở lô ${i / 500 + 1}: ${errMsg(error)}`, 'error'); }
    }
    toast(`Đã nhập ${parsed.length} khách`, 'success');
    close(); await refresh();
  } }, 'Nhập dữ liệu');

  const close = openModal('Nhập danh sách từ CSV', h('div', { class: 'stack' },
    h('p', { class: 'small' }, 'Cột bắt buộc: ', h('code', null, 'phong'), ', ', h('code', null, 'khung_gio'), ', ', h('code', null, 'ho_ten'),
      '. Tuỳ chọn: ', h('code', null, 'ngay'), ' (trống = ngày đang xem), ', h('code', null, 'sdt, email, cong_ty, ghi_chu'),
      '. Phòng ghi số (1–8) hoặc tên; khung giờ ghi giờ bắt đầu (09:00, 9h).'),
    h('button', { type: 'button', class: 'btn small', onclick: () => downloadCsv('mau-danh-sach.csv', [CSV_HEADER,
      [S.date, '1', '09:00', 'Nguyễn Văn A', '0901234567', 'a@vidu.com', 'Công ty A', ''],
      [S.date, '2', '10:00', 'Trần Thị B', '0912345678', '', 'Công ty B', 'Khách VIP']]) }, 'Tải file mẫu'),
    file, preview), [h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Đóng'), importBtn]);
}
