<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { cnyCents } from './domain.ts';
import { listRequests, reviewRequest, money, total, type RequestForm } from './data.ts';
const router = useRouter();
const records = ref<RequestForm[]>([]), stage = ref(''), selected = ref<RequestForm>(), comment = ref(''), error = ref(''), busy = ref(false);
const pending = computed(() => records.value.filter(r => r.status === '已提交' && (!stage.value || r.approvalStage === stage.value)));
/** Read all pending approvals from the local database. */
async function refresh() { records.value = await listRequests(); }
onMounted(refresh);
/** Open a decision tied to the displayed request revision. */
function open(record: RequestForm) { selected.value = record; comment.value = ''; error.value = ''; }
/** Persist an approval decision before refreshing the work queue. */
async function decide(action: '通过' | '驳回') {
  busy.value = true; error.value = '';
  try {
    const r = selected.value!;
    await reviewRequest(r.id, r.revision, r.approvalStage, action, comment.value);
    await refresh(); selected.value = undefined;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); console.error(cause); }
  finally { busy.value = false; }
}
</script>
<template>
  <div class="section-head"><div><p class="eyebrow">采购管理 / 审批中心</p><h1>审批工作台</h1><p>查看待办，核对申请并记录审批意见</p></div><el-button @click="refresh">刷新待办</el-button></div>
  <el-alert title="本地审批演示：当前账号可办理部门及财务节点，不代表真实权限隔离。" type="info" :closable="false"/>
  <section class="panel"><div class="section-head"><h2>待审批申请 · {{pending.length}}</h2><el-select v-model="stage" aria-label="审批阶段筛选" placeholder="全部节点" clearable style="width:180px"><el-option label="部门审批" value="部门"/><el-option label="财务审批" value="财务"/></el-select></div>
    <el-table :data="pending" empty-text="暂无待审批申请"><el-table-column prop="code" label="采购编码" min-width="200" show-overflow-tooltip/><el-table-column prop="title" label="申请标题" min-width="180"/><el-table-column label="采购类型" width="100"><template #default="{row}">{{row.details.type}}</template></el-table-column><el-table-column prop="department" label="申请部门"/><el-table-column label="金额"><template #default="{row}">{{money(total(row),row.currency)}}</template></el-table-column><el-table-column label="当前节点"><template #default="{row}">{{row.approvalStage}}审批</template></el-table-column><el-table-column label="操作" width="180"><template #default="{row}"><el-button link @click="router.push('/requests/'+row.id)">查看详情</el-button><el-button link type="primary" @click="open(row)">办理审批</el-button></template></el-table-column></el-table>
  </section>
  <el-dialog :model-value="!!selected" title="办理审批" width="min(560px,94vw)" :close-on-click-modal="false" @close="selected=undefined">
    <template v-if="selected"><h2>{{selected.title}}</h2><p>采购编码：{{selected.code}}</p><p>{{selected.approvalStage}}审批 · {{money(total(selected),selected.currency)}}</p><p v-if="selected.exchangeRate">参考汇率（{{selected.exchangeRate.date}}）：1 {{selected.currency}} = {{selected.exchangeRate.rate}} CNY · 折合人民币 {{money(cnyCents(selected)! / 100, 'CNY')}}</p><p>人民币金额达到 ¥10,000.00 时，部门审批通过后进入财务审批。</p><el-form label-position="top"><el-form-item label="审批意见" required :error="error"><el-input v-model="comment" type="textarea" :rows="4" aria-label="审批意见"/></el-form-item></el-form><p v-if="error" role="alert" aria-label="审批错误" class="error">{{error}}</p></template>
    <template #footer><el-button :disabled="busy" @click="selected=undefined">取消</el-button><el-button type="danger" :disabled="busy" @click="decide('驳回')">驳回申请</el-button><el-button type="primary" :loading="busy" @click="decide('通过')">审批通过</el-button></template>
  </el-dialog>
</template>
