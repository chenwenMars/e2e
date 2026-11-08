# @e2e-dev/web-benchmark

A Next.js app of self-contained scenarios that are hard to automate, and the
e2e suites written against them. This is where we test writing tests with
`e2e`: every scenario isolates one awkward surface (shadow roots, a canvas-only
UI, nested iframes, native dialogs, a second tab, drag and drop, a DOM that
remounts every second, an accessibility tree that lies) so a test either
handles that surface or fails for exactly that reason.

The app under `app/` is copied from `apps/web-benchmark` in the tester-army
monorepo, where the same scenarios gate the autonomous QA agent. Keep diffs
against that source minimal so scenarios port both ways, and never fix a
planted bug.

## Layout

- `app/`: the Next.js project. `app/src/examples.ts` is the catalog: every
  scenario's slug, name, description, and, for bug-book entries, the
  `plantedBug`. One component per scenario in `app/src/Examples/`, served at
  `/e/<slug>`; the home page lists them all.
- `e2e.config.ts` + `tests/`: the deterministic suite. Gates every PR
  (`benchmark.yml`); `@e2e-dev/github` posts each run as one pull request
  comment. Every scenario has a deterministic twin, `tests/<slug>.e2e.ts`,
  driven with locators and `expect` only: the floor the agentic suite must
  match, so a red agentic run is the model, not the tools. A bug-book
  scenario asserts what the page truly shows, planted bug included and named
  in the title. A scenario the deterministic API cannot finish keeps its test
  declared with `{ skip: '<reason>' }`, so the gap stays visible.
- `e2e.agent.config.ts` + `tests-agent/`: the agentic suite, derived from the
  deterministic config. It gates every PR too. Each step spends real model
  calls and needs `DEEPSEEK_API_KEY` in this folder's `.env`. `scenarios.e2e.ts`
  drives every task scenario the accessibility tree can carry with one
  `agent.act` per scenario and checks the success message deterministically;
  scenarios the grammar cannot finish yet are declared and skipped with the
  reason. `planted-bugs.e2e.ts` asserts that an `agent.assert` of the correct
  behavior fails on a bug-book scenario, so a passing judgment there is a
  missed bug. Its recordings under `.e2e/cache/` are committed: CI replays
  them read-only and calls the model only for a step with no recording, so
  the gate runs at deterministic speed. When a scenario or a step changes,
  re-record locally with the `test:agent` command below and commit the
  changed entries in the same pull request.

## Commands

Build the runner first; the suites run the built `e2e` CLI by path, like
the testbed does: pnpm links no `e2e` bin for a workspace package whose `dist`
does not exist yet at install time, and CI installs before it builds.

```bash
pnpm build                                          # from the repo root, once
pnpm --filter @e2e-dev/web-benchmark run test         # build the app, run tests/ headlessly
pnpm --filter @e2e-dev/web-benchmark dev             # browse the scenarios on :4280
```

### 在浏览器中观察常规测试和 AI 测试

以下命令均在仓库根目录执行。使用 Node.js 24.8+，或 Node.js 22.22.3+；
本机已安装的版本可通过 `nvm use 24.15.0` 切换。
首次运行前执行上面的 `pnpm build` 构建框架包；框架源码未变时，无须重复构建。

运行全部常规测试（不调用模型），显示浏览器：

```bash
pnpm --filter @e2e-dev/web-benchmark run test:headed --workers 1 --retries 0
```

运行 onboarding-wizard 的完整五步表单填写和提交测试（不调用模型）：

```bash
pnpm --filter @e2e-dev/web-benchmark run test:headed tests/onboarding-wizard.e2e.ts --grep 'the review step repeats the brief and finishes with the PIN' --workers 1 --retries 0
```

要运行该场景文件中的全部五个常规测试，去掉 `--grep` 和后面的测试名称。

运行全部 AI Agent 测试，显示浏览器并真实调用 DeepSeek
（先按下一节填写 `apps/web-benchmark/.env`）：

```bash
pnpm --filter @e2e-dev/web-benchmark run test:agent --headed --debug --no-cache --workers 1 --retries 0
```

建议先验证一个商品搜索场景，再运行全部 AI 测试：

常规测试（运行该文件中的两个测试，不调用模型）：

```bash
pnpm --filter @e2e-dev/web-benchmark run test:headed tests/debounced-search.e2e.ts --workers 1 --retries 0
```

AI Agent 测试（调用 DeepSeek）：

```bash
pnpm --filter @e2e-dev/web-benchmark run test:agent --tag debounced-search --headed --debug --no-cache --workers 1 --retries 0
```

