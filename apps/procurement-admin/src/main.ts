import { createApp } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import ElementPlus, { ElMessage } from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import "element-plus/dist/index.css";
import "./style.css";
import App from "./App.vue";
import Login from "./Login.vue";
import Desk from "./Desk.vue";
import Form from "./Form.vue";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/home" },
    { path: "/login", component: Login },
    ...["home", "requests", "suppliers"].map((name) => ({
      path: "/" + name,
      name,
      component: Desk,
    })),
    { path: "/requests/new", component: Form },
    { path: "/requests/:id", component: Form, props: true },
  ],
});
router.beforeEach((to) => {
  if (to.path !== "/login" && !sessionStorage.getItem("procurement-user"))
    return "/login";
});
const app = createApp(App);
app.config.errorHandler = (error) => {
  console.error(error);
  ElMessage.error(error instanceof Error ? error.message : String(error));
};
app.use(router).use(ElementPlus, { locale: zhCn }).mount("#app");
