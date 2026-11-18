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
- **Hooks → Before User Created → Add hook → Postgres:** chọn schema `public`, hàm `hook_before_user_created`, rồi bấm Save. **Bước này bắt buộc.** Sau khi bật, chỉ những email có trong tab Nhân sự mới tạo được tài khoản; email lạ nhập vào sẽ bị từ chối ngay, không nhận được link đăng nhập.
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
4. **Danh sách khách → Nhập Excel/CSV**, dùng **file master** (khuyên dùng, đúng bố cục file nội bộ). Mẫu ẩn danh: `docs/mau-master.xlsx`.
   - Hàng tiêu đề `Room 6 (60) | Room 5 (40) | …`: số trong ngoặc là **sức chứa riêng** của phòng.
   - Mỗi khối cột (A–G, I–O, Q–W…) là **1 ngày**. Cột bên trái mỗi khối là giờ.
   - Ô ở hàng giờ là **cuộc họp**, ví dụ `GMD 1 - VY` được hiểu là cuộc họp *GMD 1*, người chủ trì *VY*. Các dòng bên dưới là khách: `Tên - Quỹ` được tách thành tên và công ty, `Quỹ (1 attendee)` cũng đọc được.
   - Khung giờ không có trong Cài đặt (08:00, 08:55, 12:00) sẽ bị bỏ qua.
   - **Ngày:** ghi ở hàng 1 phía trên mỗi khối (vd. `Ngày 1 - 20/11/2026`), hoặc chọn trong màn hình xem trước khi nhập.
   - **Người được vào phòng (tuỳ chọn):** thêm một hàng trước khung giờ đầu tiên, ô cột giờ ghi `Trực phòng (email)`, rồi điền email dưới từng phòng. Người đó sẽ được tạo tài khoản và chỉ thấy phòng của mình trong ngày đó.
   - Phòng không có trong file có thể xoá tự động (chỉ khi chưa có khách).
   - Nhập lại file đã sửa: khách mới được thêm, khách cũ được giữ nguyên, cuộc họp được cập nhật theo file. Trùng nghĩa là cùng ngày, phòng, khung giờ, tên **và** công ty.
   - Tạo lại mẫu: `python3 tools/make_master_sample.py`.

   Hoặc dùng **file mỗi phòng 1 sheet:** tải **file mẫu** `mau-danh-sach.xlsx` (hoặc `du-lieu-mau.xlsx` có sẵn dữ liệu giả để chạy thử).
   - Mỗi phòng một sheet `P1`…`P8`. Ở đầu sheet, điền các ô nền vàng:
     - **Tên phòng**
     - **Người trực (email)**: người được quyền xem phòng đó. Nhiều người thì cách nhau dấu phẩy.
     - **Tên người trực**
     - **Ngày**: để trống thì lấy ngày đang chọn trên trang.
   - Bên dưới là bảng khách: cột Khung giờ đã điền sẵn 10 dòng mỗi khung, bạn chỉ cần điền Họ tên, SĐT, Email, Công ty, Ghi chú. Dòng nào bỏ trống Họ tên sẽ bị bỏ qua.
   - Khi nhập, trang sẽ đổi tên phòng, **tạo tài khoản người trực và phân công đúng phòng**, rồi thêm khách. Nhập lại cùng file không tạo khách trùng.
   - Sự kiện nhiều ngày: copy sheet phòng và đổi ô Ngày.
   - Vẫn nhận CSV dạng bảng phẳng, với các cột `phong`, `khung_gio`, `ho_ten` (bắt buộc) và `ngay`, `sdt`, `email`, `cong_ty`, `ghi_chu`.
   - Muốn tạo lại file mẫu: `python3 tools/make_template.py` (thêm `--sample` để có dữ liệu giả).

### Cập nhật Excel trong lúc diễn ra sự kiện (đồng bộ)
Sửa file master trên máy rồi tải lên lại: **Danh sách khách → Nhập Excel/CSV**. Ô **"Đồng bộ với file"** mặc định được bật với file master.
- Khách mới có trong file thì được **thêm**.
- Khách không còn trong file thì chuyển sang **Đã huỷ**. Không xoá hẳn: vẫn còn trong Nhật ký và bấm **Khôi phục** được.
- Khách đã huỷ mà quay lại file thì được **khôi phục**.
- Cuộc họp được thêm, sửa hoặc xoá theo file.
- **Luôn giữ nguyên** người đã check-in và khách walk-in do người trực thêm, kể cả khi họ không có trong file.
- Chỉ áp dụng cho các phòng và ngày có trong file. Trước khi huỷ hoặc khôi phục ai, trang hiện danh sách để bạn xác nhận.
- Với CSV hoặc file lẻ, ô đồng bộ mặc định **tắt**: trang chỉ thêm khách mới.

Muốn sửa nhanh 1–2 người thì sửa trực tiếp trên web: **Sửa** (đổi phòng, giờ, thông tin), **+ Thêm khách**, **Xoá hẳn**, hoặc **Sửa cuộc họp**. Người trực thấy thay đổi ngay mà không cần tải lại trang.

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
- **Ai vào được?** Chỉ email có trong tab Nhân sự (đang hoạt động). Có 3 lớp bảo vệ:
  1. **Auth Hook** (bước 3): email lạ không tạo được tài khoản, nên không nhận được link đăng nhập.
  2. **Magic link / mã OTP** gửi vào hộp thư: phải mở được hộp thư của email đó mới đăng nhập được, nên không cần mật khẩu.
  3. **RLS trong database:** kể cả người đã có tài khoản, nếu bị xoá hoặc khoá khỏi Nhân sự thì không đọc được dòng dữ liệu nào. Người trực chỉ đọc được phòng mình.
- Trang HTML trên GitHub Pages là công khai: ai có link đều thấy **màn hình đăng nhập** và mã nguồn, nhưng **không thấy dữ liệu**. Danh sách khách chỉ nằm trong Supabase. Nếu muốn ẩn cả màn hình đăng nhập, hãy đặt trang sau Cloudflare Access hoặc dùng Netlify có mật khẩu.
- Bật **Point-in-time / daily backups** nếu dùng gói trả phí, hoặc xuất CSV cuối mỗi ngày.
