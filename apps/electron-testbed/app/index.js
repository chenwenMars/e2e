// The sign-in window's script: it talks to the main process through the
// preload bridge only.
const form = document.getElementById('sign-in');
const status = document.querySelector('[data-testid="status"]');
const count = document.querySelector('[data-testid="count"]');

void window.testbed.greeting().then((text) => {
  document.getElementById('greeting').textContent = text;
});

// A remembered user survives a relaunch: it lives in the app's data, which `app.clearState()` empties.
const remembered = localStorage.getItem('remembered-user');
if (remembered !== null) {
  form.elements.namedItem('username').value = remembered;
  status.textContent = `Welcome back, ${remembered}`;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const result = await window.testbed.signIn({
    username: String(data.get('username')),
    password: String(data.get('password')),
    plan: String(data.get('plan')),
    remember: data.get('remember') === 'on',
  });
  status.textContent = result.message;
  if (result.ok && data.get('remember') === 'on') localStorage.setItem('remembered-user', String(data.get('username')));
});

document.getElementById('increment').addEventListener('click', () => {
  count.textContent = String(Number(count.textContent) + 1);
});

document.getElementById('open-settings').addEventListener('click', () => {
  void window.testbed.openSettings();
});

// A web component's content sits in an open shadow root, where a CSS locator still reaches it.
document.getElementById('badge-host').attachShadow({ mode: 'open' }).innerHTML = '<span class="badge">Beta</span>';

// A field that hands focus on to the username field as soon as it gets it, as a focus trap can.
document.querySelector('[data-testid="handoff"]').addEventListener('focus', () => {
  document.querySelector('[data-testid="username"]').focus();
});

// A field that swallows every key press, as a masked input that handles keys itself does.
document.querySelector('[data-testid="invite"]').addEventListener('keydown', (event) => event.preventDefault());

// A field whose focus handler holds the page for two seconds, longer than a short action timeout.
document.querySelector('[data-testid="slow"]').addEventListener('focus', () => {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    // Busy on purpose: the page answers nothing until the handler returns.
  }
});

document.getElementById('wide').addEventListener('click', () => {
  document.querySelector('[data-testid="wide-result"]').textContent = 'Wide action ran';
});

// A drop counts only when the press started on the source and the release lands on the zone, far below it.
let pressed;
document.addEventListener('mousedown', (event) => {
  pressed = event.target.id;
});
document.addEventListener('mouseup', (event) => {
  if (event.target.id !== 'drop-zone') return;
  document.querySelector('[data-testid="drag-result"]').textContent = `Dropped ${pressed || 'nothing'} on the zone`;
});

// A field whose key handler holds the page for 300 ms per key, so typing a word outlasts a short timeout.
document.querySelector('[data-testid="laggy"]').addEventListener('keydown', () => {
  const until = Date.now() + 300;
  while (Date.now() < until) {
    // Busy on purpose.
  }
});

document.getElementById('locked').addEventListener('click', () => {
  document.querySelector('[data-testid="link-result"]').textContent = 'Locked action ran';
});
document.getElementById('unlocked').addEventListener('click', () => {
  document.querySelector('[data-testid="link-result"]').textContent = 'Unlocked action ran';
});
document.getElementById('archive-link').addEventListener('click', (event) => {
  event.preventDefault();
  document.querySelector('[data-testid="link-result"]').textContent = 'Archive opened';
});

document.querySelector('[data-testid="attachment"]').addEventListener('change', (event) => {
  document.querySelector('[data-testid="attachment-name"]').textContent = Array.from(event.target.files, (file) => file.name).join(', ');
});

// Options that arrive after a request, as a list loaded from a server does.
setTimeout(() => {
  const room = document.querySelector('[data-testid="room"]');
  room.replaceChildren(...['Lobby', 'Studio'].map((name) => new Option(name)));
}, 300);

const items = document.getElementById('items');
for (let index = 1; index <= 40; index += 1) {
  const item = document.createElement('li');
  item.textContent = `Item ${index}`;
  items.append(item);
}

// A checkbox widget that sets its state in a later task, as a framework batching updates does.
const lateCheck = document.querySelector('[data-testid="late-check"]');
lateCheck.addEventListener('click', () => {
  setTimeout(() => lateCheck.setAttribute('aria-checked', String(lateCheck.getAttribute('aria-checked') !== 'true')), 150);
});

// A key sent to a node that cannot take focus reaches the document, as on the web.
document.addEventListener('keydown', (event) => {
  document.querySelector('[data-testid="key-result"]').textContent = `Key ${event.key}`;
});

// A web component that renders a button around a slotted label: the click lands on the slotted child.
customElements.define('word-button', class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<button type="button"><slot></slot></button>';
    root.querySelector('button').addEventListener('click', () => {
      document.querySelector('[data-testid="word-result"]').textContent = 'Word button clicked';
    });
  }
});

// A native dialog the app opens: nothing answers it, so it is dismissed and the app reads `false`.
document.getElementById('ask').addEventListener('click', () => {
  document.querySelector('[data-testid="ask-result"]').textContent = `confirm returned ${confirm('Sure?')}`;
});

// A modal dialog is in the top layer, above everything the page stacks with z-index.
document.getElementById('open-vault').addEventListener('click', () => document.getElementById('vault-dialog').showModal());
