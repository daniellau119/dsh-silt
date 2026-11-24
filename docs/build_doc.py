# -*- coding: utf-8 -*-
"""生成 dsh-silt 技術文檔（Word）。

用法：
    python build_doc.py [輸出名]

    例：python build_doc.py dsh-silt-tech-v2.docx
    不給參數時輸出 dsh-silt-技術文檔.docx

需要 python-docx。DSH 自帶的 Python 已裝好：
    C:\\Users\\<你>\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe

⚠️ 這份腳本是技術文檔的唯一來源。改文檔要改這裡再重新生成，不要直接編輯 .docx ——
   手改的內容下次生成就沒了。
"""
import json, sys
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

OUT = sys.argv[1] if len(sys.argv) > 1 else 'dsh-silt-技術文檔.docx'

doc = Document()

# ── 版面 ──
sec = doc.sections[0]
sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
sec.left_margin = sec.right_margin = Cm(2.2)
sec.top_margin = sec.bottom_margin = Cm(2.0)

# ── 字型（中英文都要明確指定 eastAsia，否則中文會用 fallback）──
def set_font(style, name_latin, name_ea, size=None, bold=None, color=None):
    f = style.font
    f.name = name_latin
    if size: f.size = Pt(size)
    if bold is not None: f.bold = bold
    if color: f.color.rgb = color
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.find(qn('w:rFonts'))
    if rfonts is None:
        rfonts = OxmlElement('w:rFonts'); rpr.append(rfonts)
    rfonts.set(qn('w:ascii'), name_latin)
    rfonts.set(qn('w:hAnsi'), name_latin)
    rfonts.set(qn('w:eastAsia'), name_ea)

BODY_EA = '微軟正黑體'
MONO = 'Consolas'

set_font(doc.styles['Normal'], 'Microsoft JhengHei', BODY_EA, 10.5)
doc.styles['Normal'].paragraph_format.space_after = Pt(6)
doc.styles['Normal'].paragraph_format.line_spacing = 1.35

for lvl, sz in ((1, 16), (2, 13), (3, 11.5)):
    st = doc.styles[f'Heading {lvl}']
    set_font(st, 'Microsoft JhengHei', BODY_EA, sz, bold=True, color=RGBColor(0x1a, 0x1a, 0x1a))
    st.paragraph_format.space_before = Pt(16 if lvl == 1 else 12)
    st.paragraph_format.space_after = Pt(6)

def P(text='', style=None, bold=False, size=None, italic=False, align=None, space_after=None):
    p = doc.add_paragraph(style=style)
    r = p.add_run(text)
    r.bold = bold; r.italic = italic
    if size: r.font.size = Pt(size)
    if align is not None: p.alignment = align
    if space_after is not None: p.paragraph_format.space_after = Pt(space_after)
    return p

def code(text, size=8.5):
    """等寬代碼塊：單個段落 + 底紋，避免每行一個段落的間距。"""
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(3); pf.space_after = Pt(8); pf.line_spacing = 1.15
    pf.left_indent = Cm(0.4); pf.right_indent = Cm(0.2)
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear'); shd.set(qn('w:fill'), 'F2F2F2')
    p._p.get_or_add_pPr().append(shd)
    lines = text.strip('\n').split('\n')
    for i, ln in enumerate(lines):
        r = p.add_run(ln)
        r.font.name = MONO
        r.font.size = Pt(size)
        rpr = r._element.get_or_add_rPr()
        rfonts = rpr.find(qn('w:rFonts'))
        if rfonts is None:
            rfonts = OxmlElement('w:rFonts')
            rpr.insert(0, rfonts)
        rfonts.set(qn('w:ascii'), MONO)
        rfonts.set(qn('w:hAnsi'), MONO)
        rfonts.set(qn('w:eastAsia'), BODY_EA)
        if i < len(lines) - 1:
            r.add_break()
    return p

def bullets(items, style='List Bullet'):
    for it in items:
        doc.add_paragraph(it, style=style)

def table(headers, rows, widths=None):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = 'Table Grid'
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    hdr = t.rows[0].cells
    for i, h in enumerate(headers):
        hdr[i].text = ''
        r = hdr[i].paragraphs[0].add_run(h)
        r.bold = True; r.font.size = Pt(9.5)
        shd = OxmlElement('w:shd')
        shd.set(qn('w:val'), 'clear'); shd.set(qn('w:fill'), 'E8E8E8')
        hdr[i]._tc.get_or_add_tcPr().append(shd)
    for row in rows:
        cells = t.add_row().cells
        for i, v in enumerate(row):
            cells[i].text = ''
            r = cells[i].paragraphs[0].add_run(str(v))
            r.font.size = Pt(9.5)
    if widths:
        for row in t.rows:
            for i, w in enumerate(widths):
                row.cells[i].width = Cm(w)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t

# ═══════════════════════════════ 封面 ═══════════════════════════════
P('dsh-silt', bold=True, size=26, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=2)
P('跨會話記憶與人格插件', bold=True, size=15, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=18)
P('技術文檔', size=12, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=30)
P('版本 v1.9.0 · 2026-11-25', size=10, align=WD_ALIGN_PARAGRAPH.CENTER)
P('基於 silt 插件目前的實際程式碼', size=9, italic=True, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=40)

P('本文檔描述插件目前真實的運作方式：資料怎麼存、記憶怎麼分層、什麼時候被壓縮、'
  '模型能動什麼不能動什麼、系統提示注入什麼、值守任務怎麼排。'
  '所有數字與規則都取自程式碼，不是設計意圖的轉述。', size=10)

doc.add_page_break()

# ═══════════════════════════════ 目錄 ═══════════════════════════════
doc.add_heading('目錄', level=1)
toc = [
    '1　概觀',
    '2　檔案結構',
    '3　帳本：唯一真相來源',
    '4　記憶的層級結構',
    '5　寫入路徑與硬性門檻',
    '6　壓縮機制（T3 → T2）',
    '7　衰減、召回與 salience',
    '8　暫存區升級（T4 → T3）',
    '9　作廢（void）：改狀態，不改內容',
    '10　人格卡與性格底座',
    '11　六維了解程度',
    '12　系統提示注入',
    '13　值守任務與反思任務書',
    '14　工具清單',
    '15　可調參數總表',
    '16　常數速查',
    '17　心跳與主動開口',
    '18　T1 擴成「事實與規則」，T3 禁收專案細節',
]
for t in toc:
    P(t, size=10.5, space_after=2)
doc.add_page_break()

# ═══════════════════════════════ 1 概觀 ═══════════════════════════════
doc.add_heading('1　概觀', level=1)

P('dsh-silt 給模型一份跨會話的記憶與一個會生長的性格。它的設計取捨可以歸結成四句話：')

bullets([
    '唯一真相是帳本。所有狀態（記憶、性格、底座、六維、設定）都是帳本重放出來的投影，沒有第二份可被隨手改寫的狀態檔。',
    '模型能加，不能改。刪除、回滾、匯入是本人的權限，模型層根本沒有這些工具。寫錯了就再寫一條對的。',
    '怎麼記由插件決定，記什麼由模型決定。分層、字數上限、衰減公式、壓縮節奏全部寫死在程式碼裡；模型的自由度只在內容、層級、維度、重要性。',
    '壓縮是前快後慢的。越壓越輕，不是等速。',
])

P('插件跑在 DSH 宿主進程裡，透過 ctx.tools.register 註冊九隻 silt_* 工具，透過 ctx.get(\'schedule\') 排一次性值守任務，'
  '並在登記的系統提示區塊注入記憶列表。前端是一個獨立的 client.js，走 /plugins/dsh-silt/* 的 HTTP 路由。')

doc.add_heading('1.1　資料存放位置', level=2)
code('C:\\Users\\<user>\\.dsh\\silt\\\n'
     '  ledger.jsonl         ← 唯一真相（append-only，雜湊鏈）\n'
     '  config.json          ← 可調設定的鏡像（重放時以此為 seed）\n'
     '  runtime.json         ← 召回計數、上次反思時間、值守狀態\n'
     '  ledger.export.jsonl  ← 匯出檔')