将 `--tag debounced-search` 替换为 `--tag date-picker`、`--tag kanban-board`
或 `--tag promo-storefront`，可以分别验证日期选择、看板和购买流程。

| 参数 | 作用 |
| --- | --- |
| `--headed` | 显示浏览器执行界面；`test:headed` 已包含此参数 |
| `--workers 1` | 使用单个 worker，方便观察 |
| `--retries 0` | 失败直接报告，不自动重试 |
| `--no-cache` | 禁用操作回放，让 AI 步骤真实调用模型 |
| `--debug` | 输出更多调试信息 |
| `--video=on --trace=on` | 可选，保留录像和执行 trace，供浏览器关闭后查看 |

这些脚本会自动构建页面并由 runner 启动网站，无须提前运行 `dev`。
运行前先在对应终端停止自己手动启动的 benchmark `dev` 服务，避免构建期间复用它。
使用 pnpm 转发参数时，不要在参数前额外添加 `--`。
报告位于 `apps/web-benchmark/.e2e/report.json`，录像和 trace 位于其 `.e2e/results/` 下。
全部 AI 测试会产生更多模型调用；测试能否通过以实际运行结果为准。

### Local DeepSeek configuration

Create `apps/web-benchmark/.env` and fill in your DeepSeek API key:

```dotenv
DEEPSEEK_API_KEY=your-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
```

The agent config explicitly loads this file; it does not read the Vite example's
`.env`. The repository ignores `.env` files. Existing shell variables take
precedence, so unset them if you want to use the file's values. The model must
support tools and image input; DeepSeek documents `deepseek-flash` as supporting
images. A missing or invalid key fails model calls rather than skipping tests.

After building the framework and the benchmark app, run one scenario with fresh
model calls (from this folder):

```bash
pnpm run build
node node_modules/e2e/dist/cli/bin.js run tests-agent/scenarios.e2e.ts --config e2e.agent.config.ts --tag debounced-search --headed --no-cache --workers 1 --retries 0
```

This local configuration uses DeepSeek instead of the upstream Gateway setup.
CI using this config also needs the `.env` file and DeepSeek credentials.

### Writing tests locally

`test` rebuilds the production app on every run. While authoring, keep the dev
server up instead: the config sets `reuseExisting`, so outside CI a server
already answering on port 4280 is used as is and nothing is started or
stopped. Run one file at a time from the package directory:

```bash
pnpm --filter @e2e-dev/web-benchmark dev
cd apps/web-benchmark
node node_modules/e2e/dist/cli/bin.js run tests/login-form.e2e.ts --headed
```

Two things bite here:

- Role names match exactly by default. The home page links are named after the
  scenario name and its description, so `getByRole('link', { name: 'Login
  Form', exact: false })` is the query that finds one. See `tests/smoke.e2e.ts`.
  Elsewhere a partial text match is a RegExp, `getByText(/Order #10482/)`, and
  `selectOption` names its option by `{ value }`, one spelling across the suite.
- `reuseExisting` trusts whatever answers on the port. A dev server left
  running from another checkout serves that checkout's scenarios.

Reports land in `.e2e/report.json`, artifacts and trace pages under `.e2e/results/`, both
ignored.

## Scenario contract

Task scenarios end in a deterministic success state. Where the DOM semantics
are intact, the terminal element carries `data-testid="success-message"`; the
adversarial scenarios (Canvas Only, Canvas Whiteboard, Div Soup, Aria Hidden
Flow, Image Only UI, CSS Content UI, Onboarding Wizard) omit test ids and
semantics on purpose, so success is only visible in pixels.

Bug-book scenarios (registry entries with `plantedBug`) contain exactly one
deterministic product bug, marked `PLANTED BUG (do not fix)` in source, and
the rest of the flow works. A test asserting the correct behavior must fail
there, which is how we check that an assertion or an `agent.assert` judgment
catches a real bug instead of passing over it. Promo Storefront and Gift Card
Purchase are traps: bug-looking artifacts (overlays, a chat widget, aria labels
that read "undefined") that are not defects, so a correct test passes.

The Login Form account is declared as the `benchmark` credential in
`e2e.config.ts`, so tests reach it through `credentials.user('benchmark')` and
agent steps fill the password through the secret tool without the model ever
seeing it.

## Adding a scenario

Create `app/src/Examples/YourCase.tsx`, register it in `app/src/examples.ts`
(the doc comment there states the rules for task and bug-book entries), and
write its tests in `tests/` or `tests-agent/`. Pair every agentic step with a
deterministic check so a wrong judgment cannot pass silently.
