# 本地采购工作台 · 从零接入 Web E2E

这个 Vue 3 + Vite 项目可以作为公司前端项目的接入演示。下面从已有业务代码开始，使用 npm 发布的 `e2e` 和 `@e2e-dev/web`。所有命令的工作目录都是当前应用，配置、测试和 `package-lock.json` 都放在本目录。常规测试完成后再添加 DeepSeek，即可分别验证浏览器自动化和真实模型操作。

## 1. 在项目中安装 E2E

假设当前独立前端项目已经可以运行，以下命令都在项目根目录执行。示例使用 npm，Node.js 需要 24.8 及以上，或 22.22.3 及以上。

```bash
npm install -D e2e @e2e-dev/web
npx e2e init
```

初始化时选择 **Web (Playwright)**，模型先选择 **None**。其余问题可按提示选择。完成后查看生成的 `e2e.config.ts`、`tests/example.e2e.ts` 和 `package.json`。将 `node_modules/`、`dist/`、`.e2e/` 和 `.env` 加入项目的 `.gitignore`。

## 2. 配置被测网站，先跑初始化示例

将向导生成的 `e2e.config.ts` 替换为以下内容。测试启动 Vite 的生产预览，`{port}` 由 runner 替换为可用端口。它与手工使用的 4290 分属不同站点，因此测试数据独立。

```ts
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  projectId: 'procurement-admin',
  tests: 'tests/**/*.e2e.ts',
  workers: 1,
  targets: [{
    name: 'web',
    engine: web(),
    app: {
      url: 'http://127.0.0.1:0',
      command: {
        executable: 'npm',
        args: ['run', 'preview', '--', '--host', '127.0.0.1', '--port', '{port}', '--strictPort'],
        log: '.e2e/logs/preview.log',
      },
    },
  }],
} satisfies E2EConfig;
```

构建应用并运行初始化示例：

```bash
npm run build
npx e2e run tests/example.e2e.ts --headed
```

**验收点**：浏览器打开采购后台，初始化示例通过。首次运行可能需要下载 Chromium。该示例验证的是应用能打开，下一步再验证采购业务。

## 3. 编写并运行第一条采购业务测试

在项目目录创建辅助文件。报价文件将通过页面上的附件控件加入申请单。

```bash
mkdir -p test-support tests
printf '%s\n' 'USB-C 扩展坞，两件，每件 129.50 元。' > test-support/quote.txt
```

**`test-support/login.ts`**

```ts
import { expect, type App, type Screen } from 'e2e';

/** The local demo publishes admin/admin on its login page. Each attempt signs into its own tab. */
export async function login(app: App, screen: Screen) {
  await app.open('/');
  await screen.getByLabel('账号').fill('admin');
  await screen.getByLabel('密码').fill('admin');
  await screen.getByRole('button', '登录').click();
  await expect(screen.getByRole('heading', '工作首页')).toBeVisible();
}
```

这里使用本地演示页公开的固定账号。每条用例在自己的标签页执行登录。迁移到公司系统时，按实际认证方式配置专用测试账号和凭证，并替换页面字段及业务断言。

**`tests/request.e2e.ts`**

```ts
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { login } from '../test-support/login.ts';

test('创建采购申请，恢复草稿并提交', async ({ app, screen, browser }) => {
  const title = '扩展坞采购验收';
  const button = (name: string) => screen.getByRole('button', name);
  await login(app, screen);
  await screen.getByRole('link', '采购申请').click();
  await button('创建申请单').click();
  await screen.getByPlaceholder('例如：研发工作站采购').fill(title);
  await screen.getByRole('combobox', /申请部门/).press('Enter');
  await screen.getByRole('option', '研发部').click();
  const date = screen.getByRole('combobox', /期望到货日期/);
  await date.fill('2027-02-01');
  await date.press('Enter');
  await screen.getByRole('textbox', /采购事由/).fill('工位增加显示器接口');
  await button('下一步').click();
  await screen.getByRole('combobox', /供应商/).fill('青禾');
  await screen.getByRole('option', '青禾办公用品').click();
  await screen.getByRole('textbox', '品名 1').fill('USB-C 扩展坞');
  await screen.getByRole('spinbutton', '数量 1').fill('2');
  await screen.getByRole('spinbutton', '单价（元） 1').fill('129.50');
  await button('下一步').click();
  await screen.getByRole('textbox', '采购说明').fill('验收时检查双屏输出');
  await browser.locator('input[type=file]').setInputFiles('test-support/quote.txt');
  await button('保存草稿').click();

  const row = screen.getByRole('row', new RegExp(title));
  await expect(row).toContainText('草稿');
  await browser.reload();
  await row.getByRole('button', '继续编辑').click();
  await button('下一步').click();
  await expect(screen.getByText('合计 ¥259.00')).toBeVisible();
  await expect(button('下载 quote.txt')).toBeVisible();
  await button('提交申请').click();
  await expect(row).toContainText('已提交');
  await row.getByRole('button', '查看详情').click();
  await expect(screen.getByRole('heading', title)).toBeVisible();
  await expect(button('下载 quote.txt')).toBeVisible();
});
```