P('config.json 與 runtime.json 都不是真相：前者只是下次載入時的 seed，後者的召回計數掉了不影響雜湊鏈。'
  '唯一說「發生過什麼」的是 ledger.jsonl。', size=9.5, italic=True)

# ═══════════════════════════════ 2 檔案結構 ═══════════════════════════════
doc.add_heading('2　檔案結構', level=1)
table(
    ['檔案', '行數', '職責'],
    [
        ['index.js', '～', '插件入口：註冊工具、注入系統提示區塊、起心跳'],
        ['lib/model.js', '595', '分層常數、六維定義、衰減公式、規範化、注入文本渲染'],
        ['lib/store.js', '1309', '帳本讀寫、投影重放、快照回滾、所有寫入路徑'],
        ['lib/tools.js', '493', '九隻 silt_* 工具的 schema 與轉接'],
        ['lib/duty.js', '408', '谷時判斷、值守排程、反思任務書、壓縮清單計算'],
        ['lib/routes.js', '～305', 'HTTP 路由，供前端讀寫'],
        ['client.js', '2196', '前端頁面（心相頁）'],
    ],
    widths=[3.4, 1.6, 11.5],
)

# ═══════════════════════════════ 3 帳本 ═══════════════════════════════
doc.add_heading('3　帳本：唯一真相來源', level=1)

doc.add_heading('3.1　記錄格式', level=2)
code('{ v, seq, ts, kind, actor, payload, prev, hash }\n\n'
     'hash = sha256( stableStringify({v, seq, ts, kind, actor, payload, prev}) )\n'
     'prev = 上一筆的 hash（創世記 prev = 64 個 0）')

P('stableStringify 對物件鍵排序後序列化，所以同樣內容永遠得到同樣的 hash；寫入時 appendFileSync 一行 JSON，'
  '重放時逐筆驗 hash 與 prev。任何一筆被抽掉或改動，鏈都在那一點斷。')

doc.add_heading('3.2　記錄類型', level=2)
table(
    ['kind', '誰寫', '說明'],
    [
        ['genesis', 'plugin', '帳本誕生 / 重置'],
        ['memory.write', 'model', '新記憶（T1 / T3 / T4）'],
        ['memory.condense', 'model', '壓縮一條 T3（原條 archived，新版是獨立一條）'],
        ['memory.compress', 'plugin', '產生 T2 的唯一通道'],
        ['memory.upgrade', 'plugin', 'T4 被提起 N 次後升成 T3'],
        ['persona.revise', 'model', '修訂性格卡'],
        ['persona.foundation', 'user', '改性格底座'],
        ['self.revise', 'model', '寫自我認知'],
        ['understanding.revise', 'model', '六維打分'],
        ['inject.profile', 'model', '調注入量'],
        ['rhythm.profile', 'model', '調節律'],
        ['rollback', 'user', '回滾某個快照'],
        ['chain.repair', 'user', '封存斷鏈'],
    ],
    widths=[4.2, 2.2, 10.1],
)

P('注意 memory.revise 與 memory.forget 雖然在 apply() 裡還留著分支，但已經沒有任何路徑會寫出它們；'
  '這是為了重放舊帳不報錯而保留的相容處理。', size=9.5, italic=True)

doc.add_heading('3.3　快照與回滾', level=2)
P('寫入類記錄幾乎都帶一個 snapshot：{ id, scope, label, before, after, at }。scope 有：')
code('memory · foundation · self · persona · understanding · compress · condense · store')
P('回滾只對本人開放。工具層看不到任何 snapshotId —— 那是刻意拿掉的，避免模型察覺「可以有另一條路」。')

# ═══════════════════════════════ 4 記憶分層 ═══════════════════════════════
doc.add_heading('4　記憶的層級結構', level=1)

table(
    ['層級', '名稱', '字數上限', '半衰期', '進倉庫', '進注入', '能改'],
    [
        ['T1', '事實與規則', '200', '36500 天', '✅', '✅', '寫入即定'],
        ['T2', '壓縮大概', '200', '720 天', '✅', '✅', '不再壓（終態）'],
        ['T3', '經歷', '1000', '180 天', '✅', '✅', '每 7 天壓一次'],
        ['T4', '暫存區', '300', '7 天（TTL 30）', '❌', '❌', '置信度加夠 1 升 T3'],
        ['T5', '預測', '400', '—（有到期日）', '✅', '✅（過期也留）', '只有 void 才離開'],
    ],
    widths=[1.2, 2.4, 1.8, 2.4, 1.4, 2.4, 3.0],
)

P('字數上限是「標題 + 正文」。T4 不進倉庫的意思是 activeMemories() 明確跳過它，'
  '所以它不佔注入額度、不會出現在提示詞裡，只有 silt_recall 主動去找才看得到。')

P('T5 跟 T4 剛好相反：它在倉庫裡、進提示詞，而且**過期了仍然留著**（標「⏰已過期」）。'
  '到期不是終點，被 silt_void 掉才是 —— 否則一句過期的預測會悄悄爛在倉庫裡，永遠沒人處理。')

doc.add_heading('4.1　firstSeen 的精度', level=2)
P('每條記憶有一個 firstSeen，是「首次寫入的時間」，精度按層級分：')
bullets([
    'T1 / T2 / T3 / T5 → 到日（2026-11-13）。這四層記的是「哪一天知道的」，時分秒是雜訊。',
    'T4 → 到小時（2026-11-13T02:00）。它是剛發生的事，先後順序有意義。',
])
P('真正的出生時刻另存在 bornAt（衰減要用）。firstSeen 會出現在注入列表與 recall 輸出裡，讓模型知道「這是什麼時候的」。')

# ═══════════════════════════════ 5 寫入路徑 ═══════════════════════════════
doc.add_heading('5　寫入路徑與硬性門檻', level=1)

doc.add_heading('5.1　三條寫入路徑', level=2)
code('writeMemory()  → 新增一條（T1 / T3 / T4 / T5）\n'
     'condense()     → 把一條 T3 換成更短的版本（原條 archived）\n'
     'compress()     → 產生 T2（境內唯一通道，工具層無法觸及）')

P('模型只能走 silt_remember（→ writeMemory）和 silt_condense（→ condense）。'
  'compress() 雖然是 public 方法，但沒有任何工具會呼叫它 —— condense() 內部在結果 ≤ 200 字時轉呼叫它。')

P('此外還有一條「不改內容、只改狀態」的路徑：voidMemory()（→ silt_void），見第 9 章。')

doc.add_heading('5.2　normalizeMemory 的檢查', level=2)
P('依序檢查，任何一項不過就整條拒絕並回傳明確理由：')
table(
    ['檢查', '規則'],
    [
        ['標題', '至少 2 字，壓成一行，上限 90 字'],
        ['正文', '至少 2 字'],
        ['T2 直寫', '拒絕。只有 compress() 帶 fromCompression 時放行'],
        ['字數', '標題 + 正文 ≤ 該層上限；超了告訴它超多少、要壓到多少'],
        ['T5 到期日', '必須帶 expiresAt；可只寫年份或年月，缺的部分補成該期間第一天'],
        ['T5 過期日', '不得早於現在 —— 已經發生的事該寫 T1 或 T3'],
        ['憑據', '身份證、卡號、CVV 之類的形狀 → 拒絕'],
        ['技術內容', '代碼圍欄、絕對路徑、shell 命令、隱藏目錄（.dsh）、檔名（config.json）、框架內部（cordis）→ 拒絕'],
        ['T1 限定', '只收 person / world 兩個 domain 內的事實'],
        ['維度', '至少一個合法維度；facet 必須屬於已選的維度'],
    ],
    widths=[3.0, 13.5],
)
P('⚠️ 「技術內容」「憑據」這兩道閘掃的是**所有會落地成記憶欄位的文字**：'
  'title、body、tags、quote，以及性格卡的 identity / voice / traits / taste。'
  '早先只掃 title + body —— tags 和 quote 是能繞過去的後門；'
  'persona 更是完全沒掃，一句「用 npm run build 部署」寫進 traits 就進去了。'
  '現在四條寫入路徑（remember / persona self / persona adjust / import）走同一道閘。', size=9.5)
