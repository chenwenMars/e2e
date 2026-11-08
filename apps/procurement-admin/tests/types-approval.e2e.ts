import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { login } from '../test-support/login.ts';
import { uniqueTitle, createSupplier } from '../test-support/fixtures.ts';

for (const type of ['服务', '软件'] as const) {
  test(`${type}采购创建、刷新持久化及两级审批`, async ({ app, screen, browser }) => {
    const title = uniqueTitle(`${type}采购流程验收`);
    const supplier = await createSupplier(app);
    const button = (name: string) => screen.getByRole('button', name);
    const setDate = async (name: RegExp, value: string) => { const field = screen.getByRole('combobox', name); await field.fill(value); await field.press('Enter'); };
    await login(app, screen);
    await screen.getByRole('link', '采购申请').click();
    await button('创建申请单').click();
    await screen.getByText(type === '服务' ? '服务采购' : '软件订阅').click();
    await screen.getByPlaceholder('例如：研发工作站采购').fill(title);
    await screen.getByRole('combobox', /申请部门/).press('Enter');
    await screen.getByRole('option', '研发部').click();
    await setDate(/期望到货日期/, '2027-01-01');
    await screen.getByRole('textbox', /采购事由/).fill('验证新类型与审批流程');
    await button('下一步').click();
    await screen.getByRole('combobox', /供应商/).fill(supplier.name);
    await screen.getByRole('option', supplier.name).click();
    if (type === '服务') {
      await screen.getByRole('combobox', /服务类别/).press('Enter');
      await screen.getByRole('option', '咨询').click();
      await screen.getByRole('textbox', /服务地点/).fill('上海');
      await setDate(/服务开始日期/, '2027-01-01');
      await setDate(/服务结束日期/, '2027-03-01');
      await screen.getByRole('textbox', /交付说明/).fill('交付技术咨询报告');
      await screen.getByRole('textbox', '里程碑名称 1').fill('交付报告');
      await setDate(/里程碑日期 1/, '2027-03-01');
      await screen.getByRole('spinbutton', '里程碑金额 1').fill('10000');
    } else {
      await screen.getByRole('textbox', /软件产品名称/).fill('设计软件');
      await screen.getByRole('spinbutton', /授权席位/).fill('10');
      await screen.getByRole('spinbutton', /每席月单价/).fill('100');
      await screen.getByRole('spinbutton', /订阅月数/).fill('10');
      await setDate(/订阅起始日期/, '2027-01-01');
      await screen.getByText('自动续费').click();
    }
    await button('下一步').click();
    await button('保存草稿').click();
    const row = screen.getByRole('row', new RegExp(title));
    await expect(row).toContainText('草稿');
    await browser.reload();
    await row.getByRole('button', '继续编辑').click();
    await button('下一步').click();
    await expect(screen.getByText('合计 ¥10,000.00')).toBeVisible();
    await button('提交申请').click();
    await expect(row).toContainText('已提交');
    await screen.getByRole('link', '审批工作台').click();
    await row.getByRole('button', '办理审批').click();
    await button('驳回申请').click();
    await expect(screen.getByRole('alert', '审批错误')).toContainText('请填写审批意见');
    await screen.getByRole('textbox', '审批意见').fill('补充交付信息');
    await button('驳回申请').click();
    await expect(row).not.toBeVisible();
    await screen.getByRole('link', '采购申请').click();
    await expect(row).toContainText('已驳回');
    await row.getByRole('button', '继续编辑').click();
    await button('提交申请').click();
    await screen.getByRole('link', '审批工作台').click();
    for (const stage of ['部门', '财务']) {
      await expect(row).toContainText(`${stage}审批`);
      await row.getByRole('button', '办理审批').click();
      await screen.getByRole('textbox', '审批意见').fill(`${stage}同意采购`);
      await button('审批通过').click();
    }
    await expect(row).not.toBeVisible();
    await screen.getByRole('link', '采购申请').click();
    await browser.reload();
    await expect(row).toContainText('已通过');
    await row.getByRole('button', '查看详情').click();
    await expect(screen.getByText('部门审批员（本地演示）：部门同意采购')).toBeVisible();
    await expect(screen.getByText('财务审批员（本地演示）：财务同意采购')).toBeVisible();
  });
}
