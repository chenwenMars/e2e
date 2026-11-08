import test from 'node:test';
import assert from 'node:assert/strict';
import { newRequest, totalCents, validateRequest, approvalPath, nextApproval, type RequestForm } from '../src/domain.ts';

function goods(): RequestForm {
  const f = newRequest();
  return { ...f, title: '设备采购', department: '研发部', applicant: 'admin', date: '2027-01-01', purpose: '研发测试', supplierId: 'SUP-1', lines: [{ name: '设备', specification: '标准版', quantity: 1, price: 9999.99 }], details: { type: '物资', address: '上海', contact: '张三', installation: false, installationNotes: '' } };
}
test('金额以分计算，10000 元起增加财务审批', () => {
  const f = goods();
  assert.equal(totalCents(f), 999999);
  assert.deepEqual(approvalPath(f), ['部门']);
  f.lines[0]!.price = 10000;
  assert.deepEqual(approvalPath(f), ['部门', '财务']);
  f.lines = [{ name: '线缆', specification: '', quantity: 3, price: 0.1 }];
  assert.equal(totalCents(f), 30);
});
test('软件金额按席位、月数计算，服务金额按里程碑合计', () => {
  const f = goods();
  f.details = { type: '软件', product: '设计工具', seats: 10, unitPrice: 99.99, months: 12, start: '2027-01-01', autoRenew: true, sensitivity: '内部' };
  assert.equal(totalCents(f), 1199880);
  f.details = { type: '服务', category: '咨询', start: '2027-01-01', end: '2027-03-01', location: '上海', deliverables: '报告', milestones: [{ name: '初稿', date: '2027-02-01', amount: 2000.5 }, { name: '终稿', date: '2027-03-01', amount: 3000.5 }] };
  assert.equal(totalCents(f), 500100);
  assert.deepEqual(validateRequest(f), []);
  f.details.milestones[0]!.date = '2026-12-01';
  assert.match(validateRequest(f).map(x => x.message).join(' '), /服务期间/);
});
test('拒绝无效金额、非整数数量、缺少安装说明与非法日期', () => {
  const f = goods();
  for (const price of [Infinity, NaN, -1, 1.001]) {
    f.lines[0]!.price = price;
    assert.ok(validateRequest(f).length > 0);
  }
  f.lines[0]!.price = 100;
  f.lines[0]!.quantity = 1.5;
  assert.ok(validateRequest(f).length > 0);
  f.lines[0]!.quantity = 1;
  f.details = { type: '物资', address: '上海', contact: '张三', installation: true, installationNotes: '' };
  assert.match(validateRequest(f).map(x => x.message).join(' '), /安装说明/);
  f.date = '2027-02-30';
  assert.match(validateRequest(f).map(x => x.message).join(' '), /日期/);
});
test('审批只能从当前待审批节点流转，驳回必须有意见', () => {
  const f = goods(); f.status = '已提交'; f.approvalStage = '部门'; f.lines[0]!.price = 10000;
  assert.deepEqual(nextApproval(f, '部门', '通过', '同意'), { status: '已提交', approvalStage: '财务' });
  assert.throws(() => nextApproval(f, '财务', '通过', '同意'), /状态已变更/);
  assert.throws(() => nextApproval(f, '部门', '驳回', '  '), /意见/);
  assert.deepEqual(nextApproval(f, '部门', '驳回', '补充报价'), { status: '已驳回', approvalStage: '完成' });
  f.approvalStage = '财务';
  assert.deepEqual(nextApproval(f, '财务', '通过', '同意'), { status: '已通过', approvalStage: '完成' });
});

test('采购编码为北京时间年月日加四位流水，超出容量明确失败', async () => {
  const { createProcurementCode } = await import('../src/domain.ts');
  const date = new Date('2026-12-31T16:00:00.007Z');
  assert.equal(createProcurementCode(date, 1), '202701010001');
  assert.equal(createProcurementCode(date, 42), '202701010042');
  assert.equal(createProcurementCode(date, 9999), '202701019999');
  for (const sequence of [0, -1, 1.5, 10000]) assert.throws(() => createProcurementCode(date, sequence), /流水号/);
  assert.equal(newRequest().code, '');
});
