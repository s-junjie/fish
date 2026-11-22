# FISH Intake

A document is a stack of decisions. An agent that writes the first element before knowing which decisions were already made is not designing — it is guessing in vector, at 400 elements per guess.

Two failures cost the same, from opposite sides:

- **Random design.** Palette, typeface, grid and imagery invented from one sentence of request. The user can only react to the whole thing, so every round of feedback is "not like this", and nothing they said survives into the next draft.
- **Interrogation.** Six questions in prose, no defaults, no artifact. The user answers once, gets a worse first impression than a draft would have given, and starts avoiding the agent.

The round below is the narrow path: **one message, at most three questions, every one with a default already chosen and a way to skip**, ending in `intent.md` — which the user can read in ten seconds and correct in one line.

---

## 0. When this runs

**First turn of a new design, before any reference is opened.** The three questions are about the user's project; no file in this kit can answer them, and the references cannot make the questions better — they only make the build after them faster, which is not what the user is waiting for.

`fish brief` is the one command worth running first: it is a directory listing, it costs milliseconds, and it turns question 3 from “do you have anything?” into “are these yours?” — `logo.svg`, `brand-manual.pdf`.

---

## 1. Does this need an intake?

Count the decisions you would otherwise *invent*. Ask when any of these is unstated:

| Unstated | Why it changes the artifact |
| :-- | :-- |
| **Who** reads it, and what they should do after | A landing page for signups and one for a brand reveal share no layout, no density, no tone. |
| **Format** — canvas, page count, medium, language | Sets every dimension downstream; a deck slide and a poster are not the same decision scaled. |
| **Identity** — logo, brand colours, typeface, an existing product or system to match | Cannot be inferred at all, and cannot be approximated later without the user seeing it. |
| **Content** — the real copy, real data, the actual screens | Determines text volume, and text volume determines the layout. |

**No intake** when the request already answers them, when the document exists and `fish brief` says what is inside it, or when the change is local ("make this blue", "rename the title", "answer this comment"). Asking there is the same failure from the other side — the user asked for a colour, not for a discovery call.

An edit inherits the intake it was made under. Re-asking on every touch is how a good gate becomes a tax.

---

## 2. Recon before you ask

```bash
./tools/fish brief                      # no document yet: the directory, the intent record, the material
./tools/fish brief existing.fish.html   # what the document already carries
```

With no document, `brief` reports whether `intent.md` sits in the directory and which logo, image, font or brand-manual files are already there — names and sizes, not contents. With a document, it adds the tokens, styles, components and assets already in use.

Both are questions you no longer have to ask. **Never ask what the directory or the document already answers**: to a user who just dropped a `brand-manual.pdf` in the folder, "do you have brand guidelines?" reads as not having looked. Open the file instead — a brand manual in the folder outranks every question in §3.

---

## 3. The one message

Send this before the first element, as one message, not as a form and not as a fifth round:

```
Before I draw, three things decide the result. Answer any of them; skip the
rest and I'll take the default and mark it as an assumption in intent.md.

1. Who is it for, and what should they do after seeing it?
   → default: <your best read of the request>

2. Where does it live — screen size, print, deck, how many pages?
   → default: <1440×900 desktop, one page / A4 / 16:9 slide>

3. Do you have material I should build on: logo, brand colours or type,
   a brand manual, a moodboard, product screenshots, the real copy?
   → default: none — I'll choose and say what I chose and why.

Say "you decide" and I'll pick all three and start immediately.
```

Rules that make it one round instead of an interrogation:

- **Three questions, hard ceiling.** A fourth is a decision you can make and mark as a bet.
- **Every question has a default that is a real answer.** "What style do you want?" is not a question, it is handing the work back.
- **The material question is asked even when 1 and 2 are obvious**, because it is the only one no inference can replace.
- **One message, then no more asking.** If the answer is thin, bet and draft; a second round costs more than a wrong assumption the user can see.
- **The turn that asks draws nothing.** A skeleton beside the questions answers them for the user, and the answers you did not get are exactly the ones it guessed at.
- **Question 3 lists the shapes material comes in.** Users do not think of a PDF brand manual or a Figma file as "an asset" until you name it.

