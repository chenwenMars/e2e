<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  listRequests,
  resetRequests,
  suppliers,
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
onMounted(async () => {
  records.value = await listRequests();
});
const filtered = computed(() =>
  records.value.filter(
    (r) =>
      (!status.value || r.status === status.value) &&
      (r.title + r.id + r.department).includes(query.value.trim()),
  ),
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
          home
            ? "工作首页"
            : route.name === "suppliers"
              ? "供应商名录"
              : "采购申请"
        }}
      </h1>
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
  <template v-if="route.name === 'suppliers'">
    <section class="panel">
      <h2>合作供应商</h2>
      <ul>
        <li v-for="s in suppliers" :key="s">{{ s }}</li>
      </ul>
    </section>
  </template>
  <template v-else>
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
        <small>已提交</small>
        <strong>
          {{ records.filter((r) => r.status === "已提交").length }}
        </strong>
      </div>
    </div>
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
          placeholder="搜索标题、编号或部门"
          clearable
        />
        <el-select
          v-model="status"
          aria-label="筛选状态"
          placeholder="全部状态"
          clearable
        >
          <el-option
            v-for="s in ['草稿', '已提交']"
            :key="s"
            :label="s"
            :value="s"
          />
        </el-select>
      </div>
      <el-table
        :data="home ? records.slice(0, 5) : filtered"
        empty-text="没有匹配的申请单"
      >
        <el-table-column label="申请标题" prop="title" min-width="180" />
        <el-table-column label="部门" prop="department" min-width="95" />
        <el-table-column label="金额" min-width="110">
          <template #default="{ row }">{{ money.format(total(row)) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === '草稿' ? 'info' : 'success'">
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              @click="router.push('/requests/' + row.id)"
            >
              {{ row.status === "草稿" ? "继续编辑" : "查看详情" }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>
  </template>
  <el-dialog v-model="resetDialog" title="恢复初始演示数据" width="410px">
    将删除本应用保存的申请单和附件，并恢复六条初始记录。
    <template #footer>
      <el-button @click="resetDialog = false">取消</el-button>
      <el-button type="danger" @click="reset">确认重置</el-button>
    </template>
  </el-dialog>
</template>
