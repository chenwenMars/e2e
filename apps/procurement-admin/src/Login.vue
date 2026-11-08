<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
const router = useRouter(),
  username = ref(""),
  password = ref(""),
  error = ref("");
function login() {
  if (username.value !== "admin" || password.value !== "admin") {
    error.value = "账号或密码错误";
    return;
  }
  sessionStorage.setItem("procurement-user", "admin");
  router.replace("/home");
}
</script>
<template>
  <main class="login">
    <form class="login-card" @submit.prevent="login">
      <b class="mark">采</b>
      <h1>登录采购工作台</h1>
      <p>演示账号和密码均为 admin</p>
      <label>
        账号
        <el-input v-model="username" autocomplete="username" />
      </label>
      <label>
        密码
        <el-input
          type="password"
          show-password
          v-model="password"
          autocomplete="current-password"
        />
      </label>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <el-button native-type="submit" type="primary">登录</el-button>
    </form>
  </main>
</template>
