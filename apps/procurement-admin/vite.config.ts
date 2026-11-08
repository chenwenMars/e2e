import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { sharedStorage } from "./server/plugin.ts";
export default defineConfig({
  plugins: [vue(), sharedStorage()],
  server: { host: "127.0.0.1", port: 4290, strictPort: true, watch: {ignored:["**/.data/**"]}, fs: {deny:["**/.data/**", "**/*.sqlite*"]} },
});
