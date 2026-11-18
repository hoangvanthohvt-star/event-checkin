-- =====================================================================
--  EVENT CHECK-IN — Supabase schema + Row Level Security
--  Chạy toàn bộ file này trong Supabase Dashboard → SQL Editor → Run.
--  File chạy lại được nhiều lần (idempotent) cho phần bảng/hàm/policy.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. BẢNG CẤU HÌNH
-- ---------------------------------------------------------------------

-- Phòng họp
create table if not exists public.rooms (
  id         smallint primary key,
  name       text not null,
  sort_order smallint not null default 0
);

-- Khung giờ trong ngày
create table if not exists public.time_slots (
  id         smallint primary key,
  start_time time not null,
  end_time   time not null,
  label      text not null
);

-- Cài đặt chung (1 dòng duy nhất)
create table if not exists public.settings (
  id          boolean primary key default true check (id),
  event_name  text not null default 'Sự kiện',
  capacity    smallint not null default 10 check (capacity > 0),
  event_dates date[] not null default '{}'
);
insert into public.settings (id) values (true) on conflict do nothing;

-- Nhân sự: định danh bằng email đăng nhập (Supabase Auth)
create table if not exists public.staff (
  email      text primary key check (email = lower(email)),
  full_name  text,
  role       text not null default 'staff' check (role in ('admin', 'staff')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Phân công trực phòng. event_date = NULL nghĩa là trực phòng đó mọi ngày.
create table if not exists public.room_assignments (
  id         bigint generated always as identity primary key,
  email      text not null references public.staff(email) on delete cascade on update cascade,
  room_id    smallint not null references public.rooms(id) on delete cascade,
  event_date date,
  created_at timestamptz not null default now()
);
create unique index if not exists room_assignments_uniq
  on public.room_assignments (email, room_id, coalesce(event_date, 'infinity'::date));

-- ---------------------------------------------------------------------
-- 2. KHÁCH HÀNG
-- ---------------------------------------------------------------------
create table if not exists public.attendees (
  id            uuid primary key default gen_random_uuid(),
  event_date    date not null,
  room_id       smallint not null references public.rooms(id),
  slot_id       smallint not null references public.time_slots(id),
  full_name     text not null check (length(trim(full_name)) > 0),
  phone         text,
  email         text,
  company       text,
  note          text,
  status        text not null default 'registered'
                check (status in ('registered', 'checked_in', 'no_show', 'cancelled')),
  is_walk_in    boolean not null default false,
  checked_in_at timestamptz,
  created_at    timestamptz not null default now(),
  created_by    text,
  updated_at    timestamptz not null default now(),
  updated_by    text
);
create index if not exists attendees_lookup_idx on public.attendees (event_date, room_id, slot_id);

-- Nhật ký thay đổi (chỉ admin xem)
create table if not exists public.attendee_log (
  id          bigint generated always as identity primary key,
  attendee_id uuid,
  action      text not null,          -- insert | update | delete
  changed_by  text,
  changed_at  timestamptz not null default now(),
  old_data    jsonb,
  new_data    jsonb
);
create index if not exists attendee_log_attendee_idx on public.attendee_log (attendee_id);
create index if not exists attendee_log_time_idx on public.attendee_log (changed_at desc);

-- ---------------------------------------------------------------------
-- 3. HÀM HỖ TRỢ PHÂN QUYỀN
--    SECURITY DEFINER để đọc bảng staff/assignments mà không bị RLS chặn
--    (tránh đệ quy policy). search_path cố định để an toàn.
-- ---------------------------------------------------------------------
create or replace function public.current_email()
returns text language sql stable
set search_path = ''
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff s
    where s.email = public.current_email() and s.role = 'admin' and s.active
  );
$$;

create or replace function public.can_access_room(p_room smallint, p_date date)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select public.is_admin() or exists (
    select 1
    from public.room_assignments a
    join public.staff s on s.email = a.email
    where a.email = public.current_email()
      and s.active
      and a.room_id = p_room
      and (a.event_date is null or a.event_date = p_date)
  );
$$;

-- Thông tin người đang đăng nhập (frontend gọi khi khởi động)
create or replace function public.get_me()
returns json language sql stable security definer
set search_path = ''
as $$
  select json_build_object(
    'email', public.current_email(),
    'full_name', s.full_name,
    'role', s.role,
    'assignments', coalesce((
      select json_agg(json_build_object('room_id', a.room_id, 'event_date', a.event_date)
                      order by a.room_id, a.event_date)
      from public.room_assignments a where a.email = s.email
    ), '[]'::json)
  )
  from public.staff s
  where s.email = public.current_email() and s.active;
$$;

-- ---------------------------------------------------------------------
-- 4. TRIGGER: kiểm tra quyền sửa, sức chứa, dấu vết người sửa
-- ---------------------------------------------------------------------
create or replace function public.attendees_before_write()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare
  v_admin    boolean := public.is_admin();
  v_capacity int;
  v_count    int;
  v_user     text := nullif(public.current_email(), '');
begin
  -- Kiểm tra quyền trước (trigger chạy trước RLS WITH CHECK), tránh lộ thông tin phòng khác
  if not v_admin and auth.uid() is not null
     and not public.can_access_room(new.room_id, new.event_date) then
    raise exception 'Bạn không có quyền với phòng này' using errcode = '42501';
  end if;

  -- Người trực không được chuyển khách sang phòng/khung giờ/ngày khác
  if tg_op = 'UPDATE' and not v_admin and auth.uid() is not null then
    if new.room_id    is distinct from old.room_id
       or new.slot_id    is distinct from old.slot_id
       or new.event_date is distinct from old.event_date then
      raise exception 'Chỉ admin mới được chuyển khách sang phòng/khung giờ khác'
        using errcode = '42501';
    end if;
  end if;

  -- Không cho tự ghi đè cột audit
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := coalesce(v_user, new.created_by);
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(v_user, new.updated_by);

  -- Thời điểm check-in
  if new.status = 'checked_in' and (tg_op = 'INSERT' or old.status is distinct from 'checked_in') then
    new.checked_in_at := now();
  elsif new.status <> 'checked_in' then
    new.checked_in_at := null;
  end if;

  -- Kiểm tra sức chứa (admin được phép vượt; người trực thì bị chặn)
  if new.status <> 'cancelled'
     and (tg_op = 'INSERT'
          or old.status = 'cancelled'
          or new.room_id is distinct from old.room_id
          or new.slot_id is distinct from old.slot_id
          or new.event_date is distinct from old.event_date)
     and not v_admin and auth.uid() is not null then
    -- khoá theo ô để 2 người thêm cùng lúc không vượt sức chứa
    perform pg_advisory_xact_lock(hashtext(new.event_date::text || ':' || new.room_id || ':' || new.slot_id));
    select capacity into v_capacity from public.settings where id;
    select count(*) into v_count
      from public.attendees a
     where a.event_date = new.event_date and a.room_id = new.room_id
       and a.slot_id = new.slot_id and a.status <> 'cancelled'
       and a.id <> new.id;
    if v_count >= v_capacity then
      raise exception 'Khung giờ này đã đủ % khách. Liên hệ admin để thêm.', v_capacity
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists attendees_before_write on public.attendees;
create trigger attendees_before_write
  before insert or update on public.attendees
  for each row execute function public.attendees_before_write();

create or replace function public.attendees_audit()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.attendee_log (attendee_id, action, changed_by, old_data, new_data)
  values (
    coalesce(new.id, old.id),
    lower(tg_op),
    nullif(public.current_email(), ''),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null;
end;
$$;

drop trigger if exists attendees_audit on public.attendees;
create trigger attendees_audit
  after insert or update or delete on public.attendees
  for each row execute function public.attendees_audit();

-- ---------------------------------------------------------------------
-- 5. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.rooms            enable row level security;
alter table public.time_slots       enable row level security;
alter table public.settings         enable row level security;
alter table public.staff            enable row level security;
alter table public.room_assignments enable row level security;
alter table public.attendees        enable row level security;
alter table public.attendee_log     enable row level security;

-- Dọn policy cũ (để chạy lại file không lỗi)
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public'
             and tablename in ('rooms','time_slots','settings','staff','room_assignments','attendees','attendee_log')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- rooms / time_slots / settings: ai đã đăng nhập cũng đọc được, chỉ admin sửa
create policy rooms_read  on public.rooms      for select to authenticated using (true);
create policy rooms_admin on public.rooms      for all    to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy slots_read  on public.time_slots for select to authenticated using (true);
create policy slots_admin on public.time_slots for all    to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy settings_read  on public.settings for select to authenticated using (true);
create policy settings_admin on public.settings for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- staff: mỗi người chỉ thấy chính mình; admin thấy & sửa tất cả
create policy staff_self  on public.staff for select to authenticated
  using (email = (select public.current_email()) or (select public.is_admin()));
create policy staff_admin on public.staff for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- room_assignments: tương tự
create policy assign_self  on public.room_assignments for select to authenticated
  using (email = (select public.current_email()) or (select public.is_admin()));
create policy assign_admin on public.room_assignments for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- attendees: chỉ thấy/sửa khách thuộc phòng được phân công; chỉ admin xoá hẳn
create policy attendees_select on public.attendees for select to authenticated
  using (public.can_access_room(room_id, event_date));
create policy attendees_insert on public.attendees for insert to authenticated
  with check (public.can_access_room(room_id, event_date));
create policy attendees_update on public.attendees for update to authenticated
  using (public.can_access_room(room_id, event_date))
  with check (public.can_access_room(room_id, event_date));
create policy attendees_delete on public.attendees for delete to authenticated
  using ((select public.is_admin()));

-- attendee_log: chỉ admin đọc; ghi qua trigger
create policy log_admin_read on public.attendee_log for select to authenticated
  using ((select public.is_admin()));

-- Quyền bảng cho người đã đăng nhập (RLS ở trên quyết định dòng nào được thấy/sửa)
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.rooms, public.time_slots, public.settings, public.staff,
  public.room_assignments, public.attendees to authenticated;
grant select on public.attendee_log to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Không cấp gì cho người chưa đăng nhập
revoke all on all tables in schema public from anon;
revoke execute on function public.get_me() from anon, public;
grant  execute on function public.get_me() to authenticated;

-- ---------------------------------------------------------------------
-- 5b. CHỈ EMAIL TRONG DANH SÁCH NHÂN SỰ MỚI ĐƯỢC TẠO TÀI KHOẢN
--     Bật trong Dashboard → Authentication → Hooks → "Before User Created"
--     → Postgres → chọn hàm public.hook_before_user_created
-- ---------------------------------------------------------------------
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_email text := lower(coalesce(event -> 'user' ->> 'email', ''));
begin
  if exists (select 1 from public.staff s where s.email = v_email and s.active) then
    return '{}'::jsonb;  -- cho phép
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'Email này chưa được cấp quyền truy cập. Vui lòng liên hệ admin.'));
end;
$$;

revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 6. REALTIME (cập nhật màn hình tức thì; Realtime tự áp dụng RLS)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'attendees') then
    alter publication supabase_realtime add table public.attendees;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 7. DỮ LIỆU MẶC ĐỊNH: 8 phòng, 7 khung giờ
-- ---------------------------------------------------------------------
insert into public.rooms (id, name, sort_order) values
  (1, 'Phòng 1', 1), (2, 'Phòng 2', 2), (3, 'Phòng 3', 3), (4, 'Phòng 4', 4),
  (5, 'Phòng 5', 5), (6, 'Phòng 6', 6), (7, 'Phòng 7', 7), (8, 'Phòng 8', 8)
on conflict (id) do nothing;

insert into public.time_slots (id, start_time, end_time, label) values
  (1, '09:00', '10:00', '09:00 – 10:00'),
  (2, '10:00', '11:00', '10:00 – 11:00'),
  (3, '11:00', '12:00', '11:00 – 12:00'),
  (4, '13:00', '14:00', '13:00 – 14:00'),
  (5, '14:00', '15:00', '14:00 – 15:00'),
  (6, '15:00', '16:00', '15:00 – 16:00'),
  (7, '16:00', '17:00', '16:00 – 17:00')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 8. TẠO ADMIN ĐẦU TIÊN — SỬA EMAIL RỒI BỎ COMMENT DÒNG DƯỚI
-- ---------------------------------------------------------------------
-- insert into public.staff (email, full_name, role) values ('ban@congty.com', 'Tên bạn', 'admin')
--   on conflict (email) do update set role = 'admin', active = true;