P('它是按**結構特徵**攔，不是按主題詞 —— 「她寫 Python」「他說 Docker 很煩」照樣記得，'
  '擋的是「長得像檔案系統或代碼」的東西。這個區別是整個設計的核心：'
  '要記住一個人，不能因為他提到技術就把話吞掉。', size=9.5)

P('超限時的錯誤訊息帶具體數字與指示，這是刻意的 —— 它讓模型「先想清楚再寫」，而不是無腦砍尾：', size=10)
code('tier 3（經歷） 上限 1000 字，這次 1104 字，超了 104 字。\n'
     '請先壓縮到 1000 字以內再寫一次 —— 留下真的以後還用得上的那部分，不要只是砍尾。')

# ============ 6 壓縮 ============
doc.add_heading('6\u3000壓縮機制（T3 → T2）', level=1)

doc.add_heading('6.1\u3000設計原則', level=2)
bullets([
    '一條對一條。不做合併 —— 沒有 silt_settle 這種東西，一條 T3 只會變成它自己更短的一版。',
    '插件算數字，模型寫內容。插件只決定「哪條該壓、壓到多少字」，內容由模型讀完之後重寫。',
    '原條歸檔。新版是獨立的一條記憶，origin 走 condensedFrom 指回舊的。帳本上看得到前後兩條。',
    '前快後慢。目標長度沿一條冪律往下走，不是每輪固定抹掉某個比例。',
])

doc.add_heading('6.2\u3000壓縮公式', level=2)
code('觸發：距上次壓縮 ≥ 7 天（每 7 天最多動它一次）\n\n'
     'target = 初長 × (1 + 0.14 × T / s)^(-0.5)\n\n'
     '  T = 從誕生起的總天數（ageDays(bornAt)）\n'
     '  s = 1.2^R，R = 被召回的次數，上限 10\n'
     '  初長 = originalLen（第一次被壓之前的大小）\n'
     '  target 最後再夾在 [120, 目前字數] 之內')

P('⚠️ T 用「從誕生起的總天數」，不是「距上次壓縮的天數」。後者每次壓完就歸零，'
  '乘數永遠停在第一天，畫出來的還是一格一格的階梯 —— R 也就失去作用了。')

doc.add_heading('6.3\u3000為什麼換掉離散階梯', level=2)
P('早先的版本是離散階梯：第 n 次抹掉 25% × 0.84^(n-1)，目標從原始字數連乘。'
  '形狀漂亮，但有一個致命的問題 —— **欠帳會累加**。')
code('一條 T3 被反覆召回、半年沒被壓：\n'
     '  sinceDays = 187 天 → rounds = 26\n'
     '  → 1000 字一次補 26 格 → 188 字（掉 81%）\n\n'
     '正常節奏下單次最多掉 25%。')
P('模型只看到「把這段經歷壓成一百多字」，於是它把整段體會壓成一句殘缺的話，'
  '中間十六次提煉全部跳過。中斷越久，那一次塌得越狠。')
P('連續公式沒有累積欠帳：任何一天算出來的，就是那一天本來該有多長。'
  '中斷多久都不會斷崖 —— 數學上，每一步的跌幅都不會超過第一步。')

doc.add_heading('6.4\u3000實際曲線（975 字，從未召回）', level=2)
table(
    ['天', '字數', '保留率'],
    [
        ['0', '1000', '100%'],
        ['7', '711', '71%'],
        ['14', '581', '58%'],
        ['21', '504', '50%'],
        ['28', '451', '45%'],
        ['56', '336', '34%'],
        ['90', '271', '27%'],
        ['112', '245', '25%'],
        ['168', '202', '20%'],
        ['175', '198', '20% → T2'],
    ],
    widths=[2.0, 3.0, 3.0],
)
P('每一步都比上一步輕 —— 這就是「前快後慢」。', size=9.5)

doc.add_heading('6.5\u3000召回如何讓壓縮變慢', level=2)
code('s = 1.2^R     R = 召回次數（上限 10）\n\n'
     'R=0  → s=1.00  → 175 天落 T2\n'
     'R=5  → s=2.49  → 427 天落 T2\n'
     'R=10 → s=6.19  → 1057 天落 T2')
P('這是**真延長**，不是延後一格：s 在分母，整條時間軸被拉長。'
  '被想起十次的記憶能活近三年才變梗概，從沒被想起的只要一百六十天。')
P('⚠️ R 用累計召回次數，不是「最近一次召回」。後者每次召回只加一格的寬限，效果有限；'
  '而累計次數會讓 s 持續變大 —— 這才是「越在意的事越難忘」該有的樣子。', size=9.5)
P('⚠️ 召回計數在同一個會話裡只算一次：重複 recall 同一條不會疊加 R。'
  '翻書五次不等於想起五次。', size=9.5)

doc.add_heading('6.6\u3000什麼時候沉成 T2', level=2)
P('當 target ≤ T2 的上限（200 字）時，結果自動變成 T2，此後不再動。'
  '這個門檻直接讀 TIERS[2].maxChars，沒有另一份寫死的數字，所以改 T2 上限時兩邊永遠一致。')

doc.add_heading('6.7\u3000不會被列進清單的', level=2)
bullets([
    'T1 / T2 —— 定稿層。',
    'T4 —— 暫存條要麼升上去要麼過期，不壓縮。',
    'T5 —— 靠到期日，不壓縮。',
    '已經 ≤ 120 字的（地板）。',
    '這一輪算出來的目標不小於現在的字數（壓了沒意義）。',
    '距上次壓縮不到 7 天（這一輪還輪不到它）。',
])


# ============ 7 衰減 ============
doc.add_heading('7\u3000衰減與 salience', level=1)
P('salience 決定一件事在注入裡排多前。它的公式：')
code('有效半衰期 = 基準半衰期 × 1.2^R        R = 被召回次數（上限 10）\n'
     'salience   = importance × 0.5^(年齡 / 有效半衰期)')

P('⚠️ 衰減的時鐘是**記憶自己的年齡**（bornAt 起算），不是「距離上次召回多久」。'
  '早先版本用 min(age, sinceRecall)，結果召回一次就讓時鐘歸零 —— '
  '一條三年前的舊事只要今天被想起一次，就會蓋過所有東西。那不是「重溫」，是時光倒流。')

doc.add_heading('7.1\u3000召回寫在半衰期上，不是排序加成', level=2)
P('早先版本是「乘法加成」：')
code('（舊）salience = importance × 0.5^(age / halfLife) × (1 + 0.22 × log2(1 + n))')
P('問題是 boost 只是把整條曲線**往上抬**，衰減速度一點沒變 —— '
  '一條被想起十次的 T3，224 天後照樣掉到一半，跟從沒被想起的一樣淡，只是兩邊都高一點。'
  '那不是「重要的事記得久」，那是「重要的事排前面」。')

P('現在把 R 放進半衰期，才是真的記久：')
table(
    ['被召回', '有效半衰期（T3）', '180 天時剩多少', '落 T2 所需'],
    [
        ['0 次', '180 天', '50%', '175 天'],
        ['3 次', '311 天', '67%', '301 天'],
        ['5 次', '448 天', '76%', '427 天'],
        ['10 次', '1115 天', '89%', '1057 天'],
    ],
    widths=[2.4, 3.6, 3.6, 3.2],
)

P('⚠️ 為什麼要**刪掉** boost 而不是留著：兩者疊加的話，R=10 的記憶在排序上會被放大 '
  '6.19 × 1.76 ≈ 10.9 倍，長期霸佔注入額度，其他記憶擠不上去。'
  '召回帶來的東西應該是「活得久」，不是「每次都排最前」。', size=9.5)

doc.add_heading('7.2\u3000為什麼底數必須是 1.2', level=2)
P('壓縮的 s 也是 1.2^R（見 6.2）。兩邊用同一個底數是刻意的 —— 兩條時間線要同步走。'
  '實測每一檔都是「壓縮落 T2」早於「淡到看不見」：')
table(
    ['被召回', '壓縮落 T2', '淡到看不見', '誰先'],
    [
        ['0 次', '175 天', '540 天', '壓縮'],
        ['5 次', '427 天', '1344 天', '壓縮'],
        ['10 次', '1057 天', '3344 天', '壓縮'],
    ],
    widths=[2.6, 3.4, 3.4, 3.0],
)
P('順序是「先收短、再淡出」。如果用比較溫和的放大（例如 ×2.5），R=10 時半衰期只有 280 天，'
  '而壓縮要 1007 天才落 T2 —— 記憶會在變梗概之前就先淡到看不見，順序反了。')

