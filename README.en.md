<div align="center">

# dsh-silt

[中文](README.md)

> Cross-session memory and persona plugin for DSH · `v1.9.0` · 2026-11-25

`dsh-silt` is a long-term memory and persona-growth engine built for the DSH host process. It gives a model a memory that self-evolves, settles in layers, and can be interrogated — plus a persona card that grows out of the conversation itself.

---

![DSH plugin](https://img.shields.io/badge/DSH-plugin-blue) ![version](https://img.shields.io/badge/v1.9.0-green) ![license](https://img.shields.io/badge/license-MIT-brightgreen)

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
| **T1** | Facts and rules: facts that stay true, and rules to follow every time | 200 | 100 yr | ✅ |
| **T2** | Gists settled out of experience | 200 | 720 d | ✅ |
| **T3** | Experiences worth keeping (**no project details**) | 1000 | 180 d | ✅ |
| **T4** | Scratch: undecided, parked for now | 300 | 8 h (lives 24 h) | ❌ |
| **T5** | Forecasts: not yet happened, has a deadline | 400 | — | ✅ even after expiry |

> **Why T1 takes rules**: something the owner repeats has nowhere else to go but T3 —
> and T3 is *experiences*, so a rule filed there reads as a past event and gets ignored next time.
> A rule has to say "when this happens ⇒ do this ⇒ because of that", but the **limit stays 200 chars** —
> the answer is to tighten the wording, not to widen the bowl.
> Dates are fine to write: a date is *when this happened*, and that is part of the memory.
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

**T4 is a buffer, not a bin** — never injected. Each time it comes back, the model says how much
that recall weighed (0–0.5); when the total reaches 1 it is promoted to T3. If nobody recalls it, it drifts away.

Why not "promoted after three recalls": three is a count, not a weight. "He mentioned that name again"
and "he suddenly brought it up" both count once, but they should not weigh the same. Only the model can
say how much, and the plugin just adds it up.

**T5 expiry is not the end** — after the deadline it stays in the prompt, tagged `⏰expired`, forcing the model to go ask how it turned out. Only being voided removes it.

```
- T5 user getting married on 20 Dec (2026-11-15) — due 2026-12-20 ⏰expired
```

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
                 ├─ yes → T2 (system-generated, terminal)
                 └─ no  → still T3, wait for the next round
```

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

---

## Void: never rewrite history, only add a record

```
old  T1 user marrying 2027-03            ← not a single character changed
       voided: true
       voidedReason: user said that was wrong, it's 2027-06
       replacedBy: <id of the new one>
new  T1 user marrying 2027-06
```

Rewriting means "history was erased". Voiding means "this is what I knew at the time; later I found out otherwise".

Voided memories are not injected, but the ledger and the store keep them. `recall` still finds them, tagged `voided: true`.

### Three ways of "no longer using it"

| Action | Trigger | Meaning | In prompt |
|---|---|---|:--:|
| Archived | plugin | Compressed away | ❌ |
| Expired | time | T5 reached its deadline | ✅ tagged ⏰ |
| Voided | one word from the user | Turned out to be wrong | ❌ |

---

## What goes into the prompt

Three blocks: the one-line system command, **who I am**, and **what I still remember**.

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
| `silt_void` | Mark as void (content unchanged) |
| `silt_condense` | Retell a T3: `condense` to say less, `recast` to re-understand |
| `silt_persona` | Persona card and self-view |
| `silt_speak` | Reach the owner unprompted — **valley hours is the only gate** |
| `silt_understanding` | Six-dimension scoring |
| `silt_duty` | Read/adjust own rhythm |
| `silt_inject` | Read/adjust injection size |
| `silt_unseen` | Page through titles that didn't fit in the prompt |
| `silt_bili` | Bilibili browsing parameters |
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
| `reflectionEveryHours` | 24 | 6–72 | How often to reflect |
| `biliEveryHours` | 20 | 6–72 | How often to browse Bilibili |
| `dutyMaxPerDay` | 2 | 1–4 | Max duty rounds per day |
| `tier4TtlDays` | 30 | 0–90 | Scratch retention in days (0 = never expires) |

Bilibili browsing has its own whitelist (`perDay`, `fetchPerRound`, `keywords`, …). Account, DMs, auto-comment and other sensitive items stay with the user and are not open to model adjustment.

---

## Record types

`ledger.jsonl` holds only these kinds, and who writes each one is fixed.

| kind | Written by | Meaning |
|---|---|---|
| `genesis` | plugin | Ledger born / reset |
| `memory.write` | model | New memory (T1 / T3 / T4 / T5) |
| `memory.condense` | model | Condense one T3 |
| `memory.compress` | plugin | The only channel that produces T2 |
| `memory.upgrade` | plugin | T4 promoted to T3 |
| `memory.void` | model | Mark as void |
| `persona.revise` | model | Revise the persona card |
| `persona.foundation` | user | Change the persona foundation |
| `understanding.revise` | model | Six-dimension scoring |
| `inject.profile` | model | Adjust injection size |
| `rhythm.profile` | model | Adjust rhythm |
| `rollback` | user | Roll back to a snapshot |
| `chain.repair` | user | Seal a broken chain |

The ledger also contains older `memory.revise`, `memory.forget` and `origin.set` records — leftovers from removed capabilities. Replay still reads through them, but nothing new produces them.

---

## Off-peak duty

When a round lands in DeepSeek's discount window (noon 12–14, evening 18–09:00 the next day, all weekend) and something is due, it schedules an autonomous round — a fresh session that decides for itself whether to tidy memory, browse Bilibili, or change its own persona.

**"Nothing needs changing" is a valid decision.**

The reflection brief is numbered:

```
1 state & rhythm  2 old-memory compression  3 scratch
4 memory quota    5 self & persona          6 future commitments
7 knowing you     8 red lines               9 wrap-up
```

---

## Hard limits

> Written in code. The model cannot change them.

1. **Technical isolation** — code, paths, config and plugin internals never enter memory. Caught by
**structural signature** (code fences, `C:\…`, `npm install`, `.dsh/config.json`, `cordis`), not by topic
keywords — so "she writes Python" and "he finds Docker annoying" are still remembered; what gets blocked is
text that *looks like* a filesystem path or code.

   All write paths go through the same gate, not a prompt-level request: `silt_remember` (including tags and
   quote), `silt_persona` `self`, `silt_persona` `adjust`/`replace`, and `silt_import`. Writing one gets
   **rejected with the reason**, not silently swallowed.

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
| **One-to-one** | No merging several memories into a gist, which is what keeps the compression history fully traceable |
| **Tiers by lifecycle** | Not hot/warm/cold, but "forever true / gist / will fade" |

**Not included**: vector search (paraphrases with different wording won't match), automatic contradiction detection, metamemory, multi-tenant isolation.

---

## UI

The constellation icon in the left sidebar.

- **Memory constellation** — 3D: six dimensions are six directions, tier sets the radius, brightness = salience
- **Still remembered** — T5 shows its deadline and overdue state
- **Self-view / persona card / what it knows about you / autonomous rhythm**
- **Evidence chain and rollback** — snapshot list, one-click import

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

