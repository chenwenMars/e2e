# 本地采购工作台 · 从零接入 Web E2E

这个 Vue 3 + Vite 项目可以作为公司前端项目的接入演示。下面从已有业务代码开始，使用 npm 发布的 `e2e` 和 `@e2e-dev/web`。所有命令的工作目录都是当前应用，配置、测试和 `package-lock.json` 都放在本目录。常规测试完成后再添加 DeepSeek，即可分别验证浏览器自动化和真实模型操作。

## 本地运行与共享文件存储

在本目录执行 `npm run dev`，访问 `http://127.0.0.1:4290`，账号和密码均为 `admin`。

供应商、采购申请、原始附件字节、审批历史及每日采购编码流水集中保存在 **`.data/procurement.sqlite`**。开发服务和预览服务复用 Vite 本地接口读写同一个文件；不需要另启后端进程或安装外部数据库。文件路径以项目目录为基准，不随浏览器、端口或启动命令的工作目录变化。清除浏览器站点数据不再删除业务记录。

不同浏览器及默认 E2E 共用该数据文件：在一个浏览器保存后，另一个浏览器进入列表或刷新即可查询。E2E 创建、修改、删除的记录也会反映到手工页面。测试使用独立记录和唯一标题，不自动重置共享数据。首页“重置演示数据”作用于所有浏览器，请核对确认弹窗。

SQLite 使用事务和唯一约束处理多服务进程并发，旧页面保存过期版本会明确报错。接口不可用或数据文件损坏时直接暴露错误，不退回 IndexedDB，也不静默恢复演示数据。运行中的 SQLite 还可能产生 `-wal` / `-shm` 文件；备份时先停止相关服务，再复制整个 `.data/` 目录。此目录已忽略 Git，且不能经静态文件地址下载。

应用需要 Vite dev 或 preview 的本地文件接口；仅将 `dist/` 放到普通静态服务器不能提供共享存储。

### 迁移已完成

已有数据已迁入项目 SQLite，共享存储继续使用。一次性的“数据管理 / 迁移浏览器数据”导航、页面和导入接口已移除；应用不再读取 IndexedDB。原浏览器旧库不主动删除，SQLite 中的采购编码、业务记录、附件和审批历史均不受模块移除影响。

### 显式隔离测试数据

默认测试共享 `.data/procurement.sqlite`。需要隔离时，在当前项目目录显式设置：

```bash
PROCUREMENT_DATA_DIR=.data/e2e npm run test:e2e -- --workers 1 --retries 0
```

此时文件为 `.data/e2e/procurement.sqlite`。`e2e.config.ts` 通过 `inheritEnv: ['PROCUREMENT_DATA_DIR']` 将变量传给预览进程，并由冒烟测试断言实际数据路径。相对目录按项目路径解释；绝对路径也可使用。不同目录表示不同数据集。

## 采购编码规则

采购编码在**首次成功保存草稿或直接提交**时生成，格式为 `yyyyMMdd` + 四位流水号，例如 `202611080001`，共 12 位。

- 前 8 位是北京时间的年月日，后四位是当天的流水号，从 `0001` 递增至 `9999`；次日从 `0001` 开始。
- 流水号持久化在共享 SQLite 文件中，与申请在同一事务分配并保存。不同浏览器及 dev/preview 进程共享计数器，刷新或删除申请不会重用当天已发出的号码；当天超过 9999 个明确报错，不扩位或静默重号。
- 编辑、提交、驳回重提及审批保留原编码；表单无法篡改已签发编码。列表、详情、审批工作台展示编码，列表支持按编码搜索。
- 已有编码及每日流水高水位保持不变，移除迁移模块不会重置编码。
- 唯一约束范围为当前项目数据文件；使用不同 `PROCUREMENT_DATA_DIR` 或不同电脑的独立项目副本时，不共享数据。


## 控制台功能与测试入口

