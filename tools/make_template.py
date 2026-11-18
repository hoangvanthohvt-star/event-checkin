"""Tạo file Excel mẫu: mỗi phòng 1 sheet (tên phòng, người trực, ngày, khung giờ, danh sách khách).

Chạy:  python3 tools/make_template.py            -> mau-danh-sach.xlsx (trống)
       python3 tools/make_template.py --sample   -> du-lieu-mau.xlsx  (có dữ liệu giả để chạy thử)
"""
import random
import sys
from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

ROOMS = 8
SLOTS = ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"]
PER_SLOT = 10
HEADER_ROW = 7

F = "Arial"
YELLOW = PatternFill("solid", fgColor="FFF2CC")
HEAD = PatternFill("solid", fgColor="1F4E79")
BAND = PatternFill("solid", fgColor="F2F5F9")
thin = Side(style="thin", color="C9D1DC")
BOX = Border(left=thin, right=thin, top=thin, bottom=thin)


def room_sheet(wb, n, sample, rnd):
    ws = wb.create_sheet(f"P{n}")
    labels = [
        ("Tên phòng", f"Phòng {n}", "Tên hiển thị của phòng trên trang web."),
        ("Người trực (email)", "", "Email người trực phòng này. Họ đăng nhập bằng email này và CHỈ thấy khách của phòng này. Nhiều người: cách nhau bằng dấu phẩy."),
        ("Tên người trực", "", "Không bắt buộc."),
        ("Ngày (dd/mm/yyyy)", "", "Để trống = ngày đang chọn trên trang khi nhập. Nếu sự kiện nhiều ngày: copy sheet này cho từng ngày."),
    ]
    ws["A1"] = f"PHÒNG {n}"
    ws["A1"].font = Font(name=F, size=14, bold=True, color="1F4E79")
    for i, (label, value, note) in enumerate(labels, start=2):
        a, b = ws.cell(row=i, column=1, value=label), ws.cell(row=i, column=2, value=value)
        a.font = Font(name=F, bold=True)
        b.font = Font(name=F, color="0000FF")
        b.fill = YELLOW
        b.border = BOX
        b.comment = Comment(note, "Event Check-in")
        ws.merge_cells(start_row=i, start_column=2, end_row=i, end_column=4)
    if sample:
        ws["B3"] = f"truc.p{n}@vidu.com"
        ws["B4"] = ["Lan", "Minh", "Hùng", "Hà", "Tuấn", "Mai", "Long", "Thảo"][n - 1]

    heads = ["Khung giờ", "Họ tên", "SĐT", "Email", "Công ty", "Ghi chú"]
    for c, t in enumerate(heads, start=1):
        cell = ws.cell(row=HEADER_ROW, column=c, value=t)
        cell.font = Font(name=F, bold=True, color="FFFFFF")
        cell.fill = HEAD
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = BOX

    r = HEADER_ROW + 1
    for si, slot in enumerate(SLOTS):
        for k in range(PER_SLOT):
            ws.cell(row=r, column=1, value=slot).number_format = "@"  # lưu dạng chữ, tránh Excel đổi thành số
            for c in range(1, 7):
                cell = ws.cell(row=r, column=c)
                cell.border = BOX
                cell.font = Font(name=F, bold=(c == 1))
                if si % 2:
                    cell.fill = BAND
            ws.cell(row=r, column=1).alignment = Alignment(horizontal="center")
            ws.cell(row=r, column=3).number_format = "@"  # giữ số 0 đầu SĐT
            if sample and k < rnd.randint(6, 10):
                ho = rnd.choice(["Nguyễn", "Trần", "Lê", "Phạm", "Hoàng", "Vũ", "Đặng", "Bùi", "Đỗ", "Hồ"])
                dem = rnd.choice(["Văn", "Thị", "Minh", "Quốc", "Thanh", "Ngọc", "Hải", "Gia"])
                ten = rnd.choice(["An", "Bình", "Châu", "Dũng", "Giang", "Hạnh", "Khoa", "Linh", "Nam", "Phúc", "Quân", "Trang"])
                ws.cell(row=r, column=2, value=f"{ho} {dem} {ten}")
                ws.cell(row=r, column=3, value="09" + "".join(rnd.choice("0123456789") for _ in range(8)))
                ws.cell(row=r, column=5, value=rnd.choice(["AGCO", "Vietcap", "Công ty Alpha", "Công ty Beta", "Gamma Corp"]))
                if rnd.random() < 0.08:
                    ws.cell(row=r, column=6, value="Khách VIP")
            r += 1

    for col, w in zip("ABCDEF", [20, 28, 15, 26, 22, 24]):
        ws.column_dimensions[col].width = w
    ws.row_dimensions[HEADER_ROW].height = 22
    ws.freeze_panes = ws.cell(row=HEADER_ROW + 1, column=1)


