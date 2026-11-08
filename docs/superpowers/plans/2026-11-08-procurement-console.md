# Procurement Console Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task.

**Goal:** 完成供应商 CRUD、三类采购表单、分级审批与控制台 UI。
**Architecture:** Vue 页面调用集中校验的数据边界，IndexedDB 原子事务持久化；保持旧申请与附件。
**Tech Stack:** Vue 3、Element Plus、idb、e2e。
**Spec:** apps/procurement-admin/DESIGN.md（用户已确认）

## Global Constraints

- 无后端，数据库升级不清空旧数据。
- 审批阈值 10000 元；驳回重提保留历史。
- 错误明确展示，不静默兜底。

## Review Focus

- 旧数据缺字段：迁移测试覆盖真实 v1 附件与空供应商草稿。
- 跨页过期状态：提交和审批在事务中检查当前状态。
- 金额边界：测试 9999.99、10000、非法数字。
- 删除关联供应商：事务检查引用且拒绝删除。
- 窄屏、键盘、错误提示：浏览器实测。

## Tasks

- [x] 1. `src/data.ts` 增加 Supplier 类型、listSuppliers/saveSupplier/deleteSupplier，版本迁移；`src/Suppliers.vue` 实现查询、编辑、详情和确认删除；`tests/suppliers.e2e.ts` 先写 CRUD 与引用限制测试，运行失败后实现再跑。
- [x] 2. `src/domain.ts` 定义三类表单及金额、校验、审批规则；`tests-unit/domain.test.ts` 用 Node 测试运行器覆盖边界。`src/data.ts` 增加迁移和提交/审批事务。
- [x] 3. `src/Form.vue`、类型字段组件、详情组件接入三类采购和草稿；扩展 `tests/request.e2e.ts` 覆盖三类、刷新与校验。
- [x] 4. `src/Approvals.vue` 实现部门/财务审批、驳回；`tests/approvals.e2e.ts` 覆盖重提、双审批和历史。
- [x] 5. `src/App.vue`、`src/Desk.vue`、`src/style.css`、`src/Login.vue` 统一蓝灰控制台、分页筛选、响应式和焦点；浏览器桌面及窄屏检查。
- [x] 6. 更新 README、AI 用例；运行 `npm run build`、单元测试与 `npm run test:e2e`，验证 v1 迁移与附件下载内容，审查 diff。

每一步保持构建可用。失败先找根因，修复后重跑相关测试。最终检查全部需求而非只检查原有测试。

## 执行记录

- 用户已确认按设计实施。采用当前工作区直接执行，保留此前 README 和测试改动。
- 供应商 CRUD 测试已先在旧页面失败（新增供应商按钮不存在），随后实现数据仓库和 Suppliers.vue，CRUD 测试通过。
- 数据库已升级 v2，迁移原四个供应商并为已有匹配申请补 supplierId。后续三类模型仍需进一步版本升级和真实 v1 迁移测试。
- 当前 build 与 4 条 E2E 通过；新增引用删除限制用例正在单独验证。
- Task 1 未全部完成：详情关联申请、停用/重复名验证、统一重置、供应商稳定 ID 表单绑定与迁移异常处理仍需完善。供应商名目前仍用于表单选择，后续改为 ID 并保留提交快照。
- Task 2–6 尚未开始；整体目标保持 active。

### 第二批进展

- 新增 domain.ts：三类 details 联合类型、集中校验、整数分金额、审批路径与状态转换；4 条 Node 单元测试通过，加入 npm run test:unit。
- data.ts 升级 v3：原生 IndexedDB cursor 迁移旧申请；supplierId 绑定、提交校验、revision 冲突检查、审批历史和草稿删除 API、全库演示重置。迁移仍需真实浏览器 v1/v2 验证。
- TypeFields/TypeSummary + Form 已支持物资、服务、软件订阅、动态字段、详情和历史；Approvals.vue 实现审批、驳回、两级流转；Desk 增加类型/状态筛选、排序分页。
- 当前原有 5 条 E2E 通过。新 types-approval 测试先发现 Element Plus 隐藏 radio/switch 不能直接 click；改用可见文字，最新完整回归正在执行。
- CSS 已初步改为蓝灰控制台，但尚未做视觉截图与窄屏实测，也不算 UI 完成。
- 尚需：供应商详情关联列表、重复名/停用/范围测试、草稿删除 UI、字段 inline 错误完善、金额/迁移/附件/并发更多验证、UI 深化、README 和 AI 用例更新、最终独立审查。


### 最终验证与审查

- `npm run build` 成功（含 vue-tsc）；仍有既有大 chunk 提示，无构建错误。
- `npm run test:unit`：4/4，金额边界、非法金额/日期、三类计费、审批状态。
- 构建后真实 CLI E2E：9/9，覆盖供应商 CRUD/关联详情/引用删除、无效资料、物资创建与草稿恢复、附件下载内容、空表单阻断、草稿删除、服务和软件的驳回重提及两级审批。
- `npm run test:storage`：真实 Chromium 中 v1/v2→v3 升级、原始附件内容、历史字段/状态保留、重复名、引用、停用/范围、单级审批及重复提交/审批阻断全部通过。
- `npm run test:layout`：1440/768/375 宽度的五个页面无页面级溢出，Tab 可进入控件，无未捕获运行时错误。人工查看桌面首页与窄屏表单截图，修正操作栏遮挡问题。
- 独立审查确认一项 Important：已删除草稿可被旧编辑页复活。真实浏览器测试先失败，之后通过显式 create/update 意图修复，含迁移 revision=0 场景回归通过；随后完整套件重跑通过。无延后 minor。
- README 已同步新字段、页面、业务规则、迁移和验证命令。原 AI 草稿用例的标题、金额和提交状态契约保持有效；本次未执行真实模型调用，不声称 AI 回归通过。
- 全部存储使用本地 IndexedDB，未增加后端、未改依赖版本。未创建 PR 或推送。
