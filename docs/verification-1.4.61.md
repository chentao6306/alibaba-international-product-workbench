# 1.4.61 窗口和安装图标

日期：2026-10-06。保留 1.4.60 的中国制造网采集、类目匹配、图片缓存和跨来源引用功能。

## 修改

- 登录、主界面、国际站登录、卖家后台及验证码窗口统一从 `window-branding.js` 创建，创建时即传入当前 `public/brand.png`。
- 验证码独立运行也初始化窗口品牌，不再依赖调用方传入图标。网页通过 `window.open()` 创建的子窗口由全局窗口事件补齐图标。
- 源码运行读取 `public/`，加密构建预览读取 `dist/`，正式客户端读取 ASAR 内的 `dist/`；不依赖启动目录。缺失资源不静默回退 Electron 图标。
- Windows AppUserModelID 与安装快捷方式的 `com.kua-yipu.workbench` 一致；任务栏图标使用随安装包分发的 `resources/brand.ico`。
- 退出、安装更新确认框指定品牌图标；安装、卸载和安装头部图标显式指定 `assets/brand.ico`。验证码窗口标题保留“抄得快”。

## 验证

```powershell
npm test -- --test-concurrency=1 test/human-verification.test.js test/human-verification-jobs.test.js test/alibaba-login.test.js test/source-navigation.test.js test/software-updates.test.js
npx --no-install electron tools/verification-window-qa.mjs
npm run dist:win:installer
npx --no-install electron tools/verification-window-qa.mjs .packaged/electron/human-verification.js
node tools/desktop-package-qa.mjs release-installer
node tools/verify-update-package.mjs release-installer
```

- 本次定向回归 41/41 通过。
- 源码和加密版本验证码流程各通过 13 次页面加载检查；涵盖延迟验证码、刷新、暂停、会话保存及网页子窗口。
- Windows 检查工具读取目标测试进程窗口的实际大小 HICON，转成像素与当前品牌图比较，不以配置文件中的图标路径作为验证结果。测试使用隔离用户目录和模拟页面，不向国际站提交商品。
- 正式 EXE 的登录窗口大小图标、主程序 EXE、外层安装包与内层 NSIS 安装包图标均通过像素检查；包内 `resources/brand.ico` 与源图标逐字节一致。卸载程序显式使用相同 ICO，本次未在用户电脑执行安装或卸载。
- 包完整性检查通过：81 个源文件对应构建输出一致、75 个业务模块加密、更新签名与安装包 SHA-256 一致。安装包大小 269,281,792 字节，SHA-256：`1e8fac743a0f4e462cc632ac774873cd5a4a23053923c6a642ae15ced0a6b398`。
- 全量业务测试与中国制造网真实页面验证范围见 [1.4.60 记录](verification-1.4.60.md)；本次未重复运行全量业务测试。
