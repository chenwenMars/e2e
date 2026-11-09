<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue';
import { ElMessage } from 'element-plus';
import type { GoodsLine, Currency } from './domain.ts';
import type { PreviewRow } from './goods-workbook.ts';

const props = defineProps<{ lines: GoodsLine[]; currency: Currency; readonly?: boolean }>();
const emit = defineEmits<{ import: [lines: GoodsLine[]] }>();
const picker = ref<HTMLInputElement>();
const busy = ref(false);
const error = ref('');
const filename = ref('');
const open = ref(false);
const rows = shallowRef<PreviewRow[]>([]);
const selected = ref(new Set<number>());
const selectedLines = computed(() => valid.value.filter(r => selected.value.has(r.row)).map(r => r.line));
const importTotal = computed(() => [...props.lines, ...selectedLines.value]
  .reduce((sum, line) => sum + Math.round(line.price * 100) * line.quantity, 0));
const totalError = computed(() => selected.value.size && !Number.isSafeInteger(importTotal.value)
  ? '导入后合计金额超过可精确计算范围，请减少选中行或调整单价、数量' : '');
const page = ref(1);
const pageSize = 50;
const valid = computed(() => rows.value.filter(r => !r.issues.length));
const visible = computed(() => rows.value.slice((page.value - 1) * pageSize, page.value * pageSize));
const emptyStarter = computed(() => {
  if (props.lines.length !== 1) return false;
  const [line] = props.lines;
  return line.name === '' && line.specification === '' && line.quantity === 1 && line.price === 0;
});

/** Generate a genuine workbook only when the user requests a download. */
async function download(template: boolean) {
  busy.value = true;
  error.value = '';
  try {
    const { writeGoodsWorkbook } = await import('./goods-workbook.ts');
    const bytes = await writeGoodsWorkbook(template ? [] : props.lines, props.currency);
    const url = URL.createObjectURL(new Blob([bytes], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = `采购明细${template ? '模板' : ''}-${props.currency}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (cause) {
    error.value = '下载失败：' + (cause instanceof Error ? cause.message : String(cause));
  } finally { busy.value = false; }
}

/** Parse into isolated preview state; cancelling or replacing the file cannot modify the request. */
async function preview(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  error.value = '';
  busy.value = true;
  try {
    if (!/\.xlsx$/i.test(file.name)) throw new Error('请选择 .xlsx 工作簿');
    const { readGoodsWorkbook } = await import('./goods-workbook.ts');
    rows.value = await readGoodsWorkbook(await file.arrayBuffer(), props.currency);
    selected.value = new Set(valid.value.map(r => r.row));
    filename.value = file.name;
    page.value = 1;
    open.value = true;
  } catch (cause) {
    error.value = `无法导入 ${file.name}：` + (cause instanceof Error ? cause.message : String(cause));
  } finally { busy.value = false; }
}

/** Append checked rows in worksheet order, consuming only the pristine starter row. */
function confirm() {
  const incoming = selectedLines.value;
  emit('import', emptyStarter.value ? incoming : [...props.lines, ...incoming]);
  open.value = false;
  ElMessage.success(`已导入 ${incoming.length} 条采购明细`);
}
</script>
<template>
  <div class="excel-tools">
    <el-button v-if="!readonly" :disabled="busy" @click="download(true)">下载 Excel 模板</el-button>
    <el-button v-if="!readonly" type="primary" plain :disabled="busy" @click="picker?.click()">导入明细</el-button>
    <el-button :disabled="busy || emptyStarter" @click="download(false)">导出明细</el-button>
    <input v-if="!readonly" ref="picker" type="file" hidden accept=".xlsx" aria-label="选择采购明细 Excel" @change="preview" />
  </div>
  <p v-if="error" role="alert" class="error">{{ error }}</p>
  <el-dialog v-model="open" title="确认导入采购明细" width="min(960px, 94vw)" append-to-body destroy-on-close>
    <p class="import-info">{{ filename }} · 共 {{ rows.length }} 行，校验通过 {{ valid.length }} 行，有误 {{ rows.length - valid.length }} 行</p>
    <el-checkbox :model-value="valid.length > 0 && selected.size === valid.length" :disabled="!valid.length"
      :indeterminate="selected.size > 0 && selected.size < valid.length"
      @change="(checked: boolean | string | number) => selected = new Set(checked ? valid.map(r => r.row) : [])">全选有效行</el-checkbox>
    <el-table :data="visible" row-key="row" max-height="400">
      <el-table-column label="导入" width="56"><template #default="{row}">
        <input type="checkbox" class="import-checkbox" :aria-label="'选择第 ' + row.row + ' 行'"
          :disabled="!!row.issues.length" :checked="selected.has(row.row)"
          @change="(event: Event) => (event.target as HTMLInputElement).checked ? selected.add(row.row) : selected.delete(row.row)" />
      </template></el-table-column>
      <el-table-column prop="row" label="Excel 行" width="78" />
      <el-table-column v-for="(label, i) in ['品名','规格','数量','单价（' + currency + '）']" :key="label" :label="label" min-width="90">
        <template #default="{row}">{{ row.cells[i] }}</template>
      </el-table-column>
      <el-table-column label="校验结果" min-width="170">
        <template #default="{row}"><span :class="{error: row.issues.length}">{{row.issues.length ? row.issues.join('；') : '通过'}}</span></template>
      </el-table-column>
    </el-table>
    <el-pagination v-if="rows.length > pageSize" v-model:current-page="page" :page-size="pageSize" :total="rows.length" layout="prev, pager, next" />
    <p v-if="totalError" role="alert" class="error">{{ totalError }}</p>
    <template #footer>
      <span class="import-count">将追加 {{ selected.size }} 条明细</span>
      <el-button @click="open = false">取消</el-button>
      <el-button type="primary" :disabled="!selected.size || !!totalError" @click="confirm">确认导入</el-button>
    </template>
  </el-dialog>
</template>
<style scoped>
.excel-tools { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 16px; }
.excel-tools .el-button { margin:0; }
.import-info { margin:0 0 8px; overflow-wrap:anywhere; }
.import-checkbox { width:16px; height:16px; accent-color:#2563eb; cursor:pointer; }
.import-count { margin-right:12px; }
</style>
