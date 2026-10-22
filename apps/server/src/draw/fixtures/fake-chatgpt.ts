/**
 * OFFLINE FIXTURE, NOT ChatGPT. Reproduces only the selectors agent-tools verified (composer, send,
 * stop, turn key, turn state, profile menu, alert) plus a plausible file input and an <img> in the
 * assistant turn. It proves the backend's CDP mechanics (upload, type, send, wait, extract, save,
 * error mapping) and nothing about the real site.
 *   /           logged in, produces an image after ~3 s
 *   /quota      logged in, answers with a [role=alert] image-limit message
 *   /loggedout  login wall
 */
type Mode = 'ok' | 'quota' | 'loggedout';

const pageHtml = (mode: Mode) => `<!doctype html><meta charset=utf-8><title>ChatGPT fixture</title>
<body>
${mode === 'loggedout' ? '<a href="/auth/login">Log in</a>' : '<button aria-label="Open profile menu">me</button>'}
<main id=conv></main>
<input type=file accept="image/*" multiple id=fi>
<div id=att></div>
<div contenteditable="true" data-composer-markdown role="textbox" aria-label="Ask ChatGPT" style="min-height:40px;border:1px solid #888"></div>
<button aria-label="Send">Send</button><span id=stopwrap></span>
<script>
const mode = ${JSON.stringify(mode)};
let files = [];
document.getElementById('fi').addEventListener('change', e => {
  files = [...e.target.files];
  document.getElementById('att').innerHTML = files.map(() => '<div data-testid="attachment">file</div>').join('');
});
const turn = (key, role, state, html) => { const d = document.createElement('section'); d.dataset.turnKey = key; d.dataset.turn = role;
  d.innerHTML = '<div data-talvt-turn-state="' + state + '"></div><div>' + html + '</div>'; document.getElementById('conv').append(d); return d; };
document.querySelector('[aria-label=Send]').addEventListener('click', () => {
  const text = document.querySelector('[role=textbox]').textContent;
  if (!text) return;
  window.__sent = (window.__sent || 0) + 1;
  fetch('/sent?files=' + files.length + '&text=' + encodeURIComponent(text.slice(0, 200)));
  document.querySelector('[role=textbox]').textContent = '';
  turn('00000000-0000-4000-8000-000000000001', 'user', 'complete', '<p>' + text.replace(/</g,'&lt;') + '</p>');
  const a = turn('00000000-0000-4000-8000-000000000002', 'assistant', 'in_progress', '<p>Creating image</p>');
  document.getElementById('stopwrap').innerHTML = '<button aria-label="Stop">Stop</button>';
  setTimeout(() => {
    document.getElementById('stopwrap').innerHTML = '';
    a.querySelector('[data-talvt-turn-state]').dataset.talvtTurnState = 'complete';
    if (mode === 'quota') {
      const al = document.createElement('div'); al.setAttribute('role','alert');
      al.textContent = "You've hit the limit for image generation requests. You can create more images when the limit resets in 2 hours 30 minutes.";
      document.body.append(al);
    } else a.lastElementChild.innerHTML = '<img alt="Generated image" width=512 height=512 src="/gen.png">';
  }, 3000);
});
</script>`;

export interface FakeChatgpt {
  readonly baseUrl: string;
  /** Prompts received by the fixture's "send" button, as `{files, text}`. */
  readonly sends: Array<{ files: number; text: string }>;
  /** Number of page loads served (any mode). */
  pageLoads(): number;
  stop(): void;
}

export function startFakeChatgpt(generatedImagePath: string): FakeChatgpt {
  let loads = 0;
  const sends: FakeChatgpt['sends'] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/gen.png') return new Response(Bun.file(generatedImagePath));
      if (url.pathname === '/sent') {
        sends.push({
          files: Number(url.searchParams.get('files')),
          text: url.searchParams.get('text') ?? '',
        });
        return new Response('ok');
      }
      const mode: Mode = url.pathname.startsWith('/quota')
        ? 'quota'
        : url.pathname.startsWith('/loggedout')
          ? 'loggedout'
          : 'ok';
      loads++;
      return new Response(pageHtml(mode), { headers: { 'content-type': 'text/html' } });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    sends,
    pageLoads: () => loads,
    stop: () => void server.stop(true),
  };
}
