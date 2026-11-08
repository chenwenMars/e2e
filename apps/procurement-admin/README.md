# 本地采购工作台

在仓库根目录执行以下命令。Vite 固定监听 4290 端口，浏览器访问 http://127.0.0.1:4290/ 。

```sh
pnpm install --frozen-lockfile
pnpm --filter @e2e-dev/procurement-admin dev
```

使用演示账号 `admin` 和密码 `admin` 登录。进入“工作首页”，从侧栏选择“采购管理 → 采购申请”。首次打开会生成六条固定记录。

1. 点击“创建申请单”，填写基本信息、优先级和用途标签。
2. 在“采购明细”中搜索供应商，录入物品、数量和单价。可以添加多行，总额随明细更新。
3. 在“说明与附件”中编辑富文本并选择本地文件。填入标题后可以保存草稿，从列表继续编辑。
4. 在“确认提交”核对字段、总额和附件，点击“提交申请”。返回列表，在“查看详情”中查看提交结果和下载原文件。

已保存的草稿和已提交申请保存在当前浏览器、当前站点的 IndexedDB 中。登录状态保存在当前标签页的 sessionStorage 中。工作首页的“重置演示数据”会在确认后恢复六条初始记录。未保存的修改在离开页面后丢弃。

```sh
pnpm --filter @e2e-dev/procurement-admin typecheck
pnpm --filter @e2e-dev/procurement-admin build
```
