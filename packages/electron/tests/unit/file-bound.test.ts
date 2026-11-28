import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { appDirectory, outsideApp } from '../../src/file-bound.ts';

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'e2e-electron-bound-')));
const app = path.join(root, 'app');
mkdirSync(path.join(app, 'renderer'), { recursive: true });
writeFileSync(path.join(app, 'main.js'), '');
writeFileSync(path.join(app, 'renderer', 'index.html'), '');
writeFileSync(path.join(root, 'secret.txt'), '');
const page = pathToFileURL(path.join(app, 'renderer', 'index.html')).href;

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('appDirectory', () => {
  it('is what the main process reports, else the declared app path, else where the first local page is', () => {
    expect(appDirectory({ reported: app, declared: '/elsewhere', firstDocument: page })).toBe(app);
    expect(appDirectory({ reported: undefined, declared: app, firstDocument: page })).toBe(app);
    expect(appDirectory({ reported: undefined, declared: path.join(app, 'main.js'), firstDocument: page })).toBe(app);
    expect(appDirectory({ reported: undefined, declared: undefined, firstDocument: page })).toBe(path.join(app, 'renderer'));
  });

  it('is the archive a packaged app shows its first page from, and nothing for an app that shows no local page', () => {
    const archive = path.join(root, 'Resources', 'app.asar');
    expect(appDirectory({ reported: undefined, declared: undefined, firstDocument: pathToFileURL(path.join(archive, 'dist', 'index.html')).href })).toBe(archive);
    expect(appDirectory({ reported: undefined, declared: undefined, firstDocument: 'http://localhost:3000/' })).toBeUndefined();
  });
});

describe('outsideApp', () => {
  it('passes the app\'s own pages and every location that is no local file', () => {
    expect(outsideApp(page, app)).toBeUndefined();
    expect(outsideApp(`${page}?tab=2#top`, app)).toBeUndefined();
    for (const location of ['https://example.com/', 'about:blank', 'data:text/html,hi', 'app://bundle/index.html', '']) expect(outsideApp(location, app), location).toBeUndefined();
  });

  it('refuses a local file outside the app\'s directory, however the path gets there', () => {
    expect(outsideApp(pathToFileURL(path.join(root, 'secret.txt')).href, app)).toMatch(/left the app's directory for file:\/\/.*secret\.txt/);
    expect(outsideApp(pathToFileURL(path.join(app, '..', 'secret.txt')).href, app)).toMatch(/outside it/);
    expect(outsideApp(pathToFileURL(`${app}-sibling/index.html`).href, app)).toMatch(/outside it/);
    symlinkSync(path.join(root, 'secret.txt'), path.join(app, 'link.txt'));
    expect(outsideApp(pathToFileURL(path.join(app, 'link.txt')).href, app)).toMatch(/outside it/);
  });

  it('refuses every local file when the app\'s directory is not known', () => {
    expect(outsideApp(page, undefined)).toMatch(/not known/);
    expect(outsideApp('https://example.com/', undefined)).toBeUndefined();
  });
});
