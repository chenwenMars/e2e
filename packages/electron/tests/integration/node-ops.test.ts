/**
 * The page-side functions in `src/in-page/`, sent as source text the way
 * `devtools.ts` sends them, on real pages in an Electron window.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevTools } from '../../src/devtools.ts';
import { activeUnder, queryAll, type NodeOps } from '../../src/in-page/node-ops.ts';
import { openTestWindow, type TestWindow } from './test-window.ts';

const devtools = new DevTools();
let window: TestWindow;

beforeAll(async () => {
  window = await openTestWindow();
});

afterAll(async () => {
  await window.close();
});

/** Runs one of `NodeOps` on a node, as the engine does. */
function run<K extends keyof NodeOps>(node: number, name: K, ...args: Parameters<NodeOps[K]>): Promise<ReturnType<NodeOps[K]>> {
  return devtools.callOn(window.page, node, name, ...args);
}

const element = (selector: string): Promise<number> => window.element(selector);

describe('nodeOp', () => {
  it('reads disabled as Chromium does: a fieldset disables its controls, aria-disabled the nearest wins', async () => {
    await window.setContent(`
      <fieldset disabled><button id="in-fieldset">A</button><legend><a href="#" id="link">L</a></legend></fieldset>
      <div aria-disabled="true"><span id="marked">M</span><div aria-disabled="false"><span id="unmarked">U</span></div></div>
      <button id="hidden" style="visibility:hidden">H</button>`);
    expect(await run(await element('#in-fieldset'), 'checkEnabled', true)).toEqual({ ok: false, reason: 'it is disabled' });
    expect(await run(await element('#in-fieldset'), 'checkEnabled', false)).toEqual({ ok: true });
    expect(await run(await element('#link'), 'checkEnabled', true)).toEqual({ ok: true });
    expect(await run(await element('#marked'), 'checkEnabled', true)).toEqual({ ok: false, reason: 'it is disabled' });
    expect(await run(await element('#unmarked'), 'checkEnabled', true)).toEqual({ ok: true });
    expect(await run(await element('#hidden'), 'checkEnabled', false)).toEqual({ ok: false, reason: 'it is not visible' });
  });

  it('hit-tests through a slot and a shadow host, and names the element that covers the point', async () => {
    await window.setContent(`
      <div id="host"><button id="slotted" style="width:100px;height:40px">S</button></div>
      <button id="covered" style="position:absolute;left:0;top:100px;width:100px;height:40px">C</button>
      <div id="cover" style="position:absolute;left:0;top:100px;width:100px;height:40px"></div>`);
    await window.inPage(() => {
      const root = document.querySelector('#host')!.attachShadow({ mode: 'open' });
      root.innerHTML = '<div><slot></slot></div>';
    });
    const slotted = await element('#slotted');
    const box = await window.box('#slotted');
    expect(await run(slotted, 'hitTest', box.x + 10, box.y + 10)).toEqual({ ok: true });
    expect(await run(await element('#covered'), 'hitTest', 10, 110)).toEqual({ ok: false, reason: 'another element (div#cover) would receive the click' });
  });

  it('takes a label over the field it names as a hit', async () => {
    await window.setContent(`<label for="field" style="display:block;width:100px;height:40px">Name</label><input id="field">`);
    expect(await run(await element('#field'), 'hitTest', 10, 10)).toEqual({ ok: true });
  });

  it('checks a field for editing and sets the value of an input that takes no typed text', async () => {
    await window.setContent(`<input id="text"><input id="ro" readonly><input id="date" type="date" value="2026-01-02"><input id="num" type="number"><div id="host" contenteditable="true">x</div><div id="plain">p</div>`);
    expect(await run(await element('#text'), 'checkEditable')).toEqual({ ok: true });
    expect(await run(await element('#ro'), 'checkEditable')).toEqual({ ok: false, reason: 'it is read-only' });
    expect(await run(await element('#host'), 'checkEditable')).toEqual({ ok: true });
    expect(await run(await element('#plain'), 'checkEditable')).toEqual({ ok: false, reason: 'it is not a text field' });
    expect(await run(await element('#text'), 'setValue', 'typed')).toBeNull();
    expect(await run(await element('#num'), 'setValue', 'abc')).toEqual({ ok: false, reason: 'the number input does not take "abc"' });
    // A malformed date is refused before the field loses what it held.
    expect(await run(await element('#date'), 'setValue', 'not a date')).toEqual({ ok: false, reason: 'the date input does not take "not a date"' });
    expect(await window.inputValue('#date')).toBe('2026-01-02');
    expect(await run(await element('#date'), 'setValue', '2026-03-04')).toEqual({ ok: true });
    expect(await window.inputValue('#date')).toBe('2026-03-04');
  });

  it('fills a range past its default bounds and an input of an unknown type, trimmed and in the case the input keeps', async () => {
    await window.setContent(`<input id="range" type="range" min="0" max="1000" step="50" value="100"><input id="odd" type="unknownkind"><input id="tint" type="color">`);
    expect(await run(await element('#range'), 'setValue', '750')).toEqual({ ok: true });
    expect(await window.inputValue('#range')).toBe('750');
    expect(await run(await element('#odd'), 'checkEditable')).toEqual({ ok: true });
    expect(await run(await element('#tint'), 'setValue', ' #FF8800 ')).toEqual({ ok: true });
    expect(await window.inputValue('#tint')).toBe('#ff8800');
  });

  it('fails a check on a node the document dropped, so the harness locates it again', async () => {
    await window.setContent(`<button id="gone">Gone</button>`);
    const gone = await element('#gone');
    await window.inPage(() => document.querySelector('#gone')!.remove());
    await expect(run(gone, 'checkEnabled', true)).rejects.toThrow(/Node is detached/);
  });

  it('says whether a file input takes several files, empties one, and tells a native radio and a file input', async () => {
    await window.setContent(`<input id="one" type="file"><input id="many" type="file" multiple><input id="radio" type="radio"><div id="aria" role="radio"></div><input id="box" type="checkbox">`);
    expect(await run(await element('#one'), 'takesFiles', 2)).toEqual({ ok: false, reason: 'the file input takes one file, not 2: it has no multiple attribute' });
    expect(await run(await element('#many'), 'takesFiles', 2)).toEqual({ ok: true });
    await run(await element('#one'), 'clearFiles');
    expect(await run(await element('#radio'), 'isNativeRadio')).toBe(true);
    // A custom radio's click may clear it: uncheck() tries.
    expect(await run(await element('#aria'), 'isNativeRadio')).toBe(false);
    expect(await run(await element('#box'), 'isNativeRadio')).toBe(false);
    expect(await run(await element('#one'), 'isFileInput')).toBe(true);
    expect(await run(await element('#box'), 'isFileInput')).toBe(false);
  });

  it('reads a checked state from the input or aria-checked on a role that has one, and null for none', async () => {
    await window.setContent(`<input id="box" type="checkbox" checked><div id="switch" role="switch" aria-checked="false"></div><button id="toggle" aria-pressed="true">T</button><div id="none"></div><div id="mixed" role="checkbox" aria-checked="mixed"></div>`);
    expect(await run(await element('#box'), 'readChecked')).toBe(true);
    expect(await run(await element('#switch'), 'readChecked')).toBe(false);
    // A toggle button's aria-pressed is not a checked state, as on the web.
    expect(await run(await element('#toggle'), 'readChecked')).toBeNull();
    expect(await run(await element('#none'), 'readChecked')).toBeNull();
    // A mixed checkbox is not checked, so check() clicks it.
    expect(await run(await element('#mixed'), 'readChecked')).toBe(false);
  });

  it('finds an option by label, then text, value, or index, and refuses a missing or disabled one', async () => {
    await window.setContent(`<select id="pick"><option value="a">Apple</option><option value="b" label="Banana">ignored</option><optgroup disabled><option value="c">Cherry</option></optgroup></select>`);
    const pick = await element('#pick');
    expect(await run(pick, 'checkSelect', { label: 'Banana' })).toEqual({ ok: true });
    expect(await run(pick, 'checkSelect', { label: 'Cherry' })).toEqual({ ok: false, reason: 'option "Cherry" is disabled' });
    expect(await run(pick, 'checkSelect', { label: 'Durian' })).toEqual({ ok: false, reason: 'no option matches {"label":"Durian"}; the options are "Apple", "Banana", "Cherry"' });
    expect(await run(pick, 'selectOption', { value: 'b' })).toEqual({ ok: true });
    expect(await window.inputValue('#pick')).toBe('b');
    expect(await run(pick, 'selectOption', { index: 0 })).toEqual({ ok: true });
    expect(await window.inputValue('#pick')).toBe('a');
  });

  it('follows focus through open shadow roots, and stops at a closed one', async () => {
    await window.setContent(`<div id="open"></div><div id="closed"></div>`);
    await window.inPage(() => {
      const open = document.querySelector('#open')!.attachShadow({ mode: 'open' });
      open.innerHTML = '<input id="inner">';
      (open.querySelector('#inner') as HTMLInputElement).focus();
    });
    const focused = (): Promise<string> => window.inPage((source: string) => (new Function(`return (${source})`)() as typeof activeUnder)(document)?.id ?? '', activeUnder.toString());
    expect(await focused()).toBe('inner');
    await window.inPage(() => {
      const closed = document.querySelector('#closed')!.attachShadow({ mode: 'closed' });
      closed.innerHTML = '<input>';
      closed.querySelector('input')!.focus();
    });
    expect(await focused()).toBe('closed');
  });

  it('points a checkbox with no box at the label that draws it, and takes a click inside that label', async () => {
    await window.setContent(`<label id="label" style="display:block;margin:40px"><input id="drawn" type="checkbox" style="position:absolute;width:0;height:0;margin:0;border:0;padding:0"> <span id="words">Drawn</span> <a id="link" href="#">terms</a></label><input id="plain" type="checkbox"><button id="other">Other</button>`);
    const drawn = await element('#drawn');
    const point = await run(drawn, 'labelPoint');
    const label = await window.box('#label');
    expect(point).toEqual({ x: Math.round(label.x + label.width / 2), y: Math.round(label.y + label.height / 2) });
    expect(await run(await element('#plain'), 'labelPoint')).toBeNull();
    expect(await run(await element('#other'), 'labelPoint')).toBeNull();
    const centre = async (selector: string): Promise<[number, number]> => {
      const box = await window.box(selector);
      return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)];
    };
    expect(await run(drawn, 'hitTest', ...(await centre('#words')))).toEqual({ ok: true });
    // A click on a link inside the label follows the link, not the label.
    expect(await run(drawn, 'hitTest', ...(await centre('#link')))).toEqual({ ok: false, reason: 'another element (a#link) would receive the click' });
  });

  it('tells focus taken from focus moved away and from focus never taken', async () => {
    await window.setContent(`<input id="field"><div id="plain">Plain</div><input id="hands-off"><input id="elsewhere">`);
    await window.inPage(() => document.querySelector('#hands-off')!.addEventListener('focus', () => (document.querySelector('#elsewhere') as HTMLInputElement).focus()));
    expect(await run(await element('#field'), 'focus')).toBe('held');
    expect(await run(await element('#plain'), 'focus')).toBe('none');
    expect(await run(await element('#hands-off'), 'focus')).toBe('moved');
  });

  it('points at the value an option has when a label names none', async () => {
    await window.setContent(`<select id="kind"><option value="work">Work</option></select>`);
    expect(await run(await element('#kind'), 'checkSelect', { label: 'work' })).toEqual({ ok: false, reason: 'no option matches {"label":"work"}; the options are "Work"; an option has the value "work": pass { value: "work" }' });
  });

  it('says which focused elements take typed text', async () => {
    await window.setContent(`<input id="text"><input id="box" type="checkbox"><textarea id="ro" readonly></textarea><div id="host" contenteditable="true"></div><ul id="list" role="listbox" tabindex="0"></ul><button id="button">B</button>`);
    expect(await run(await element('#text'), 'takesText')).toBe(true);
    expect(await run(await element('#box'), 'takesText')).toBe(false);
    expect(await run(await element('#ro'), 'takesText')).toBe(false);
    expect(await run(await element('#host'), 'takesText')).toBe(true);
    // A listbox takes typed keys as typeahead; a button would take a space as a click.
    expect(await run(await element('#list'), 'takesText')).toBe(true);
    expect(await run(await element('#button'), 'takesText')).toBe(false);
  });
});

