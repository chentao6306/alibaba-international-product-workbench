# 发行包源码保护

从 1.4.59 开始，正式 Windows 安装包增加加密封装。开发源码、Git 仓库和本地开发启动方式保持可维护；只在 `beforePack` 中转换发行内容。

## 实际保护范围

- `server/` 和 Electron 主进程/后台工作线程的 业务模块使用 AES-256-GCM。每次构建生成新的随机密钥和构建 ID，每个模块有独立随机 nonce；认证附加数据绑定构建 ID 与模块路径，不能用另一模块的密文替换。
- 发行目录中的对应 `.js` 仅为启动占位文件，业务源码在 `.js.bin` 密文中。解密后的源码只交给 Node 模块加载器，不生成明文临时文件或磁盘缓存。
- 加载程序及密钥材料编译进 `protected-loader.jsc`，不附送加载程序的源码或明文密钥配置。编译使用项目锁定的 Electron 主进程；主窗口和工作线程均验证加载。
- 登录界面、验证界面、预加载桥接和 Vite 界面脚本进行标识符与字符串混淆。不关闭 Electron 沙箱，不授予界面额外的 Node 或文件权限。
- 保留 ASAR 完整性校验、仅加载 ASAR、禁用 RunAsNode/Node 环境选项/Node 调试参数、Cookie 加密，以及原来的系统凭据加密。发行包不包含业务 source map、开发数据或授权服务器私钥。

采用内存解密而不直接编译全部采集代码，是因为 Playwright 需要把回调函数序列化后发送到浏览器执行。业务模块保留函数文本与本地变量，避免字节码移除函数源码后破坏采集和上架。[Bytenode 官方限制说明](https://github.com/bytenode/bytenode) 和 [Node 模块加载钩子](https://nodejs.org/download/release/v22.18.0/docs/api/module.html) 可供维护时参考。

## 明确的限制

这是发行文件的静态保护，不是无法破解的承诺。解密能力存在于客户端；有能力分析字节码、拦截加载器、调试进程或读取内存的攻击者仍可能恢复运行代码。界面脚本必须在浏览器中运行，混淆也不能提供绝对保密性。第三方开源依赖和更新协议仍按正常文件分发。

许可证仍由服务器校验，客户端加密不替代服务器授权。真正不能公开的商业逻辑应逐步放到服务端。没有把更新签名私钥放进客户端，也没有给旧客户强行修改或撤销授权。旧的 1.4.58 安装包不具备本次保护，客户需要安装 1.4.59 或更新版本。

## 构建和检查

构建和运行测试使用 Node.js 22.18 或更新的 22 LTS 版本；加载钩子依赖较新的 Node 模块 API。

```powershell
npm ci
npm run dist:win:installer
node tools/desktop-package-qa.mjs release-installer
node tools/protected-package-qa.mjs release-installer/win-unpacked
node --test test/protected-modules.test.js
npm test -- --test-concurrency=2
```

输出为 `release-installer/chaodekuai-1.4.92-setup.exe` 和同名 `.exe.update.json`。后台上传两个文件、填写更新说明后正式发布，官网和软件内更新才会切换。不要把 `.packaged`、安装包或运行密钥材料提交 Git；锁文件必须同步。

更新 Electron、V8、Bytenode 或构建平台后必须重新编译整个发行包并运行上述检查，不能拼接不同构建的 `.bin` 与 `.jsc`。源码测试之外，`protected-package-qa.mjs` 会直接导入实际 ASAR 中的加密模块，在 Electron 主进程和工作线程中检查加载，并用本地浏览器夹具验证采集、跨品类属性、OE 多值、SKU、物流和登录。该测试不向真实商家账号提交商品。

