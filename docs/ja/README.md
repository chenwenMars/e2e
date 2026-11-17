# Japanese docs

The Japanese translation of the e2e docs. The site serves each page here at
`/docs/ja/<path>`; a page without a translation shows the English page with a
notice. English stays the source of truth.

## Layout

- `docs/ja/<path>.mdx` translates `docs/<path>.mdx`: same path, same file name.
- `navigation.json` holds the Japanese labels for every tab and group in
  `docs/docs.json` (`tabs`, `groups`), keyed by the English label. The navigation order and
  pages come from `docs/docs.json`; there is no second navigation to keep in
  sync.
- Images, snippets, and `docs/examples/` are shared with the English pages.

## Updating a translation

1. Translate the text: prose, frontmatter `title`, `description`, and
   `sidebarTitle`, and the human-readable attributes of components (`title`
   on `<Card>`, `<Accordion>`, `<Tab>`, `<Step>`, the text of `<Note>`,
   `<Warning>`, `<Tip>`).
2. Keep the outline: the same headings at the same levels in the same order,
   the same `<Tab>` and `<Accordion>` elements in the same order, and every
   `id="..."`. The site gives a translated heading the English heading's id
   by position, so links and the language switcher land on the same section.
   `pnpm docs:check` (`scripts/check-docs-translations.ts`) fails when the
   outline drifts.
3. Leave code alone: code blocks, inline code, fence titles, URLs, link
   targets and their `#anchors` stay exactly as on the English page.
   `pnpm docs:check` fails when a code block differs. Links
   stay docs-root relative (`/quickstart#install`); the site points them at
   the Japanese pages.
4. Snippet imports sit one folder deeper: `./snippets/x.jsx` becomes
   `../snippets/x.jsx`.

When an English change adds or removes a heading, tab, or accordion, make the
same change here. An English placeholder heading is fine until someone
translates it; deleting the translated page falls back to English.

## Style

- Polite form (です・ます調), plain technical Japanese.
- Wrap lines anywhere: the site drops a line break between two Japanese
  characters, so it never shows as a space.
- A half-width space between Japanese and Latin words or inline code:
  `e2e の設定`, `` `test()` を呼び出します ``.
- Keep product, package, and API names in English: e2e, Playwright,
  `@e2e-dev/web`, MCP, CI, GitHub Actions.
- Katakana loanwords keep the long vowel mark (サーバー, ユーザー,
  プロバイダー), except ブラウザ.

| English | Japanese |
| --- | --- |
| test, test suite | テスト, テストスイート |
| agent, agentic | エージェント, エージェント型 |
| deterministic | 決定論的 |
| engine | エンジン |
| runner | ランナー |
| fixture | フィクスチャ |
| locator | ロケーター |
| step | ステップ |
| assertion | アサーション |
| target | ターゲット |
| replay cache | リプレイキャッシュ |
| executor | エグゼキューター |
| provider | プロバイダー |
| hosted browser | ホスト型ブラウザ |
| device | デバイス |
| worker | ワーカー |
| retry | リトライ |
| report, reporter | レポート, レポーター |
| secret | シークレット |
| session | セッション |
| judge | ジャッジ |
| decision model | デシジョンモデル |
| coding agent | コーディングエージェント |
| skill | スキル |
| bug bash | バグバッシュ |
| visual testing | ビジュアルテスト |
| self-healing | セルフヒーリング |
| pull request | プルリクエスト |
| config, configuration | 設定 |
| screenshot | スクリーンショット |
| semantic tree | セマンティックツリー |
