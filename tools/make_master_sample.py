"""Tạo docs/mau-master.xlsx: mẫu ẩn danh theo đúng bố cục file master (3 ngày × 6 phòng, khung giờ theo hàng).

Bố cục:
  Hàng 1 : ngày của từng khối (ô gộp phía trên mỗi khối)
  Hàng 2 : "Room 6 (60)" … "Room 1 (10)"  — số trong ngoặc là sức chứa
  Hàng 4 : "Trực phòng (email)" — email người được xem phòng đó (tuỳ chọn)
  Hàng giờ: cột giờ = 09:00…16:00, ô mỗi phòng = tên cuộc họp "MÃ n - NGƯỜI CHỦ TRÌ"
  Các dòng dưới: khách "Tên - Quỹ"
Chạy: python3 tools/make_master_sample.py
"""
import datetime
import random
from openpyxl import Workbook
from openpyxl.utils import get_column_letter
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

F = "Arial"
rnd = random.Random(12)
ROOMS = [(6, 60), (5, 40), (4, 50), (3, 30), (2, 20), (1, 10)]
SLOTS = [datetime.time(h) for h in (9, 10, 11, 13, 14, 15, 16)]
DAYS = ["20/11/2026", "21/11/2026", "22/11/2026"]
TICKERS = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH", "KKK", "MMM", "NNN", "PPP"]
HOSTS = ["AN", "BINH", "CHAU", "DUNG", "GIANG", "HANH", "KHOA", "LINH"]
FIRST = ["Alex", "Ben", "Chloe", "David", "Emma", "Frank", "Grace", "Henry", "Ivy", "Jack", "Kate", "Leo", "Mia", "Noah", "Olivia", "Minh", "Lan", "Huy"]
FUNDS = ["Alpha Capital", "Beta Partners", "Gamma Fund", "Delta AM", "Epsilon", "Zeta Invest", "Theta Asset", "Kappa Holdings", "Lambda Fund", "Sigma AM"]

PINK = PatternFill("solid", fgColor="FFCCEC")
YELLOW = PatternFill("solid", fgColor="FFF2CC")
BLUE = PatternFill("solid", fgColor="DDEBF7")
thin = Side(style="thin", color="BFBFBF")
BOX = Border(left=thin, right=thin, top=thin, bottom=thin)

wb = Workbook()
ws = wb.active
ws.title = "Sheet1"
row = 6
time_rows = {}
# Bố cục hàng: mỗi khung giờ chiếm (số khách tối đa + 2) dòng — giống file gốc
heights = {}
plan = {}
for d in range(3):
    for t in SLOTS:
        for ri, (room, cap) in enumerate(ROOMS):
            if rnd.random() < 0.25:
                continue
            n = rnd.randint(2, min(cap, 18))
            guests = [f"{rnd.choice(FIRST)} {chr(65 + rnd.randint(0, 25))}. - {rnd.choice(FUNDS)}" for _ in range(n)]
            if rnd.random() < 0.2:
                guests[-1] = f"{rnd.choice(FUNDS)} (1 attendee)"
            plan[(d, t, ri)] = (f"{rnd.choice(TICKERS)} {d + 1} - {rnd.choice(HOSTS)}", guests)
            heights[t] = max(heights.get(t, 0), n)

r = 8
for t in SLOTS:
    time_rows[t] = r
    r += heights.get(t, 0) + 2
    if t == datetime.time(11):
        time_rows["lunch"] = r
        r += 2

for d in range(3):
    tcol = 1 + d * 8  # A, I, Q
    first = tcol + 1
    ws.merge_cells(start_row=1, start_column=first, end_row=1, end_column=first + 5)
    c = ws.cell(row=1, column=first, value=f"Ngày {d + 1} - {DAYS[d]}")
    c.font = Font(name=F, bold=True, size=12)
    c.alignment = Alignment(horizontal="center")
    lab = ws.cell(row=4, column=tcol, value="Trực phòng (email)")
    lab.font = Font(name=F, bold=True, size=9)
    lab.alignment = Alignment(wrap_text=True)
    for ri, (room, cap) in enumerate(ROOMS):
        col = first + ri
        h = ws.cell(row=2, column=col, value=f"Room {room} ({cap})")
        h.font = Font(name=F, bold=True)
        h.fill = PINK
        h.alignment = Alignment(horizontal="center")
        e = ws.cell(row=4, column=col, value=f"truc.room{room}@vidu.com" if d == 0 else "")
        e.fill = YELLOW
        e.font = Font(name=F, color="0000FF", size=9)
        e.border = BOX
        ws.column_dimensions[get_column_letter(col)].width = 26
    ws.column_dimensions[get_column_letter(tcol)].width = 11
    for t in SLOTS:
        tr = time_rows[t]
        tc = ws.cell(row=tr, column=tcol, value=t)
        tc.number_format = "hh:mm"
        tc.font = Font(name=F, bold=True)
        for ri in range(6):
            if (d, t, ri) not in plan:
                continue
            title, guests = plan[(d, t, ri)]
            mc = ws.cell(row=tr, column=first + ri, value=title)
            mc.font = Font(name=F, bold=True)
            mc.fill = BLUE
            for k, g in enumerate(guests, start=1):
                ws.cell(row=tr + k, column=first + ri, value=g).font = Font(name=F, size=10)
    lc = ws.cell(row=time_rows["lunch"], column=tcol, value=datetime.time(12))
    lc.number_format = "hh:mm"
    lc.font = Font(name=F, bold=True, color="808080")
    ws.cell(row=time_rows["lunch"], column=first, value="").font = Font(name=F)

note = ws.cell(row=6, column=1, value="Ô vàng hàng 4: email người trực từng phòng (để trống được — phân công sau ở tab Nhân sự). Hàng 1: ngày của khối.")
note.font = Font(name=F, italic=True, size=9, color="808080")
ws.freeze_panes = "B3"
wb.save("docs/mau-master.xlsx")
print("docs/mau-master.xlsx", sum(len(g) for _, g in plan.values()), "khách,", len(plan), "cuộc họp")