- **供应商名录**：新增、编辑、详情、删除，按名称/联系人/电话搜索，按启用状态及供应范围筛选并分页。名称不可重复；被申请引用的供应商只能停用。详情提供关联申请入口。旧版预置供应商缺少的联系方式保留为空，编辑保存时须补齐。
- **采购申请**：物资采购（动态明细、规格、收货、安装条件字段）、服务采购（起止日期、交付说明、动态里程碑）、软件订阅（席位、每席月单价、月数、自动续费、敏感级别）。支持草稿恢复、草稿确认删除、附件上传下载、富文本说明、搜索/类型与状态筛选、金额排序及分页。
- **审批工作台**：本地演示规则为低于 10,000 元仅部门审批，达到 10,000 元需部门和财务两级审批。审批意见必填；驳回后可修改重提，历史保留。已提交及已通过申请只读。此页面演示状态流转，不提供真实多用户权限隔离。

- **重置数据**：首页重置会同时清除供应商、申请、附件及审批历史并恢复预置数据，所有浏览器都会受影响，执行前有确认弹窗。

在本目录运行：

```bash
npm run build
npm run test:unit
npm run test:e2e -- --workers 1 --retries 0
npm run test:storage
npm run test:layout
```

常规 E2E 使用构建后的页面，覆盖供应商 CRUD、关联删除限制、三类采购、刷新恢复、附件下载内容、驳回重提和两级审批。`test:storage` 显式创建临时数据目录，同时启动 dev（4297）和 preview（4296），用真实 Chromium 验证已有 SQLite 数据读取、迁移入口及接口移除、跨上下文共享、附件下载、并发及服务重启持久化。`test:layout` 使用临时数据库和预览端口 4298，验证 1440/768/375 像素布局，截图输出到 `.e2e/ui/shared-storage/`。两个辅助验证都会清理自己的临时数据，不使用默认共享文件；需先构建，并确保测试端口空闲。

## 1. 在项目中安装 E2E

假设当前独立前端项目已经可以运行，以下命令都在项目根目录执行。示例使用 npm，Node.js 需要 24.8 及以上，或 22.22.3 及以上。

```bash
npm install -D e2e @e2e-dev/web
npx e2e init
```

初始化时选择 **Web (Playwright)**，模型先选择 **None**。其余问题可按提示选择。完成后查看生成的 `e2e.config.ts`、`tests/example.e2e.ts` 和 `package.json`。将 `node_modules/`、`dist/`、`.e2e/` 和 `.env` 加入项目的 `.gitignore`。

## 2. 配置被测网站，先跑初始化示例

将向导生成的 `e2e.config.ts` 替换为以下内容。测试启动 Vite 的生产预览，`{port}` 由 runner 替换为可用端口。虽然端口与手工访问的 4290 不同，默认仍使用同一份项目共享文件；需要隔离时显式设置 `PROCUREMENT_DATA_DIR`。

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
        inheritEnv: ['PROCUREMENT_DATA_DIR'],
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

共享数据下每条测试创建自己拥有的供应商和申请，并使用唯一标题。以下辅助文件供常规及 AI 用例共用：

**`test-support/fixtures.ts`**

```ts
import type { App } from 'e2e';
import { newRequest } from '../src/domain.ts';
import { newSupplier } from '../src/storage-model.ts';

/** Give every retained E2E record a new identity without modifying user records. */
export function uniqueTitle(label:string) {return `${label}-${crypto.randomUUID().slice(0,8)}`;}
/** Create one explicit test supplier through the same validated local API. */
export async function createSupplier(app:App) {
  const supplier={...newSupplier(),name:uniqueTitle('E2E供应商'),contact:'测试联系人',phone:'13800138000',email:'e2e@example.com',address:'上海测试园区',scopes:['物资','服务','软件']};
  const response=await fetch(`${app.baseUrl}/api/procurement/suppliers/save`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({supplier})});
  if(!response.ok)throw new Error(await response.text());return supplier;
}
/** Provision an owned draft for reference checks or AI tests, never a user's seed record. */
export async function createDraft(app:App,supplier:Awaited<ReturnType<typeof createSupplier>>,label='E2E采购草稿') {
  const form={...newRequest(),title:uniqueTitle(label),department:'研发部',applicant:'admin',date:'2027-02-01',purpose:'测试业务流程',supplierId:supplier.id,lines:[{name:'会议设备',specification:'标准版',quantity:1,price:200}],details:{type:'物资' as const,address:'上海测试园区',contact:'测试联系人',installation:false,installationNotes:''}};
  const response=await fetch(`${app.baseUrl}/api/procurement/requests/save`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({form,operation:'create'})});
  if(!response.ok)throw new Error(await response.text());return form;
}
```