describe('queryAll', () => {
  it('matches in the document and in every open shadow root, one root at a time', async () => {
    await window.setContent(`<p class="hit">1</p><div id="host"></div>`);
    await window.inPage(() => {
      const root = document.querySelector('#host')!.attachShadow({ mode: 'open' });
      root.innerHTML = '<p class="hit">2</p><div id="nested"></div>';
      root.querySelector('#nested')!.attachShadow({ mode: 'open' }).innerHTML = '<p class="hit">3</p>';
      document.body.appendChild(document.createElement('div')).attachShadow({ mode: 'closed' }).innerHTML = '<p class="hit">hidden</p>';
    });
    const texts = await window.inPage((source: string) => (new Function(`return (${source})`)() as typeof queryAll)('.hit').map((found) => found.textContent), queryAll.toString());
    expect(texts).toEqual(['1', '2', '3']);
    // A selector that crosses a root matches nothing: each root is matched on its own.
    const crossing = await window.inPage((source: string) => (new Function(`return (${source})`)() as typeof queryAll)('#host .hit').length, queryAll.toString());
    expect(crossing).toBe(0);
  });

  it('reads computed styles, and how much of a box its scrollers and the window leave in view', async () => {
    await window.setContent(`
      <body style="margin:0">
      <p id="styled" style="color:rgb(255, 0, 0);font-weight:700">S</p>
      <div style="width:100px;height:100px;overflow:hidden;position:relative">
        <div id="half" style="width:100px;height:100px;margin-top:50px"></div>
        <div id="scrolled-out" style="width:100px;height:50px;margin-top:500px"></div>
        <div id="fixed" style="position:fixed;left:0;top:0;width:10px;height:10px"></div>
      </div>
      <div id="below" style="margin-top:5000px;width:10px;height:10px"></div>
      <span id="boxless" style="display:none">N</span>`);
    expect(await run(await element('#styled'), 'readStyle', ['color', 'font-weight'])).toEqual({ color: 'rgb(255, 0, 0)', 'font-weight': '700' });
    expect(await run(await element('#half'), 'viewportIntersection')).toEqual({ intersects: true, ratio: 0.5 });
    expect(await run(await element('#scrolled-out'), 'viewportIntersection')).toEqual({ intersects: false, ratio: 0 });
    // A fixed box is the window's to clip, whatever scroller it sits in.
    expect(await run(await element('#fixed'), 'viewportIntersection')).toEqual({ intersects: true, ratio: 1 });
    expect(await run(await element('#below'), 'viewportIntersection')).toEqual({ intersects: false, ratio: 0 });
    expect(await run(await element('#boxless'), 'viewportIntersection')).toEqual({ intersects: false, ratio: 0 });
  });
});
