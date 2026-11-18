# Event Check-in: 8 phòng × 7 khung giờ

Web app quản lý và check-in khách cho sự kiện nhiều phòng họp.

- **Admin (bạn):** xem toàn bộ, chuyển khách giữa phòng/khung giờ, nhập/xuất CSV, quản lý người trực, xem nhật ký thay đổi.
- **Người trực phòng:** chỉ thấy khách của phòng mình (theo ngày được phân công), check-in, thêm khách walk-in, huỷ hoặc khôi phục khách.

Quyền được kiểm tra **trong database** bằng Row Level Security của Postgres, không phải ở giao diện. Dù có mở DevTools, người trực cũng không đọc được dữ liệu phòng khác.

```
event-checkin/
├── supabase/schema.sql   # bảng, RLS, trigger, dữ liệu mặc định
└── docs/                 # trang tĩnh, không cần build
    ├── index.html
    ├── app.js
    ├── style.css
    └── config.js         # điền URL + anon key
```

## Cài đặt (khoảng 15 phút)

### 1. Tạo project Supabase
1. Vào https://supabase.com, tạo project mới (gói Free là đủ cho khoảng 560 khách/ngày).
2. Chọn region gần Việt Nam (Singapore).

### 2. Tạo database
1. Dashboard → **SQL Editor** → New query.
2. Mở `supabase/schema.sql`, kéo xuống **mục 8**, bỏ comment và **sửa email thành email của bạn**:
   ```sql
   insert into public.staff (email, full_name, role) values ('ban@congty.com', 'Tên bạn', 'admin')
     on conflict (email) do update set role = 'admin', active = true;
   ```
3. Dán toàn bộ file vào SQL Editor rồi bấm **Run**. File chạy lại nhiều lần cũng không sao.

### 3. Cấu hình đăng nhập
Dashboard → **Authentication**:
- **URL Configuration → Site URL**: điền địa chỉ trang web sau khi deploy (bước 5). Thêm địa chỉ đó vào **Redirect URLs**.
- **Email Templates → Magic Link**: nên thêm mã 6 số vào email, để người trực mở email trên máy tính vẫn nhập mã được trên điện thoại:
  ```html
  <h2>Đăng nhập</h2>
  <p><a href="{{ .ConfirmationURL }}">Bấm vào đây để đăng nhập</a></p>
  <p>Hoặc nhập mã: <strong>{{ .Token }}</strong></p>
  ```
- **Gửi email:** server email mặc định của Supabase chỉ gửi được **vài email mỗi giờ**. Trước ngày sự kiện, hãy cấu hình **SMTP riêng** (Authentication → Emails → SMTP Settings), ví dụ Resend, Brevo hoặc Gmail Workspace. Nếu không, 9 người đăng nhập cùng lúc sẽ bị nghẽn.

### 4. Điền config
Dashboard → **Project Settings → API**. Copy *Project URL* và *anon public key* (hoặc *publishable key*) vào `docs/config.js`.
Không bao giờ dùng `service_role` / secret key ở đây.

### 5. Deploy trang web (chọn 1 cách)
- **Netlify Drop:** vào https://app.netlify.com/drop rồi kéo thả thư mục `docs/`. Xong.
- **Vercel / Cloudflare Pages / GitHub Pages:** deploy thư mục `docs/` dạng static site, không cần build command.
- Chạy thử trên máy: `cd docs && python3 -m http.server 8000`, rồi mở http://localhost:8000 và thêm `http://localhost:8000` vào Redirect URLs.

### 6. Bật Realtime (để màn hình tự cập nhật)
`schema.sql` đã thêm bảng `attendees` vào publication `supabase_realtime`. Kiểm tra lại ở Dashboard → **Database → Publications**: `supabase_realtime` phải có `attendees`.

## Sử dụng

### Lần đầu (admin)
1. Đăng nhập bằng email admin.
2. **Cài đặt:** đặt tên sự kiện, sức chứa (mặc định 10), **thêm các ngày diễn ra sự kiện**, đổi tên phòng và chỉnh khung giờ nếu cần.
3. **Nhân sự:** thêm email 8 người trực và phân công phòng, "mọi ngày" hoặc từng ngày cụ thể. Phòng nào chưa có người trực sẽ hiện cảnh báo vàng.
4. **Danh sách khách → Nhập CSV:** bấm "Tải file mẫu" để lấy định dạng.
   - Cột bắt buộc: `phong` (1–8 hoặc tên phòng), `khung_gio` (09:00 / 9h), `ho_ten`.
   - Cột tuỳ chọn: `ngay` (yyyy-mm-dd hoặc dd/mm/yyyy, để trống thì lấy ngày đang xem), `sdt`, `email`, `cong_ty`, `ghi_chu`.
   - Excel lưu dạng *CSV UTF-8* là được. Dấu phân cách `,` hay `;` đều đọc được.

### Trong ngày sự kiện
- **Người trực** mở link trên điện thoại. App tự chọn khung giờ hiện tại; họ bấm **Check-in** khi khách đến, hoặc **+ Thêm khách** cho walk-in. Khi khung giờ đã đủ sức chứa, nút thêm bị khoá và database cũng từ chối, kể cả khi 2 người cùng bấm một lúc.
- **Admin** xem lưới tổng quan 8×7 cập nhật realtime, bấm vào ô để xem danh sách. Bấm **Sửa** để chuyển khách sang phòng/khung giờ khác. Admin được phép vượt sức chứa (ô sẽ hiện màu đỏ).
- **Nhật ký:** ghi lại mọi lần thêm/sửa/xoá, ai làm, lúc nào, đổi từ gì sang gì.
- **Xuất CSV:** xuất danh sách đang lọc, mở được bằng Excel và có trạng thái check-in.

## Bảng phân quyền

| Thao tác | Admin | Người trực |
|---|---|---|
| Xem khách | Tất cả | Chỉ phòng + ngày được phân công |
| Check-in / đổi trạng thái / sửa thông tin | ✓ | ✓ (phòng mình) |
| Thêm khách | ✓ (được vượt sức chứa) | ✓ (phòng mình, trong sức chứa) |
| Chuyển phòng / khung giờ / ngày | ✓ | ✗ |
| Xoá hẳn khách | ✓ | ✗ (chỉ đổi sang "Đã huỷ") |
| Nhân sự, cài đặt, nhật ký | ✓ | ✗ |
| Người không có trong danh sách nhân sự | Không thấy gì | |

Toàn bộ các luật trên nằm trong `schema.sql` (policies + trigger `attendees_before_write`).

## Lưu ý bảo mật
- Khi một người trực nghỉ, hãy bấm **Khoá** để họ mất quyền ngay lập tức, kể cả khi họ còn đăng nhập.
- Bất kỳ ai cũng có thể *đăng ký* tài khoản bằng magic link, nhưng nếu email không có trong bảng nhân sự thì họ không thấy dữ liệu gì. Muốn chặn hẳn: Authentication → Sign In / Providers → tắt *Allow new users to sign up*, rồi tạo user cho người trực ở Authentication → Users → *Invite user*.
- Bật **Point-in-time / daily backups** nếu dùng gói trả phí, hoặc xuất CSV cuối mỗi ngày.