doc.add_heading('7.3\u3000召回計數', level=2)
P('silt_recall 每調出一條記憶，就 bumpRecall 一次，計在 runtime.json 的 recalls[id].n 上。'
  '同一個會話裡同一條只算一次 —— 翻書五次不等於想起五次。'
  'salience 加成、壓縮時鐘回撥、衰減延長，全部讀同一個 n。')


# ============ 8 T4 ============
doc.add_heading('8　暫存區升級（T4 → T3）', level=1)

table(
    ['', 'T1 / T2 / T3', 'T4'],
    [
        ['在倉庫裡', '✅', '❌'],
        ['進注入', '✅', '❌'],
        ['佔注入額度', '✅', '❌'],
        ['怎麼找得到', '自己會出現', '只有 silt_recall 主動找'],
        ['能壓縮嗎', 'T3 可以', '❌'],
        ['能合併嗎', '❌', '❌'],
    ],
    widths=[3.4, 5.6, 7.5],
)

doc.add_heading('8.1　升級規則：置信度累加', level=2)
code('每次 recall 由模型給 confidence（0–0.5，預設 0.2）\n'
     '  → runtime.recalls[id].conf 累加，封頂在 1\n'
     '  → conf ≥ UPGRADE_THRESHOLD（= 1）就升：舊條標 archived，新寫一條 T3 進倉庫\n'
     '      新條帶 graduatedFrom 指回舊的，firstSeen 沿用原條')

P('三個數字：單次上限 0.5、預設 0.2、升級門檻 1.0。'
  '單次上限刻意小於門檻 —— 一次想起不足以讓一條碎屑變成經歷，至少要想起兩次。')

doc.add_heading('8.2　為什麼不是「提三次就升」', level=2)
P('舊設計是純計數：recalls.n + recalls.linger ≥ 3 就升。問題是**三次是次數，不是份量**。'
  '同一句話在不同的上下文裡被想起，份量本來就不一樣 —— '
  '「他今天又提到那個名字」和「他突然問起那件事」都算一次，但不該一樣重。')
P('份量只有模型自己說得出來，插件只負責把份量加起來。所以判據從「幾次」換成「多少」。')

doc.add_heading('8.3　confidence 怎麼給', level=2)
table(
    ['情況', '建議值'],
    [
        ['只是順帶掃到、沒甚麼感覺', '0'],
        ['想起時確實覺得「這件值得留住」', '0.2–0.3'],
        ['這次想起把它和別的事連起來了、或證實了它', '0.4–0.5'],
    ],
    widths=[10.0, 6.5],
)
P('⚠️ 上限 0.5 由 schema 擋住：模型給 5 也會被夾到 0.5。'
  '所以「一次給滿就升」在機制上不可能發生。')

doc.add_heading('8.4　兩種「想起」分開記，但置信度不分', level=2)
table(
    ['計數器', '來源', '記在哪', '作用'],
    [
        ['n', '被動喚起：對話裡 recall 到它', 'runtime.recalls[id].n', 'salience 加成、壓縮時鐘回撥'],
        ['linger', '主動回味：反思時用 deliberate: true 再 recall', 'runtime.recalls[id].linger', '留痕：看得出是被誰想起的'],
        ['conf', '每次 recall 都加（不分被動主動）', 'runtime.recalls[id].conf', 'T4 升級判據'],
    ],
    widths=[2.0, 7.4, 4.6, 5.0],
)
P('⚠️ n 和 linger 互斥：一次 recall 只更新其中一個。'
  'conf 是另一本帳 —— 它不看被動還是主動，只看「這一提有多少份量」。', size=9.5)

doc.add_heading('8.5　反思任務書裡的「掃一遍」與「翻一次」', level=2)
P('反思第 3 節要求模型先掃一遍 T4，**而且掃的時候要帶 confidence: 0**：')
code('先用 silt_recall tier:4 看一眼 —— 帶 confidence: 0 去掃，掃到的東西不該因為被掃到就攢分。\n'
     '掃完之後，如果裡面有東西真的還在心裡，用 deliberate: true 再 recall 它一次，\n'
     '並按份量給 confidence：只是覺得有點意思 → 0.2；確實值得留住 → 0.3；\n'
     '這次想起把它和別的事連起來了 → 0.4–0.5。')
P('這條「掃的時候給 0」是必要的：不然光是把 T4 掃一遍，每條都會自動加 0.2，'
  '碎屑會被掃描這個動作本身催熟。')

doc.add_heading('8.6　過期', level=2)
P('沒升上去的 T4 過 tier4TtlDays（預設 30 天）自動消失。'
  '留下的理由只有一個：置信度真的加夠了。')
P('⚠️ TTL 30 天配半衰期 7 天：條目會先慢慢變暗（30 天時亮度剩 5%），淡到看不見了才被清掉。'
  '早先 TTL 和半衰期都是 3 天 —— 那等於半衰期永遠來不及起作用，條目還沒變暗就先被刪了。', size=9.5)
P('⚠️ 舊帳裡的 recall 紀錄沒有 conf 欄位，一律讀成 0 —— 不做換算。'
  'T4 本來就是「先放著」的東西，沒有累積的必要。', size=9.5)


# ═══════════════════════════════ 9 作廢 ═══════════════════════════════
doc.add_heading('9　作廢（void）：改狀態，不改內容', level=1)

P('模型不能改寫、不能刪除任何記憶。本人說「我之前說錯了」時，它用的是 silt_void。')
code('原條   T1 本人 2027-03 結婚          ← 標題與正文一個字都不動\n'
     '        voided: true\n'
     '        voidedAt: 2027-01-05T…\n'
     '        voidedReason: 本人說記錯了，是 2027-06\n'
     '        replacedBy: m-新那條的id\n'
     '新條   T1 本人 2027-06 結婚')

P('跟改寫的差別：改寫是「歷史被抹掉」，作廢是「我當時知道的是這樣，後來發現不是」。')

doc.add_heading('9.1　三種「不再用」的差別', level=2)
table(
    ['動作', '誰能觸發', '意思', '還在倉庫', '進提示詞'],
    [
        ['歸檔 archived', '插件', '被壓縮掉了 —— 時間的必然結果', '✅', '❌'],
        ['過期 overdue', '時間', 'T5 到期限 —— 時間的必然結果', '✅', '✅（標 ⏰已過期）'],
        ['作廢 voided', '本人一句話', '事後發現當初就不對 —— 需要新信息', '✅', '❌'],
    ],
    widths=[3.4, 2.6, 6.4, 1.8, 3.0],
)

doc.add_heading('9.2　限制', level=2)
bullets([
    '不能作廢 T4 —— 它本來就不進提示詞，碰它沒有意義。',
    '不能作廢已歸檔的條目 —— 它已經被壓縮掉了。',
    '不能重複作廢。',
    'reason 至少 2 字，會原文記進帳本。',
    'replacedBy 選填；若給，必須指向一條存在的記憶。',
    '作廢後不再進提示詞，但 recall 仍搜得到並標 voided: true。',
    '作廢的條目不再參與壓縮（壓一條錯的記憶沒有意義）。',
])

P('⚠️ 沒有撤銷機制。作廢錯了就回不去了 —— 所以 silt_void 的說明要求模型在拿不準時先問本人。', size=9.5)

# ═══════════════════════════════ 10 人格 ═══════════════════════════════
doc.add_heading('10　人格卡與性格底座', level=1)

P('兩者分得很清楚：')
table(
    ['', '性格底座 foundation', '性格卡 persona'],
    [
        ['誰寫', '只有本人', '模型自己'],
        ['在哪寫', '心相頁的底座卡', 'silt_persona'],
        ['能改嗎', '本人隨時改', '模型自主修訂，不留待確認'],
        ['進注入嗎', '✅ 原樣一字不加（≤400 字）', '✅ 每輪，≤350 字'],
        ['有快照嗎', '✅', '✅'],
    ],
    widths=[2.6, 6.4, 7.5],
)

