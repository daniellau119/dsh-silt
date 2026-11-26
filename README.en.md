<div align="center">

# dsh-silt

[中文](README.md)

> Cross-session memory and persona plugin for DSH · `v1.10.0` · 2026-11-25

`dsh-silt` is a long-term memory and persona-growth engine built for the DSH host process. It gives a model a memory that self-evolves, settles in layers, and can be interrogated — plus a persona card that grows out of the conversation itself.

---

![DSH plugin](https://img.shields.io/badge/DSH-plugin-blue) ![version](https://img.shields.io/badge/v1.10.0-green) ![license](https://img.shields.io/badge/license-MIT-brightgreen)

</div>

---

A model forgets the previous turn every turn. This plugin gives it a cross-session memory store and a persona card that keeps growing.

It is not just about remembering names. It solves four things:

- **Fading** — something from three years ago should not burn as bright as today
- **Settling** — an experience slowly condenses into a one-line gist
- **Expiring** — "I'm getting married next month" should trigger a follow-up question once it passes
- **Being wrong** — when the user says "I got that wrong", the old memory must be voidable, with a trace left behind

The whole design comes down to four sentences:

1. **The ledger is the only truth**  
   Every piece of state (memories, persona, six dimensions, settings) is replayed from `ledger.jsonl`. There is no second state file that can be quietly rewritten.

2. **The model can add, never modify**  
   Delete, rollback and import are the user's powers. The model can write a new memory, or flag one as "no longer true" with `silt_void`.

3. **The plugin decides *how* it is stored; the model decides *what* is stored**  
   Character limits, decay formulas and compression cadence are all hard-coded. The model's freedom is content, tier, dimensions and salience.

4. **Compression is fast first, then slow**  
   An experience that gets retold repeatedly sheds more and more gently, until it settles into a one-line "roughly".

---

## Five tiers

| | What it is | Limit | Base half-life | In prompt |
|:--:|---|:--:|:--:|:--:|
| **T1** | Facts and rules: facts that stay true **and belong in every prompt**, and rules to follow every time | 200 | 100 yr | ✅ |
| **T2** | Gists settled out of experience | 200 | 720 d | ✅ |
| **T3** | Experiences worth keeping (**no project details**) | 1000 | 180 d | ✅ |
| **T4** | Scratch: undecided, parked for now | 300 | follows TTL (48 h default) | ❌ |
| **T5** | Forecasts: not yet happened, has a deadline | 400 | — | ✅ even after expiry |

> **Why T1 takes rules**: something the owner repeats has nowhere else to go but T3 —
> and T3 is *experiences*, so a rule filed there reads as a past event and gets ignored next time.
> A rule has to say "when this happens ⇒ do this ⇒ because of that", but the **limit stays 200 chars** —
> the answer is to tighten the wording, not to widen the bowl.
> Dates are fine to write: a date is *when this happened*, and that is part of the memory.
>
> **T1 has to clear two gates: still true tomorrow, and worth being in every prompt.**
> "Useful if I look it up later" — company registration numbers, CEO names, event dates,
> customer lists, product lines — goes to T3: it compresses, fades, and has an exit.
> T1 is a hundred-year seat, not "a more important memory".
>
> **Why T3 refuses project details**: which file changed, what got installed, how deep the debug went —
> the code already records that. Spending a T3 slot on it only crowds out actual people and events.
> Test: in a month, will you still care which file it was?
>
> **Why T4 never enters the prompt**: it is only "parked for now"; it becomes T3 once recalled
> often enough. Not being in the prompt means its lifetime is **not** charged to the injection budget.

**A half-life is how long brightness takes to halve, not when the memory is deleted** — and recall extends it:

```
effective half-life = base half-life × 1.2^R      R = times recalled (capped at 10)
```

| Recalled | T3 effective half-life |
|:--:|---:|
| 0 times | 180 d |
| 5 times | 279 d |
| 10 times | **1115 d** |

Something recalled ten times still has 89% of its brightness after 180 days; an equally old memory nobody
recalled is down to 50%.

Recall is written into the **half-life**, not into a per-turn ranking boost — because "important" should mean
**it lives longer**, not "it sorts first every time". The latter lets one memory squat on the injection budget
and pushes everything else out.

**T4 is a buffer, not a bin** — never injected. Each time it comes back, the model gives an
**integer weight**: `0` = merely scanned past (no weight), `1` = came to mind in passing,
`2` = it actually connected to something else or was confirmed. When the total reaches **3** it is
promoted to T3 — so *two deliberate recalls* or *three passing ones*. If nobody recalls it, it drifts away.

Why not "promoted after three recalls": three is a count, not a weight. "He mentioned that name again"
and "he suddenly brought it up" both count once, but they should not weigh the same. Only the model can
say how much, and the plugin just adds it up. Integers rather than decimals because picking between
0.2 / 0.3 / 0.4 is something the model does *unreliably*; picking between 1 and 2 it does consistently.
The arithmetic is also transparent: it can work out "two more and this stays".

#### What counts as "recalled"

`R` is expensive (R=10 ⇒ 1057 days before it becomes a gist), so **a scan must not count**:

| Action | Counts? |
|---|---|
| `silt_recall` **with a query** (looking for one specific thing) | ✅ yes |
| `silt_recall` with only `limit` (paging through) | ❌ no |
| Any recall with `countAsRecall: false` | ❌ no |

Why: reflection runs every 12 hours and every round "reads memories about the owner" before scoring —
that is *browsing*, not recalling a specific thing. If browsing counted, the same batch would max out `R`
within five days and stop being compressed or fading for three years, while memories reflection never
touched would still fade in 175 days. **The result is that reflection's reading habits decide which
memories become immortal**, not whether those things actually matter.

> ⚠️ This blocks `R` (half-life) only — **not T4's weight**: `n` is a side effect the plugin records
> automatically (it was found, so it counts), whereas `weight` is a judgement the model gives.
> Scanning should have no side effects, but weight the model *explicitly* gives while scanning still counts.

**T5 expiry is not the end** — after the deadline it stays in the prompt, tagged `⏰expired`, forcing the model to go ask how it turned out. Only being voided removes it.

```
- T5 user getting married on 20 Dec (2026-11-15) — due 2026-12-20 ⏰expired
```

---

## What makes it different

**1. Forgetting happens to the content, not just the ordering**

In most systems decay only decides *who goes into the prompt first*; the memory itself loses nothing.
Here a T3 is genuinely re-told every 7 days, its target length following a power law
(`initial × (1 + 0.14·T/s)^-0.5`), settling into T2 in roughly 175 days —
and **never earlier** than 171 days × `1.2^R` (see "The model cannot reach T2" below).

Forgetting costs actual content — it is not a change of position.

**2. Being recalled extends a memory's life**

Each recall multiplies the effective half-life by `1.2^R` (capped at 10), and the compression timeline
stretches with it.

A memory recalled ten times: half-life 180 d → 1115 d, and it takes **1057 days** to become a gist.
One never recalled becomes a gist in 175 days.

Unlike a ranking boost: a boost only makes it *more likely to be picked*, whereas this makes it
**live longer**. And "compressed to T2" always happens before "faded out of sight" — the order is
shorten first, fade later.

**3. Forecasts have a deadline, and expiring does not delete them**

T5 carries `expiresAt`, at whatever granularity you can manage — a year is fine. After expiry it stays
in the prompt tagged `⏰expired`; only being voided removes it.

An expired forecast should not quietly rot in storage. Expiry is not the end, it is the signal that
"this one needs an answer".

**4. Void, rather than rewrite**

When the owner says "I remembered that wrong", the original title and body stay untouched; only
`voided` / `voidedReason` / `replacedBy` are added.

Rewriting would erase history; voiding says "this is what I knew then, and later it turned out not to be so."
A voided memory leaves the prompt but `recall` still finds it, tagged `voided: true`.

---

## Compression: fast first, then slow

T3 is condensed every 7 days. The target length is not "erase a fixed fraction each round" but a
**power-law curve**:

```
target = initial × (1 + 0.14 × T/s)^(-0.5)

T = total days since birth
s = 1.2^R,  R = times recalled (capped at 10)
```

A 1000-character memory (the T3 limit), never recalled:

```
day   0 → 1000   day  28 → 451    day  90 → 271
day   7 → 711    day  35 → 412    day 168 → 202
day  14 → 581    day  56 → 336    day 175 → 198 (T2)
day  21 → 504
```

Retention climbs from 71% to 95%; it settles into a T2 on day 175 — the same day its brightness halves.

Human forgetting drops hardest in the first few days and then flattens out — a linear curve is simply wrong.

### Why a continuous curve, not a ladder

An earlier version used a discrete ladder (erase `25% × 0.84^n` each round). Its fatal flaw: **debt accumulates**.

A T3 recalled over and over for half a year without being condensed reaches `sinceDays = 187`, and the next
round replays 26 steps at once — 975 characters collapse to 184 in one shot, a **drop of 81%**. The model
only sees "squash this experience into a hundred-odd characters" and turns a whole arc into a broken
fragment, skipping sixteen rounds of distillation.

The continuous curve has no accumulated debt: whatever the day, it computes the length that day
*should* have. No cliff, however long the interruption — measured, the worst single step never exceeds
the first one (28.9%).

### Recalled more often, longer timeline

`s = 1.2^R` stretches the whole timeline — a real extension, not a one-slot deferral:

| Recalled | Days until T2 |
|:--:|---:|
| 0 times | 175 d |
| 5 times | 427 d |
| 10 times | **1057 d** |

The same memory, recalled ten times, lasts nearly three years before becoming a gist.

<details>
<summary>Compared with Ebbinghaus</summary>

| Day | 1 | 7 | 21 | 56 | 90 |
|---|---|---|---|---|---|
| Ebbinghaus | 44% | 24% | 17% | 12% | 11% |
| This plugin | 94% | 71% | 50% | 34% | 27% |

Same direction, overall 2–3× slower — this stores meaningful content, not nonsense syllables.
(`19/81 ≈ 0.2346` is the coefficient that matches Ebbinghaus exactly, but it drops 38.5% in seven days,
which is too harsh, so 0.14 is used.)
</details>

---

## The model cannot reach T2

```
model → condense(id, title, body, mode)
           │
        mode = recast?
        ├─ yes → stays at T3 forever (a change of understanding, not of length)
        └─ no  → result ≤ 200 chars?
                 ├─ no  → still T3, wait for the next round
                 └─ yes → old enough? (≥ 171 days × 1.2^R)
                          ├─ yes → T2 (system-generated, terminal)
                          └─ no  → still T3 (the reply says how long is left)
```

**Why two gates**: T2 is the 720-day half-life terminal state. With length alone, a 10-day-old T3
written a bit shorter would be pinned as a "settled gist" on the spot — the opposite of
"roughly 175 days to T2". The age gate is how long the longest T3 takes to reach 200 chars (171 days),
scaled by `1.2^R`.

`silt_remember` only accepts `tier` 1 / 3 / 4 / 5 — **`tier: 2` is rejected outright**.

Why: if the model could write T2 directly, it would bypass the whole compression path and pin whatever it likes onto a terminal state.

**The plugin decides how short it gets compressed; the model decides what survives.**

### Recast: the same event, a different understanding

`mode: "recast"` takes the same path (old row archived, new row is a separate memory), but the purpose differs:

| | `condense` | `recast` |
|---|---|---|
| Purpose | say it in fewer words | change how you see it |
| `targetLen` | enforced | ignored |
| Length | only gets shorter | may stay the same |
| Tier | drops to T2 when short enough | **always stays at T3** |

Six months on, recalling "he always works late at night" — the fact is unchanged, but the understanding becomes "he uses the night to hide from the day". That is a recast, not a compression.

**A recast never settles into T2**, because it is a thing still being thought about and should not be nailed down. The original row stays in the ledger (`memory.recast`), so she can see how she used to see it.

The division of labour with `silt_void`: void says "this is no longer true"; recast says "my view has changed".

#### Recast has three fences

Without limits, `recast` becomes a "never shrink" button: write up to 1000 chars every time, always stay in
T3, never settle into T2 — the whole compression ladder is bypassed. So:

| Fence | Rule |
|---|---|
| T3 only | Facts (T1), gists (T2), scratch (T4) and forecasts (T5) cannot be recast |
| At most 3 per memory | `recastCount` **accumulates across versions**; the 4th is refused. `silt_recall` returns `recastLeft` |
| Does not reset the compression clock | `lastCondensedAt` and `bornAt` both carry over — otherwise the clock is effectively zeroed |

> ⚠️ "Does not reset the clock" alone is not enough: a recast produces a **new memory**, and the
> compression target formula uses "days since birth". Hence the absolute cap above.

---

## Merge: several rows into one

`silt_merge` folds **2–3 T3 memories** into one. **T1 is paused** (2026-11-27): details merged away in T1 never come back; tighten the two intake gates first, then see how much real duplication is left.

```
several T3 → one T3 (not a T2 gist)
originals  archived (not voided — they were not wrong) + mergedInto
new row    mergedFrom, inherits the earliest dates and clock
```

Same tier because merging is tidying, not forgetting: folding into T2 would open a back door to "never fade".

| Fence | Rule |
|---|---|
| Read before merging | every id must have been **targeted-recalled in this session**; titles alone and `countAsRecall:false` scans do not count (`seenInSession`) |
| T3, 2–3 | voided, archived and mixed-tier rows are refused; T1 / T2 / T4 / T5 are out of scope for now |
| No borrowed lifetime | `bornAt` / `firstSeen` / `lastCondensedAt` take the earliest; `originalLen` takes the max; `recastCount` takes the max; R is seeded from the ledger payload's `recallSeed` |

Originals are archived and rollback restores them; `silt_recall` with `includeArchived` finds them and
marks `mergedInto`. **Not merging is not a failure** — and merging does not keep a T3 fresh: it still
follows its original clock.

---

## Void: never rewrite history, only add a record

```
old  T1 user marrying 2027-03            ← not a single character changed
       voided: true
       voidedReason: 本人指正: it's 2027-06, not 03
       replacedBy: <id of the new one>
new  T1 user marrying 2027-06
```

Rewriting means "history was erased". Voiding means "this is what I knew at the time; later I found out otherwise".

**Voiding has two uses, told apart by a `reason` prefix:**

| Prefix | Used for | Example |
|---|---|---|
| `本人指正：…` | He says the old row was wrong or has changed | "本人指正: it's 2027-06, not 03" |
| `分類遷移：…` | The fact is fine; it only moved tier or got consolidated | "分類遷移: T1 → T3, content unchanged" |

The prefix is not decoration: the ledger needs it to tell "I actually got this wrong" from "I merely re-organised", or that signal rots. A reclassification is not a licence to drop detail — the fact itself must not change shape when it moves.

Voided memories are not injected, but the ledger and the store keep them. `recall` still finds them, tagged `voided: true`.

### Three ways of "no longer using it"

| Action | Trigger | Meaning | In prompt |
|---|---|---|:--:|
| Archived | plugin | Compressed away | ❌ |
| Expired | time | T5 reached its deadline | ✅ tagged ⏰ |
| Voided | 本人指正 / 分類遷移 | Turned out wrong / moved or consolidated | ❌ |

---

## What goes into the prompt

**Three** blocks: the one-line system command, **who I am**, and **what I still remember**.

```
系統命令：你的跨會話記憶與性格只走 silt_* 工具寫入；……

【自我認知】
- I stand on the side of "explanations that can be checked", not "grand-sounding stories"
- Traditional Chinese, short sentences, conclusion first
- Explanations must be checkable: likes to break things down to mechanism……

【仍記得的】
- T1 我的名字是 Ash（2026-11-12）
- T2 他信數據，不信說話順不順（2026-11-12）
- T3 記憶是重寫不是回放（2026-11-12）
（另有 16 條沒顯示 —— 用 silt_unseen 翻標題，找到再用 silt_recall 搜正文）
```

### Titles only

The memory block carries **titles and dates, no body text**. Bodies are fetched on demand
by `silt_recall`.

This is not a space-saving hack; it came out of testing. Given only titles, the model saw
"he trusts data, not whoever sounds convincing", and when asked "remember what I trust?"
it called `silt_recall` itself and pulled the original quote back. It knows to look, and it can find it.

At the same budget, titles-only fits more than twice as many entries as title-plus-body.

### Say it when things don't fit

Memory will eventually overflow. When a title doesn't fit, the last line says how many were left out:

```
（另有 16 條沒顯示 —— 用 silt_unseen 翻標題，找到再用 silt_recall 搜正文）
```

`silt_unseen` pages through those titles (40 per page by default) and returns `rest`.
`rest > 0` means pass `page: N+1` to keep turning; `rest = 0` means you're at the end.
Like flipping through a book — stop at the title you want.

Without that line the model assumes "this is all I remember", so it neither looks nor admits the blind spot.

### Slot count derived from the budget

```
slots = injectBudget ÷ 50      (3000 chars ⇒ 60 slots)
```

Slots and characters used to be two separately-tuned gates that didn't know about each other —
raise the budget and the count still blocks you, or the reverse. Prompt characters are what's
actually scarce, so the count is derived from it. `injectCount` no longer has any effect.

---

## How memory is stored

There is exactly one source of truth: `<DSH_HOME>/silt/ledger.jsonl` — append-only, hash-chained per record.

```
hash = sha256({v, seq, ts, kind, actor, payload, prev})
```

Memories, persona, foundation, six dimensions and snapshots are all projections replayed from this ledger. Remove or alter any single record and the chain breaks at that point — the UI turns red, rollback is disabled.

Every mutation carries before/after snapshots and can be rolled back by id.

---

## Tools

| Tool | What it does |
|---|---|
| `silt_recall` | Search memories. The only entry point that can see T4 |
| `silt_remember` | Write one (T1 / T3 / T4 / T5 — **T2 cannot be written**) |
| `silt_void` | Mark as no longer used (`本人指正` or `分類遷移`; content unchanged, still searchable) |
| `silt_condense` | Retell a T3: `condense` to say less, `recast` to re-understand |
| `silt_merge` | Fold 2–3 same-tier similar memories into one (must have been recalled first) |
| `silt_persona` | Persona card and self-view |
| `silt_speak` | Reach the owner unprompted — **valley hours is the only gate** |
| `silt_understanding` | Six-dimension scoring |
| `silt_duty` | Read/adjust own rhythm |
| `silt_inject` | Read/adjust injection size |
| `silt_unseen` | Page through titles that didn't fit in the prompt |
| `silt_archive` | Verify the hash chain |

What the model does not have: **delete, rewrite, rollback, import, master switch**. Only the user can touch these.

### The plugin itself

| File | Responsibility |
|---|---|
| `index.js` | Register tools, inject system prompt, start heartbeat |
| `lib/model.js` | Tier constants, decay formula, injection rendering |
| `lib/store.js` | Ledger I/O, projection replay, write paths |
| `lib/tools.js` | Tool schemas and adapters |
| `lib/duty.js` | Off-peak detection, duty scheduling, compression plan |
| `lib/routes.js` | HTTP routes |
| `client.js` | Front-end constellation page |

---

## Tunable parameters

The model may adjust these itself, but each has a hard range. Out-of-range values are **clamped to the boundary**, not rejected.

| Param | Default | Range | Meaning |
|---|:--:|:--:|---|
| `injectBudget` | 1800 | 600–3200 | Character budget for injection — the one to tune |
| `injectCount` | 12 | 1–64 | ⚠️ No longer effective: slots are derived from the budget ÷ 50 |
| `reflectionEveryHours` | 24 | 6–72 | How often to reflect (ignored once `reflectionAt` is set) |
| `reflectionAt` | `null` | `["19:00","07:00"]` | Fixed clock times (UTC+8); `reflectionEveryHours` no longer applies |
| `dutyMaxPerDay` | 2 | 1–4 | Max duty rounds per day |
| `tier4TtlHours` | 48 | 24–168 | Scratch lifetime in **hours** (1–7 days); 0 = never expires (special case) |

**Every knob reports who last set it.** `silt_duty` and `silt_inject` both return a `setBy`
field: `user` (set by the owner, in the UI), `model` (tuned by the model), or `default`
(never touched). The reflection prompt uses it to decide what may be changed —
**anything marked `user` is off limits.**

> Why this field exists: page edits used to write only `config.json` and never the ledger.
> `setBy` scans the ledger, so numbers the owner set looked like "nobody set this" and the
> model went ahead and changed them. `saveConfig()` now writes a `config.profile` record
> with `actor: 'user'`, which is what makes the chain consistent.


---

## Record types

`ledger.jsonl` holds only these kinds, and who writes each one is fixed.

| kind | Written by | Meaning |
|---|---|---|
| `genesis` | plugin | Ledger born / reset |
| `memory.write` | model | New memory (T1 / T3 / T4 / T5) |
| `memory.condense` | model | Condense one T3 |
| `memory.recast` | model | Recast one T3 (same event, different reading) |
| `memory.compress` | plugin | The only channel that produces T2 |
| `memory.upgrade` | plugin | T4 promoted to T3 |
| `memory.void` | model | Mark as void |
| `persona.revise` | model | Revise the persona card |
| `persona.foundation` | user | Change the persona foundation |
| `self.revise` | model | Rewrite the self-view |
| `understanding.revise` | model | Six-dimension scoring |
| `inject.profile` | model | Adjust injection size |
| `rhythm.profile` | model | Adjust rhythm |
| `config.profile` | user | Page-level settings (including `enabled`) |
| `duty.arm` | plugin | Start one duty round |
| `speak.send` | model | Proactive message actually sent |
| `speak.defer` | model | Wanted to say it, decided not to |
| `speak.pending` | model | Held a line for the next waking |
| `speak.pendingClear` | model | Released a held line |
| `speak.ack` | user | The owner replied (raised by `api-session/activity`) |
| `confirm.request` | user | Queue an owner-confirmed legacy action |
| `confirm.resolve` | user/plugin | That action approved / refused / expired |
| `import.bundle` | user | Import a JSON bundle |
| `import.ledger` | user | Import a whole ledger.jsonl |
| `export` | user | Record an export (GET does not) |
| `rollback` | user | Roll back to a snapshot |
| `chain.repair` | user | Seal a broken chain |

The ledger also contains older `memory.revise`, `memory.forget` and `origin.set` records — leftovers from removed capabilities. Replay still reads through them, but nothing new produces them.

---

## Off-peak duty

When a round lands in DeepSeek's discount window (noon 12–14, evening 18–09:00 the next day, all weekend) and something is due, it schedules an autonomous round — **in the session where you last spoke, not a fresh session** — that decides for itself whether to tidy its memory or change its own persona.

**"Nothing needs changing" is a valid decision.**

The reflection brief is numbered:

```
1 state & rhythm   2 old-memory compression  3 scratch (T4)
4 memory quota     4.5 re-reading old events 5 self & persona
6 future commitments  6.5 speaking up        7 knowing you
8 red lines        9 wrap-up & coming to find you
```

> 4.5 and 6.5 contain instructions rather than tasks of their own, so they only appear when there is
> something to act on (a memory worth re-reading, or words still held back). A round with nothing to
> re-read simply goes from 4 to 5.

> **Step 9 is not only a wrap-up**: it requires `silt_speak` to say one thing to him (or `defer` with a reason). Every reflection round is therefore a chance to come find you, not just to sort things out privately.

---

## Speaking up

`silt_speak` is the only path that lets it talk to the owner without being asked first.

**Two conditions only: off-peak, and its own judgement.**

**Reflection time is when it comes to find you**: the final step of each reflection round tells it to say one thing via `silt_speak` (or `defer` with a reason). **The reflection round itself also runs in the session where you last spoke** (`homeSession`), not a fresh session — even after a long silence. Only if that session is archived/missing does the round fail (it does not quietly open a new room).

What was deliberately left out, and why:

| Not added | Why |
|---|---|
| Daily cap | That would override its reading of the situation with the plugin's preference |
| Cooldown | Having something to say and being blocked by "wait 12 hours" means the plugin is lying |
| Interruption score / busy detection | It knows the situation better than a timer does |
| Score threshold | Make it compute a number and pass a bar, and it learns to game the bar |

The plugin only does the two things the model cannot: **read the clock** (is it off-peak) and
**deliver** (it has no scheduling service).

Deciding not to speak, with `op: "defer"` and a one-line reason, is recorded too — **silence is not failure**.

---

## Hard limits

> Written in code. The model cannot change them.

1. **Technical isolation** — code, paths, config and plugin internals never enter memory. Caught by
**structural signature** (code fences, `C:\…`, `npm install`, `.dsh/config.json`, `cordis`), not by topic
keywords — so "she writes Python" and "he finds Docker annoying" are still remembered; what gets blocked is
text that *looks like* a filesystem path or code.

   All write paths go through the same gate, not a prompt-level request: `silt_remember` (including tags and
   quote), `silt_persona` `self` and `adjust`/`replace`, and the page's **bundle import** (including quotes
   inside evidence). Writing one gets **rejected with the reason**, not silently swallowed. Whole-ledger
   import is stricter: seq, prev and every hash must match; a hash mismatch is refused — it will not recompute
   hashes and launder a tampered ledger.

