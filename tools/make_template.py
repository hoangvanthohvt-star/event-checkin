"""Excel template: one sheet per room (room name, staff email, date, time slots, guest list).

Run:  python3 tools/make_template.py            -> docs/template-per-room.xlsx (empty)
      python3 tools/make_template.py --sample   -> docs/sample-data.xlsx       (fake data to try)
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
        ("Room name", f"Room {n}", "Room name shown on the website."),
        ("Staff email", "", "Email of the person on duty in this room. They sign in with it and see ONLY this room. Several people: separate with commas."),
        ("Staff name", "", "Optional."),
        ("Date (dd/mm/yyyy)", "", "Empty = the date selected on the website when importing. Multi-day event: copy this sheet for each day."),
    ]
    ws["A1"] = f"ROOM {n}"
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

    heads = ["Time slot", "Full name", "Phone", "Email", "Company", "Note"]
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
                    ws.cell(row=r, column=6, value="VIP")
            r += 1

    for col, w in zip("ABCDEF", [20, 28, 15, 26, 22, 24]):
        ws.column_dimensions[col].width = w
    ws.row_dimensions[HEADER_ROW].height = 22
    ws.freeze_panes = ws.cell(row=HEADER_ROW + 1, column=1)


def guide_sheet(wb):
    ws = wb.active
    ws.title = "Instructions"
    rows = [
        ("HOW TO FILL IN THIS WORKBOOK", None),
        ("", None),
        ("1. Each sheet P1…P8 is one meeting room.", None),
        ("2. Fill in only the YELLOW cells at the top of each sheet:", None),
        ("     • Room name — shown on the website", None),
        ("     • Staff email — who may see this room (several: separate with commas)", None),
        ("     • Staff name — optional", None),
        ("     • Date — empty = the date selected on the website when importing", None),
        ("3. Guest list: fill in Full name (required), Phone, Email, Company, Note under the right time slot.", None),
        ("   The Time slot column has 10 rows per slot — rows without a name are ignored.", None),
        ("4. Multi-day event: copy a room sheet (right-click → Move or Copy) and change the Date cell.", None),
        ("5. On the website: Admin → Guest list → Import Excel/CSV → choose file → preview → Import.", None),
        ("   Importing the same file again does not create duplicates.", None),
        ("", None),
        ("EXAMPLE (for reference only — this sheet is not imported):", None),
    ]
    for i, (t, _) in enumerate(rows, start=1):
        ws.cell(row=i, column=1, value=t).font = Font(name=F, bold=(i in (1, 15)), size=14 if i == 1 else 10,
                                                    color="1F4E79" if i == 1 else "000000")
    ex = [("Room name", "VIP Room 1"), ("Staff email", "lan.nguyen@company.com"), ("Staff name", "Lan Nguyen"),
          ("Date (dd/mm/yyyy)", "20/11/2026")]
    for j, (a, b) in enumerate(ex, start=16):
        ws.cell(row=j, column=1, value=a).font = Font(name=F, bold=True)
        c = ws.cell(row=j, column=2, value=b)
        c.font = Font(name=F, color="0000FF")
        c.fill = YELLOW
    for c, t in enumerate(["Time slot", "Full name", "Phone", "Email", "Company", "Note"], start=1):
        cell = ws.cell(row=21, column=c, value=t)
        cell.font = Font(name=F, bold=True, color="FFFFFF")
        cell.fill = HEAD
    for c, v in enumerate(["09:00", "Binh Tran", "0901234567", "binh.tran@example.com", "Example Fund", "VIP"], start=1):
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
    out = "docs/sample-data.xlsx" if sample else "docs/template-per-room.xlsx"
    wb.save(out)
    print(out)


if __name__ == "__main__":
    main()
