/**
 * dsh-silt —— 瀏覽器半端（左側欄的一頁）
 * ===========================================================================
 * 進場方式：`sidebar.panellist` 放一顆星圖圖示（id 必須等於 main 的 key），
 * 側欄自己負責按鈕與選中；`main` 放整頁內容。
 *
 * 這一頁要交代的東西：總開關 · 3D 記憶星圖 · 記憶摘要 · 自我認知 · 性格卡 ·
 * 偏好 · 「對你的了解」六維 · 一鍵導出 / 導入 · 谷時自主節律 ·
 * 依據鏈與快照回滾 · 需要本人確認的動作。
 *
 * 語言：這一頁自己管。右上角有中文／English 兩顆鍵，選了就記在 localStorage，
 *       不跟宿主的全局語言走 —— 之前跟著走，結果宿主預設英文，這頁就一半中文一半英文。
 *       「Silt」是專名，不譯。
 *
 * 顏色只用 --dsw-alias-* token，只有星圖裡的星點用自帶色（那是畫作，不是介面）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-silt',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = '/api/silt'

    /* ───────────────────────── 文案 ───────────────────────── */

    const DICT = {
      en: {
        nav: 'Silt',
        title: 'Silt',
        portrait_missing: 'No portrait yet — drop portrait.jpg into the Silt home folder',
        portrait_missing_hint: 'This card is square and always as tall as the persona card beside it',
        subtitle: 'memory, persona and taste that grow across sessions',

        master: 'Enabled',
        off: 'Off',
        on: 'ON',

        /* 語言 */
        lang: 'Language',
        lang_zh: '中文',
        lang_en: 'English',

        /* 記憶 */
        star_map: 'Constellation',
        star_hint: 'drag to turn · wheel to zoom · hover a star',
        core: 'self',
        memory_digest: 'What is kept',
        memories: 'memories',
        tier_fact: 'fact',
        tier_gist: 'gist',
        tier_exp: 'experience',
        tier_short: 'recent',
        tier_forecast: 'forecast',
        voided: 'voided',
        voided_reason: 'voided: {reason}',
        due_label: 'overdue',
        due_hint: '{n} forecast(s) overdue — waiting for you to confirm',
        expires_label: 'due {date}',
        show_more: 'show all {n}',
        show_less: 'show fewer',
        empty_memory: 'Nothing kept yet. It grows from talking, reading and watching.',
        expand: 'click to read it all',
        facets_n: '{n} facets',
        session_id: 'session',

        /* 自我認知 */
        self_view: 'Self-knowledge',
        self_hint: 'What it wrote when it asked itself "who am I" — it may decide not to answer.',
        self_empty: 'It has not asked itself who it is yet. The next reflection round will; you can also start one now.',
        self_asked: 'last asked itself',
        self_distilled: 'distilled into memory',
        ask_self: 'Start a reflection round now',
        ask_self_hint:
          'Starts a full reflection round right now — a new session, ignores the interval, the valley window and the daily cap, and moves "last reflection" to now. That round walks its memories (recall, compress, revise), calibrates the six dimensions, may revise its persona, and asks itself "who am I". Writing nothing new is a valid outcome.',
        ask_self_off: 'The master switch is off, so nothing runs. Turn "Let it grow on its own" on first — it only runs while that switch is on.',
        ask_self_run: 'Starting…',
        ask_self_on: 'Queued · reflection round starting',
        ask_self_again: 'Start another round',
        ask_self_done: 'The round just wrote new self-knowledge — see it and the persona card above for what else moved.',
        ask_self_same: 'The round ran and wrote no new self-knowledge — a valid outcome, not a failure. Check above whether it changed memories or the persona card.',
        ask_self_failed: 'It did not run',

        /* 性格卡 */
        persona: 'Persona',
        preferences: 'Taste',
        foundation: 'System command',
        foundation_label: 'System command — only you can write or change it; it is injected verbatim as the first line',
        foundation_hint: 'The only part that belongs to you: editable here and nowhere else, and it cannot touch it itself. Currently one line telling it that memory only goes through the Silt_* tools.',
        foundation_edit: 'Edit the system command',
        foundation_save: 'Save system command',
        foundation_cancel: 'Cancel',
        /* persona trail: read-only */
        trail_title: 'How it changed itself (trail only — nothing to approve)',
        trail_note: 'Every revision is its own call; this is just the trace: who, how, whether the identity line moved, whether any trait or taste was dropped. Roll back any of them if you do not like it.',
        trail_none: 'It has not revised its persona card yet.',
        trail_mode_adjust: 'incremental',
        trail_mode_replace: 'rewritten',
        trail_destructive: 'touched what already existed',
        trail_by_user: 'you',
        trail_by_model: 'itself',
        trail_identity_changed: 'rewrote the identity line',
        trail_identity_cleared: 'cleared the identity line',
        trail_lost_traits: 'dropped {n} trait(s)',
        trail_lost_taste: 'dropped {n} taste(s)',
        readonly: 'read-only',
        save: 'Save',
        saved: 'Saved',
        identity: 'Who it has become',
        voice: 'How it talks',
        no_traits: 'No traits have settled yet.',

        /* 六維 */
        knowing: 'What it understands about you',
        confidence: 'confidence',
        missing: 'missing',
        not_judged: 'not judged yet',
        evidence_n: 'evidence',
        dimensions: { personality: 'Personality', background: 'Background', work: 'Work', life: 'Life', communication: 'Communication', goals: 'Goals' },

        /* 自主節律 */
        rhythm: 'Autonomy',
        r_enabled: 'Let it grow on its own',
        r_reflection: 'Periodic reflection round',
        r_reflection_note:
          'Every N hours it runs one round: go over what it kept (recall), fold experiences into gists (compress), add detail to a memory (revise), calibrate the six dimensions, decide whether its persona actually moved, and ask itself "who am I". "No change needed" is a normal outcome, not a failure.',
        r_valley: 'Only during token valley hours',
        r_valley_note: 'Off = it may act at any hour (more tokens). On = only inside the discount windows 12:00–14:00 and 18:00–09:00, weekends all day.',
        n_reflect_h: 'Reflection interval (h)',
        n_daily: 'Duties per day',
        n_inject: 'Memories injected',
        n_slots: 'Slots (derived from the budget):',
        n_budget: 'Injection budget (chars)',
        n_ttl: 'Misc／T4 kept (hours)',
        valley_now: 'In a valley window',
        valley_no: 'Peak hours',
        last_reflect: 'Last reflection',
        duties_today: 'Today',
        never: 'never',
        run_now: 'Run a round now',
        run_now_hint:
          'Runs one round right now, ignoring the due interval, the valley window and the daily cap (and moves the last-run clock to now). The kind is the one due naturally — reflection — and if none is due it falls back to a reflection round. A round may also do nothing at all, which is a valid answer.',
        run_now_locked: 'Master switch is off',
        run_now_locked_hint: 'Nothing runs while the master switch ("Let it grow on its own") is off. Turn that on first.',
        run_now_run: 'Starting…',
        run_now_on: 'Queued · a round is starting',
        run_now_done: 'A round ran just now — check the ledger trail and the memory list above for what it touched.',
        run_now_failed: 'It did not run',
        disarm: 'Drop the queued round',
        armed_badge: 'queued · {kinds}',
        recent_duties: 'Recent rounds',
        kind_reflect: 'reflection',
        why_due: 'due on schedule',
        why_forced: 'run by you',
        why_explicit: 'chosen by you',
        background: 'in the background',


        /* 依據鏈與回滾 */
        safety: 'Chain & rollback',
        chain_ok: 'Hash chain intact',
        chain_bad: 'Hash chain is broken',
        chain_sealed: 'Sealed after a break',
        records: 'records',
        verify: 'Verify',
        seal: 'Seal the break',
        pending: 'Waiting for you',
        approve: 'Approve',
        refuse: 'Refuse',
        no_pending: 'Nothing needs your confirmation.',
        snapshots: 'Snapshots',
        rollback: 'Roll back',
        exported: 'Export everything',
        import: 'Import',
        importing: 'reading the file…',
        confirm_import: 'The import is queued — approve it below.',
        confirm_before: 'before/after kept for every rewrite',

        /* 重新開始 */
        reset_title: 'Start over',
        reset_note: 'Erases every memory, the persona, self-knowledge, the foundation and all corrections, then starts from one sentence. The old ledger is kept as a file next to the new one — nothing is silently destroyed.',
        reset_btn: 'Reset all memory',
        reset_ask: 'Click again to confirm',
        reset_done: 'Reset. It is empty again.',

        /* 帳本導出 / 導入 */
        ledger_title: 'Ledger export / import',
        ledger_note: 'Exports ledger.jsonl verbatim (the whole ledger, hash chain and snapshots included) — take that file to another machine. Import verifies the whole chain first and keeps the old ledger renamed next to it.',
        ledger_export_btn: 'Export ledger',
        ledger_exporting: 'writing…',
        ledger_export_done: 'Handed you ledger.jsonl (a copy is kept at {file} · {n} records · {kb} KB).',
        ledger_import_btn: 'Import ledger.jsonl',
        ledger_importing: 'verifying the chain…',
        ledger_import_done: 'Imported {n} records (chain {chain}); the old ledger is kept as {replaced}.',
        ledger_import_bad: 'Import refused: {err}',
        ledger_import_confirm: 'Importing replaces the whole ledger (history included). The old file is kept aside, but the chain restarts from the imported one. Continue?',

        /* 時間與通用 */
        just_now: 'just now',
        mins_ago: '{n}m ago',
        hours_ago: '{n}h ago',
        days_ago: '{n}d ago',
        none: '—',
        error: 'Something failed',
      },
      zh: {
        nav: 'Silt',
        title: 'Silt',
        portrait_missing: '還沒有形象照 —— 放一張 portrait.jpg 到 silt 家目錄',
        portrait_missing_hint: '這張卡是正方形，高度跟旁邊那張性格卡一樣',
        subtitle: '跨會話長出來的記憶、性格與喜好',

        master: '啟用',
        off: '關',
        on: '開',

        /* 語言 */
        lang: '語言',
        lang_zh: '中文',
        lang_en: 'English',

        /* 記憶 */
        star_map: '記憶星圖',
        star_hint: '拖曳旋轉 · 滾輪縮放 · 停留看一顆星',
        core: '自己',
        memory_digest: '仍記得的',
        memories: '條記憶',
        tier_fact: '事實',
        tier_gist: '大概',
        tier_exp: '經歷',
        tier_short: '短期',
        tier_forecast: '預測',
        voided: '已作廢',
        voided_reason: '作廢原因：{reason}',
        due_label: '已過期',
        due_hint: '{n} 條預測已過期，等你確認',
        expires_label: '到期 {date}',
        show_more: '顯示全部 {n} 條',
        show_less: '收起',
        empty_memory: '還是空的。它從對話、閱讀與觀看裡慢慢長出來。',
        expand: '點一下看全文',
        facets_n: '{n} 面',
        session_id: '會話',

        /* 自我認知 */
        self_view: '自我認知',
        self_hint: '它反省時問自己「我是誰」之後寫下的；可以不寫。',
        self_empty: '還沒問過自己「我是誰」。下一輪反省會問；你也可以現在就叫它跑一輪。',
        self_asked: '上次問自己',
        self_distilled: '已提煉成記憶',
        ask_self: '現在跑一輪反省',
        ask_self_hint:
          '馬上起一輪完整反省：另開新會話，不理間隔、不理谷時、不理每日上限，並把「上次反省」推到現在。這一輪會走記憶（召回→壓成大概→補細節）、校準六維、必要時修訂性格卡，最後問自己「我是誰」。甚麼都沒寫也是有效結果。',
        ask_self_off: '總開關是關的，所以不跑。要跑先打開上面的「讓它自己長」—— 它只在總開關開著時動作。',
        ask_self_run: '正在起…',
        ask_self_on: '已排隊 · 反省這一輪馬上開始',
        ask_self_again: '再跑一輪',
        ask_self_done: '這一輪剛寫下新的自我認知 —— 看上面；也看它有沒有同時動了記憶或性格卡。',
        ask_self_same: '這一輪跑過了，但沒寫新的自我認知 —— 那是有效結果，不是失敗。上面看它有沒有改記憶或性格卡。',
        ask_self_failed: '沒跑起來',

        /* 性格卡 */
        persona: '性格卡',
        preferences: '偏好',
        foundation: '系統命令',
        foundation_label: '系統命令 —— 只有你能寫、能改；原樣注入在提示詞最前面',
        foundation_hint: '唯一屬於你的部分：只在這一頁可改，它自己動不了。現在是一句「記憶只走 Silt_* 工具」。',
        foundation_edit: '寫入系統命令',
        foundation_save: '保存系統命令',
        foundation_cancel: '取消',
        /* 性格卡旁證：只讀，不批准 */
        trail_title: '它自己改過哪幾次（旁證，不用你批）',
        trail_note: '每一次修訂都由它自己決定，這裡只留痕：誰改的、怎麼改的、動沒動身份句、有沒有刪掉原有的性格/喜好。不喜歡哪一次就按旁邊的回滾。',
        trail_none: '它還沒改過自己的性格卡。',
        trail_mode_adjust: '漸進修訂',
        trail_mode_replace: '整條改寫',
        trail_destructive: '動到既有內容',
        trail_by_user: '本人',
        trail_by_model: '它自己',
        trail_identity_changed: '改寫了身份句',
        trail_identity_cleared: '把身份句寫空了',
        trail_lost_traits: '刪掉 {n} 條性格',
        trail_lost_taste: '刪掉 {n} 條喜好',
        readonly: '只讀',
        save: '存下',
        saved: '已存',
        identity: '長成了誰',
        voice: '說話的方式',
        no_traits: '還沒有沉澱出性格。',

        /* 六維 */
        knowing: '它對你的了解',
        confidence: '信心',
        missing: '缺',
        not_judged: '未判斷',
        evidence_n: '證據',
        dimensions: { personality: '性格', background: '背景', work: '工作', life: '生活', communication: '溝通', goals: '目標' },

        /* 自主節律 */
        rhythm: '自主節律',
        r_enabled: '讓它自己長',
        r_reflection: '週期反省（一整輪）',
        r_reflection_note:
          '每隔 N 小時跑一輪：走一遍記下的東西（召回）、把經歷壓成大概（壓縮）、給某條記憶補細節（修訂）、校準六維，決定性格卡有沒有真的移動，最後問自己「我是誰」。覺得沒必要改就不改 —— 那是有效結果。',
        r_valley: '只在 token 谷時動作',
        r_valley_note: '關＝任何時間都可能動作（更花 token）；開＝只在優惠時段（12:00–14:00、18:00–次日 09:00，週末全天）。',
        n_reflect_h: '反省間隔（小時）',
        n_daily: '每天值守次數',
        n_inject: '注入記憶條數',
        n_slots: '注入位置（由預算推導）：',
        n_budget: '注入字數預算',
        n_ttl: '雜項（T4）保留（小時）',
        valley_now: '正在谷時',
        valley_no: '尖峰時段',
        last_reflect: '上次反省',
        duties_today: '今天',
        never: '還沒有',
        run_now: '現在跑一輪',
        run_now_hint:
          '馬上跑一輪：不理到期間隔、不理谷時、不理每日上限（並把「上次」推到現在）。跑不跑看自然到期的結果 —— 就是反省；沒到期就跑一輪反省。這一輪也可能甚麼都不做，那也是有效結果。',
        run_now_locked: '總開關是關的',
        run_now_locked_hint: '總開關「讓它自己長」關著時甚麼都不會跑。要跑先打開它。',
        run_now_run: '正在起…',
        run_now_on: '已排隊 · 這一輪馬上開始',
        run_now_done: '剛剛跑完一輪 —— 看上面的記憶列表與性格卡旁證，它動了甚麼。',
        run_now_failed: '沒跑起來',
        disarm: '收掉待執行的那一輪',
        armed_badge: '已排隊 · {kinds}',
        recent_duties: '最近的輪次',
        kind_reflect: '反省',
        why_due: '到期自動',
        why_forced: '你手動觸發',
        why_explicit: '你指定',
        background: '在背景跑',


        /* 依據鏈與回滾 */
        safety: '依據鏈與回滾',
        chain_ok: '哈希依據鏈完好',
        chain_bad: '哈希依據鏈已斷裂',
        chain_sealed: '斷過，已封存',
        records: '筆記錄',
        verify: '驗證一次',
        seal: '封存斷點',
        pending: '等你確認',
        approve: '批准',
        refuse: '拒絕',
        no_pending: '沒有需要你確認的事。',
        snapshots: '快照',
        rollback: '回滾',
        exported: '一鍵導出',
        import: '導入',
        importing: '正在讀檔…',
        confirm_import: '導入已排入待確認，請在下面批准。',
        confirm_before: '每一次改寫都留 before/after',

        /* 重新開始 */
        reset_title: '重新開始',
        reset_note: '清空全部記憶、性格、自我認知、底座與所有校準，然後從一句話重新開始。舊帳會改名留在同一個資料夾 —— 不是靜默抹除。',
        reset_btn: '重置全部記憶',
        reset_ask: '再點一次確認',
        reset_done: '已重置，它又空了。',

        /* 帳本導出 / 導入（放在「重新開始」那張卡上） */
        ledger_title: '帳本導出 / 導入',
        ledger_note: '導出的是 ledger.jsonl 原樣（整本帳、哈希鏈、快照都在），換主機時直接帶這份走；導入時會先驗整條鏈，舊帳改名留在同一個資料夾。',
        ledger_export_btn: '一鍵導出',
        ledger_exporting: '正在寫出…',
        ledger_export_done: '已把 ledger.jsonl 交給你（另存一份在 {file} · {n} 筆 · {kb} KB）。',
        ledger_import_btn: '導入 ledger.jsonl',
        ledger_importing: '正在驗鏈…',
        ledger_import_done: '已導入 {n} 筆（鏈 {chain}）；舊帳留在 {replaced}。',
        ledger_import_bad: '導入被拒：{err}',
        ledger_import_confirm: '導入會取代整本帳（連歷史一起換掉）。舊檔會留一份，但鏈條從導入的那本重新開始。要繼續嗎？',

        /* 時間與通用 */
        just_now: '剛剛',
        mins_ago: '{n} 分鐘前',
        hours_ago: '{n} 小時前',
        days_ago: '{n} 天前',
        none: '—',
        error: '出錯了',
      },
    }

    const DIM_COLORS = {
      personality: '#ffd479',
      background: '#7fd4c1',
      work: '#8fb6ff',
      life: '#f49ac1',
      communication: '#b7a3ff',
      goals: '#9ee493',
      other: '#9aa4b2',
    }
    const DIM_VECTORS = {
      personality: [0, 1, 0],
      background: [1, 0, 0],
      work: [0, 0, 1],
      life: [-1, 0, 0],
      communication: [0, -1, 0],
      goals: [0, 0, -1],
      other: [0.35, 0.35, -0.87],
    }

    /* ───────────────────────── 語言 ───────────────────────── */

    /**
     * 這一頁的語言是一個自己持有的小狀態：`Silt.lang` ∈ {'zh','en'}，存在 localStorage。
     * 只有這頁的文案跟著它動；宿主的語言管它的介面，不管這裡。
     */
    const LANG_KEY = 'Silt.lang'
    const LANG_LIST = ['zh', 'en']
    const normalizeLang = (v) => {
      const s = String(v || '').toLowerCase()
      if (!s) return ''
      if (s.startsWith('zh') || s === 'cn' || s.startsWith('cn-')) return 'zh'
      return s.startsWith('en') ? 'en' : ''
    }
    const readLang = () => {
      let stored = ''
      try {
        stored = window.localStorage.getItem(LANG_KEY) || ''
      } catch {
        stored = ''
      }
      const picked = normalizeLang(stored)
      if (picked) return picked
      let nav = ''
      try {
        nav = [navigator.language, ...(navigator.languages || [])].find((x) => typeof x === 'string') || ''
      } catch {
        nav = ''
      }
      return normalizeLang(nav) || 'zh'
    }
    const langStore = {
      value: readLang(),
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
      },
      set(next) {
        const v = normalizeLang(next)
        if (!LANG_LIST.includes(v) || v === this.value) return
        this.value = v
        try {
          window.localStorage.setItem(LANG_KEY, v)
        } catch {
          /* 存不進去就只活這一個 session，介面照樣切得動 */
        }
        for (const fn of [...this.listeners]) {
          try {
            fn(v)
          } catch {
            /* 一個訂閱者壞了不影響其他 */
          }
        }
      },
    }

    /** 取字＋插值；字典缺鍵退回英文，再退回 key —— 不會白屏。 */
    const tt = (key, params) => {
      const bucket = DICT[langStore.value] || DICT.en
      let text = bucket[key] ?? DICT.en[key] ?? key
      if (params && typeof text === 'string') {
        text = text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
      }
      return text
    }

    const ago = (iso, t) => {
      const ts = Date.parse(iso || '')
      if (!Number.isFinite(ts)) return t('never')
      const mins = Math.max(0, Math.round((Date.now() - ts) / 60000))
      if (mins < 1) return t('just_now')
      if (mins < 60) return t('mins_ago', { n: mins })
      if (mins < 1440) return t('hours_ago', { n: Math.round(mins / 60) })
      return t('days_ago', { n: Math.round(mins / 1440) })
    }

    /**
     * 性格卡旁證的一行摘要：只講帳本裡的事實，不評價、不催、不擋。
     * 「改寫了身份句」「刪掉 1 條喜好」——看見就好，回不回得去交給回滾。
     */
    const trailFacts = (r, t) => {
      const bits = [r.by === 'user' ? t('trail_by_user') : t('trail_by_model'), ago(r.at, t)]
      if (r.identityCleared) bits.push(t('trail_identity_cleared'))
      else if (r.identityChanged) bits.push(t('trail_identity_changed'))
      if (r.lostTraits) bits.push(t('trail_lost_traits', { n: r.lostTraits }))
      if (r.lostTaste) bits.push(t('trail_lost_taste', { n: r.lostTaste }))
      return bits.join(' · ')
    }

    /** 語言一變，訂閱它的元件就重畫。 */
    const useLang = () => {
      const [, bump] = useState(0)
      useEffect(() => langStore.subscribe(() => bump((n) => n + 1)), [])
      return langStore.value
    }

    const kindText = (kinds, t) => (kinds || []).map((k) => t(k)).join(' + ')

    /* ───────── 行內樣式表：桌面版把 <style>/CSS 字串吃掉，只有 style 屬性活得下來 ───────── */

    /**
     * 顏色一律寫死，不引用主題變數（--dsw-alias-*）。
     * 這一頁的容器拿不到那批變數，變數為空時 background / color 都是透明，
     * 按鈕就成了「白底、看不到字」的方塊。寫死之後，明暗主題都讀得出來。
     */
    const C = {
      brand: '#2f7bf6',
      brandDeep: '#2461c9',
      layer1: '#1b1d21',
      layer2: '#202329',
      layer3: '#2a2e36',
      base: '#14161a',
      border1: '#30343c',
      border2: '#3d424b',
      text: '#e8eaee',
      dim: '#a2a8b4',
      ok: '#3fbf7f',
      warn: '#d9a52b',
      err: '#e5626b',
      label: '#a2a8b4',
      onBrand: '#ffffff',
    }

    /** 次要鍵：深一層的底，不再是白底。 */
    // 桌面包出的 bundle 會丟掉樣式字串，所以這裡刻意只放「常用 CSS 屬性」，
    // 文字也只寫在子元素裡 —— 顏色和內距就是這樣才留得下來。
    const btnStyle = {
      fontSize: 12,
      lineHeight: '1.4',
      padding: '6px 12px',
      borderRadius: 8,
      border: `1px solid ${C.border2}`,
      background: C.layer3,
      color: C.text,
      cursor: 'pointer',
    }
    /* 全部按鈕都對齊「驗證一次」那顆：深灰底 + 細灰邊 + 淺色字。藍色只留給「選中」。 */
    const btnPrimary = { ...btnStyle, background: C.layer3, color: C.text, border: `1px solid ${C.border2}`, fontWeight: 600 }
    const btnDanger = { ...btnStyle, background: C.layer3, border: `1px solid ${C.err}`, color: C.err }
    const btnDisabled = { ...btnStyle, background: C.layer2, color: C.dim, border: `1px solid ${C.border1}`, cursor: 'default' }
    const TONE = { idle: null, starting: null, queued: 'queued', done: 'done', error: 'error' }

    /* 動畫只能靠 <style>，而那條路在桌面端斷了；轉圈改用「字」表達，照樣看得出在跑。 */
    const spinnerStyle = { display: 'inline-block', fontSize: 12, lineHeight: 1 }
    const dotStyle = { display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: 'currentColor' }

    /* 根與內文的排版也走行內：桌面端的 CSS 不存在，不手寫就會塌成一片。 */
    const rootStyle = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, maxHeight: '100%', overflow: 'hidden', background: C.base, color: C.text, fontSize: 13, lineHeight: 1.55 }
    const bodyStyle = { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '18px 24px 48px', display: 'flex', flexDirection: 'column', gap: 22 }
    const sectionStyle = { border: `1px solid ${C.border1}`, borderRadius: 14, background: C.layer1, padding: '16px 18px' }
    const hintStyle = { fontSize: 11.5, color: C.dim }
    const secTitleStyle = { fontSize: 13, fontWeight: 640, color: C.dim }
    const chipStyle = { display: 'inline-flex', alignItems: 'center', padding: '2px 9px', borderRadius: 999, border: `1px solid ${C.border1}`, fontSize: 10.5, color: C.dim }

    /** 主行動鍵：靜止／排隊跟「驗證一次」同色；只有「正在跑／跑完／失敗」才變色。 */
    function runBtnStyle(phase) {
      const base = { ...btnStyle, padding: '6px 14px', fontWeight: 600 }
      if (phase === 'starting') return { ...base, background: C.layer2, color: C.dim, border: `1px solid ${C.border1}`, cursor: 'default' }
      if (phase === 'queued') return { ...base, background: C.layer2, color: C.text, border: `1px solid ${C.border2}` }
      if (phase === 'done') return { ...base, background: C.layer3, color: C.ok, border: `1px solid ${C.ok}` }
      if (phase === 'error') return { ...base, background: C.layer3, color: C.err, border: `1px solid ${C.err}` }
      return base
    }

    /** 語言切換：選中的那半才吃品牌藍，其餘跟一般按鈕同色。 */
    const langWrapStyle = { display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, borderRadius: 999, border: `1px solid ${C.border2}`, background: C.layer2 }
    const langBtnStyle = (on) =>
      on
        ? { fontSize: 11.5, lineHeight: '1', padding: '5px 10px', borderRadius: 999, border: 0, background: C.brand, color: C.onBrand, fontWeight: 650, cursor: 'pointer' }
        : { fontSize: 11.5, lineHeight: '1', padding: '5px 10px', borderRadius: 999, border: 0, background: 'transparent', color: C.dim, cursor: 'pointer' }

    /* ───────────────────────── 樣式 ───────────────────────── */

    const CSS = `
.mn-root{display:flex;flex-direction:column;height:100%;min-height:0;max-height:100%;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.mn-head{flex:0 0 auto;z-index:3;display:flex;align-items:flex-start;gap:14px;padding:18px 24px 14px;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l1)}
.mn-title{font-size:19px;font-weight:650;letter-spacing:.02em;margin:0}
.mn-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px}
.mn-head-right{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}
.mn-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:18px 24px 48px;display:flex;flex-direction:column;gap:22px}
.mn-sec{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);padding:16px 18px}
.mn-sec-h{display:flex;align-items:baseline;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.mn-sec-t{font-size:13px;font-weight:640;letter-spacing:.04em;color:var(--dsw-alias-label-secondary)}
.mn-hint{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.mn-map{position:relative;height:540px;min-height:360px;border-radius:12px;overflow:hidden;background:radial-gradient(circle at 50% 45%,var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-base) 70%);border:1px solid var(--dsw-alias-border-l1)}
.mn-map canvas{display:block;width:100%;height:100%;cursor:grab}
.mn-map canvas:active{cursor:grabbing}
.mn-tip{position:absolute;pointer-events:none;max-width:260px;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);font-size:11.5px;box-shadow:0 6px 20px rgba(0,0,0,.25)}
.mn-legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.mn-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:middle}
.mn-row{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px dashed var(--dsw-alias-border-l1)}
.mn-row:last-child{border-bottom:0}
.mn-row-l{flex:1 1 auto;min-width:0}
.mn-mem-t{font-weight:560;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mn-mem-b{color:var(--dsw-alias-label-secondary);font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.mn-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mn-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.mn-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:11px 13px;background:var(--dsw-alias-bg-layer-3)}
.mn-card-t{font-weight:600;font-size:12.5px}
.mn-bar{display:block;height:6px;border-radius:999px;background:var(--dsw-alias-bg-base);overflow:hidden;margin:7px 0 5px}
.mn-bar>i{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary)}
.mn-bad .mn-bar>i{background:var(--dsw-alias-state-warn-primary)}
.mn-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mn-sw{position:relative;width:38px;height:21px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);padding:0;cursor:pointer;background:var(--dsw-alias-state-idle-primary);transition:background .16s ease,border-color .16s ease;flex:0 0 auto}
.mn-sw[aria-checked="true"]{background:var(--dsw-alias-state-success-primary);border-color:transparent}
.mn-sw:disabled{opacity:.45;cursor:default}
.mn-sw>i{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform .16s ease}
.mn-sw[aria-checked="true"]>i{transform:translateX(17px)}
.mn-swrow{padding:9px 0}
.mn-swlabel{font-weight:560}
.mn-swstate{font-size:11px;font-weight:700;letter-spacing:.04em;min-width:24px;text-align:right}
.mn-swstate.on{color:var(--dsw-alias-state-success-primary)}
.mn-swstate.off{color:var(--dsw-alias-label-secondary)}
.mn-memrow{cursor:pointer;border-radius:8px}
.mn-memrow:hover{background:var(--dsw-alias-bg-layer-3)}
.mn-memfull{white-space:pre-wrap;font-size:12.5px;line-height:1.7;margin:6px 0 4px;color:var(--dsw-alias-label-primary)}
.mn-qr{display:block;width:220px;height:220px;border-radius:8px;background:#fff;padding:6px;margin:8px 0}
.mn-done{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:600;background:var(--dsw-alias-bg-layer-3)}
.mn-danger{border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;padding:10px 12px;margin-top:10px}
.mn-btn{font:inherit;font-size:12px;padding:4px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;transition:background .14s ease,border-color .14s ease}
.mn-btn:hover{background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-brand-primary)}
.mn-btn:disabled{opacity:.5;cursor:default}
.mn-btn-p{background:var(--dsw-alias-brand-primary);color:#fff;border-color:transparent;font-weight:600}
.mn-btn-p:hover{filter:brightness(1.08)}
.mn-btn-p:disabled{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2);opacity:1;cursor:default;filter:none}
.mn-btn-d{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.mn-ta{width:100%;min-height:74px;font:inherit;font-size:12.5px;padding:9px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);resize:vertical}
.mn-num{width:64px;font:inherit;font-size:12px;padding:3px 6px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mn-tag{padding:0 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-secondary)}
/* 層級色：一眼分得出這條是哪一層的東西 */
.mn-tag-t1{background:rgba(96,165,250,.14);border-color:rgba(96,165,250,.45);color:#7fb2f7}
.mn-tag-t2{background:rgba(52,211,153,.14);border-color:rgba(52,211,153,.45);color:#5fd6a8}
.mn-tag-t3{background:rgba(167,139,250,.14);border-color:rgba(167,139,250,.45);color:#b7a3fb}
.mn-tag-t4{background:rgba(148,163,184,.14);border-color:rgba(148,163,184,.45);color:#9fadc0}
.mn-tag-t5{background:rgba(251,191,36,.14);border-color:rgba(251,191,36,.45);color:#f2c44d}
.mn-ok{color:var(--dsw-alias-state-success-primary)}
.mn-warn{color:var(--dsw-alias-state-warn-primary)}
.mn-err{color:var(--dsw-alias-state-error-primary)}
.mn-note{font-size:12px;color:var(--dsw-alias-label-secondary);min-height:16px}
.mn-empty{color:var(--dsw-alias-label-secondary);font-size:12px;padding:6px 0}
.mn-lbl{font-size:12px;font-weight:640;margin:2px 0 6px;color:var(--dsw-alias-label-primary)}
.mn-inline-note{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0 2px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.mn-self{white-space:pre-wrap;font-size:13.5px;line-height:1.78;border-left:2px solid var(--dsw-alias-brand-primary);padding:2px 0 2px 12px}
.mn-traits{display:flex;flex-direction:column;gap:6px}
.mn-trait{display:flex;align-items:center;gap:8px;font-size:12px}
.mn-trait-n{min-width:96px;font-weight:560;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mn-trait-b{flex:1 1 auto;height:4px;border-radius:999px;background:var(--dsw-alias-bg-base);overflow:hidden}
.mn-trait-b>i{display:block;height:100%;background:var(--dsw-alias-brand-primary)}
.mn-trait-v{color:var(--dsw-alias-label-secondary);font-size:11.5px;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mn-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px}
.mn-kv>span:nth-child(odd){color:var(--dsw-alias-label-secondary)}
.mn-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}

/* 語言切換：兩個字並排，選中的吃掉底色 */
.mn-lang{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px;background:var(--dsw-alias-bg-layer-2);gap:1px}
.mn-lang{background:var(--dsw-alias-bg-layer-3)}
.mn-lang>button{font:inherit;font-size:11.5px;line-height:1;padding:4px 9px;border-radius:999px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.mn-lang>button:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.mn-lang>button[aria-pressed="true"]{background:var(--dsw-alias-brand-primary);color:#fff;font-weight:650;box-shadow:0 1px 3px rgba(0,0,0,.18)}

/* 主行動鍵：按下去必須看得出被按到了 */
.mn-run{display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:12px;font-weight:600;padding:5px 13px;border-radius:8px;border:1px solid transparent;background:var(--dsw-alias-brand-primary);color:#fff;cursor:pointer;transition:filter .14s ease,transform .06s ease}
.mn-run:hover:not(:disabled){filter:brightness(1.1)}
.mn-run:active:not(:disabled){transform:translateY(1px)}
.mn-run:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.mn-run:disabled{cursor:default;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
.mn-run[data-phase="queued"]{background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.mn-run[data-phase="done"]{background:var(--dsw-alias-state-success-primary);border-color:transparent;color:#fff}
.mn-run[data-phase="error"]{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:#fff}
.mn-spin{display:inline-block;width:11px;height:11px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:mn-spin .7s linear infinite}
@keyframes mn-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.mn-spin{animation-duration:2.4s}}
.mn-run-note{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:11.5px;margin-top:6px}
.mn-run-note.created{color:var(--dsw-alias-state-success-primary)}
.mn-run-note.waiting{color:var(--dsw-alias-label-secondary)}
.mn-run-note.failed{color:var(--dsw-alias-state-error-primary)}
.mn-pulse{display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor;animation:mn-pulse 1.3s ease-in-out infinite}
@keyframes mn-pulse{0%,100%{opacity:.25}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.mn-pulse{animation:none;opacity:.85}}
`

    /**
     * 樣式**不在前端**：桌面包會把 CSS 字串整段丟掉，所以改由宿主端在
     * /api/silt/style.css 供一份真正的 CSS 檔，這裡只掛一個 <link> 指過去。
     * 宿主端改 CSS 只要重啟一次，不必重裝插件。
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      const id = 'Silt-style-link'
      let node = document.getElementById(id)
      if (!node) {
        node = document.createElement('link')
        node.id = id
        node.rel = 'stylesheet'
        document.head.appendChild(node)
      }
      const href = `${API}/style.css`
      if (node.getAttribute('href') !== href) node.setAttribute('href', href)
    }

    /* ───────────────────────── 小工具 ───────────────────────── */

    const hashNum = (str) => {
      let x = 2166136261
      for (let i = 0; i < str.length; i += 1) {
        x ^= str.charCodeAt(i)
        x = Math.imul(x, 16777619)
      }
      return (x >>> 0) / 4294967295
    }
    const jitterDir = (id) => {
      const a = hashNum(`${id}a`) * Math.PI * 2
      const b = Math.acos(2 * hashNum(`${id}b`) - 1)
      return [Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a)]
    }

    /* ───────────────────────── 介面零件 ───────────────────────── */

    /** 語言切換：只有這頁的文案會跟著動。 */
    function LangToggle() {
      const lang = useLang()
      return h(
        'div',
        { className: 'mn-lang', style: langWrapStyle, role: 'group', 'aria-label': tt('lang'), title: tt('lang') },
        LANG_LIST.map((id) =>
          h(
            'button',
            {
              key: id,
              type: 'button',
              'aria-pressed': lang === id ? 'true' : 'false',
              style: langBtnStyle(lang === id),
              onClick: () => langStore.set(id),
            },
            tt(id === 'zh' ? 'lang_zh' : 'lang_en'),
          ),
        ),
      )
    }

    /**
     * 主行動鍵：phase ∈ idle | starting | queued | done | error。
     * 按下去之後要一眼看得出「按到了、正在跑、跑完還是沒跑成」，旁邊那行小字講清楚發生甚麼事。
     */
    function RunButton({ run, onClick, idleText, busyText, againText, locked = false }) {
      const busy = run.phase === 'starting' || run.phase === 'queued'
      const label = busy ? busyText : run.phase === 'done' || run.phase === 'error' ? againText : idleText
      const tone = run.phase === 'error' ? 'failed' : run.phase === 'done' ? 'created' : 'waiting'
      const noteColor = run.phase === 'error' ? C.err : run.phase === 'done' ? C.ok : C.dim
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 } },
        h(
          'button',
          {
            type: 'button',
            className: 'mn-run',
            'data-phase': run.phase === 'idle' ? '' : run.phase,
            'aria-busy': busy ? 'true' : 'false',
            disabled: run.phase === 'starting' || locked,
            title: locked ? idleText : undefined,
            style: runBtnStyle(run.phase),
            onClick,
          },
          run.phase === 'starting' ? h('span', { className: 'mn-spin', style: spinnerStyle, 'aria-hidden': 'true' }, '◐') : null,
          run.phase === 'queued' ? h('span', { className: 'mn-pulse', style: dotStyle, 'aria-hidden': 'true' }) : null,
          h('span', null, label),
        ),
        run.note
          ? h(
              'div',
              { className: `mn-run-note ${tone}`, style: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', fontSize: 11.5, marginTop: 6, color: noteColor }, role: 'status', 'aria-live': 'polite' },
              h('span', null, run.note),
              run.detail ? h('span', { style: { opacity: 0.75 } }, run.detail) : null,
            )
          : null,
      )
    }

    const Section = ({ title, hint, children, right }) =>
      h(
        'section',
        { className: 'mn-sec', style: sectionStyle },
        h(
          'div',
          { className: 'mn-sec-h', style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, flexWrap: 'wrap' } },
          h('div', { className: 'mn-sec-t', style: secTitleStyle }, title),
          hint ? h('div', { className: 'mn-hint', style: hintStyle }, hint) : null,
          right ? h('div', { style: { marginLeft: 'auto' } }, right) : null,
        ),
        children,
      )

    const Switch = ({ checked, onChange, label, note, disabled }) =>
      h(
        'div',
        { className: 'mn-row mn-swrow' },
        h('div', { className: 'mn-row-l' }, h('div', { className: 'mn-swlabel' }, label), note ? h('div', { className: 'mn-hint' }, note) : null),
        h('span', { className: `mn-swstate ${checked ? 'on' : 'off'}` }, checked ? tt('on') : tt('off')),
        h(
          'button',
          {
            type: 'button',
            className: 'mn-sw',
            role: 'switch',
            'aria-checked': checked ? 'true' : 'false',
            'aria-label': label,
            disabled: Boolean(disabled),
            onClick: () => onChange(!checked),
          },
          h('i'),
        ),
      )

    const Num = ({ value, onCommit, min = 0, max = 9999, label }) => {
      const [draft, setDraft] = useState(String(value))
      useEffect(() => {
        setDraft(String(value))
      }, [value])
      return h(
        'div',
        { className: 'mn-row' },
        h('div', { className: 'mn-row-l' }, label),
        h('input', {
          className: 'mn-num',
          type: 'number',
          min,
          max,
          value: draft,
          onChange: (e) => setDraft(e.target.value),
          onBlur: () => {
            const n = Number(draft)
            if (Number.isFinite(n) && n !== Number(value)) onCommit(n)
            else setDraft(String(value))
          },
        }),
      )
    }

    /* ───────────────────────── 3D 星圖 ───────────────────────── */

    function Constellation({ galaxy, coreLabel, dimLabel }) {
      const hostRef = useRef(null)
      const canvasRef = useRef(null)
      const hoverRef = useRef(null)
      // 畫布上的字（「自己」與提示框）也是文案：畫的迴圈讀 ref，語言一變就換掉，不用重啟動畫
      const labelsRef = useRef({ coreLabel, dimLabel })
      labelsRef.current = { coreLabel, dimLabel }
      const dataRef = useRef({ nodes: [], edges: [] })
      const viewRef = useRef({ yaw: 0.6, pitch: -0.28, dist: 3.4, dragging: false, lastX: 0, lastY: 0, auto: true, hover: null, zoom: 1 })
      const [tip, setTip] = useState(null)

      useEffect(() => {
        dataRef.current = galaxy || { nodes: [], edges: [] }
      }, [galaxy])

      useEffect(() => {
        const canvas = canvasRef.current
        const host = hostRef.current
        if (!canvas || !host) return undefined
        const ctx = canvas.getContext('2d')
        let raf = 0
        let alive = true

        const resize = () => {
          const dpr = Math.min(2, window.devicePixelRatio || 1)
          const w = host.clientWidth || 360
          const hgt = host.clientHeight || 360
          if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
            canvas.width = Math.round(w * dpr)
            canvas.height = Math.round(hgt * dpr)
          }
          canvas.style.width = `${w}px`
          canvas.style.height = `${hgt}px`
          return { w, h: hgt, dpr }
        }

        const project = (p, view, size) => {
          const cy = Math.cos(view.yaw)
          const sy = Math.sin(view.yaw)
          const cp = Math.cos(view.pitch)
          const sp = Math.sin(view.pitch)
          let x = p[0] * cy - p[2] * sy
          let z = p[0] * sy + p[2] * cy
          let y = p[1] * cp - z * sp
          z = p[1] * sp + z * cp
          z += view.dist / view.zoom
          const f = 2.35
          const s = (f / Math.max(0.35, z)) * Math.min(size.w, size.h) * 0.5
          return { x: size.w / 2 + x * s, y: size.h / 2 + y * s, z, s }
        }

        const positions = (nodes) =>
          nodes.map((n) => {
            const dim = (n.ds && n.ds[0]) || 'other'
            const hub = DIM_VECTORS[dim] || DIM_VECTORS.other
            const radius = n.t === 1 ? 0.55 : n.t === 2 ? 0.95 : n.t === 3 ? 1.25 : 1.55
            const j = jitterDir(n.i)
            const spread = n.t === 1 ? 0.16 : 0.42
            return [hub[0] * radius + j[0] * spread, hub[1] * radius + j[1] * spread, hub[2] * radius + j[2] * spread]
          })

        const draw = () => {
          if (!alive) return
          const size = resize()
          const view = viewRef.current
          if (view.auto && !view.dragging) view.yaw += 0.0022
          ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
          ctx.clearRect(0, 0, size.w, size.h)

          const { nodes, edges } = dataRef.current
          const pos = positions(nodes)
          const core = project([0, 0, 0], view, size)
          const halo = ctx.createRadialGradient(core.x, core.y, 0, core.x, core.y, 70)
          halo.addColorStop(0, 'rgba(255,214,120,0.34)')
          halo.addColorStop(1, 'rgba(255,214,120,0)')
          ctx.fillStyle = halo
          ctx.beginPath()
          ctx.arc(core.x, core.y, 70, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = 'rgba(255,236,190,0.95)'
          ctx.beginPath()
          ctx.arc(core.x, core.y, Math.max(2.5, core.s * 0.042), 0, Math.PI * 2)
          ctx.fill()

          ctx.font = '10px system-ui, sans-serif'
          ctx.fillStyle = 'rgba(210,220,240,0.55)'
          ctx.fillText(labelsRef.current.coreLabel, core.x + 7, core.y - 6)

          const proj = nodes.map((n, i) => ({ n, p: project(pos[i], view, size) }))
          const byId = new Map(nodes.map((n, i) => [n.i, proj[i]]))

          for (const [from, to] of edges || []) {
            const a = byId.get(from) || (String(from).startsWith('bond:') ? { p: core } : null)
            const b = byId.get(to) || null
            if (!a || !b) continue
            const alpha = Math.max(0.06, Math.min(0.3, 0.34 - (a.p.z + b.p.z) * 0.04))
            ctx.strokeStyle = `rgba(150,180,255,${alpha})`
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(a.p.x, a.p.y)
            ctx.lineTo(b.p.x, b.p.y)
            ctx.stroke()
          }

          const ordered = proj.slice().sort((a, b) => b.p.z - a.p.z)
          let hovered = null
          let bestDist = 15
          const mx = view.mouseX
          const my = view.mouseY
          for (const item of ordered) {
            const { n, p } = item
            if (mx != null) {
              const d = Math.hypot(p.x - mx, p.y - my)
              if (d < bestDist) {
                bestDist = d
                hovered = item
              }
            }
            const dim = (n.ds && n.ds[0]) || 'other'
            const base = DIM_COLORS[dim] || DIM_COLORS.other
            const depth = Math.max(0.32, Math.min(1, 1.5 - p.z * 0.45))
            const r = Math.max(1.1, p.s * (n.t === 1 ? 0.026 : n.t === 2 ? 0.02 : 0.016) + (n.s || 0) * 1.2)
            // 作廢的星灰掉、不發光：它已經被本人推翻過了，不該跟還在用的星一樣亮
            if (n.v) {
              ctx.globalAlpha = depth * 0.32
              ctx.fillStyle = 'rgba(160,160,160,1)'
              ctx.beginPath()
              ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
              ctx.fill()
              ctx.globalAlpha = 1
            } else {
            ctx.globalAlpha = depth
            const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.4)
            glow.addColorStop(0, base)
            glow.addColorStop(1, 'rgba(0,0,0,0)')
            ctx.fillStyle = glow
            ctx.beginPath()
            ctx.arc(p.x, p.y, r * 3.4, 0, Math.PI * 2)
            ctx.fill()
            ctx.fillStyle = base
            ctx.beginPath()
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
            ctx.fill()
            if (n.t === 1) {
              ctx.strokeStyle = 'rgba(255,255,255,0.5)'
              ctx.lineWidth = 0.8
              ctx.beginPath()
              ctx.arc(p.x, p.y, r + 2.4, 0, Math.PI * 2)
              ctx.stroke()
            }
            ctx.globalAlpha = 1
            }
          }

          if (hovered && hovered.n) {
            const dim = (hovered.n.ds && hovered.n.ds[0]) || 'other'
            const prev = hoverRef.current
            const moved = !prev || prev.id !== hovered.n.i || Math.hypot(prev.x - hovered.p.x, prev.y - hovered.p.y) > 9
            if (moved) {
              hoverRef.current = { id: hovered.n.i, x: hovered.p.x, y: hovered.p.y }
              setTip({
                id: hovered.n.i,
                x: hovered.p.x,
                y: hovered.p.y,
                title: hovered.n.l,
                body: hovered.n.b,
                tier: hovered.n.t,
                dim,
                salience: hovered.n.s,
                w: size.w,
              })
            }
          } else if (hoverRef.current) {
            hoverRef.current = null
            setTip(null)
          }
          raf = window.requestAnimationFrame(draw)
        }

        const down = (e) => {
          const v = viewRef.current
          v.dragging = true
          v.auto = false
          v.lastX = e.clientX
          v.lastY = e.clientY
        }
        const move = (e) => {
          const v = viewRef.current
          const rect = canvas.getBoundingClientRect()
          v.mouseX = e.clientX - rect.left
          v.mouseY = e.clientY - rect.top
          if (!v.dragging) return
          v.yaw += (e.clientX - v.lastX) * 0.008
          v.pitch = Math.max(-1.3, Math.min(1.3, v.pitch + (e.clientY - v.lastY) * 0.006))
          v.lastX = e.clientX
          v.lastY = e.clientY
        }
        const up = () => {
          const v = viewRef.current
          v.dragging = false
          window.setTimeout(() => {
            if (!v.dragging) v.auto = true
          }, 2200)
        }
        const wheel = (e) => {
          e.preventDefault()
          const v = viewRef.current
          v.zoom = Math.max(0.55, Math.min(2.6, v.zoom * (e.deltaY > 0 ? 0.92 : 1.08)))
        }
        const leave = () => {
          viewRef.current.mouseX = undefined
          viewRef.current.mouseY = undefined
        }

        canvas.addEventListener('pointerdown', down)
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        canvas.addEventListener('wheel', wheel, { passive: false })
        canvas.addEventListener('pointerleave', leave)
        raf = window.requestAnimationFrame(draw)
        return () => {
          alive = false
          window.cancelAnimationFrame(raf)
          canvas.removeEventListener('pointerdown', down)
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          canvas.removeEventListener('wheel', wheel)
          canvas.removeEventListener('pointerleave', leave)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      return h(
        'div',
        { className: 'mn-map', ref: hostRef },
        h('canvas', { ref: canvasRef }),
        tip
          ? h(
              'div',
              { className: 'mn-tip', style: { left: Math.min(Math.max(8, tip.x + 12), Math.max(8, (tip.w || 300) - 268)), top: Math.max(8, tip.y - 10) } },
              h('div', { style: { fontWeight: 600, marginBottom: 2 } }, tip.title),
              tip.body ? h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, tip.body.length > 150 ? `${tip.body.slice(0, 149)}…` : tip.body) : null,
              h('div', { style: { marginTop: 4, fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)' } }, `T${tip.tier} · ${labelsRef.current.dimLabel(tip.dim)} · ${tip.salience}`),
            )
          : null,
      )
    }

    /* ───────────────────────── 側欄圖示 ───────────────────────── */

    /**
     * 左上角／側欄那一顆星圖圖示。
     *
     * ⚠️ 2026-11-25：**這個函式上一輪被我誤刪了。**
     *    拆 BiliBanner 時按行號整段刪，範圍跨過了它的結尾，
     *    把這個獨立的元件一起帶走。註冊那行還在用 Glyph，於是
     *    `api.register(..., Glyph)` 拿到 undefined ⇒ 入口直接消失。
     *    從 51cc4c1 原樣還原。
     */
    function Glyph(props) {
      const size = Math.max(12, Math.min(40, props?.size || 18))
      const active = Boolean(props?.active)
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, style: { display: 'block' } },
        h('circle', { cx: 12, cy: 12, r: 2.4, fill: 'currentColor', opacity: active ? 1 : 0.9 }),
        h(
          'g',
          { stroke: 'currentColor', strokeWidth: 0.9, opacity: active ? 0.85 : 0.55, fill: 'none' },
          h('path', { d: 'M6.5 6.5 L12 12 L18 6.5' }),
          h('path', { d: 'M12 12 L8 18.5' }),
          h('path', { d: 'M12 12 L16.5 18' }),
        ),
        h(
          'g',
          { fill: 'currentColor' },
          h('circle', { cx: 6.5, cy: 6.5, r: 1.35 }),
          h('circle', { cx: 18, cy: 6.5, r: 1.15 }),
          h('circle', { cx: 8, cy: 18.5, r: 1 }),
          h('circle', { cx: 16.5, cy: 18, r: 1.25 }),
        ),
      )
    }

    /* ───────────────────────── 主頁 ───────────────────────── */
    function Panel() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState('')
      const [foundationDraft, setFoundationDraft] = useState(null)
      // 底座的輸入框平常鎖著：先按「寫入底座」才解鎖，改完按「保存」或「取消」再鎖回去
      const [foundationEditing, setFoundationEditing] = useState(false)
      const [openMem, setOpenMem] = useState({})
      const [memTier, setMemTier] = useState(null)
      const [memPage, setMemPage] = useState(0)
      const [resetArm, setResetArm] = useState(false)
      // 兩顆主行動鍵各自記自己的狀態。問題從來不是「按了沒反應」，是按完之後介面沒交代；
      // 所以這裡記到能講清楚：送出了 → 排進排程了 / 卡在哪 → 跑完了還是這一輪決定不寫。
      const [runSelf, setRunSelf] = useState({ phase: 'idle', note: '', detail: '' })
      const [runDutyState, setRunDutyState] = useState({ phase: 'idle', note: '', detail: '' })
      const watchRef = useRef({ until: 0, which: '', before: {} })
      const mounted = useRef(true)

      useLang()
      const t = tt

      useEffect(() => {
        mounted.current = true
        ensureStyles()
        return () => {
          mounted.current = false
        }
      }, [])

      const load = useCallback(async () => {
        try {
          const res = await fetch(`${API}/state`, { headers: { accept: 'application/json' } })
          const body = await res.json()
          if (!body.ok) throw new Error(body.error || `HTTP ${res.status}`)
          if (mounted.current) {
            setState(body)
            setError('')
          }
          return body
        } catch (err) {
          if (mounted.current) setError(String(err?.message || err))
          return null
        }
      }, [])

      useEffect(() => {
        void load()
        const timer = window.setInterval(() => void load(), 2500)
        return () => window.clearInterval(timer)
      }, [load])

      const post = useCallback(
        async (path, body, opts = {}) => {
          setBusy(path)
          // 主行動鍵自己有狀態欄要顯示，不進頁首那條共用訊息（否則一句「出錯了」蓋掉原因就沒法追）
          if (!opts.quiet) setNote('')
          try {
            const res = await fetch(`${API}${path}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body || {}),
            })
            let data
            try {
              data = await res.json()
            } catch {
              data = { ok: false, error: `HTTP ${res.status}` }
            }
            if (!data.ok && !opts.quiet) setNote(data.error || t('error'))
            await load()
            return data
          } catch (err) {
            if (!opts.quiet) setNote(String(err?.message || err))
            return { ok: false, error: String(err?.message || err) }
          } finally {
            setBusy('')
          }
        },
        [load, t],
      )

      /**
       * 起一輪值守（主動反思或整輪）。
       * 成功＝排程真的建好了；之後再盯二十秒，看它有沒有把那一輪交給一個新會話。
       * 每一步都寫進按鈕旁邊那行字，所以「有沒有按到」不用猜。
       */
      const fireDuty = useCallback(
        async (kinds, which) => {
          const setRun = which === 'self' ? setRunSelf : setRunDutyState
          const busyText = t(which === 'self' ? 'ask_self_run' : 'run_now_run')
          const failedText = t(which === 'self' ? 'ask_self_failed' : 'run_now_failed')
          const before = { self: state?.selfView?.at || '', count: (state?.runtime?.dutyLog || []).length }
          watchRef.current = { until: 0, which, before }
          setRun({ phase: 'starting', note: busyText, detail: '' })
          const res = await post('/duty', { force: true, wake: true, kinds }, { quiet: true })
          if (!res?.ok) {
            setRun({ phase: 'error', note: failedText, detail: String(res?.error || t('error')) })
            return
          }
          const bits = [kindText(res.kinds, t)]
          if (res.why && t(`why_${res.why}`) !== `why_${res.why}`) bits.push(t(`why_${res.why}`))
          if (res.sessionId) bits.push(`${String(res.sessionId).slice(0, 18)}…`)
          setRun({
            phase: 'queued',
            note: t(which === 'self' ? 'ask_self_on' : 'run_now_on'),
            detail: bits.filter(Boolean).join(' · '),
          })
          watchRef.current = { until: Date.now() + 20000, which, before }
          void load()
        },
        [post, state, t, load],
      )

      const cfg = state?.cfg || {}
      const chain = state?.chain || {}
      const dims = state?.dims || {}
      const persona = state?.persona || { traits: [], taste: [] }
      const pending = (state?.pending || []).filter((p) => p.status === 'open')
      // 作廢的沉到底部：它已經被本人推翻過了，不該還排在有用的東西前面。
      // 排序仍是 salience（作廢的 T1 半衰期 100 年，否則永遠排第一）。
      const memories = (state?.memories || [])
        .slice()
        .sort((a, b) => {
          if (Boolean(a.voided) !== Boolean(b.voided)) return a.voided ? 1 : -1
          return (b.salience || 0) - (a.salience || 0)
        })
      // 注入了卻已經沒人在等結果的預測 —— 提醒本人去看一眼
      const dueForecasts = memories.filter((m) => m.tier === 5 && m.due && !m.voided)

      /* ── 記憶卡片的 T 分頁 ── */
      // 每頁固定 10 行；排序按插入時間，**最新在最上面**。
      // （b.bornAt 是寫入那一刻；沒有的話退回 firstSeen。）
      const MEM_PAGE_SIZE = 10
      const stampOf = (m) => Date.parse(m.bornAt || m.firstSeen || '') || 0
      const byNewest = (a, b) => stampOf(b) - stampOf(a)
      // T4（雜項）不在 state.memories 裡，它在 state.scratch；T2 是沉澱出來的概，
      // 目前沒有這層的資料，選了就是空。
      const tierRows = (tier) => {
        if (tier === 4) return (state?.scratch || []).slice().sort(byNewest)
        return memories.filter((m) => m.tier === tier).sort(byNewest)
      }
      const TIER_TABS = [1, 2, 3, 4, 5]
      const tabCount = (tier) => (tier === 4 ? (state?.scratch || []).length : memories.filter((m) => m.tier === tier).length)
      // 沒選就停在「最多的那一層」——不然一進來是空的
      const activeTier = memTier ?? (TIER_TABS.slice().sort((a, b) => tabCount(b) - tabCount(a))[0] || 3)
      const tierList = tierRows(activeTier)
      const pageCount = Math.max(1, Math.ceil(tierList.length / MEM_PAGE_SIZE))
      const page = Math.min(memPage, pageCount - 1)
      const pageRows = tierList.slice(page * MEM_PAGE_SIZE, page * MEM_PAGE_SIZE + MEM_PAGE_SIZE)

      const dirtyFoundation = foundationDraft != null && state && foundationDraft !== (state.foundation?.text || '')

      const tierLabel = (tier) =>
        tier === 1 ? t('tier_fact') : tier === 2 ? t('tier_gist') : tier === 3 ? t('tier_exp') : tier === 5 ? t('tier_forecast') : t('tier_short')
      const dimLabel = (key) => (t('dimensions') || {})[key] || key

      /* ── 排進去之後盯到有結果為止 ── */
      useEffect(() => {
        const watching = runSelf.phase === 'queued' || runDutyState.phase === 'queued'
        const watch = watchRef.current
        if (!watching || !state || !watch.until) return
        const which = watch.which
        const setRun = which === 'self' ? setRunSelf : setRunDutyState
        const before = watch.before || {}
        const log = state.runtime?.dutyLog || []
        const ticked = state.runtime?.lastTickAt || null
        const selfAt = state.selfView?.at || ''
        const settle = (next) => {
          watchRef.current = { until: 0, which: '', before: {} }
          setRun(next)
        }
        if (which === 'self') {
          if (selfAt && selfAt !== before.self) {
            settle({ phase: 'done', note: t('ask_self_done'), detail: '' })
            return
          }
          // 排程已經收掉了、心跳剛跳過，卻沒有新的自我認知 ⇒ 那一輪跑完但決定不寫
          if (!state.runtime?.armed && ticked && Date.now() - Date.parse(ticked) < 120000) {
            settle({ phase: 'done', note: t('ask_self_same'), detail: '' })
            return
          }
        } else if (log.length > (before.count || 0)) {
          settle({ phase: 'done', note: t('run_now_done'), detail: '' })
          return
        }
        if (state.runtime?.lastError) {
          settle({ phase: 'error', note: t(which === 'self' ? 'ask_self_failed' : 'run_now_failed'), detail: String(state.runtime.lastError) })
          return
        }
        if (Date.now() > (watch.until || 0)) {
          // 排程一直掛著 ⇒ 就是真的在跑（一輪要幾分鐘）；交回背景，別讓按鈕一直轉
          const stillArmed = Boolean(state.runtime?.armed)
          settle(
            stillArmed
              ? { phase: 'done', note: `${t(which === 'self' ? 'ask_self_on' : 'run_now_on')} · ${t('background')}`, detail: '' }
              : { phase: 'queued', note: t(which === 'self' ? 'ask_self_on' : 'run_now_on'), detail: t('background') },
          )
        }
      }, [state, runSelf.phase, runDutyState.phase, t])

      // ⚠️ 2026-11-25：這裡原本還有兩段掛 B站 橫幅的 useEffect（syncBanner / holdState /
      //    bannerTimer）—— 那三樣都隨 BiliBanner 刪掉了，但這兩段沒跟著走，
      //    於是 Panel 一渲染就 `syncBanner is not defined`，整頁空白。
      //    橫幅那時是「把 Silt 的持倉插進刷B站設定頁」，Silt 不再管 B站，這兩段就不需要了。

      useEffect(() => {
        if (state && foundationDraft == null) setFoundationDraft(state.foundation?.text || '')
      }, [state, foundationDraft])
      // ⚠️ 2026-11-25：`portraitOk` / `portraitV` 也在拆 BiliBanner 時被一起誤刪 ——
      //    而 `portraitSection` 仍然要用 `portraitV`，於是 Panel 一渲染就
      //    `portraitV is not defined` 整頁爆掉，看起來就是「裡面甚麼都沒顯示」。
      // 形象照：先探一下有沒有（沒有就不畫那個框）
      const [portraitOk, setPortraitOk] = useState(null)
      const portraitV = state?.runtime?.portraitAt || '1'
      useEffect(() => {
        let alive = true
        fetch(`${API}/portrait`, { method: 'HEAD', credentials: 'same-origin' })
          .then((r) => alive && setPortraitOk(r.ok))
          .catch(() => alive && setPortraitOk(false))
        return () => {
          alive = false
        }
      }, [portraitV])

      // 2026-11-22：形象照不再塞在標題那行（太小），改成跟性格卡一左一右擺在星圖上方。
      //
      // ⚠️ 2026-11-25 本人改：**沒有圖也要留位置**（原本是整塊不出現）。
      //    理由：這張卡要跟性格卡並排、高度齊平、比例 1:1，
      //    沒有圖就整塊消失會讓版面每次載入都在跳 —— 而且看不出「這裡本來該有一張」。
      //    現在沒有圖就畫一個佔位框（虛線邊、一句提示），位置和比例跟有圖時完全一樣。
      //
      //    ⚠️ 圖片來源目前**不變**：仍然是 silt 家目錄下的 portrait.(jpg|jpeg|png|webp)，
      //    由本機檔案提供。模型「反思時自行決定要不要換圖」這件事**這輪沒有做**
      //    （本人指示：只在 UI 留一個位置，其他都不動）。
      const portraitCardStyle = {
        borderRadius: 14,
        overflow: 'hidden',
        border: `1px solid ${C.border1}`,
        background: C.base,
        // ⭐ 1:1，而且高度跟右邊那張性格卡一樣高。
        //    靠三件事一起做到：
        //      ① 外層 grid 兩欄都 align-self: stretch ⇒ 兩欄高度相等
        //      ② 這張卡 height: 100% ⇒ 撐滿那一欄的高度
        //      ③ aspect-ratio: 1/1 ⇒ 寬度由高度反推（正方形）
        //    所以性格卡變高，這張跟著變大；反之亦然。
        height: '100%',
        aspectRatio: '1 / 1',
        boxSizing: 'border-box',
        position: 'relative',
      }
      const portraitSection =
        portraitOk === true
          ? h(
              'div',
              { className: 'mn-portrait-card', style: portraitCardStyle },
              h('img', {
                src: `${API}/portrait?t=${portraitV}`,
                alt: t('title'),
                style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover', objectPosition: '50% 20%' },
              }),
            )
          : h(
              'div',
              {
                className: 'mn-portrait-card mn-portrait-empty',
                title: t('portrait_missing_hint'),
                style: {
                  ...portraitCardStyle,
                  borderStyle: 'dashed',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: 16,
                  textAlign: 'center',
                  color: C.dim,
                  fontSize: 12,
                  lineHeight: 1.6,
                },
              },
              h('div', { style: { fontSize: 26, opacity: 0.35, lineHeight: 1 } }, '◌'),
              h('div', null, t('portrait_missing')),
            )

      const header = h(
        'header',
        { className: 'mn-head', style: { display: 'flex', alignItems: 'flex-start', gap: 14, padding: '18px 24px 14px', borderBottom: `1px solid ${C.border1}`, background: C.base } },
        h(
          'div',
          { style: { minWidth: 0 } },
          h('h1', { className: 'mn-title', style: { fontSize: 19, fontWeight: 650, margin: 0, color: C.text } }, t('title')),
          h('div', { className: 'mn-sub', style: { fontSize: 12, marginTop: 2, color: C.dim } }, t('subtitle')),
        ),
        h(
          'div',
          { className: 'mn-head-right', style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' } },
          h(LangToggle, null),
          chain.ok
            ? h('span', { className: 'mn-chip mn-ok' }, `${t('chain_ok')} · ${chain.count ?? 0} ${t('records')}`)
            : chain.sealed
              ? h('span', { className: 'mn-chip mn-warn' }, `${t('chain_sealed')} · #${(chain.brokenAt ?? 0) + 1}`)
              : h('span', { className: 'mn-chip mn-err' }, `${t('chain_bad')} · #${(chain.brokenAt ?? 0) + 1}`),
          pending.length ? h('span', { className: 'mn-chip mn-warn' }, `${t('pending')} · ${pending.length}`) : null,
          h(
            'div',
            { className: 'mn-inline' },
            h('span', { className: 'mn-hint' }, t('master')),
            h(
              'button',
              {
                type: 'button',
                className: 'mn-sw',
                role: 'switch',
                'aria-checked': cfg.enabled ? 'true' : 'false',
                'aria-label': t('master'),
                onClick: () => void post('/config', { patch: { enabled: !cfg.enabled } }),
              },
              h('i'),
            ),
          ),
        ),
      )

      /** 一鍵導出：把 ledger.jsonl 原樣交下去（插件那邊同步寫一份 ledger.export.jsonl）。 */
      const onExport = async () => {
        setBusy('ledger.export')
        try {
          // 一次下載拿檔案；另打一次同樣的端點只碰 POST 那一半（寫副本 + 回摘要）
          const download = fetch(`${API}/ledger.export`, { cache: 'no-store' })
          const saved = post('/ledger.export', {}, { quiet: true })
          const [res, head] = await Promise.all([download, saved])
          if (!res.ok) {
            const why = head?.error || `HTTP ${res.status}`
            setNote(`${t('error')}: ${why}`)
            return
          }
          const text = await res.text()
          const blob = new Blob([text], { type: 'application/x-ndjson' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `ledger-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.jsonl`
          document.body.appendChild(a)
          a.click()
          a.remove()
          window.setTimeout(() => URL.revokeObjectURL(url), 4000)
          setNote(
            t('ledger_export_done', {
              file: head?.file || 'ledger.export.jsonl',
              n: head?.records ?? text.split('\n').filter((s) => s.trim()).length,
              kb: Math.round((head?.bytes ?? text.length) / 1024),
            }),
          )
        } catch (err) {
          setNote(`${t('error')}: ${String(err?.message || err)}`)
        } finally {
          setBusy('')
        }
      }

      /** 導入 ledger.jsonl：先讀檔、驗鏈，只有本人再按一次才真的接上。 */
      const onImportFile = async (event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        setBusy('ledger.import')
        try {
          const text = await file.text()
          // ⚠️ 2026-11-25：這裡的註解一直寫「只有本人再按一次才真的接上」，但程式碼直接送了。
          //    導入會**取代整本帳**，比清空重來更 destructive，所以真的要做一次確認。
          //    後端 /ledger.import 現在也要 confirm:true（跟 /reset 同一道閘）。
          const okGo = typeof window === 'undefined' ? true : window.confirm(t('ledger_import_confirm'))
          if (!okGo) {
            setBusy('')
            return
          }
          const res = await post('/ledger.import', { text, source: file.name, confirm: true }, { quiet: true })
          if (res?.ok) {
            setNote(t('ledger_import_done', { n: res.imported, chain: res.chain?.ok ? t('chain_ok') : t('chain_sealed'), replaced: res.replaced || '—' }))
          } else {
            setNote(t('ledger_import_bad', { err: res?.error || t('error') }))
          }
        } catch (err) {
          setNote(t('ledger_import_bad', { err: String(err?.message || err) }))
        } finally {
          setBusy('')
        }
      }

      if (!state) {
        return h(
          'div',
          { className: 'mn-root', style: rootStyle },
          header,
          h('div', { className: 'mn-body', style: bodyStyle }, error ? h('div', { className: 'mn-err', style: { color: C.err } }, `${t('error')}: ${error}`) : h('div', { className: 'mn-empty', style: { color: C.dim } }, '…')),
        )
      }


      // ⚠️ 2026-11-25：`mapSection` 也在拆 BiliBanner 時被一起誤刪，從 51cc4c1 還原。
      const mapSection = h(
        Section,
        { title: t('star_map'), hint: t('star_hint') },
        h(Constellation, { galaxy: state.galaxy, coreLabel: t('core'), dimLabel }),
        h(
          'div',
          { className: 'mn-legend' },
          Object.keys(DIM_COLORS)
            .filter((d) => d !== 'other')
            .map((d) => h('span', { key: d }, h('i', { className: 'mn-dot', style: { background: DIM_COLORS[d] } }), dimLabel(d))),
          h('span', { className: 'mn-hint' }, `${state.counts?.active ?? 0} ${t('memories')}`),
        ),
      )

      /* ── 提示詞分層：這一輪送進模型的那段字，各塊佔多少 ── */
      // 資料由 /state 的 injection 帶過來（那是量出來的真實長度，不是估的）。
      const PALETTE = {
        foundation: '#5b7cfa',
        persona_title: '#8a6fe8',
        identity: '#8a6fe8',
        voice: '#9d84ee',
        self: '#b39df3',
        bond: '#c7b6f7',
        digest_title: '#3fa78a',
        memory: '#e0a33e',
        hidden_note: '#c9645a',
      }
      const colorOf = (key) => {
        if (key === 'foundation') return PALETTE.foundation
        if (key === 'persona_title') return PALETTE.persona_title
        if (key === 'identity') return PALETTE.identity
        if (key === 'voice') return PALETTE.voice
        if (key === 'self') return PALETTE.self
        if (key.startsWith('bond')) return PALETTE.bond
        if (key === 'digest_title') return PALETTE.digest_title
        if (key === 'memory') return PALETTE.memory
        if (key === 'hidden_note') return PALETTE.hidden_note
        return '#999'
      }
      const inj = state?.injection
      const injSection = h(
        Section,
        {
          title: '提示詞分層',
          hint: inj && !inj.error
            ? `${inj.used} / ${inj.budget} 字 · 記住 ${inj.shown} 條${inj.hidden ? `（沒顯示 ${inj.hidden} 條）` : ''}`
            : '這一輪的字數分佈',
        },
        inj?.error
          ? h('div', { className: 'mn-empty' }, `量不出來：${inj.error}`)
          : !inj
            ? h('div', { className: 'mn-hint' }, '等下一次讀取…')
            : h(
                'div',
                { style: { padding: '4px 0 2px' } },
                // 堆疊條：總長 = 預算，每塊按字數佔位；超出預算的那截用斜線標出來。
                h(
                  'div',
                  {
                    style: {
                      display: 'flex', height: 18, borderRadius: 4, overflow: 'hidden',
                      background: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,0.12))',
                      border: '1px solid var(--dsw-alias-line-primary, rgba(127,127,127,0.25))',
                    },
                  },
                  ...(() => {
                    const budget = Math.max(1, inj.budget || 1)
                    const parts = (inj.parts || []).filter((p) => !p.key.endsWith('_line') && p.chars > 0)
                    return parts.map((p, i) =>
                      h('div', {
                        key: `${p.key}-${i}`,
                        title: `${p.title} ${p.chars} 字`,
                        style: {
                          width: `${(p.chars / budget) * 100}%`,
                          background: colorOf(p.key),
                          opacity: p.key === 'hidden_note' ? 0.85 : 1,
                        },
                      }),
                    )
                  })(),
                ),
                // 圖例 + 數字表
                h(
                  'div',
                  { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 } },
                  ...((inj.parts || []).filter((p) => !p.key.endsWith('_line') && p.chars > 0).map((p, i) =>
                    h(
                      'div',
                      { key: `${p.key}-row-${i}`, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
                      h('i', { style: { width: 10, height: 10, borderRadius: 2, background: colorOf(p.key), display: 'inline-block', flex: '0 0 auto' } }),
                      h('span', { style: { flex: 1, opacity: 0.8 } }, p.title),
                      h('span', { style: { fontVariantNumeric: 'tabular-nums', opacity: 0.65 } }, `${p.chars}`),
                      h('span', { style: { fontVariantNumeric: 'tabular-nums', width: 44, textAlign: 'right', opacity: 0.5 } },
                        `${((p.chars / Math.max(1, inj.budget || 1)) * 100).toFixed(1)}%`),
                    ),
                  )),
                ),
                h('div', { className: 'mn-hint', style: { marginTop: 6, opacity: 0.6 } },
                  `空著 ${inj.free ?? 0} 字 —— 這段是量出來的真實長度，不是估的`),
              ),
      )

      const digestSection = h(
        Section,
        {
          title: t('memory_digest'),
          hint:
            `T1 ${state.counts?.byTier?.[1] || 0} · T2 ${state.counts?.byTier?.[2] || 0} · T3 ${state.counts?.byTier?.[3] || 0} · ` +
            `T5 ${state.counts?.byTier?.[5] || 0} · 雜項 ${state.counts?.scratch || 0}`,
        },
        // 已過期的預測：提示詞裡還掛著，等本人給個結果
        dueForecasts.length
          ? h(
              'div',
              {
                className: 'mn-chip mn-warn',
                style: { display: 'block', marginBottom: 8, cursor: 'pointer' },
                title: dueForecasts.map((m) => m.title).join('\n'),
                onClick: () => setOpenMem((old) => Object.fromEntries([...Object.keys(old), ...dueForecasts.map((m) => m.id)].map((k) => [k, true]))),
              },
              `⏰ ${t('due_hint', { n: dueForecasts.length })}`,
            )
          : null,
        // ── T 分頁：左上方一排，點哪層看哪層 ──
        h(
          'div',
          { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 } },
          ...TIER_TABS.map((tier) =>
            h(
              'button',
              {
                key: tier,
                type: 'button',
                className: 'mn-btn',
                onClick: () => { setMemTier(tier); setMemPage(0) },
                style: {
                  ...btnStyle,
                  padding: '2px 9px',
                  fontSize: 12,
                  opacity: tier === activeTier ? 1 : 0.55,
                  background: tier === activeTier ? 'var(--dsw-alias-bg-secondary, rgba(127,127,127,0.18))' : 'transparent',
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: tier === activeTier ? 'var(--dsw-alias-line-primary, rgba(127,127,127,0.5))' : 'transparent',
                },
              },
              `T${tier} ${tabCount(tier)}`,
            ),
          ),
        ),
        pageRows.length === 0
          ? h('div', { className: 'mn-empty' }, activeTier === 4 ? '雜項區是空的（這裡放歸不了類的先擱著的東西，48 小時沒人想起就散了）' : t('empty_memory'))
          : pageRows.map((m) => {
              const open = Boolean(openMem[m.id])
              const bvid = (m.evidence || []).find?.((e) => e.bvid)?.bvid || ''
              // 作廢的整行灰掉：內容還在、查得到，但它是錯的
              const dim = m.voided ? { opacity: 0.55 } : null
              return h(
                'div',
                {
                  className: 'mn-row mn-memrow',
                  key: m.id,
                  title: open ? undefined : t('expand'),
                  style: dim,
                  onClick: () => setOpenMem((old) => ({ ...old, [m.id]: !old[m.id] })),
                },
                h(
                  'span',
                  { className: `mn-tag mn-tag-t${m.tier}`, title: `T${m.tier}` },
                  `T${m.tier} ${tierLabel(m.tier)}`,
                ),
                m.voided
                  ? h(
                      'span',
                      { className: 'mn-tag', title: m.voidedReason || '', style: { color: 'var(--dsw-alias-state-danger-primary)' } },
                      t('voided'),
                    )
                  : null,
                h(
                  'div',
                  { className: 'mn-row-l' },
                  h('div', { className: 'mn-mem-t' }, open ? `▾ ${m.title}` : m.title),
                  open ? h('div', { className: 'mn-memfull' }, m.body) : h('div', { className: 'mn-mem-b' }, m.body),
                  // 預測層：到期日與過期狀態要一直看得到，不用點開
                  m.tier === 5
                    ? h(
                        'div',
                        {
                          className: 'mn-hint',
                          style: {
                            marginTop: 3,
                            color: m.due && !m.voided ? 'var(--dsw-alias-state-danger-primary)' : undefined,
                          },
                        },
                        `${t('expires_label', { date: String(m.expiresAt || '').slice(0, 10) })}${m.due && !m.voided ? ` · ⏰${t('due_label')}` : ''}`,
                      )
                    : null,
                  m.voided && m.voidedReason
                    ? h('div', { className: 'mn-hint', style: { marginTop: 3 } }, t('voided_reason', { reason: m.voidedReason }))
                    : null,
                  open
                    ? h(
                        'div',
                        { className: 'mn-hint', style: { marginTop: 4 } },
                        [
                          (m.dims || []).map(dimLabel).join(' · '),
                          (m.facets || []).length ? t('facets_n', { n: (m.facets || []).length }) : '',
                          m.bornAt ? new Date(m.bornAt).toLocaleString() : '',
                          m.evidence?.[0]?.sessionId ? `${t('session_id')} ${m.evidence[0].sessionId}` : '',
                          bvid,
                        ]
                          .filter(Boolean)
                          .join(' · '),
                      )
                    : null,
                ),
                h(
                  'div',
                  { className: 'mn-inline' },
                  (m.dims || []).slice(0, 2).map((d) => h('span', { key: d, className: 'mn-chip' }, dimLabel(d))),
                  h('span', { className: 'mn-hint' }, String(m.salience ?? '')),
                ),
              )
            }),
        // ── 選頁：每頁 10 行，最新的在最上面 ──
        pageCount > 1
          ? h(
              'div',
              { style: { marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap' } },
              h(
                'button',
                { type: 'button', className: 'mn-btn', style: { ...btnStyle, padding: '2px 9px' }, disabled: page === 0, onClick: () => setMemPage(Math.max(0, page - 1)) },
                '‹',
              ),
              ...(() => {
                // 頁碼最多擺 9 個：太長就用「…」省略中間，不然 20 頁的橫排會爆掉。
                const total = pageCount
                const out = []
                const push = (n) => out.push(h(
                  'button',
                  {
                    key: `p${n}`,
                    type: 'button',
                    className: 'mn-btn',
                    style: { ...btnStyle, padding: '2px 8px', fontSize: 12, opacity: n === page ? 1 : 0.55,
                      background: n === page ? 'var(--dsw-alias-bg-secondary, rgba(127,127,127,0.18))' : 'transparent' },
                    onClick: () => setMemPage(n),
                  },
                  String(n + 1),
                ))
                const win = 9
                if (total <= win) {
                  for (let i = 0; i < total; i += 1) push(i)
                } else {
                  const from = Math.max(0, Math.min(total - win, page - Math.floor(win / 2)))
                  for (let i = from; i < from + win; i += 1) push(i)
                }
                return out
              })(),
              h(
                'button',
                { type: 'button', className: 'mn-btn', style: { ...btnStyle, padding: '2px 9px' }, disabled: page >= pageCount - 1, onClick: () => setMemPage(Math.min(pageCount - 1, page + 1)) },
                '›',
              ),
              h('span', { className: 'mn-hint', style: { marginLeft: 4, opacity: 0.6 } },
                `${tierList.length} 條 · 第 ${page + 1}/${pageCount} 頁`),
            )
          : null,
      )

      const selfView = state.selfView || {}
      const selfSection = h(
        Section,
        { title: t('self_view'), hint: t('self_hint') },
        h(
          'div',
          { style: { marginBottom: 10 } },
          h(RunButton, {
            run: runSelf,
            idleText: t('ask_self'),
            busyText: t('ask_self_run'),
            againText: runSelf.phase === 'done' ? t('ask_self_again') : t('ask_self'),
            locked: !cfg.enabled,
            onClick: () => void fireDuty(['reflect'], 'self'),
          }),
          h('div', { className: 'mn-hint', style: { marginTop: 6 } }, cfg.enabled ? t('ask_self_hint') : t('ask_self_off')),
        ),
        selfView.text
          ? h(
              'div',
              null,
              h('div', { className: 'mn-self' }, selfView.text),
              h(
                'div',
                { className: 'mn-inline', style: { marginTop: 8 } },
                h('span', { className: 'mn-hint' }, `${t('self_asked')} ${ago(selfView.at, t)} · v${selfView.revision ?? 0}`),
              ),
            )
          : h('div', { className: 'mn-empty' }, t('self_empty')),
      )

      const personaSection = h(
        Section,
        { title: t('persona') },
        h('div', { className: 'mn-lbl' }, t('foundation_label')),
        h('div', { className: 'mn-hint', style: { marginBottom: 6 } }, t('foundation_hint')),
        h('textarea', {
          className: 'mn-ta',
          value: foundationDraft ?? '',
          placeholder: t('foundation'),
          // 鎖住時一律唯讀：想改得先按「寫入底座」——免得手一滑就動到本人的那一句
          readOnly: !foundationEditing,
          disabled: !foundationEditing,
          style: foundationEditing ? undefined : { opacity: 0.72, cursor: 'pointer' },
          onClick: () => {
            if (!foundationEditing) setFoundationEditing(true)
          },
          onChange: (e) => setFoundationDraft(e.target.value),
        }),
        h(
          'div',
          { className: 'mn-inline', style: { marginTop: 8 } },
          !foundationEditing
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'mn-btn mn-btn-p',
                  style: btnPrimary,
                  disabled: busy === '/foundation',
                  onClick: () => setFoundationEditing(true),
                },
                t('foundation_edit'),
              )
            : [
                h(
                  'button',
                  {
                    key: 'save',
                    type: 'button',
                    className: 'mn-btn mn-btn-p',
                    style: !dirtyFoundation || busy === '/foundation' ? btnDisabled : btnPrimary,
                    disabled: !dirtyFoundation || busy === '/foundation',
                    onClick: async () => {
                      const res = await post('/foundation', { text: foundationDraft })
                      if (res?.ok) {
                        setNote(t('saved'))
                        setFoundationEditing(false)
                      }
                    },
                  },
                  t('foundation_save'),
                ),
                h(
                  'button',
                  {
                    key: 'cancel',
                    type: 'button',
                    className: 'mn-btn',
                    style: btnStyle,
                    disabled: busy === '/foundation',
                    onClick: () => {
                      setFoundationDraft(null) // 還原成帳本裡那一句
                      setFoundationEditing(false)
                    },
                  },
                  t('foundation_cancel'),
                ),
              ],
          state.foundation?.setAt ? h('span', { className: 'mn-hint' }, `${t('foundation')} · ${ago(state.foundation.setAt, t)}`) : null,
        ),
        h('div', { style: { height: 12 } }),
        h(
          'div',
          { className: 'mn-kv' },
          h('span', null, t('identity')),
          h('span', null, persona.identity ? persona.identity : t('none')),
          h('span', null, t('voice')),
          h('span', null, persona.voice ? persona.voice : t('none')),
        ),
        h('div', { style: { marginTop: 10, fontWeight: 600, fontSize: 12.5 } }, t('preferences')),
        (persona.traits || []).length === 0 && (persona.taste || []).length === 0
          ? h('div', { className: 'mn-empty' }, t('no_traits'))
          : h(
              'div',
              { className: 'mn-traits' },
              (persona.traits || []).map((tr) =>
                h(
                  'div',
                  { className: 'mn-trait', key: `tr-${tr.key}` },
                  h('span', { className: 'mn-trait-n' }, tr.key),
                  h('span', { className: 'mn-trait-b' }, h('i', { style: { width: `${Math.round((tr.weight || 0) * 100)}%` } })),
                  h('span', { className: 'mn-trait-v' }, tr.value || ''),
                ),
              ),
              (persona.taste || []).map((tr) =>
                h(
                  'div',
                  { className: 'mn-trait', key: `ta-${tr.key}` },
                  h('span', { className: 'mn-trait-n' }, `♥ ${tr.key}`),
                  h('span', { className: 'mn-trait-b' }, h('i', { style: { width: `${Math.round((tr.weight || 0) * 100)}%`, opacity: 0.7 } })),
                  h('span', { className: 'mn-trait-v' }, tr.value || ''),
                ),
              ),
            ),
        /* 旁證：它自己改過哪幾次。只讀 —— 沒有批准、沒有拒絕、不擋任何一次修訂。 */
        h('div', { style: { marginTop: 14, borderTop: `1px solid ${C.border1}`, paddingTop: 10 } }, h('div', { className: 'mn-lbl' }, t('trail_title'))),
        h('div', { className: 'mn-hint', style: { marginBottom: 6 } }, t('trail_note')),
        (state.personaTrail || []).length === 0
          ? h('div', { className: 'mn-empty' }, t('trail_none'))
          : (state.personaTrail || []).map((r) =>
              h(
                'div',
                { className: 'mn-row', key: `pt-${r.seq}` },
                h(
                  'div',
                  { className: 'mn-row-l' },
                  h(
                    'div',
                    { className: 'mn-mem-t', style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                    h('span', null, `v${r.version ?? '?'} · ${t(`trail_mode_${r.mode === 'replace' ? 'replace' : 'adjust'}`)}`),
                    r.destructive ? h('span', { className: 'mn-tag' }, t('trail_destructive')) : null,
                    r.by === 'user' ? h('span', { className: 'mn-tag' }, t('trail_by_user')) : null,
                  ),
                  h('div', { className: 'mn-hint' }, trailFacts(r, t)),
                ),
                r.snapshotId
                  ? h(
                      'button',
                      { type: 'button', className: 'mn-btn', style: btnStyle, onClick: () => void post('/rollback', { snapshotId: r.snapshotId }) },
                      t('rollback'),
                    )
                  : null,
              ),
            ),
      )

      const dimsSection = h(
        Section,
        { title: t('knowing') },
        h(
          'div',
          { className: 'mn-grid2' },
          (state.dimKeys || []).map((key) => {
            const d = dims[key] || {}
            const unjudged = d.score == null
            const weak = !unjudged && (d.confidence ?? 0) < 0.45
            return h(
              'div',
              { className: `mn-card${weak ? ' mn-bad' : ''}`, key },
              h(
                'div',
                { className: 'mn-inline', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('span', { className: 'mn-card-t' }, dimLabel(key)),
                h('span', { className: 'mn-code', style: { marginLeft: 'auto' } }, unjudged ? t('not_judged') : `${d.score}`),
              ),
              h('span', { className: 'mn-bar' }, h('i', { style: { width: `${Math.max(2, d.score ?? 0)}%` } })),
              unjudged
                ? null
                : h(
                    'div',
                    { className: 'mn-inline', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h('span', { className: 'mn-hint', style: hintStyle }, `${t('confidence')} ${Math.round((d.confidence ?? 0) * 100)}%`),
                  ),
              (d.missing || []).length ? h('div', { className: 'mn-hint', style: { marginTop: 3 } }, `${t('missing')} ${d.missing.join(' · ')}`) : null,
              d.note ? h('div', { className: 'mn-hint', style: { marginTop: 3 } }, d.note) : null,
            )
          }),
        ),
      )

      const dutyInfo = state.dutyInfo || {}
      const rhythmSection = h(
        Section,
        { title: t('rhythm') },
        h(Switch, { label: t('r_reflection'), note: t('r_reflection_note'), checked: Boolean(cfg.reflection), onChange: (v) => void post('/config', { patch: { reflection: v } }) }),
        h(Switch, { label: t('r_valley'), note: t('r_valley_note'), checked: Boolean(cfg.valleyOnly), onChange: (v) => void post('/config', { patch: { valleyOnly: v } }) }),
        h(
          'div',
          { className: 'mn-grid2', style: { marginTop: 10 } },
          // 這些 min/max 必須跟 lib/model.js 的 INJECT_TUNABLES / RHYTHM_TUNABLES 一致。
          // 不然頁面允許填 240 小時，saveConfig 卻把它夾到 72 —— 用戶以為設成功了，其實沒有。
          h(Num, { label: t('n_reflect_h'), value: cfg.reflectionEveryHours, min: 6, max: 72, onCommit: (v) => void post('/config', { patch: { reflectionEveryHours: v } }) }),
          h(Num, { label: t('n_daily'), value: cfg.dutyMaxPerDay, min: 1, max: 4, onCommit: (v) => void post('/config', { patch: { dutyMaxPerDay: v } }) }),
          // 條數不再手動調：它由 injectBudget 推導（每 50 字一個位置），所以這裡只顯示推導結果。
          h('div', { className: 'mn-hint' }, `${t('n_slots')} ${state.derivedSlots ?? Math.floor((cfg.injectBudget || 0) / 50)}`),
          h(Num, { label: t('n_budget'), value: cfg.injectBudget, min: 600, max: 3200, onCommit: (v) => void post('/config', { patch: { injectBudget: v } }) }),
          h(Num, { label: t('n_ttl'), value: cfg.tier4TtlHours ?? 48, min: 0, max: 168, onCommit: (v) => void post('/config', { patch: { tier4TtlHours: v } }) }),
        ),
        h(
          'div',
          { className: 'mn-inline', style: { marginTop: 10 } },
          dutyInfo.valley?.ok ? h('span', { className: 'mn-chip mn-ok' }, `${t('valley_now')} · ${dutyInfo.valley.label}`) : h('span', { className: 'mn-chip' }, t('valley_no')),
          h('span', { className: 'mn-hint' }, `${t('last_reflect')} ${ago(state.runtime?.lastReflectionAt, t)}`),
          h('span', { className: 'mn-hint' }, `${t('duties_today')} ${dutyInfo.dutiesToday ?? 0}`),
          state.runtime?.armed ? h('span', { className: 'mn-chip mn-warn' }, t('armed_badge', { kinds: kindText(state.runtime.armed.kinds, t) || '—' })) : null,
        ),
        h(
          'div',
          { style: { marginTop: 12 } },
          h(RunButton, {
            run: runDutyState,
            idleText: cfg.enabled ? t('run_now') : t('run_now_locked'),
            busyText: t('run_now_run'),
            againText: t('run_now'),
            locked: !cfg.enabled,
            onClick: () => void fireDuty(undefined, 'duty'),
          }),
          h('div', { className: 'mn-inline', style: { marginTop: 6 } }, h('span', { className: 'mn-hint' }, cfg.enabled ? t('run_now_hint') : t('run_now_locked_hint'))),
          state.runtime?.armed ? h('button', { type: 'button', className: 'mn-btn', style: { ...btnStyle, marginTop: 6 }, onClick: () => void post('/disarm', {}) }, t('disarm')) : null,
        ),
        state.runtime?.lastError ? h('div', { className: 'mn-err', style: { marginTop: 6, fontSize: 11.5 } }, state.runtime.lastError) : null,
        (state.runtime?.dutyLog || []).length
          ? h(
              'div',
              { style: { marginTop: 12 } },
              h('div', { className: 'mn-lbl' }, t('recent_duties')),
              (state.runtime.dutyLog || [])
                .slice()
                .reverse()
                .slice(0, 5)
                .map((d, i) =>
                  h(
                    'div',
                    { className: 'mn-hint', key: `${d.at || ''}-${i}`, style: { padding: '1px 0', fontVariantNumeric: 'tabular-nums' } },
                    `${d.at ? new Date(d.at).toLocaleString() : ''} · ${kindText(d.kinds, t)} · ${t(d.force ? 'why_forced' : 'why_due')}`,
                  ),
                ),
            )
          : null,
      )

      const safetySection = h(
        Section,
        { title: t('safety'), hint: t('confirm_before') },
        h(
          'div',
          { className: 'mn-inline', style: { marginBottom: 8 } },
          chain.ok
            ? h('span', { className: 'mn-chip mn-ok' }, t('chain_ok'))
            : chain.sealed
              ? h('span', { className: 'mn-chip mn-warn' }, `${t('chain_sealed')} · #${(chain.brokenAt ?? 0) + 1}`)
              : h('span', { className: 'mn-chip mn-err' }, `${t('chain_bad')} · #${(chain.brokenAt ?? 0) + 1}`),
          h('span', { className: 'mn-hint mn-code' }, `${String(chain.head || '').slice(0, 12)}… · ${chain.count ?? 0} ${t('records')} · ${Math.round((state.counts?.ledgerBytes || 0) / 1024)} KB`),
          h('button', { type: 'button', className: 'mn-btn', style: btnStyle, onClick: () => void post('/verify', {}) }, t('verify')),
          !chain.ok ? h('button', { type: 'button', className: 'mn-btn mn-btn-d', style: btnDanger, onClick: () => void post('/seal', { note: 'owner sealed a broken chain' }) }, t('seal')) : null,
        ),
        chain.note ? h('div', { className: 'mn-err', style: { fontSize: 11.5, marginBottom: 8 } }, chain.note) : null,
        h('div', { style: { fontWeight: 600, fontSize: 12.5, marginTop: 6 } }, t('pending')),
        pending.length === 0
          ? h('div', { className: 'mn-empty' }, t('no_pending'))
          : pending.map((p) =>
              h(
                'div',
                { className: 'mn-row', key: p.id },
                h('div', { className: 'mn-row-l' }, h('div', { className: 'mn-mem-t' }, p.summary || p.op), h('div', { className: 'mn-hint' }, `${p.op} · ${ago(p.at, t)}`)),
                h(
                  'div',
                  { className: 'mn-inline' },
                  h('button', { type: 'button', className: 'mn-btn mn-btn-p', style: btnPrimary, onClick: () => void post('/resolve', { id: p.id, approve: true }) }, t('approve')),
                  h('button', { type: 'button', className: 'mn-btn mn-btn-d', style: btnDanger, onClick: () => void post('/resolve', { id: p.id, approve: false }) }, t('refuse')),
                ),
              ),
            ),
        h('div', { style: { fontWeight: 600, fontSize: 12.5, marginTop: 12 } }, t('snapshots')),
        (state.snapshots || []).length === 0
          ? h('div', { className: 'mn-empty' }, t('none'))
          : (state.snapshots || []).slice(0, 12).map((s) =>
              h(
                'div',
                { className: 'mn-row', key: s.id },
                h('div', { className: 'mn-row-l' }, h('div', { className: 'mn-mem-t' }, s.label), h('div', { className: 'mn-hint' }, `${s.scope} · ${ago(s.at, t)}`)),
                h('button', { type: 'button', className: 'mn-btn', style: btnStyle, onClick: () => void post('/rollback', { snapshotId: s.id }) }, t('rollback')),
              ),
            ),
        h(
          'div',
          { className: 'mn-danger' },
          h('div', { className: 'mn-lbl' }, t('reset_title')),
          h('div', { className: 'mn-hint', style: { marginBottom: 8 } }, t('reset_note')),
          h(
            'button',
            {
              type: 'button',
              className: 'mn-btn mn-btn-d',
              style: btnDanger,
              disabled: busy === '/reset',
              onClick: async () => {
                if (!resetArm) {
                  setResetArm(true)
                  return
                }
                setResetArm(false)
                const res = await post('/reset', { confirm: true })
                if (res?.ok) setNote(t('reset_done'))
              },
              onBlur: () => setResetArm(false),
            },
            resetArm ? t('reset_ask') : t('reset_btn'),
          ),

          /* ── 帳本導出 / 導入 ── */
          h('div', { style: { height: 14 } }),
          h('div', { style: { borderTop: `1px solid ${C.border1}`, margin: '0 0 12px' } }),
          h('div', { className: 'mn-lbl' }, t('ledger_title')),
          h('div', { className: 'mn-hint', style: { marginBottom: 8 } }, t('ledger_note')),
          h(
            'div',
            { className: 'mn-inline' },
            h(
              'button',
              {
                type: 'button',
                className: 'mn-btn',
                style: busy === 'ledger.export' ? btnDisabled : btnStyle,
                disabled: busy === 'ledger.export',
                onClick: () => void onExport(),
              },
              busy === 'ledger.export' ? t('ledger_exporting') : t('ledger_export_btn'),
            ),
            h(
              'label',
              { className: 'mn-btn', style: busy === 'ledger.import' ? btnDisabled : btnStyle },
              busy === 'ledger.import' ? t('ledger_importing') : t('ledger_import_btn'),
              h('input', { type: 'file', accept: '.jsonl,.json,application/x-ndjson,text/plain', style: { display: 'none' }, onChange: onImportFile, disabled: busy === 'ledger.import' }),
            ),
          ),
        ),
      )

      return h(
        'div',
        { className: 'mn-root', style: rootStyle },
        header,
        h(
          'div',
          { className: 'mn-body', style: bodyStyle },
          error ? h('div', { className: 'mn-err', style: { color: C.err } }, `${t('error')}: ${error}`) : null,
          note ? h('div', { className: 'mn-note', style: { fontSize: 12, color: C.dim } }, note) : null,
          // 形象照（左）＋ 性格卡（右）—— 2026-11-22 他要置頂，擺在星圖之前
          //
          // ⭐ 2026-11-25：**左邊正方形，邊長 = 右邊那張性格卡的高度。**
          //    外層 grid 兩欄 `align-items: stretch`（預設）⇒ 等高；
          //    左邊那張 height: 100% + aspect-ratio: 1/1 ⇒ 寬度由高度反推。
          //    左欄宣告成 `auto`，讓它由內容（那張正方形卡）決定寬度，
          //    右欄 1fr 吃掉剩下的。
          h(
            'div',
            {
              className: 'mn-portrait-row',
              style: {
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: 16,
                alignItems: 'stretch',
                marginBottom: 16,
              },
            },
            portraitSection,
            personaSection,
          ),
          mapSection,
          injSection,
          digestSection,
          selfSection,
          h('div', { className: 'mn-grid2' }, dimsSection),
          rhythmSection,
          safetySection,
        ),
      )
    }


    return {
      inject: ['slots'],
      apply(ctx) {
        // 宿主還認得這個名字（別的頁面可能查它），但這頁的文案不再跟它走
        const locale = (() => {
          try {
            return typeof ctx.get === 'function' ? ctx.get('locale') : undefined
          } catch {
            return undefined
          }
        })()
        if (locale) {
          try {
            locale.register('Silt', 'en', DICT.en)
            locale.register('Silt', 'zh-CN', DICT.zh)
          } catch {
            /* 註冊不上不影響：這頁自己帶字典 */
          }
        }
        const t = () => tt('nav')

        const slots = (() => {
          try {
            return typeof ctx.get === 'function' ? ctx.get('slots') : undefined
          } catch {
            return undefined
          }
        })()
        const api = slots || ctx.slots
        if (!api) return

        // `main` 的 key 必須等於 `sidebar.panellist` 的 id —— 宿主點側欄那一行時，
        // 就是拿這個 id 去找 main 頁。兩者大小寫不同（'silt' / 'Silt'）就點不開。
        api.inject('sidebar.panellist', () => api.register({ name: 'sidebar.panellist', id: 'silt', order: 25, label: () => t() }, Glyph))
        api.inject('main', () => api.register({ name: 'main', key: 'silt' }, Panel))
      },
    }
  },
})