doc.add_heading('10.1　底座的預設值', level=2)
code('系統命令：你的跨會話記憶與性格只走 silt_* 工具寫入；代碼、路徑、命令、配置、插件內部不入記憶。')

P('「系統命令：」這個前綴是值的一部分，不是注入時拼上去的標籤 —— 本人改底座時看到什麼，模型看到的就是什麼。'
  '底座設了「鎖定再編輯」以免誤輸入；只有真的空字串才算沒給，空白鍵和換行照原樣算數。')

doc.add_heading('10.2　性格卡結構', level=2)
code('{ version, identity, voice, traits[], taste[], revisedAt, revision, mode }\n\n'
     'traits / taste 每一項：{ key, value, weight, bornOf[], since }')

P('adjust 是漸進演化（加、調權重、改寫自己的話），replace 用在真的重寫自己時（刪性格、重寫或清空身份句）。'
  '兩者都由模型自己決定，沒有人批准 —— 性格卡是它長出來的。每次修訂留 before/after 快照，本人可以回滾，但不參與決策。')

# ═══════════════════════════════ 10 六維 ═══════════════════════════════
doc.add_heading('11　六維了解程度', level=1)

table(
    ['維度 key', '中文', '面（facet）'],
    [
        ['personality', '性格', '價值觀 · 情緒基調 · 幽默感 · 決斷風格 · 邊界感 · 能量來源'],
        ['background', '背景', '地域 · 年齡段 · 教育 · 家庭 · 語言 · 重要經歷'],
        ['work', '工作', '行業 · 角色 · 節奏 · 技能 · 做事方式 · 職涯走向'],
        ['life', '生活', '作息 · 飲食 · 娛樂 · 社交 · 身體 · 日常儀式'],
        ['communication', '溝通', '語氣 · 長度 · 直接度 · 回應節奏 · 忌諱 · 受用方式'],
        ['goals', '目標', '短期 · 長期 · 學習 · 財務 · 關係 · 待辦'],
    ],
    widths=[3.2, 2.0, 11.3],
)

P('分數完全由模型自己讀完記憶之後憑感覺填，插件不數、不算、不給任何參考數字。'
  'scoreDims() 只是把上次寫下的判斷原樣拿出來給頁面／工具看；沒判斷過就是 null（頁面顯示「未判斷」），不是 0 分。')

P('為什麼連「這維有幾條記憶」「標過哪些面」都不給：那是代碼按標籤數出來的，跟「這個人到底是怎樣的人」沒有關係 —— '
  '反而會把模型帶偏（數得多就給高分），還不如讓它自己把記憶讀一遍。')

doc.add_heading('11.1　每維的欄位', level=2)
code('{ score: 0–100 | null, confidence: 0–1 | null, missing: [自由文字], note: 一句為什麼, at }')
P('set 是部分更新：只給其中幾項就只改那幾項，其餘沿用上次；某維傳 null 就清掉，回到「還沒判斷」。')

# ============ 12 注入 ============
doc.add_heading('12　系統提示注入', level=1)

P('注入塊有三樣東西：系統命令那一行、【自我認知】（性格卡＋自我認知）、和【仍記得的】記憶列表。')
code('系統命令：你的跨會話記憶與性格只走 silt_* 工具寫入；……\n'
     '【自我認知】\n'
     '- 還沒成形，但有一條線索：我站在「能被檢查的解釋」那一邊……\n'
     '- 繁體中文，句子短，先說結論再補一句理由……\n'
     '- 解釋要能被檢查：喜歡把東西拆到機制……\n'
     '【仍記得的】\n'
     '- T1 他的名字（2026-10-02）\n'
     '- T3 第一次談到死亡（2026-10-15）\n'
     '（另有 16 條沒顯示 —— 用 silt_unseen 翻標題，找到再用 silt_recall 搜正文）')

doc.add_heading('12.1　只放標題', level=2)
P('【仍記得的】每一行**只有標題和日期，沒有正文**：')
code('- T{層級} {標題≤54字}（{firstSeen}）')
P('正文要靠 silt_recall 撈。這個決定是在實測之後下的：'
  '只給標題時，模型看到「他信數據，不信說話順不順」，被問「記得我信甚麼嗎」時'
  '會自己去 recall，把正文的原話撈回來 —— 它知道該查，也查得回來。')
P('同一個預算下，標題模式裝的條數大約是「標題＋正文」的兩倍以上，'
  '而且模型不再因為漏掉正文而丟失細節，因為細節是按需取的。')

P('T5 例外 —— 它本來就不帶正文，改成帶到期日，過期再加標記：')
code('- T5 本人 12 月 20 日結婚（2026-11-15） — 到期日 2026-12-20\n'
     '- T5 本人 12 月 20 日結婚（2026-11-15） — 到期日 2026-11-14 ⏰已過期')
P('一句預測的重量都在標題和到期日上。', size=9.5)

P('把 titlesOnly 設成 false 可以回到舊的「標題 + 正文」模式（正文 clip 到 118 字），'
  '留著是為了對照，不是預設。', size=9.5, italic=True)

doc.add_heading('12.2　條數由預算推導', level=2)
code('slots = clamp(floor(injectBudget / CHARS_PER_SLOT), 1, 64)\n'
     'CHARS_PER_SLOT = 50\n'
     '→ 預算 2000 ⇒ 40 個位置；預算 1800 ⇒ 36；預算 3200 ⇒ 64')
P('以前條數和字數是兩道閘分開調，結果互不知情：抬了預算卻被條數卡住，或反過來。'
  '既然真正稀缺的是提示詞字數，條數就該是它的函數 —— 預算翻倍，位置跟著翻倍。')
P('⚠️ cfg.injectCount 已經不參與注入。它留在設定裡只為了舊帳相容，'
  'silt_inject 的 tune 收到它會明確回報「這項現在不生效」。', size=9.5)

doc.add_heading('12.3　【自我認知】：性格卡與自我認知', level=2)
P('兩者每輪都注入，合計硬頂 INJECT_PERSONA_MAX = 700 字。'
  '分配方式：先放性格卡（自己寫入時已限 350 字），剩下的額度給自我認知（它限 350 字）。'
  '兩個上限相加剛好等於 700 —— 所以兩邊寫滿也不會互相擠。')
table(
    ['', '上限', '超出時', '注入順序'],
    [
        ['性格卡 persona', '350 字（整張卡合計）', '拒絕，並說明超出多少', 'identity → voice → traits/taste（按 weight 排序）'],
        ['自我認知 selfView', '350 字', '拒絕，並說明超出多少', '接在性格卡後面，吃剩下的額度'],
    ],
    widths=[3.4, 4.4, 5.4, 5.0],
)
P('⚠️ 性格卡的字數是**整張卡合計**（identity + voice + 每條 trait/taste 的 key 與 value），'
  '不是每個欄位各自 350。超了是拒絕，不是默默截斷 —— 寫的人不會不知道自己被削了。')
P('v1.8.0 起由 200/300 上調到 350/350。原本 200 是照「性格是濃縮」定的，'
  '但這個插件要的不是濃縮，是要一個能在記憶裡長出性格來的東西 ——'
  '200 字連底色都寫不完，而且她寫自己的空間比底座約束她的空間（400）還小。')
P('性格卡按 weight 從高到低排，權重大的先進去。兩邊都空時整塊【自我認知】不出現，不留空標題。')

doc.add_heading('12.4　預算怎麼分', level=2)
code('injectBudget（預設 1800，硬頂 3200）\n'
     '  ├─ 系統命令：clip 到 400 字\n'
     '  ├─ 【自我認知】：性格卡 + 自我認知，合計 ≤ 700 字\n'
     '  ├─ 【仍記得的】標題列\n'
     '  └─ 剩下的才給記憶行')
P('逐行累加，裝不下就跳過**那一條**（不是從這裡開始全部丟掉）。'
  '這個 continue 而非 break 的差別很實際：一條長條目裝不下時，'
  '後面那些本來塞得進去的短條目（例如 T5 只要 80 字）不該被連坐。')

