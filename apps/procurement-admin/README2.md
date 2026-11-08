# 独立模式：接入已有的公司测试站点


公司系统已经部署时，可以单独建立一个 **E2E 测试项目**。运行机能访问测试站点即可，测试项目只需保存配置、测试代码和测试数据。前端源码不是必需的。

没有源码也可以编写常规测试。浏览器呈现的按钮、输入框、可访问名称、页面文字和 URL 都可以作为定位与断言依据。Agent 可以帮助探索未知流程，常规测试则适合固定且需要精确验证的流程。两者可以在同一条测试中组合。

### 创建独立测试项目

以下命令在新目录执行，选择 **Web (Playwright)** 和 **None** 完成初始化。安装时默认获取 npm 上的最新版本。

```bash
mkdir company-web-e2e
cd company-web-e2e
npm init -y
npm install -D e2e @e2e-dev/web
npx e2e init
```

将 `e2e.config.ts` 改成指向实际测试环境：

```ts
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [{
    name: 'company-web',
    engine: web(),
    app: { url: 'https://test.example.com' },
  }],
} satisfies E2EConfig;
```

把 `https://test.example.com` 换成公司测试站点。先用普通浏览器确认网络、VPN 和测试账号可用。已有站点的配置不需要 `app.command`，不需要运行公司前端的构建命令。

### 先验证站点能打开

向导生成的 `tests/example.e2e.ts` 是一个打开页面的冒烟示例。运行：

```bash
npx e2e run tests/example.e2e.ts --headed
```

浏览器能打开页面并不代表已经登录。如果页面使用 SSO、验证码或 MFA，需要根据公司的实际认证方式设计测试账号和登录流程。

### 使用 Agent 探索页面

安装模型依赖：

```bash
npm install -D ai@7.0.164 @ai-sdk/deepseek@3.0.81
```

在当前测试项目的 `.env` 中设置以下变量，并将 `.env` 加入 `.gitignore`：

```dotenv
DEEPSEEK_API_KEY=填入你的真实Key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
```

创建 `e2e.agent.config.ts`，复用上面的公司站点配置：

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
  projectId: 'company-web-agent',
  tests: 'tests-agent/**/*.e2e.ts',
  timeout: 300_000,
  actionTimeout: 90_000,
  agents: { default: { model: createDeepSeek({ baseURL, apiKey })(model) } },
} satisfies E2EConfig;
```

例如，账号已登录或站点允许访问目标页面时，可以先运行：

```bash
npx e2e explore '查看采购申请列表和创建表单，检查页面是否正常显示' --config e2e.agent.config.ts --headed --max-steps 3
```

这个命令不需要预先编写测试文件，Agent 会根据目标观察页面并操作，调用模型会产生费用。探索会产生实际页面操作，目标、账号权限和测试数据需要适合测试环境。探索发现需要结合截图和实际页面复核，再将稳定、可重复的操作整理为测试。

### 将探索结果写成可重复测试

可以人工使用浏览器开发者工具查看控件，或配置 [e2e MCP](https://e2e.com/docs/mcp-server)，让编码助手通过 `observe` 查看页面、通过 `locate` 查询定位器。随后在 `tests/` 中编写测试。下面名称是示例，必须替换为公司页面的实际名称和业务预期：

```ts
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('采购申请列表可以打开', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('link', '采购申请').click();
  await expect(screen.getByRole('heading', '采购申请')).toBeVisible();
});
```

```bash
npx e2e run tests/company.e2e.ts --headed
```

将代码保存为 `tests/company.e2e.ts` 后运行。若需要登录，参考 [Authentication](https://e2e.com/docs/authentication) 配置测试账号、`credentials` 和 setup。session 保存后可以在本次运行的后续测试中复用；实际能否复用还取决于公司登录方式。密码通过环境变量或公司密钥管理提供，不写进测试或自然语言指令。登录成功后先断言，再保存 session。

如果希望由 AI 完成部分操作，可以使用 `agent.act`，并在每个目标后加入明确断言。页面文本和截图可能发送给模型服务，选择公司允许使用的模型和测试数据。