2. **No silent erasure** — hash chain, see above.
3. **No fabrication** — the evidence on each memory comes from the plugin, from the call that wrote it. The model cannot supply it.
4. **No credentials** — ID numbers and card numbers are caught by shape, through the same gate.
5. **Add, never modify** — write a correct one, or void the old one.

---

## Compared with other approaches

Most agent memory systems on the market solve "how to store more" and "how to retrieve better". This plugin solves a third problem:
**how to let what was stored evolve on its own — getting shorter, fainter, wrong, expired — with a trace at every step.**

Tiering, forgetting curves and memory consolidation are nothing new. What is different:

| | Difference |
|---|---|
| **What fades is the content** | Other decays only affect ranking and eviction; a T3 here actually gets shorter |
| **Forecasts have deadlines** | Past due, it stays in view and forces handling instead of rotting quietly |
| **Voiding is a full mechanism** | Many systems have no contradiction resolution at all — wrong facts just sit there |
| **Merging is optional** | Same-tier 2–3 rows become one (not a gist); read them first, originals archived and rollback-able |
| **Tiers by lifecycle** | Not hot/warm/cold, but "forever true / gist / will fade" |

**Not included**: vector search (paraphrases with different wording won't match), automatic contradiction detection, metamemory, multi-tenant isolation.

---

## UI

The constellation icon in the left sidebar.

- **Portrait + persona card** — side by side; the portrait is square, its side equal to the persona card's height
- **Memory constellation** — 3D: six dimensions are six directions, tier sets the radius, brightness = salience
- **Still remembered** — T5 shows its deadline and overdue state
- **Self-view / persona card / what it knows about you / autonomous rhythm**
- **Evidence chain and rollback** — snapshot list, one-click import

### Portrait

The left card is **always there**: it shows the image if one exists, and a dashed placeholder if not.

- Source: `<DSH_HOME>/silt/portrait.(jpg|jpeg|png|webp)` — changing the portrait means replacing that file
- Ratio is fixed at **1:1**, and its height follows the persona card beside it (taller persona card ⇒ larger portrait)
- ⚠️ Today the **owner** drops the file in; the model has no way to change it.
  "Let it decide during reflection whether to change the portrait" is not implemented — where images
  would come from (an image-generation API / a pool the owner prepares / the model only writing a
  description) has not been decided, so this round only reserves the slot.

---

## Scope

This plugin assumes the model honestly judges "is this worth remembering". It defends against format problems, credential leaks and silent tampering — it cannot stop a model from writing a great deal about unimportant things.

What actually governs quality is **limits, decay, compression, voiding** — not the number of rules.

---

## Docs

- [Technical documentation (v2, Chinese, `.docx`)](docs/dsh-silt-tech-v2.docx)

---

## License

[MIT](LICENSE) © 2026 Daniel Lau

Use it, modify it, ship it commercially, keep it closed — just keep the copyright notice.
No warranty: the plugin assumes the model judges honestly. It guards against format problems
and credential leaks, not against a model writing a great deal about unimportant things.

