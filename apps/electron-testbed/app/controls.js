// The controls page: each control is one case the engine got wrong once, read
// and driven by tests/controls.e2e.ts.

const someFiles = document.querySelector('#some-files');
someFiles.addEventListener('click', () => someFiles.setAttribute('aria-checked', 'true'));

const attachment = document.querySelector('[data-testid="attachment"]');
attachment.addEventListener('change', () => {
  document.querySelector('[data-testid="attachment-count"]').textContent = `${attachment.files.length} files`;
  void (attachment.files[0]?.text() ?? Promise.resolve('')).then((text) => {
    document.querySelector('[data-testid="attachment-text"]').textContent = text.slice(0, 40);
  });
});

document.querySelector('#guard').addEventListener('click', () => {
  window.addEventListener('beforeunload', (event) => event.preventDefault());
});

// Covers the button, renders it anew while covered, then uncovers it: a tap that waited on the first button must find the new one.
document.querySelector('#rerender-start').addEventListener('click', () => {
  const cover = document.createElement('div');
  cover.id = 'cover';
  document.body.append(cover);
  setTimeout(() => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Save draft';
    button.addEventListener('click', () => {
      document.querySelector('[data-testid="draft-status"]').textContent = 'Saved';
    });
    document.querySelector('#rerender-host').replaceChildren(button);
  }, 400);
  setTimeout(() => cover.remove(), 800);
});

document.querySelector('#scroll-under').addEventListener('click', () => {
  const target = document.querySelector('#under-header');
  window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY - 20);
});
document.querySelector('#under-header').addEventListener('click', () => {
  document.querySelector('[data-testid="under-header-status"]').textContent = 'Tapped';
});

// Typeahead: a key moves the selection to the first option it starts.
const planets = document.querySelector('#planets');
planets.addEventListener('keydown', (event) => {
  const next = [...planets.querySelectorAll('[role="option"]')].find((option) => option.textContent.toLowerCase().startsWith(event.key.toLowerCase()));
  if (next === undefined) return;
  for (const option of planets.querySelectorAll('[role="option"]')) option.setAttribute('aria-selected', String(option === next));
});

document.querySelector('#tip-anchor').addEventListener('mouseenter', () => {
  document.querySelector('[data-testid="tip"]').textContent = 'Tip shown';
});

const hold = document.querySelector('#hold');
hold.addEventListener('pointerdown', () => {
  document.querySelector('[data-testid="hold-state"]').textContent = 'down';
});
hold.addEventListener('pointerup', () => {
  document.querySelector('[data-testid="hold-state"]').textContent = 'up';
});

// What an editor that keeps its own model sees: the last beforeinput.
document.querySelector('[data-testid="tracked"]').addEventListener('beforeinput', (event) => {
  document.querySelector('[data-testid="tracked-event"]').textContent = event.inputType;
});

const scheme = window.matchMedia('(prefers-color-scheme: dark)');
const showScheme = () => {
  document.querySelector('[data-testid="scheme"]').textContent = scheme.matches ? 'dark' : 'light';
};
scheme.addEventListener('change', showScheme);
showScheme();

// An HTML drag: the drop reads what dragstart put in the data transfer, which only a real drag carries.
const tray = document.querySelector('#tray');
document.querySelector('#card').addEventListener('dragstart', (event) => {
  event.dataTransfer.setData('text/plain', 'card');
});
tray.addEventListener('dragover', (event) => event.preventDefault());
tray.addEventListener('drop', (event) => {
  event.preventDefault();
  document.querySelector('[data-testid="tray-status"]').textContent = `Tray holds ${event.dataTransfer.getData('text/plain')}`;
});

// A control its own change handler replaces: the click did its work, and the checkbox is gone.
document.querySelector('[data-testid="replace-box"]').addEventListener('change', () => document.querySelector('#replace-label').replaceWith('Saved'));

// An upload button: its click opens the chooser of a file input nothing shows.
const picked = document.querySelector('#picked');
document.querySelector('[data-testid="upload-button"]').addEventListener('click', () => picked.click());
picked.addEventListener('change', () => {
  document.querySelector('[data-testid="picked-name"]').textContent = picked.files[0]?.name ?? 'No file';
});

// A custom radio that a click clears, which a native one never does.
const ariaRadio = document.querySelector('[data-testid="aria-radio"]');
ariaRadio.addEventListener('click', () => ariaRadio.setAttribute('aria-checked', ariaRadio.getAttribute('aria-checked') === 'true' ? 'false' : 'true'));

const count = (output) => {
  const target = document.querySelector(`[data-testid="${output}"]`);
  target.textContent = String(Number(target.textContent) + 1);
};
document.querySelector('[data-testid="more-info"]').addEventListener('click', (event) => {
  event.preventDefault();
  count('more-clicks');
});
const hostButton = document.createElement('button');
hostButton.textContent = 'Hosted action';
hostButton.addEventListener('click', () => count('host-clicks'));
document.querySelector('[data-testid="disabled-host"]').attachShadow({ mode: 'open' }).append(hostButton);
