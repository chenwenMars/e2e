<script setup lang="ts">
import { computed, onMounted, ref, toRaw, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { listRequests, listSuppliers, saveSupplier, deleteSupplier, newSupplier, type Supplier, type RequestForm } from './data.ts';
const router = useRouter();
const requests = ref<RequestForm[]>([]);
const related = computed(() => requests.value.filter(r => r.supplierId === detail.value?.id));
const records = ref<Supplier[]>([]), query = ref(''), status = ref(''), scope = ref(''), page = ref(1);
const editing = ref(false), detail = ref<Supplier>(), deleting = ref<Supplier>(), form = ref(newSupplier()), busy = ref(false), error = ref('');
const filtered = computed(() => records.value.filter(s => (s.name + s.contact + s.phone).includes(query.value.trim()) && (!status.value || String(s.enabled) === status.value) && (!scope.value || s.scopes.includes(scope.value))));
watch([query, status, scope], () => page.value = 1);
/** Refresh the local directory. */
async function refresh() { records.value = await listSuppliers(); requests.value = await listRequests(); }
onMounted(refresh);
/** Open an independent editor so cancelling never mutates saved data. */
function edit(record?: Supplier) { form.value = record ? structuredClone(toRaw(record)) : newSupplier(); error.value = ''; editing.value = true; }
/** Persist only after boundary validation succeeds. */
async function save() {
  busy.value = true; error.value = '';
  try { await saveSupplier(toRaw(form.value)); await refresh(); editing.value = false; ElMessage.success('供应商已保存'); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); console.error(cause); }
  finally { busy.value = false; }
}
/** Confirm deletion and surface reference errors without closing the dialog. */
async function remove() {
  busy.value = true; error.value = '';
  try { await deleteSupplier(deleting.value!.id); await refresh(); deleting.value = undefined; page.value = 1; ElMessage.success('供应商已删除'); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); console.error(cause); }
  finally { busy.value = false; }
}
</script>
<template>
  <div class="section-head"><div><p class="eyebrow">采购管理 / 合作伙伴</p><h1>供应商名录</h1><p>管理供应商资料、供应范围与合作状态</p></div><el-button type="primary" @click="edit()">新增供应商</el-button></div>
  <section class="panel">
    <div class="filters">
      <el-input v-model="query" aria-label="搜索供应商" placeholder="搜索名称、联系人或电话" clearable />
      <el-select v-model="status" aria-label="供应商状态" placeholder="全部状态" clearable><el-option label="启用" value="true"/><el-option label="停用" value="false"/></el-select>
      <el-select v-model="scope" aria-label="供应范围筛选" placeholder="全部供应范围" clearable><el-option v-for="s in ['物资','服务','软件']" :key="s" :label="s" :value="s"/></el-select>
    </div>
    <el-table :data="filtered.slice((page-1)*10,page*10)" empty-text="没有匹配的供应商">
      <el-table-column prop="name" label="供应商名称" min-width="180"/><el-table-column prop="contact" label="联系人" min-width="100"/><el-table-column prop="phone" label="联系电话" min-width="140"/>
      <el-table-column label="供应范围" min-width="120"><template #default="{row}">{{ row.scopes.join('、') }}</template></el-table-column>
      <el-table-column label="状态" width="90"><template #default="{row}"><el-tag :type="row.enabled ? 'success' : 'info'">{{row.enabled ? '启用' : '停用'}}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="190"><template #default="{row}"><el-button link type="primary" @click="detail=row">详情</el-button><el-button link type="primary" @click="edit(row)">编辑</el-button><el-button link type="danger" @click="deleting=row; error=''">删除</el-button></template></el-table-column>
    </el-table>
    <el-pagination v-model:current-page="page" :page-size="10" :total="filtered.length" layout="total, prev, pager, next" />
  </section>
  <el-dialog v-model="editing" :title="records.some(s=>s.id===form.id) ? '编辑供应商' : '新增供应商'" width="min(640px, 94vw)" :close-on-click-modal="false">
    <el-form label-position="top"><div class="grid">
      <el-form-item label="供应商名称" required><el-input v-model="form.name" aria-label="供应商名称"/></el-form-item>
      <el-form-item label="联系人" required><el-input v-model="form.contact" aria-label="联系人"/></el-form-item>
      <el-form-item label="联系电话" required><el-input v-model="form.phone" aria-label="联系电话"/></el-form-item>
      <el-form-item label="邮箱" required><el-input v-model="form.email" aria-label="邮箱"/></el-form-item>
    </div><el-form-item label="地址" required><el-input v-model="form.address" aria-label="地址"/></el-form-item>
    <el-form-item label="供应范围" required><el-checkbox-group v-model="form.scopes"><el-checkbox v-for="s in ['物资','服务','软件']" :key="s" :value="s">{{s}}</el-checkbox></el-checkbox-group></el-form-item>
    <el-form-item label="合作状态"><el-switch v-model="form.enabled" aria-label="启用供应商" active-text="启用" inactive-text="停用"/></el-form-item>
    <el-form-item label="备注"><el-input v-model="form.notes" type="textarea" aria-label="备注"/></el-form-item></el-form>
    <p v-if="error" role="alert" class="error">{{error}}</p>
    <template #footer><el-button :disabled="busy" @click="editing=false">取消</el-button><el-button type="primary" :loading="busy" @click="save">保存供应商</el-button></template>
  </el-dialog>
  <el-dialog :model-value="!!deleting" title="删除供应商" width="min(440px,94vw)" @close="deleting=undefined">
    <p>确认删除“{{deleting?.name}}”？已被申请引用的供应商无法删除。</p><p v-if="error" role="alert" class="error">{{error}}</p>
    <template #footer><el-button @click="deleting=undefined">取消</el-button><el-button type="danger" :loading="busy" @click="remove">确认删除</el-button></template>
  </el-dialog>
  <el-drawer :model-value="!!detail" title="供应商详情" size="min(520px,95vw)" @close="detail=undefined"><template v-if="detail"><h2>{{detail.name}}</h2><dl class="review"><template v-for="[label,value] in [['联系人',detail.contact],['电话',detail.phone],['邮箱',detail.email],['地址',detail.address],['供应范围',detail.scopes.join('、')],['备注',detail.notes]]" :key="label"><dt>{{label}}</dt><dd>{{value || '未填写'}}</dd></template></dl><h3>关联采购申请 · {{related.length}}</h3><el-empty v-if="!related.length" description="暂无关联申请"/><div v-for="r in related" :key="r.id" class="related-request"><el-button link type="primary" @click="router.push('/requests/'+r.id)">{{r.title}}</el-button><el-tag>{{r.status}}</el-tag></div></template></el-drawer>
</template>
