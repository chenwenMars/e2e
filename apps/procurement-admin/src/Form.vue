<script setup lang="ts">
import { computed, onMounted, ref, toRaw } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, type UploadFile } from "element-plus";
import RichText from "./RichText.vue";
import TypeFields from './TypeFields.vue';
import TypeSummary from './TypeSummary.vue';
import { validateRequest, newDetails, approvalPath, type ProcurementType, type ValidationIssue } from './domain.ts';
import {
  departments,
  listSuppliers,
  type Supplier,
  tags,
  money,
  total,
  newForm,
  getRequest,
  saveRequest,
} from "./data";
const props = defineProps<{ id?: string }>(),
  router = useRouter();
const form = ref(newForm()),
  ready = ref(false),
  busy = ref(false),
  error = ref("");
const suppliers = ref<Supplier[]>([]);
const steps = ["基本信息", "采购明细", "说明与附件", "确认提交"];
const readonly = computed(() => !['草稿', '已驳回'].includes(form.value.status));
const issues = ref<ValidationIssue[]>([]);
const selectedType = computed({ get: () => form.value.details.type, set: (type: ProcurementType) => { form.value.details = newDetails(type); form.value.supplierId = ''; issues.value = []; } });
/** Locate the validation error for a basic form field. */
function fieldError(field: string) { return issues.value.find(i => i.field === field)?.message; }
const selectedSupplier = computed(() => suppliers.value.find(s => s.id === form.value.supplierId));
onMounted(async () => {
  suppliers.value = await listSuppliers();
  if (props.id) form.value = await getRequest(props.id);
  ready.value = true;
});
/** Validate the visible step using the same rules as persisted submission. */
function validate(step: number) {
  issues.value = validateRequest(form.value).filter(i => i.step === step);
  return issues.value.map(i => i.message).join('；');
}
/** Move only after the current step passes centralized validation. */
function move(direction: number) {
  error.value = direction > 0 ? validate(form.value.step) : "";
  if (!error.value) form.value.step += direction;
}
/** Attach the original File for IndexedDB structured cloning. */
function addFile(upload: UploadFile) {
  if (!upload.raw) throw new Error("无法读取选中的文件");
  form.value.files.push(upload.raw);
}
/** Download the persisted attachment bytes. */
function download(file: File) {
  const url = URL.createObjectURL(file),
    link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** Validate the submission and persist before navigating to the list. */
async function save(submit: boolean) {
  error.value = "";
  if (!form.value.title.trim()) {
    error.value = "请输入申请标题";
    issues.value = [{field: 'title', step: 0, message: error.value}];
    form.value.step = 0;
    return;
  }
  if (submit)
    for (let i = 0; i < 3; i++) {
      const message = validate(i);
      if (message) {
        form.value.step = i;
        error.value = message;
        return;
      }
    }
  busy.value = true;
  try {
    await saveRequest({
      ...toRaw(form.value),
      updated: new Date().toISOString(),
      status: submit ? "已提交" : "草稿",
    }, props.id ? 'update' : 'create');
    ElMessage.success(submit ? "申请单已提交" : "草稿已保存");
    await router.push("/requests");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    console.error(cause);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <template v-if="ready">
    <div class="section-head">
      <div>
        <p class="eyebrow">采购管理 / 采购申请</p>
        <h1>
          {{ readonly ? "申请单详情" : id ? "编辑采购草稿" : "创建采购申请" }}
        </h1>
      </div>
      <el-button @click="router.push('/requests')">返回列表</el-button>
    </div>
    <section class="panel sheet">
      <el-steps
        v-if="!readonly"
        :active="form.step"
        finish-status="success"
        simple
      >
        <el-step v-for="s in steps" :key="s" :title="s" />
      </el-steps>
      <h2>{{ readonly ? form.title : steps[form.step] }}</h2>
      <div class="request-status"><el-tag>{{form.status}}</el-tag><span data-testid="procurement-code">采购编码：{{form.code || '首次保存草稿或提交时自动生成'}}</span><span v-if="form.status==='已提交'">当前节点：{{form.approvalStage}}审批</span></div>
      <el-alert v-if="form.status==='已驳回'" title="申请已驳回，请根据审批意见修改后重新提交。历史记录会保留。" type="warning" :closable="false"/>
      <el-form label-position="top" v-if="!readonly && form.step === 0">
        <el-form-item label="采购类型" required><el-radio-group v-model="selectedType"><el-radio-button value="物资">物资采购</el-radio-button><el-radio-button value="服务">服务采购</el-radio-button><el-radio-button value="软件">软件订阅</el-radio-button></el-radio-group></el-form-item>
        <div class="grid">
          <el-form-item label="申请标题" required :error="fieldError('title')">
            <el-input v-model="form.title" placeholder="例如：研发工作站采购" />
          </el-form-item>
          <el-form-item label="申请部门" required :error="fieldError('department')">
            <el-select v-model="form.department">
              <el-option v-for="d in departments" :key="d" :value="d" />
            </el-select>
          </el-form-item>
          <el-form-item label="申请人" required :error="fieldError('applicant')">
            <el-input v-model="form.applicant" />
          </el-form-item>
          <el-form-item label="期望到货日期" required :error="fieldError('date')">
            <el-date-picker v-model="form.date" value-format="YYYY-MM-DD" />
          </el-form-item>
          <el-form-item label="优先级">
            <el-radio-group v-model="form.priority">
              <el-radio value="普通">普通</el-radio>
              <el-radio value="紧急">紧急</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="用途标签">
            <el-checkbox-group v-model="form.categories">
              <el-checkbox v-for="s in tags" :key="s" :value="s">
                {{ s }}
              </el-checkbox>
            </el-checkbox-group>
          </el-form-item>
        </div>
        <el-form-item label="采购事由" required :error="fieldError('purpose')">
          <el-input v-model="form.purpose" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <el-form v-else-if="!readonly && form.step === 1" label-position="top">
        <el-form-item label="供应商" required :error="fieldError('supplierId')">
          <el-select
            v-model="form.supplierId"
            filterable
            placeholder="搜索并选择供应商"
          >
            <el-option v-for="s in suppliers" :key="s.id" :label="s.name" :value="s.id" :disabled="!s.enabled || !s.scopes.includes(form.details.type)" />
          </el-select>
        </el-form-item>
        <TypeFields v-model="form" :issues="issues"/>
        <p class="amount">合计 {{ money.format(total(form)) }}</p>
      </el-form>
      <div v-else-if="!readonly && form.step === 2">
        <h3>采购说明</h3>
        <RichText v-model="form.notes" />
        <h3>附件</h3>
        <el-upload
          action="#"
          multiple
          :auto-upload="false"
          :show-file-list="false"
          :on-change="addFile"
        >
          <el-button>选择附件</el-button>
        </el-upload>
        <ul>
          <li v-for="(file, i) in form.files" :key="i">
            {{ file.name }}
            <el-button link @click="form.files.splice(i, 1)">移除</el-button>
          </li>
        </ul>
      </div>
      <div v-else class="review">
        <dl>
          <template
            v-for="[k, v] in [
              ['申请标题', form.title],
              ['申请部门', form.department],
              ['申请人', form.applicant],
              ['期望到货日期', form.date],
              ['优先级', form.priority],
              ['用途标签', form.categories.join('、')],
              ['采购事由', form.purpose],
              ['供应商', readonly ? form.supplier : selectedSupplier?.name],
              ['采购类型', form.details.type],
              ['审批路径', approvalPath(form).join(' → ')],
            ]"
            :key="k"
          >
            <dt>{{ k }}</dt>
            <dd>{{ v }}</dd>
          </template>
        </dl>
        <TypeSummary :form="form"/>
        <p class="amount">合计 {{ money.format(total(form)) }}</p>
        <h3>采购说明</h3>
        <RichText :model-value="form.notes" readonly />
        <h3>附件</h3>
        <span v-if="!form.files.length">无附件</span>
        <el-button
          v-for="(f, i) in form.files"
          :key="i"
          link
          type="primary"
          @click="download(f)"
        >
          下载 {{ f.name }}
        </el-button>
      </div>
      <section v-if="form.history.length" class="history"><h3>审批记录</h3><el-timeline><el-timeline-item v-for="event in form.history" :key="event.id" :timestamp="new Date(event.at).toLocaleString('zh-CN')"><strong>{{event.stage}} · {{event.action}}</strong><p>{{event.actor}}：{{event.comment}}</p></el-timeline-item></el-timeline></section>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <div v-if="!readonly" class="actions">
        <el-button :disabled="busy" @click="save(false)">保存草稿</el-button>
        <div>
          <el-button v-if="form.step > 0" @click="move(-1)">上一步</el-button>
          <el-button v-if="form.step < 3" type="primary" @click="move(1)">
            下一步
          </el-button>
          <el-button v-else type="primary" :loading="busy" @click="save(true)">
            提交申请
          </el-button>
        </div>
      </div>
    </section>
  </template>
</template>
