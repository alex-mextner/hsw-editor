# Draw backends (missing views)

Generate extra views (front/side/top/back, orthographic-ish, white background) of one object from its photo.
Results are **hints for the fitter, never ground truth**: every candidate is `source: 'generated'`, is
quality-gated and carries its prompt-template version. Dimensions still come from calibrated photos or the user.

Code: contract, prompts and quality gate in `packages/draw`; backends, guard, routes, CLI in `apps/server/src/draw`;
Python caller in `services/draw/draw_client.py`.

## Backends

| id | what | one-time user action |
|---|---|---|
| `omp` | omp `generate_image` (codex transport) run as a throw-away `omp --mode json` with a per-run config overlay; the user's omp config is never changed | `omp login openai-codex` (or an `OPENROUTER_API_KEY` / `GEMINI_API_KEY` / `XAI_API_KEY`) |
| `chatgpt-browser` | Ordinary Chrome with a **dedicated** profile (`~/.local/share/hsw-editor/chatgpt-profile`), own loopback CDP port (9231), private Xvfb `:131`. Driven over CDP: upload refs, type prompt, send, wait, extract `<img>` | `hsw-editor draw login chatgpt`: log in once in the window that opens, close it |
| `manual` | A pending job holds `prompt.txt` + the refs; the user uploads image(s); the same request collects them | none |

Setting `backend`: `auto` (default) tries `omp` → `chatgpt-browser` → `manual`, falling through **only** on
`login_required` / `backend_unavailable`. `quota_exhausted` and `challenge` stop the chain (the same plan may sit behind
both ChatGPT paths; a captcha needs a human). Or pin one backend.

Rules the browser backend never breaks: one owner lock (`draw/chatgpt-owner.lock` + Chrome's own profile lock); never
attaches to a `chatgpt-guardian-*` browser or profile (refuses any path containing `chatgpt-guardian`); only its own tab;
human pacing (default 60 s min gap + 0.5-4 s jitter, 30 sends/24 h, `HSW_DRAW_MIN_INTERVAL_MS`, `HSW_DRAW_DAILY_CAP`);
stops at login wall / captcha and tells the user; no stealth flags, no captcha solving, cookies are never read or exported.
Privacy: reference photos leave the machine for both automatic backends.

## Contract v1 (`packages/draw/src/contract.ts`)

`DrawBackend.draw(req, signal) -> DrawResult`. CLI: `hsw-editor draw run [--backend id]`, one JSON request on stdin, one
JSON result on stdout, exit code = failure class.

Request: `{version:1, prompt (<=8000), refs:[{path:/abs, role?: subject|style|view}] (<=5), n (1..4, sequential),
size (1024x1024|1536x1024|1024x1536), outDir:/abs, timeoutMs?, tag?}`.
Success: `{ok:true, backend, images:[{path,mime,bytes,sha256,width,height}], meta:{elapsedMs, model?, conversationUrl?}}`.

| failure `code` | exit | retryable | editor action |
|---|---|---|---|
| `invalid_request` | 2 | no | caller bug |
| `login_required` | 3 | no | show the one-time steps |
| `quota_exhausted` | 4 | after `retryAfterMs` | disable draw until then, offer manual |
| `challenge` | 5 | no | human must act in the dedicated browser |
| `timeout` | 6 | once | |
| `backend_unavailable` | 7 | no | Chrome/Xvfb/omp missing, profile owned elsewhere, selector drift (screenshot saved in outDir) |
| `refused` | 8 | no | answered without an image / policy |
| `manual_pending` | 10 | yes | `jobDir` holds `prompt.txt`, refs, `inbox/` |

## Quota / guard state

`~/.local/share/hsw-editor/draw/guard.json` (mode 600), per backend: send timestamps (rolling 24 h), `blockedUntil`
(parsed from "resets in N hours M minutes", default 1 h, min 1 min), `loginRequiredAt`, `challengeAt`, `lastOkAt`.
A blocked backend refuses locally without touching the browser. A login wall is re-checked after 2 min or by a status
probe; a challenge is cleared only by a healthy probe/login after the human acted.

## HTTP API (`createDrawRoutes`, `apps/server/src/draw/routes.ts`)

- `GET /api/draw/backends[?probe=1]` → `{settings, backends:[{id,state,message,steps[],retryAfterMs?,verified,sendsLast24h,dailyCap}]}`;
  `state` ∈ ready|login_required|quota_exhausted|challenge|unavailable|manual. `steps` are literal shell commands. omp is
  checked on every call (cheap `omp models ls --kind image`, 60 s cache); the ChatGPT page is loaded only with `probe=1`.
- `GET|PUT /api/draw/settings` `{backend: auto|omp|chatgpt-browser|manual}`.
- `GET /api/draw/manual/:id` → prompt, refs, uploaded count; `POST /api/draw/manual/:id/inbox` raw image body (<= 35 MiB,
  magic-byte validated) → the next `draw.views` run with the same inputs collects it.
- Generation itself is the job kind `draw.views` on the job runner (one draw at a time, server-wide).

## CLI

```
hsw-editor draw status [--probe] [--json]   # exit 1 when no automatic backend is ready
hsw-editor draw doctor                      # status with live probes + the exact one-time steps
hsw-editor draw login chatgpt               # one-time interactive login (user's display, dedicated profile)
hsw-editor draw stop                        # stop the dedicated automation browser
hsw-editor draw settings [auto|omp|chatgpt-browser|manual]
hsw-editor draw run [--backend id] < request.json
```

## Prompts (`packages/draw/src/prompts.ts`, `PROMPT_TEMPLATE_VERSION = 1`)

One request per missing view. Every prompt demands: the SAME object, pure white seamless background, no cast/contact
shadow, orthographic projection, centred with margin, even lighting, nothing else in frame; plus real dimensions when
known. Consistency across views is by chaining: the subject photo is always ref #1, accepted earlier views follow as
`view` refs (max 5). Neither backend exposes a seed. Bump the version on any wording change.

## Quality gate (`packages/draw/src/quality.ts`)

Cheap deterministic CV on decoded RGBA (decoding via `sharp` in the server): rejects `aspect_mismatch`,
`background_not_white`, `object_missing`, `object_cut`, `shadow` (soft gray far from solid pixels),
`proportion_mismatch` (silhouette bbox vs the fit's expected aspect); `perspective` (straight converging silhouette
edges) is a warning unless `strictPerspective`. Rejected images are kept in the draw work dir for inspection and never
attached to a wall.

## Selector provenance (chatgpt-browser)

VERIFIED upstream (agent-tools `live_dom.js`/`dom.js`): composer, send, stop, turn key/state, profile menu, login link,
`[role=alert]`, attachment marker, captcha frames. OBSERVED logged-out (2026-10-22): file inputs, "Log in" button.
UNVERIFIED until the first logged-in run: which file input takes uploads (the image-accepting one is chosen), the
generated `<img>` shape, image-quota wording. The first real run is a calibration run; failures save a screenshot.
Offline proof: `chatgpt-browser.e2e.test.ts` drives real headless Chrome against `fixtures/fake-chatgpt.ts` (mechanics
only). Against the real site, a logged-out profile is reported `login_required` (nothing typed, nothing sent).
