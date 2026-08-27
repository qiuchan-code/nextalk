import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  // 用相对路径打包，这样部署到 GitHub Pages 的子目录（用户名.github.io/仓库名/）
  // 不用改任何配置就能正常加载资源
  base: './',
  server: {
    // 允许手机在同一 WiFi 下通过电脑 IP 访问
    host: true
  }
})
