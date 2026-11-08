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