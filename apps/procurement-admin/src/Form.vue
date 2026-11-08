<script setup lang="ts">
import { computed, onMounted, ref, toRaw } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, type UploadFile } from "element-plus";
import RichText from "./RichText.vue";
import {
  departments,
  suppliers,
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
const steps = ["基本信息", "采购明细", "说明与附件", "确认提交"];
const readonly = computed(() => form.value.status === "已提交");
onMounted(async () => {
  if (props.id) form.value = await getRequest(props.id);
  ready.value = true;
});
function validate(step: number) {
  const f = form.value;
  if (!f.title.trim()) return "请输入申请标题";
  if (
    !step &&
    (!f.department || !f.applicant.trim() || !f.date || !f.purpose.trim())
  )
    return "请填写申请部门、申请人、期望到货日期和采购事由";
  if (
    step === 1 &&
    (!f.supplier ||
      !f.lines.length ||
      f.lines.some(
        (l) =>
          !l.name.trim() ||
          !Number.isInteger(l.quantity) ||
          !(l.quantity > 0 && l.price > 0),
      ))
  )
    return "请选择供应商，并为每行填写品名、正整数数量和大于零的单价";
  return "";
}
function move(direction: number) {
  error.value = direction > 0 ? validate(form.value.step) : "";
  if (!error.value) form.value.step += direction;
}
function addFile(upload: UploadFile) {
  if (!upload.raw) throw new Error("无法读取选中的文件");
  form.value.files.push(upload.raw);
}
function download(file: File) {
  const url = URL.createObjectURL(file),
    link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function save(submit: boolean) {
  error.value = "";
  if (!form.value.title.trim()) {
    error.value = "请输入申请标题";
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
    });
    ElMessage.success(submit ? "申请单已提交" : "草稿已保存");
    await router.push("/requests");
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
      <el-form label-position="top" v-if="!readonly && form.step === 0">
        <div class="grid">
          <el-form-item label="申请标题" required>
            <el-input v-model="form.title" placeholder="例如：研发工作站采购" />
          </el-form-item>
          <el-form-item label="申请部门" required>
            <el-select v-model="form.department">
              <el-option v-for="d in departments" :key="d" :value="d" />
            </el-select>
          </el-form-item>
          <el-form-item label="申请人" required>
            <el-input v-model="form.applicant" />
          </el-form-item>
          <el-form-item label="期望到货日期" required>
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
        <el-form-item label="采购事由" required>
          <el-input v-model="form.purpose" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <el-form v-else-if="!readonly && form.step === 1" label-position="top">
        <el-form-item label="供应商" required>
          <el-select
            v-model="form.supplier"
            filterable
            placeholder="搜索并选择供应商"
          >
            <el-option v-for="s in suppliers" :key="s" :value="s" />
          </el-select>
        </el-form-item>
        <div class="line" v-for="(line, i) in form.lines" :key="i">
          <el-form-item :label="'品名 ' + (i + 1)">
            <el-input v-model="line.name" />
          </el-form-item>
          <el-form-item :label="'数量 ' + (i + 1)">
            <el-input-number v-model="line.quantity" :min="1" :precision="0" />
          </el-form-item>
          <el-form-item :label="'单价（元） ' + (i + 1)">
            <el-input-number v-model="line.price" :min="0" :precision="2" />
          </el-form-item>
          <el-button
            :disabled="form.lines.length === 1"
            @click="form.lines.splice(i, 1)"
          >
            删除行
          </el-button>
        </div>
        <el-button
          @click="form.lines.push({ name: '', quantity: 1, price: 0 })"
        >
          添加明细
        </el-button>
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
              ['供应商', form.supplier],
            ]"
            :key="k"
          >
            <dt>{{ k }}</dt>
            <dd>{{ v }}</dd>
          </template>
        </dl>
        <h3>采购明细</h3>
        <table>
          <thead>
            <tr>
              <th>品名</th>
              <th>数量</th>
              <th>单价</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(l, i) in form.lines" :key="i">
              <td>{{ l.name }}</td>
              <td>{{ l.quantity }}</td>
              <td>{{ money.format(l.price) }}</td>
            </tr>
          </tbody>
        </table>
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