---

## 4. `intent.md` — the artifact

Write it beside the document, before the first element: plain text, because intent has to be revised, diffed and reviewed, and it outlives any one document. `fish brief` reports whether it exists; nothing enforces what is in it.

```md
# <Project> — design brief

## Goal
<one sentence: what this is for, and what the reader does after it>

## Audience & format
<who reads it; canvas / medium / pages; language>

## Direction
<a concrete posture in one line: "quiet editorial — warm paper, one serif, generous margins">
- palette: <roles with hex> — <user's brand / picked, because …>
- type: <families and where they come from>
- imagery: <what it shows and where it comes from>

## Material
| asset | source | how it enters |
| :-- | :-- | :-- |
| logo | [by: user] logo.svg | `assets import`, never redrawn |
| photography | [by: ai] Openverse | searched, embedded, credited |

## Bets
- <what the user did not confirm> — wrong if <what would falsify it>

## Open
- <a question that can wait until the draft exists>
```

The **Bets** section is the point of the file. An assumption written as “8px grid” is a decision the user must argue with; “8px rhythm — wrong if this should feel editorial and airy” is one they can falsify in four words. Every bet needs its falsifier, or it is a fact you invented.

Keep it under a screen. A brief nobody reads is a document nobody corrects.

---

## 5. Material

Material is what the user already owns. It outranks anything a source can return, and no search can guess it.

| They hand you | What it decides | How it enters |
| :-- | :-- | :-- |
| **Logo / wordmark** | The one mark that must be exact | `assets import` the file. Never redraw a real mark, never trace a screenshot, never rebuild it from type. Raster-only: use it at its own size, do not upscale. |
| **Brand manual / guidelines** (PDF, site, deck) | Palette, type, clearspace, what is forbidden | Read it before choosing anything. Colours → colour tokens; families → `fonts[]` + `fontFamily`; rules → constraints in `## Direction`. It outranks your taste and your defaults. |
| **Moodboard / references** | Direction, not content | Take what it actually shows — temperature, contrast, crop, density — and say which property you took. Placing the reference image itself is a different decision. |
| **Product shots / real screens** | The product's real surface | Import them. Never hand-draw a fake dashboard beside a real one. |
| **Copy** | Text volume, which is layout | Use their words over lorem ipsum. If there are none, say the copy is placeholder and keep it obviously so. |
| **Fonts** | Voice, and whether the file travels | Ask which. A family with no `fonts[].src` re-wraps on a machine that lacks it (`--strict-assets`). |
| **"Not this"** | Bounds the space more cheaply than any preference | Off-limits colours, competitor resemblance, legal marks. One line, one saved round. |

**A source instead of a file** — a link to a photo they like is material too: import the URL with its credit (`assets.md` §2 “Bring a URL you already chose”) instead of searching for something similar.

**None of it** is also an answer: search the sources in `assets.md`, then say what you picked and why in `## Direction`. What is not allowed is a stock lookalike standing in for a logo or a photo the user may already own, without saying so.

Licences and attribution are in `assets.md` §1 — a credited Openverse result is still a licensed work.

---

## 6. Exit paths

The gate has to survive every answer, including none:

- **Answered** → write `intent.md`, then draft (§0 of `workflow.md`).
- **"You decide"** → choose, record the choices as bets, and stop asking for the rest of the session.
- **No human** (CI, batch, one-shot, a prompt pasted with no one behind it) → write `intent.md` from the prompt alone, mark every line you invented as a bet, draft, and say at handover which sections are guesses. Never stall waiting for an answer that is not coming, and never present a guess as the brief.
- **Half answered** → take what you got, default the rest, bet them. A second round is worse than a visible assumption.
- **Existing document** → no intake. `fish brief` it and work.

---

## 7. Anti-patterns

- Asking what `fish brief` would have told you.
- A question with no default.
- Searching stock for a logo.
- Presenting an invented palette as "the brand".
- Re-asking after "you decide".
- `intent.md` with no `## Bets` — that is a description of the draft, not a record of what was assumed.
- Turning intake into a stall. If the answer never comes, the draft with marked bets *is* the answer.