def guide_sheet(wb):
    ws = wb.active
    ws.title = "Hướng dẫn"
    rows = [
        ("HƯỚNG DẪN ĐIỀN DANH SÁCH", None),
        ("", None),
        ("1. Mỗi sheet P1…P8 là một phòng họp.", None),
        ("2. Chỉ điền vào các ô NỀN VÀNG ở đầu sheet:", None),
        ("     • Tên phòng — tên hiển thị trên trang web", None),
        ("     • Người trực (email) — email người được quyền xem phòng này (nhiều người: cách nhau dấu phẩy)", None),
        ("     • Tên người trực — không bắt buộc", None),
        ("     • Ngày — để trống thì lấy ngày đang chọn trên trang lúc nhập", None),
        ("3. Danh sách khách: điền Họ tên (bắt buộc), SĐT, Email, Công ty, Ghi chú vào đúng khung giờ.", None),
        ("   Cột Khung giờ đã điền sẵn 10 dòng mỗi khung — dòng nào để trống Họ tên sẽ được bỏ qua.", None),
        ("4. Sự kiện nhiều ngày: copy sheet phòng (chuột phải → Move or Copy) và đổi ô Ngày.", None),
        ("5. Trên trang web: Admin → Danh sách khách → Nhập Excel/CSV → chọn file → xem trước → Nhập.", None),
        ("   Nhập lại cùng file không tạo trùng khách (trùng = cùng ngày, phòng, khung giờ, họ tên).", None),
        ("", None),
        ("VÍ DỤ ĐIỀN (chỉ để tham khảo — sheet này không được nhập):", None),
    ]
    for i, (t, _) in enumerate(rows, start=1):
        ws.cell(row=i, column=1, value=t).font = Font(name=F, bold=(i in (1, 15)), size=14 if i == 1 else 10,
                                                    color="1F4E79" if i == 1 else "000000")
    ex = [("Tên phòng", "Phòng VIP 1"), ("Người trực (email)", "lan.nguyen@congty.com"), ("Tên người trực", "Nguyễn Thị Lan"),
          ("Ngày (dd/mm/yyyy)", "20/11/2026")]
    for j, (a, b) in enumerate(ex, start=16):
        ws.cell(row=j, column=1, value=a).font = Font(name=F, bold=True)
        c = ws.cell(row=j, column=2, value=b)
        c.font = Font(name=F, color="0000FF")
        c.fill = YELLOW
    for c, t in enumerate(["Khung giờ", "Họ tên", "SĐT", "Email", "Công ty", "Ghi chú"], start=1):
        cell = ws.cell(row=21, column=c, value=t)
        cell.font = Font(name=F, bold=True, color="FFFFFF")
        cell.fill = HEAD
    for c, v in enumerate(["09:00", "Trần Văn Bình", "0901234567", "binh.tran@agco.com", "AGCO", "Khách VIP"], start=1):
        ws.cell(row=22, column=c, value=v).font = Font(name=F)
        ws.cell(row=22, column=c).number_format = "@"
    ws.column_dimensions["A"].width = 22
    ws.column_dimensions["B"].width = 26
    for col in "CDEF":
        ws.column_dimensions[col].width = 20


def main():
    sample = "--sample" in sys.argv
    rnd = random.Random(7)
    wb = Workbook()
    guide_sheet(wb)
    for n in range(1, ROOMS + 1):
        room_sheet(wb, n, sample, rnd)
    out = "du-lieu-mau.xlsx" if sample else "mau-danh-sach.xlsx"
    wb.save(out)
    print(out)


if __name__ == "__main__":
    main()