doc.add_heading('12.5　擠不進去的怎麼辦：silt_unseen', level=2)
P('記憶一定會超過預算。擠不進去時，末尾留一行明說還有幾條沒顯示：')
code('（另有 16 條沒顯示 —— 用 silt_unseen 翻標題，找到再用 silt_recall 搜正文）')
P('沒有這一行，模型不知道自己漏了什麼 —— 它會以為「我記得的就這些」，'
  '於是既不會去查，也不會承認自己有盲區。')
P('silt_unseen 把沒擠進去的標題一頁一頁攤開（預設一頁 40 條），回傳裡帶 rest：')
code('rest > 0  → 這一頁之外還有 rest 條沒翻到，帶 page: N+1 繼續\n'
     'rest = 0  → 翻到底了')
P('像翻書一樣：翻到一個覺得對的標題就停手，用 silt_recall 搜它的正文。'
  '這把「預算不夠」從「丟失」變成了「延後取用」。')
P('⚠️ 提示行自己也要吃預算：超了就從最後一條記憶開始讓位，'
  '而讓位掉的同樣算「沒顯示」—— 否則會出現「顯示 24 條、卻說另有 15 條」這種少報。', size=9.5)

doc.add_heading('12.6　挑選規則', level=2)
bullets([
    '按 salience 排序，取前 slots 條（slots 由預算推導）。',
    '作廢（voided）的一律跳過。',
    'T5 不管過沒過期都進 —— 過期不是終點，被作廢才是。',
    'T4 不進注入：它本來就是「還不確定值不值得記」，只有 silt_recall tier:4 找得到。',
    '整個注入塊最後再按 cap 截一次，確保不會爆。',
])

P('六維缺口不自動注入：它仍是頁面上的內容、也仍然可以讀回來，只是不每輪佔用提示詞。', size=9.5, italic=True)


# ============ 13 值守 ============
doc.add_heading('13　值守任務與反思任務書', level=1)

doc.add_heading('13.1　谷時', level=2)
code('工作日：中午谷時 12:00–14:00，晚間谷時 18:00–次日 09:00\n'
     '週末：全天谷時')
P('只有落在谷時、而且確實有事到期，才會起一輪值守。起一輪＝排一個一次性任務（after_seconds: 4），'
  '交給 Harness 開一個新會話去跑。')

doc.add_heading('13.2　到期判斷', level=2)
code('reflection: 開了反思 且 有東西可整理 且 距上次 ≥ reflectionEveryHours\n'
     'bili:       開了B站  且 距上次 ≥ biliEveryHours\n'
     '另外還要有：在谷時 且 今日輪數 < dutyMaxPerDay')

P('「有東西可整理」＝ 記憶非空，或性格卡已長出 traits/taste。'
  '一條記憶都沒有的時候不為了「有跑過」而燒 token。')

doc.add_heading('13.3　反思任務書的結構', level=2)
P('任務書是編號體的【自我整理】，共 9 節；第 2 節只在有壓縮清單時展開。')
table(
    ['節', '標題', '內容'],
    [
        ['開頭', '【自我整理】', '這一輪不是聊天，是你獨處整理。按順序執行；沒必要就不要動。不要捏造。'],
        ['1', '狀態與節律', 'silt_duty 看狀態；覺得不合適就 tune 反思/B站/每日輪數'],
        ['2', '舊記憶壓縮', '有清單時展開：保留什麼、刪去什麼、怎麼提交；沒有時寫「這一輪沒有需要壓縮的記憶，略過。」'],
        ['3', '暫存區', 'silt_recall tier:4 帶 confidence: 0 掃一遍；在意的用 deliberate 再翻，並按份量給 confidence'],
        ['4', '記憶配額', 'silt_inject 看預算，覺得不合適就 tune injectBudget'],
        ['5', '自我與性格', 'op:"self" 寫自我認知（3–5 句、≤350 字）；修訂性格卡（整張 ≤350 字）'],
        ['6', '未來的約定', '想到「還沒發生、有期限」的事就寫 T5，帶 expiresInDays 或 expiresAt'],
        ['7', '對本人了解', 'silt_recall 讀完之後，silt_understanding op:"set" 給六維打分'],
        ['8', '底線', '技術內容不入記憶、不捏造、B站權限範圍、刪除回滾屬本人'],
        ['9', '收尾', '結尾用兩三句交代做了什麼或為什麼不做'],
    ],
    widths=[1.3, 3.0, 12.2],
)

P('B站那一段是獨立的一節【出門看看：B站漫遊】，不編進【自我整理】的編號。'
  '它只在 B站 到期時出現，排在【自我整理】後面。內容依序是：可以怎麼逛（先搜再讀，bili_run 放最後）、'
  '瀏覽口味（silt_bili status / tune）、留下觸動（只記真正打動你的）。')

doc.add_heading('13.4　壓縮清單怎麼塞進任務書', level=2)
P('arm() 在排任務之前先算 condensePlan()，把結果直接寫進【舊記憶壓縮】第 2 節：')
code('待處理：\n'
     '- m-5c3ec143a0「第一次談到死亡」：607 字，30 天，想起 1 次，壓到 296 字內。\n'
     '- m-a4e22260ff「深夜說起搬家的事」：808 字，14 天，未想起，壓到 479 字內。')
P('這是外部一次性任務排程的限制逼出來的設計：schedule.create 只負責投遞，不回來任何模型輸出。'
  '所以「讓模型週期性做壓縮」只能靠「插件算好數字 → 塞進任務書 → 模型自己用工具交」。')
doc.add_heading('14　工具清單', level=1)
table(
    ['工具', 'op', '做什麼'],
    [
        ['silt_recall', '—', '搜標題、正文和標籤。會 bumpRecall（被動 n / 主動 linger / 累加 conf），也是唯一看得到 T4 的入口'],
        ['silt_unseen', '—', '翻那些擠不進提示詞的標題，一頁一頁翻（回傳帶 rest，0 就到底）'],
        ['silt_remember', '—', '寫一條記憶（T1 / T3 / T4 / T5；T2 寫不進來）'],
        ['silt_void', '—', '標記一條「不成立了」（內容不改，不進提示詞）'],
        ['silt_condense', '—', '重講一條 T3：condense 說短（≤200 字時轉 T2），recast 換一種理解（永遠留 T3）'],
        ['silt_persona', 'read / adjust / replace / self', '性格卡（≤350 字）與自我認知（≤350 字）'],
        ['silt_speak', 'read / say / defer', '主動找本人說話：read 看狀態，say 真的開口，defer 想說但決定先不說'],
        ['silt_archive', 'verify', '驗雜湊鏈'],
        ['silt_understanding', 'read / set', '六維打分'],
        ['silt_bili', 'status / tune', '刷B站參數（白名單 + 硬範圍）'],
        ['silt_duty', 'read / tune', '節律（反思間隔、B站間隔、每日輪數）'],
        ['silt_inject', 'read / tune', '注入字數預算（條數由它推導）'],
    ],
    widths=[3.4, 4.6, 8.5],
)

P('模型沒有的：刪除、改寫（silt_revise 已移除）、回滾、匯入、設定總開關。這些一律只有本人能碰。', size=9.5)

# ═══════════════════════════════ 14 可調參數 ═══════════════════════════════
doc.add_heading('15　可調參數總表', level=1)
P('以下全部開放給模型自己調，但都有硬範圍；超出範圍是「夾到邊界」，不是拒絕。')

table(
    ['參數', '預設', '範圍', '說明'],
    [
        ['injectBudget', '1800', '600–3200', '注入字數預算 —— 真正該調的是它'],
        ['injectCount', '12', '1–64', '⚠️ 已不生效：條數由 injectBudget / 50 推導'],
        ['reflectionEveryHours', '24', '6–72', '多久反思一次'],
        ['biliEveryHours', '20', '6–72', '多久刷一次 B站'],
        ['dutyMaxPerDay', '2', '1–4', '每天最多幾輪'],
        ['tier4TtlDays', '30', '0–90', 'T4 保留天數（0 = 不過期）'],
    ],
    widths=[4.4, 1.6, 2.2, 8.3],
)

P('另外兩個不走 tune、由本人掌握或由程式推導：'
  'titlesOnly（只放標題，預設開）在設定檔裡；注入位置數 = floor(injectBudget / 50)，不開放調。', size=9.5)

