<script setup lang="ts">
import type { RequestForm, ValidationIssue } from './domain.ts';
const form = defineModel<RequestForm>({ required: true });
const props = defineProps<{ issues: ValidationIssue[] }>();
/** Read the centralized field validation message. */
function error(field: string) { return props.issues.find(i => i.field === field)?.message; }
</script>
<template>
  <template v-if="form.details.type === '物资'">
    <div class="line" v-for="(line,i) in form.lines" :key="i">
      <el-form-item :label="'品名 '+(i+1)" :error="error(`lines.${i}.name`)"><el-input v-model="line.name"/></el-form-item>
      <el-form-item :label="'规格 '+(i+1)"><el-input v-model="line.specification"/></el-form-item>
      <el-form-item :label="'数量 '+(i+1)" :error="error(`lines.${i}.quantity`)"><el-input-number v-model="line.quantity" :min="1" :precision="0"/></el-form-item>
      <el-form-item :label="'单价（元） '+(i+1)" :error="error(`lines.${i}.price`)"><el-input-number v-model="line.price" :min="0" :precision="2"/></el-form-item>
      <el-button :disabled="form.lines.length===1" @click="form.lines.splice(i,1)">删除行</el-button>
    </div>
    <el-button @click="form.lines.push({name:'',specification:'',quantity:1,price:0})">添加明细</el-button>
    <div class="grid">
      <el-form-item label="收货地址" required :error="error('address')"><el-input v-model="form.details.address"/></el-form-item>
      <el-form-item label="收货联系人" required :error="error('contact')"><el-input v-model="form.details.contact"/></el-form-item>
    </div>
    <el-form-item label="安装服务"><el-switch v-model="form.details.installation" aria-label="需要安装" active-text="需要安装"/></el-form-item>
    <el-form-item v-if="form.details.installation" label="安装说明" required :error="error('installationNotes')"><el-input v-model="form.details.installationNotes" type="textarea"/></el-form-item>
  </template>
  <template v-else-if="form.details.type === '服务'">
    <div class="grid">
      <el-form-item label="服务类别" required :error="error('category')"><el-select v-model="form.details.category"><el-option v-for="s in ['咨询','维护','培训','设计']" :key="s" :value="s"/></el-select></el-form-item>
      <el-form-item label="服务地点" required :error="error('location')"><el-input v-model="form.details.location"/></el-form-item>
      <el-form-item label="服务开始日期" required :error="error('period')"><el-date-picker v-model="form.details.start" value-format="YYYY-MM-DD"/></el-form-item>
      <el-form-item label="服务结束日期" required :error="error('period')"><el-date-picker v-model="form.details.end" value-format="YYYY-MM-DD"/></el-form-item>
    </div>
    <el-form-item label="交付说明" required :error="error('deliverables')"><el-input v-model="form.details.deliverables" type="textarea"/></el-form-item>
    <h3>交付里程碑</h3><p>每个里程碑日期须在服务期间内，采购总额为里程碑金额合计。</p>
    <div class="line" v-for="(m,i) in form.details.milestones" :key="i">
      <el-form-item :label="'里程碑名称 '+(i+1)" :error="error(`milestones.${i}.name`)"><el-input v-model="m.name"/></el-form-item>
      <el-form-item :label="'里程碑日期 '+(i+1)" :error="error(`milestones.${i}.date`)"><el-date-picker v-model="m.date" value-format="YYYY-MM-DD"/></el-form-item>
      <el-form-item :label="'里程碑金额 '+(i+1)" :error="error(`milestones.${i}.amount`)"><el-input-number v-model="m.amount" :min="0" :precision="2"/></el-form-item>
      <el-button :disabled="form.details.milestones.length===1" @click="form.details.milestones.splice(i,1)">删除里程碑</el-button>
    </div>
    <el-button @click="form.details.milestones.push({name:'',date:'',amount:0})">添加里程碑</el-button>
  </template>
  <template v-else>
    <div class="grid">
      <el-form-item label="软件产品名称" required :error="error('product')"><el-input v-model="form.details.product"/></el-form-item>
      <el-form-item label="授权席位" required :error="error('seats')"><el-input-number v-model="form.details.seats" :min="1" :precision="0"/></el-form-item>
      <el-form-item label="每席月单价" required :error="error('unitPrice')"><el-input-number v-model="form.details.unitPrice" :min="0" :precision="2"/></el-form-item>
      <el-form-item label="订阅月数" required :error="error('months')"><el-input-number v-model="form.details.months" :min="1" :precision="0"/></el-form-item>
      <el-form-item label="订阅起始日期" required :error="error('start')"><el-date-picker v-model="form.details.start" value-format="YYYY-MM-DD"/></el-form-item>
      <el-form-item label="数据敏感级别" required :error="error('sensitivity')"><el-select v-model="form.details.sensitivity"><el-option v-for="s in ['公开','内部','敏感']" :key="s" :value="s"/></el-select></el-form-item>
    </div>
    <el-form-item label="续费方式"><el-switch v-model="form.details.autoRenew" aria-label="自动续费" active-text="自动续费"/></el-form-item>
    <p>采购总额 = 授权席位 × 每席月单价 × 订阅月数</p>
  </template>
</template>