**`tests/request.e2e.ts`**

```ts
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { login } from '../test-support/login.ts';
import { uniqueTitle, createSupplier } from '../test-support/fixtures.ts';

/** Read the issued business code from the row actually rendered on screen. */
async function readCode(browser: import('@e2e-dev/web').Browser, title: string) {
    return browser.evaluate((title) => {
        const row = Array.from(document.querySelectorAll('.el-table__body tr')).find(r => r.textContent?.includes(title));
        const code = row?.textContent?.match(/\d{12}/)?.[0];
        if (!code) throw new Error('列表缺少采购编码');
        return code;
    }, title);
}

test('创建采购申请，恢复草稿并提交', async ({ app, screen, browser }) => {
    const title = uniqueTitle('扩展坞采购验收');
    const supplier = await createSupplier(app);
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
    await screen.getByRole('combobox', /供应商/).fill(supplier.name);
    await screen.getByRole('option', supplier.name).click();
    await screen.getByRole('textbox', '品名 1').fill('USB-C 扩展坞');
    await screen.getByRole('spinbutton', '数量 1').fill('2');
    await screen.getByRole('spinbutton', '单价（元） 1').fill('129.50');
    await screen.getByRole('textbox', /收货地址/).fill('上海市测试园区');
    await screen.getByRole('textbox', /收货联系人/).fill('张三');
    await button('下一步').click();
    await screen.getByRole('textbox', '采购说明').fill('验收时检查双屏输出');
    await browser.locator('input[type=file]').setInputFiles('test-support/quote.txt');
    await button('保存草稿').click();

    const row = screen.getByRole('row', new RegExp(title));
    await expect(row).toContainText('草稿');
    const code = await readCode(browser, title);
    await browser.reload();
    await row.getByRole('button', '继续编辑').click();
    await expect(screen.getByTestId('procurement-code')).toContainText(code);
    await button('下一步').click();
    await expect(screen.getByText('合计 ¥259.00')).toBeVisible();
    await expect(button('下载 quote.txt')).toBeVisible();
    await button('提交申请').click();
    await expect(row).toContainText('已提交');
    assert.equal(await readCode(browser, title), code);
    await row.getByRole('button', '查看详情').click();
    await expect(screen.getByRole('heading', title)).toBeVisible();
    await expect(button('下载 quote.txt')).toBeVisible();
    const download = await browser.waitForDownload(() => button('下载 quote.txt').click());
    assert.equal(await readFile(download.absolutePath, 'utf8'), await readFile('test-support/quote.txt', 'utf8'));
});

test('直接提交采购申请，刷新后仍可在列表搜索并查看详情', async ({ app, screen, browser }) => {
    const title = uniqueTitle('本地持久化采购验收');
    const supplier = await createSupplier(app);
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
    await screen.getByRole('textbox', /采购事由/).fill('验证提交后的本地存储和列表查询');
    await button('下一步').click();
    await screen.getByRole('combobox', /供应商/).fill(supplier.name);
    await screen.getByRole('option', supplier.name).click();
    await screen.getByRole('textbox', '品名 1').fill('USB-C 扩展坞');
    await screen.getByRole('spinbutton', '数量 1').fill('2');
    await screen.getByRole('spinbutton', '单价（元） 1').fill('129.50');
    await screen.getByRole('textbox', /收货地址/).fill('上海市测试园区');
    await screen.getByRole('textbox', /收货联系人/).fill('张三');
    await button('下一步').click();
    await screen.getByRole('textbox', '采购说明').fill('直接提交后刷新检查');
    await browser.locator('input[type=file]').setInputFiles('test-support/quote.txt');
    await button('下一步').click();
    await button('提交申请').click();

    const row = screen.getByRole('row', new RegExp(title));
    await expect(row).toContainText('已提交');
    const code = await readCode(browser, title);
    await expect(row).toContainText('¥259.00');
    await browser.reload();
    await screen.getByRole('textbox', '搜索申请单').fill(code);
    await screen.getByRole('combobox', '筛选状态').press('Enter');
    await screen.getByRole('option', '已提交').click();
    await expect(row).toContainText('已提交');
    await expect(screen.getByRole('row', /季度办公耗材/)).not.toBeVisible();
    await row.getByRole('button', '查看详情').click();
    await expect(screen.getByRole('heading', title)).toBeVisible();
    await expect(screen.getByTestId('procurement-code')).toContainText(code);
    await expect(screen.getByText('合计 ¥259.00')).toBeVisible();
    await expect(screen.getByText('直接提交后刷新检查')).toBeVisible();
    await expect(button('下载 quote.txt')).toBeVisible();
    const download = await browser.waitForDownload(() => button('下载 quote.txt').click());
    assert.equal(await readFile(download.absolutePath, 'utf8'), await readFile('test-support/quote.txt', 'utf8'));
});

test('空表单不能进入下一步，草稿删除后刷新仍不存在', async ({ app, screen, browser }) => {
  const title = uniqueTitle('临时删除草稿');
  await login(app, screen);
  await screen.getByRole('link', '采购申请').click();
  await screen.getByRole('button', '创建申请单').click();
  await screen.getByRole('button', '下一步').click();
  await expect(screen.getByRole('heading', '基本信息')).toBeVisible();
  await expect(screen.getByRole('alert')).toContainText('请输入申请标题');
  await screen.getByPlaceholder('例如：研发工作站采购').fill(title);
  await screen.getByRole('button', '保存草稿').click();
  const row = screen.getByRole('row', new RegExp(title));
  await expect(row).toContainText('草稿');
  await row.getByRole('button', '删除草稿').click();
  await screen.getByRole('button', '取消').click();
  await expect(row).toBeVisible();
  await row.getByRole('button', '删除草稿').click();
  await screen.getByRole('button', '确认删除草稿').click();
  await expect(row).not.toBeVisible();
  await browser.reload();
  await expect(row).not.toBeVisible();
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
import { createSupplier, createDraft } from '../test-support/fixtures.ts';

test('AI 核对并提交会议室设备采购草稿', async ({ app, agent, screen }) => {
    const supplier=await createSupplier(app);const draft=await createDraft(app,supplier,'AI会议室设备采购');
    await login(app, screen);
    await agent.act('从采购申请列表搜索并打开标题为 {title} 的草稿，继续编辑。', {params:{title:draft.title}});
    await expect(screen.getByRole('heading', '编辑采购草稿')).toBeVisible();
    await agent.act('保留现有申请信息和明细，逐步进入“确认提交”页面，停在最终提交之前。');
    await expect(screen.getByRole('heading', '确认提交')).toBeVisible();
    await expect(screen.getByText('合计 ¥200.00')).toBeVisible();
    await agent.act('提交当前已核对的采购申请。');
    await expect(screen.getByRole('row', new RegExp(draft.title))).toContainText('已提交');
});
```

```bash
npx e2e list --config e2e.agent.config.ts
npm run build
npx e2e run tests-agent/request.e2e.ts --config e2e.agent.config.ts --headed --debug --no-cache --workers 1 --retries 0
```

**验收点**：`list` 应只列出一条 AI 测试。实际运行时，定位器先完成登录，随后 DeepSeek 在页面上搜索本次独立创建的会议室设备采购草稿，推进到确认页并提交。代码验证金额为 200.00 元，以及最终状态为“已提交”。`--no-cache` 要求本次操作真实调用模型；仅列出用例不能证明模型鉴权或业务流程成功。

## 5. 查看结果

每次运行结束查看终端和本项目的 `.e2e/report.json`。要保留过程，可在同一运行命令末尾追加 `--video=on --trace=on`，然后打开终端打印的 `.e2e/results/` 下的录像和 `trace.md`。若预览服务启动失败，先检查 `npm run build` 和 `.e2e/logs/preview.log`；AI 失败时先区分模型认证错误和页面断言错误。

接入已经部署的公司测试站点，请参阅 [独立模式：接入已有的公司测试站点](README2.md)。
