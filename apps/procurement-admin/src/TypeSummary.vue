<script setup lang="ts">
import type { RequestForm } from './domain.ts';
import GoodsExcel from './GoodsExcel.vue';
import { money } from './data.ts';
defineProps<{ form: RequestForm }>();
</script>
<template>
  <h3>{{form.details.type}}采购明细</h3>
  <template v-if="form.details.type==='物资'">
    <GoodsExcel :lines="form.lines" :currency="form.currency" readonly />
    <table><thead><tr><th>品名</th><th>规格</th><th>数量</th><th>单价</th></tr></thead><tbody><tr v-for="(l,i) in form.lines" :key="i"><td>{{l.name}}</td><td>{{l.specification}}</td><td>{{l.quantity}}</td><td>{{money(l.price, form.currency)}}</td></tr></tbody></table>
    <dl><dt>收货地址</dt><dd>{{form.details.address || '历史记录未填写'}}</dd><dt>收货联系人</dt><dd>{{form.details.contact || '历史记录未填写'}}</dd><dt>安装服务</dt><dd>{{form.details.installation ? form.details.installationNotes : '无需安装'}}</dd></dl>
  </template>
  <template v-else-if="form.details.type==='服务'">
    <dl><dt>服务类别</dt><dd>{{form.details.category}}</dd><dt>服务期间</dt><dd>{{form.details.start}} 至 {{form.details.end}}</dd><dt>服务地点</dt><dd>{{form.details.location}}</dd><dt>交付说明</dt><dd>{{form.details.deliverables}}</dd></dl>
    <table><thead><tr><th>里程碑</th><th>日期</th><th>金额</th></tr></thead><tbody><tr v-for="(m,i) in form.details.milestones" :key="i"><td>{{m.name}}</td><td>{{m.date}}</td><td>{{money(m.amount, form.currency)}}</td></tr></tbody></table>
  </template>
  <dl v-else><dt>软件产品</dt><dd>{{form.details.product}}</dd><dt>授权席位</dt><dd>{{form.details.seats}}</dd><dt>每席月单价</dt><dd>{{money(form.details.unitPrice, form.currency)}}</dd><dt>订阅月数</dt><dd>{{form.details.months}}</dd><dt>起始日期</dt><dd>{{form.details.start}}</dd><dt>自动续费</dt><dd>{{form.details.autoRenew ? '是' : '否'}}</dd><dt>数据敏感级别</dt><dd>{{form.details.sensitivity}}</dd></dl>
</template>