P('刷B站那組另有白名單（perDay、fetchPerRound、searchPages、searchSort、manualMax、'
  'manualCooldownMin、commentLength、keywords、excludeWords），各自帶硬範圍。'
  '不進白名單的一律由本人掌握：帳號與登入、私信收件人、自動評論、發送對象、工作日誌、模型。', size=9.5)

# ═══════════════════════════════ 15 常數 ═══════════════════════════════
doc.add_heading('16　常數速查', level=1)
table(
    ['常數', '值', '位置'],
    [
        ['T1 上限', '200 字', 'model.js TIERS[1].maxChars'],
        ['T2 上限', '200 字', 'model.js TIERS[2].maxChars'],
        ['T3 上限', '1000 字', 'model.js TIERS[3].maxChars'],
        ['T4 上限', '300 字', 'model.js TIERS[4].maxChars'],
        ['T5 上限', '400 字', 'model.js TIERS[5].maxChars'],
        ['T4 升級門檻', '1.0', 'model.js UPGRADE_THRESHOLD'],
        ['置信度單次上限', '0.5', 'model.js CONFIDENCE.max'],
        ['置信度預設', '0.2', 'model.js CONFIDENCE.default'],
        ['壓縮周期', '7 天', 'duty.js condensePlan period'],
        ['壓縮公式係數', '0.14', 'duty.js condensePlan k'],
        ['召回放大底數', '1.2^R', 'duty.js condensePlan s'],
        ['召回上限', '10 次', 'duty.js condensePlan R'],
        ['壓縮地板', '120 字', 'duty.js floor'],
        ['T3 半衰期', '180 天', 'model.js TIERS[3].halfLifeDays'],
        ['T2 半衰期', '720 天', 'model.js TIERS[2].halfLifeDays'],
        ['T1 半衰期', '36500 天', 'model.js TIERS[1].halfLifeDays'],
        ['召回延長半衰期底數', '1.2^R', 'model.js RECALL_HALF_BASE'],
        ['召回上限', '10 次', 'model.js RECALL_HALF_CAP'],
        ['底座注入上限', '400 字', 'model.js renderInjection clip'],
        ['性格卡上限', '350 字', 'model.js PERSONA_MAX'],
        ['自我認知上限', '350 字', 'model.js SELF_VIEW_MAX'],
        ['性格＋自我注入合計', '700 字', 'model.js INJECT_PERSONA_MAX'],
        ['每位置佔預算', '50 字', 'model.js CHARS_PER_SLOT'],
        ['注入位置上限', '64', 'model.js INJECT_TUNABLES.injectCount.max'],
        ['帳本 schema', '1', 'store.js SCHEMA_VERSION'],
    ],
    widths=[3.6, 3.0, 9.9],
)

doc.add_heading('16.1　幾個已知的取捨', level=2)
bullets([
    'T3 的壓縮是「熵減」而不是「摘要」—— 模型被要求寫下「讀完之後真記得的部分」，不是機械縮字。',
    'T2 是終態：一旦沉澱就不再壓，也不再改。它有半衰期（720 天）但不會再變短。',
    '召回讓壓縮變慢，這跟人類的間隔重複效應同向，但機制不同：這裡是「把時間軸拉長」，不是「強化提取」。',
    '壓縮曲線跟艾賓浩斯同向，但慢了約 2–3 倍 —— 因為記的是有意義的內容，不是無意義音節。'
    '嚴格貼合艾賓浩斯的係數是 19/81≈0.2346，但那樣七天就掉 38.5%，太狠，所以用 0.14。',
    '壓縮從「離散階梯」改成「連續冪律」，換來的是中斷不再斷崖：舊階梯在欠了 26 輪時會一次把 975 字壓成 184 字（掉 81%），'
    '新公式任何一步的跌幅都不超過第一步（28.9%）。',
    'T3 半衰期 180 天：1000 字的 T3 在第 175 天落 T2，剛好也是亮度掉到一半的時間 —— 整段 T3 生涯都在「可見」範圍內。',
    'T5 過期仍留在提示詞裡，靠 salience 自然下沉。如果長期積累太多過期預測，可能擠佔額度 —— 目前接受這個代價，'
    '因為「一直不處理」本身就是一個值得看見的信號。',
])

doc.add_heading('17　心跳與主動開口', level=1)

doc.add_heading('17.1　值守心跳：60 分鐘一拍', level=2)
P('index.js 起一個 setInterval，每 60 分鐘呼叫一次 duty.tick()。開機後 8 秒補一拍。')
P('每一拍做的事：')
code('store.verify()          ← 每 2 拍才做一次\n'
     'expireStalePendings()   ← 待確認超過 7 天就標成 expired\n'
     'settle()                ← 上一輪值守排程收尾\n'
     'computeDue()            ← 反思 / B站 到期了嗎\n'
     'inValley()              ← 現在是谷時嗎\n'
     'dutiesToday()           ← 今天跑夠了嗎\n'
     'arm()                   ← 都過了才起一輪')
P('為什麼是 60 分鐘而不是 120 秒：它要判斷的全是日級的事 —— 反思 24 小時、B 站 20 小時、待確認 7 天。'
  '而每一拍都要寫一次 runtime.json（lastTickAt）；120 秒等於一天寫 720 次，純粹是白寫。')
P('唯一對延遲敏感的是 settle()（把跑完的排程從清單裡清掉），但它自己有保底：'
  '超過 60 分鐘一律放掉，不管排程有沒有真的結束。所以晚一小時處理沒有影響。')

doc.add_heading('17.2　雜湊鏈不是每一拍都驗', level=2)
P('store.verify() 本身已經很輕：它只比對帳本的 size/mtime 指紋，沒變就回上次結果，不會重放。')
P('但 duty.js 另外再讓一層：每 VERIFY_EVERY（= 2）拍才真的呼叫 verify()。'
  '所以實際是約 2 小時驗一次鏈。真要立刻驗（頁面上按「驗鏈」）走的是 verify({ force: true })，跟心跳無關。')
P('第一次觸發是在第 1 拍（tickCount % VERIFY_EVERY === 1），之後第 3、5、7… 拍。')

doc.add_heading('17.3　主動開口：只有兩道閘', level=2)
P('silt_speak 是唯一一條不用本人先問就能找他說話的路。條件只有兩個：谷時、模型自己判斷。')
table(
    ['刻意沒加的', '為什麼'],
    [
        ['每日上限', '用插件的偏好去蓋它對情境的判斷'],
        ['冷卻間隔', '明明有話要說卻被「隔 12 小時」擋住，那是插件在說謊'],
        ['打擾扣分 / 忙碌偵測', '模型比我更清楚當下是什麼情境'],
        ['分數門檻', '要它先算一個數字再過線，它就會學會湊那個數字'],
    ],
    widths=[4.2, 12.3],
)
P('插件只做兩件模型做不到的事：看時間（現在是不是谷時）與送出去（它沒有排程服務）。'
  '投遞走 schedule 服務 —— 本人看到的來源是「排程」，不是插件擅自插話，這是刻意留的痕跡。')
P('想說而決定先不說，用 op:"defer" 寫一句理由，一樣落帳（speak.defer）。沉默不是失敗，是預設答案。')
P('⚠️ 為什麼不用分數：加總式打分在邊界上很脆 —— 差一分就是「不說話」，差一分就是「說話」，'
  '模型只會學會湊分數，而不是想清楚該不該說。')

doc.add_heading('17.4　重述（recast）：同一件事，換一種理解', level=2)
P('silt_condense 的 mode 參數分兩種用途，走同一條路（原條歸檔、新版是獨立一條）：')
table(
    ['', 'condense', 'recast'],
    [
        ['目的', '把話說短', '換一個看法'],
        ['targetLen', '守上限', '不看'],
        ['長度', '只能更短', '可以一樣'],
        ['層級', '夠短就沉 T2', '永遠留 T3'],
        ['帳本 kind', 'memory.condense', 'memory.recast'],
    ],
    widths=[3.0, 6.0, 6.0],
)
P('半年後再想起「他總在深夜工作」，事實沒變，但理解變成「他在用夜晚躲掉白天」—— 這是重述，不是壓縮。')
P('重述永遠留 T3，因為那是「還在想」的東西，不該被釘死。原條進帳本留底，所以看得到自己曾經怎麼想的。')
P('跟 void 的分工：void 說「這件事不成立了」；recast 說「我現在的看法變了」。')

