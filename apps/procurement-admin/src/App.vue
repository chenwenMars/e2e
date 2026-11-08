<script setup lang="ts">
import { useRoute, useRouter } from "vue-router";
const route = useRoute(),
  router = useRouter();
function logout() {
  sessionStorage.removeItem("procurement-user");
  router.replace("/login");
}
</script>
<template>
  <router-view v-if="route.path === '/login'" />
  <div v-else class="shell">
    <aside>
      <div class="brand">
        <b class="mark">采</b>
        采购工作台
      </div>
      <nav aria-label="主导航">
        <router-link to="/home">工作首页</router-link>
        <small>采购管理</small>
        <router-link
          to="/requests"
          :class="{ active: route.path.startsWith('/requests') }"
        >
          采购申请
        </router-link>
        <router-link to="/suppliers">供应商名录</router-link>
      </nav>
      <footer>本地工作空间</footer>
    </aside>
    <main>
      <header class="top">
        <span>采购管理系统</span>
        <div>
          admin
          <el-button text @click="logout">退出登录</el-button>
        </div>
      </header>
      <section class="page"><router-view :key="route.fullPath" /></section>
    </main>
  </div>
</template>