```bash
npx e2e list tests/request.e2e.ts
npm run build
npx e2e run tests/request.e2e.ts --headed --workers 1 --retries 0
```

**验收点**：在浏览器中看到填写四步表单、上传附件、保存草稿、刷新并继续编辑。确认页金额是 259.00 元，提交后列表显示“已提交”，详情页提供 `quote.txt` 下载按钮。此时不需要模型 Key。运行 `npx e2e run --headed` 会执行 `tests/` 下的全部常规用例，包括向导生成的冒烟用例。

## 4. 接入 DeepSeek，运行 AI 用例

```bash
npm install -D ai@7.0.164 @ai-sdk/deepseek@3.0.81
mkdir -p tests-agent
```

在**当前项目**的 `.env` 中手动设置以下三项。已有文件时只编辑对应变量，保留现有 Key 和其他配置。变量使用 `DEEPSEEK_` 前缀，供 Node 测试进程读取。

```dotenv
DEEPSEEK_API_KEY=填入你的真实Key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
```

**`e2e.agent.config.ts`**

```ts
import { existsSync } from 'node:fs';
import { createDeepSeek } from '@ai-sdk/deepseek';
import type { E2EConfig } from 'e2e';
import base from './e2e.config.ts';

const envFile = new URL('./.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const { DEEPSEEK_API_KEY: apiKey, DEEPSEEK_BASE_URL: baseURL, DEEPSEEK_MODEL: model } = process.env;
if (!apiKey || !baseURL || !model) {
  throw new Error('请在 .env 或运行环境中填写 DEEPSEEK_API_KEY、DEEPSEEK_BASE_URL 和 DEEPSEEK_MODEL');
}

export default {
  ...base,
  projectId: 'procurement-admin-agent',
  tests: 'tests-agent/**/*.e2e.ts',
  timeout: 300_000,
  actionTimeout: 90_000,
  agents: { default: { model: createDeepSeek({ baseURL, apiKey })(model) } },
} satisfies E2EConfig;
```

**`tests-agent/request.e2e.ts`**

```ts
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { login } from '../test-support/login.ts';

test('AI 核对并提交会议室设备采购草稿', async ({ app, agent, screen }) => {
  await login(app, screen);
  await agent.act('从采购申请列表打开标题为“会议室协作设备”的草稿，继续编辑。');
  await expect(screen.getByRole('heading', '编辑采购草稿')).toBeVisible();
  await agent.act('保留现有申请信息和明细，逐步进入“确认提交”页面，停在最终提交之前。');
  await expect(screen.getByRole('heading', '确认提交')).toBeVisible();
  await expect(screen.getByText('合计 ¥200.00')).toBeVisible();
  await agent.act('提交当前已核对的采购申请。');
  await expect(screen.getByRole('row', /会议室协作设备/)).toContainText('已提交');
});
```

```bash
npx e2e list --config e2e.agent.config.ts
npm run build
npx e2e run tests-agent/request.e2e.ts --config e2e.agent.config.ts --headed --debug --no-cache --workers 1 --retries 0
```

**验收点**：`list` 应只列出一条 AI 测试。实际运行时，定位器先完成登录，随后 DeepSeek 在页面上找到预置的“会议室协作设备”草稿，推进到确认页并提交。代码验证金额为 200.00 元，以及最终状态为“已提交”。`--no-cache` 要求本次操作真实调用模型；仅列出用例不能证明模型鉴权或业务流程成功。

## 5. 查看结果

每次运行结束查看终端和本项目的 `.e2e/report.json`。要保留过程，可在同一运行命令末尾追加 `--video=on --trace=on`，然后打开终端打印的 `.e2e/results/` 下的录像和 `trace.md`。若预览服务启动失败，先检查 `npm run build` 和 `.e2e/logs/preview.log`；AI 失败时先区分模型认证错误和页面断言错误。

接入已经部署的公司测试站点，请参阅 [独立模式：接入已有的公司测试站点](README2.md)。
