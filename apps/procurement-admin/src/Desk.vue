<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { cnyCents } from './domain.ts';
import { useRoute, useRouter } from "vue-router";
import {
  listRequests,
  deleteRequest,
  resetRequests,
  money,
  total,
  type RequestForm,
} from "./data";
const route = useRoute(),
  router = useRouter();
const records = ref<RequestForm[]>([]),
  query = ref(""),
  status = ref(""),
  resetDialog = ref(false);
const deleting = ref<RequestForm>(), deleteError = ref('');
/** Delete only the draft revision confirmed in the dialog. */
async function remove() {
  try { await deleteRequest(deleting.value!.id, deleting.value!.revision); records.value = await listRequests(); deleting.value=undefined; page.value=1; }
  catch(cause) { deleteError.value=cause instanceof Error ? cause.message : String(cause); console.error(cause); }
}
const type = ref(""), page = ref(1), sort = ref("updated");
watch([query,status,type,sort], () => page.value=1);
onMounted(async () => {
  records.value = await listRequests();
});
const filtered = computed(() =>
  records.value.filter(
    (r) =>
      (!status.value || r.status === status.value) &&
      (!type.value || r.details.type === type.value) &&
      (r.title + r.code + r.id + r.department).includes(query.value.trim()),
  ).toSorted((a,b) => sort.value === "amount" ? (cnyCents(b) ?? -1) - (cnyCents(a) ?? -1) : b.updated.localeCompare(a.updated)),
);
const home = computed(() => route.name === "home");
async function reset() {
  await resetRequests();
  records.value = await listRequests();
  resetDialog.value = false;
}
</script>
<template>
  <div class="section-head">
    <div>
      <p class="eyebrow">采购管理</p>
      <h1>
        {{
          home ? "工作首页" : "采购申请"
        }}
      </h1><p>{{home ? '掌握采购进度，集中处理申请与审批待办' : '从需求提出到审批完成，跟踪每一笔采购'}}</p>
    </div>
    <el-button v-if="home" @click="resetDialog = true">重置演示数据</el-button>
    <el-button
      v-if="route.name === 'requests'"
      type="primary"
      @click="router.push('/requests/new')"
    >
      创建申请单
    </el-button>
  </div>
    <div class="metrics" v-if="home">
      <div>
        <small>申请总数</small>
        <strong>{{ records.length }}</strong>
      </div>
      <div>
        <small>待完善草稿</small>
        <strong>{{ records.filter((r) => r.status === "草稿").length }}</strong>
      </div>
      <div>
        <small>待审批申请</small>
        <strong>
          {{ records.filter((r) => r.status === "已提交").length }}
        </strong>
      </div>
    </div>
    <section v-if="home" class="quick-actions"><div><h2>采购业务工作区</h2><p>新建采购需求、维护合作伙伴，或处理当前审批任务。</p></div><div><el-button type="primary" @click="router.push('/requests/new')">创建申请单</el-button><el-button @click="router.push('/approvals')">处理审批待办</el-button></div></section>
    <section class="panel">
      <div class="section-head">
        <h2>{{ home ? "最近申请" : "申请单列表" }}</h2>
        <el-button
          v-if="home"
          link
          type="primary"
          @click="router.push('/requests')"
        >
          查看全部申请 →
        </el-button>
      </div>
      <div v-if="!home" class="filters">
        <el-input
          v-model="query"
          aria-label="搜索申请单"
          placeholder="搜索标题、采购编码或部门"
          clearable
        />
        <el-select
          v-model="status"
          aria-label="筛选状态"
          placeholder="全部状态"
          clearable
        >
          <el-option
            v-for="s in ['草稿', '已提交', '已通过', '已驳回']"
            :key="s"
            :label="s"
            :value="s"
          />
        </el-select>
        <el-select v-model="type" aria-label="筛选采购类型" placeholder="全部类型" clearable><el-option v-for="t in ['物资','服务','软件']" :key="t" :value="t"/></el-select>
        <el-select v-model="sort" aria-label="排序方式"><el-option label="最近更新" value="updated"/><el-option label="按人民币金额从高到低" value="amount"/></el-select>
      </div>
      <el-table
        :data="home ? records.slice(0, 5) : filtered.slice((page-1)*10,page*10)"
        empty-text="没有匹配的申请单"
      >
        <el-table-column label="采购编码" prop="code" min-width="200" show-overflow-tooltip />
        <el-table-column label="申请标题" prop="title" min-width="180" />
        <el-table-column label="类型" width="90"><template #default="{row}">{{row.details.type}}</template></el-table-column>
        <el-table-column label="部门" prop="department" min-width="95" />
        <el-table-column label="金额" min-width="110">
          <template #default="{ row }">{{ money(total(row),row.currency) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === '草稿' ? 'info' : row.status === '已驳回' ? 'danger' : row.status === '已提交' ? 'warning' : 'success'">
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              @click="router.push('/requests/' + row.id)"
            >
              {{ ["草稿","已驳回"].includes(row.status) ? "继续编辑" : "查看详情" }}
            </el-button>
            <el-button v-if="row.status==='草稿'" link type="danger" @click="deleting=row;deleteError=''">删除草稿</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination v-if="!home" v-model:current-page="page" :page-size="10" :total="filtered.length" layout="total, prev, pager, next"/>
    </section>
  <el-dialog :model-value="!!deleting" title="删除采购草稿" width="min(440px,94vw)" @close="deleting=undefined"><p>确认删除“{{deleting?.title}}”及其附件？</p><p v-if="deleteError" role="alert" class="error">{{deleteError}}</p><template #footer><el-button @click="deleting=undefined">取消</el-button><el-button type="danger" @click="remove">确认删除草稿</el-button></template></el-dialog>
  <el-dialog v-model="resetDialog" title="恢复初始演示数据" width="410px">
    将删除项目共享文件中的供应商、申请单、附件和审批历史，并恢复初始演示数据。所有浏览器和 E2E 都会受影响。
    <template #footer>
      <el-button @click="resetDialog = false">取消</el-button>
      <el-button type="danger" @click="reset">确认重置</el-button>
    </template>
  </el-dialog>
</template>
