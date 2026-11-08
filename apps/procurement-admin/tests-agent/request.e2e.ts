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