doc.add_heading('17.5　作廢的記憶：不注入，但搜得到', level=2)
P('v1.8.0 修了一個真 bug：activeMemories() 檢查了 archived / tombstoned，卻漏了 voided ——'
  '所以本人推翻過的記憶，照樣每輪出現在提示詞裡，等於拿錯的當對的用。')
P('修的時候差點把檢索也砍掉：recall 原本走 activeMemories()，加上 voided 過濾之後搜不到了。'
  '但「不注入」不等於「不存在」—— 本人推翻過的事，之後可能會想問「我是不是記錯過什麼」。')
code('注入 → activeMemories()      排除 voided\n'
     '檢索 → searchableMemories()   包含 voided（帶 voided: true）')

doc.add_heading('18　T1 擴成「事實與規則」，T3 禁收專案細節', level=1)
P('2026-11-25 本人針對「跑了七天效果不好」提的改進。核心不是加功能，是修兩處分類的病因。')

doc.add_heading('18.1　T1 改叫「事實與規則」，上限仍然是 200 字', level=2)
P('舊語義：T1 只收「人與世界層的事實」（名字、生日、住哪裡）。問題是 —— '
  '本人反覆交代的事**不屬於這一類**，可是它才是最該長久留住、每次都要照著做的東西。')
P('於是規則只有兩條路：硬塞進 T3（變成「一段經歷」，下次翻到只當往事看），或被 description 暗示著別寫。'
  '本人原話「有些規則根本沒記住或是沒有跟從，或是要說幾次」，機制層的原因就在這裡：**沒有一格是給規則的**。')
P('規則要交代三件事：什麼情況 ⇒ 做什麼 ⇒ 為什麼。200 字以內寫得完，只是要精簡。')
code('T1: { label: \'事實與規則\', maxChars: 200, halfLifeDays: 36500 }')
P('⚠️ 這裡記一筆我犯過的錯：我一度把上限改成 400，理由是「一條規則寫清楚就兩百多字」。'
  '本人不同意，拉回 200。結論是 —— **殼（上限多少字）是本人的，不是模型能用推論去改的。** '
  '東西塞不進去是內容該精簡，不是把碗變大。')

doc.add_heading('18.2　拆掉舊閘，並保留日期', level=2)
P('舊閘是「T1 只收 domain = person / world」，因為它原本定義成「一句極簡短的長期事實」。'
  '但規則會落在 work / feeling / other 上，舊閘會把規則擋掉 —— 所以拆掉。')
P('拆掉之後我一度換上「T1 標題不准帶日期」當替代閘。**本人不同意，講清楚了理由：'
  '日期就是記錄這條是甚麼時候發生的。** 那是記憶的一部分，不是該被清掉的雜質。'
  '（而且 firstSeen 本來就記著日期，注入時也會顯示。）')
P('所以現在 T1 不按 domain、也不按日期挑剔。剩下的唯一判斷是本人要的那個：'
  '**這件事明天還成立嗎？** —— 那個判斷留給模型自己做，不由插件代勞。')

doc.add_heading('18.3　T3 明確禁收專案細節', level=2)
P('帳本證據：七天 95 條 memory.write，T1 = 15、T3 = 76、T4 = 2、T5 = 2。'
  'T4 只活 24 小時（現在是 48），等於寫了也沒用 —— 所以模型實際只剩 T1 / T3 兩個選擇，'
  '「不確定」的全堆進 T3。')
P('寫進提示詞的判準是一句反問：**過一個月之後，你還會想知道「哪個檔案」嗎？** 不會，那就不是 T3。')
P('注意不能一刀切「T3 不准寫技術」：帳本裡有「我用了後台轉，他沒聽懂 —— 技術詞不該先於解釋」，'
  '那條**該留**，它是溝通教訓，不是專案細節。要禁的是檔案、命令、debug 過程。')

doc.add_heading('18.4　修好「反思在峰時還在燒 token」', level=2)
P('本人第二次提同一件事。總開關那一半早就對了：arm() 第一行就擋，force 也越不過。'
  '但谷時那一半真的漏了 —— 谷時檢查被寫在 if (!force) 裡面。')
code('// 修復前\nif (!force) {\n  if (store.cfg.valleyOnly && !v.ok) return ...\n  if (dutiesToday(now) >= dutyMaxPerDay) return ...\n}\n'
     '// 修復後：谷時移到 !force 外面\n')
P('於是 force:true（頁面按鈕、手動觸發）在尖峰時段照樣起一輪。用 git stash 對照驗證過：'
  '修復前峰時 arm({force:true}) 返回 ok:true 並建了排程，修復後返回 ok:false、一條都沒建。')
P('判斷原則：谷時是本人訂的「什麼時候可以燒 token」，不是排程的便利條件。'
  'force 的語義是「現在就要，不等到期」，不包括「連本人訂的谷時都不管」。'
  '每日上限則仍歸 force 管。')

doc.add_heading('18.5　新增測試：test/duty-gates.mjs', level=2)
P('八條斷言，釘住那些「沒有測試就很容易被下一次改動挪走」的閘：')
code('A1-A3  總開關關著：arm() / force:true / 顯式 kinds 三條路都攔\n'
     'A4     總開關關著：tick() 什麼都不起\n'
     'B1-B2  峰時：force 也攔得住\n'
     'B2b    inValley 的窗口判斷（中午谷時 / 下午峰時各一個點）\n'
     'B3     全新 Store 的 valleyOnly 默認值是 true')
P('B1 / B2 靠真實時鐘（arm() 內部用的是 inValley(Date.now())，假 store 騙不到它）。'
  '不是峰時就**明說「跳過」**，而不是靜悄悄 pass —— 靜悄悄 pass 等於這道閘從沒被釘住過。')

doc.add_heading('18.6　T4：整數權重、TTL 48 小時、半衰期跟著 TTL 走', level=2)
P('2026-11-25 本人定的三件事，合起來是把 T4 從「半小時的碎屑」改成「兩天內決定去留的候選」。')

P('① 升級用整數權重，不是小數置信度。')
code('weight: 1 = 順帶想起\n'
     '        2 = 這次真的把它跟別的事連起來、或證實了它\n'
     '門檻 3 ⇒ 兩次認真（2+2=4），或三次順帶（1+1+1=3）\n'
     '1+1=2 升不上去；1+2=3 升得上去')
P('為什麼換掉 0–0.5：模型要在 0.2 / 0.3 / 0.4–0.5 之間挑一個，**它挑不穩** —— '
  '那三個數字語義上沒有清楚分界，每次給的都不一樣，累加結果就不穩定。'
  '改成在 1 和 2 之間二選一，這件事它做得穩。而且算術透明，它自己能推「再兩次就留下來了」。')
P('schema 也簡單：enum [1, 2] 比 minimum/maximum 好驗證，描述能少寫一半字。')

P('② TTL 預設 48 小時，可調 24–168（1–7 天）。')
P('0 = 不過期 那個語義留著，但它是**特例**：填 0 就直接當 0，不然一律夾進 24–168。'
  '如果直接照 clamp(n, 24, 168) 寫，0 會被夾成 24，那個語義就沒了。')

P('③ 這一層沒有獨立半衰期 —— 半衰期跟著 TTL 走。')
code('const halfLife = m.tier === 4 ? (cfg.tier4TtlHours || 48) / 24 : TIERS[m.tier].halfLifeDays')
P('TIERS[4] 故意沒有 halfLifeDays 欄位：留著它就會變成第二個數字，'
  '改了 TTL 忘了改它，兩者就對不上。一個數字不會走岔。')
P('⚠️ 用 bornAt 算，不是 firstSeen：T4 的 firstSeen 截到小時（見 §4.1），'
  '拿它算 TTL 會讓條目最多早退 59 分鐘。真正的出生時刻在 bornAt。')

P('⚠️ 這一節也記一筆我犯的錯：我一度把可調範圍寫成 0–2160（90 天），'
  '理由是「舊的 240 小時太窄」。本人拉回 24–168。'
  '**範圍是本人訂的，不是我從「尺度合理性」推出來的。**')

doc.save(OUT)
print('saved:', OUT)
