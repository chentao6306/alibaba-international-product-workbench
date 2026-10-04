# 1.4.57 验证记录

日期：2026-10-04

## 本次修复

- 汽车灯具类目采集到的英文属性会映射到国际站发布页的中文必填字段：`Purpose`、`Car Model`、`Voltage`、`Condition`、`Lumens`、`Color Temperature`。
- OE 代码在发布页没有可选项、只有可输入组合框时，会按自定义值填写，触发输入和变更事件，并回读确认已经提交。
- 已保存的商品继续使用原采集数据重试，不需要删除或重新采集。

## 验证命令

```powershell
npm test
npm run build
node tools/desktop-package-qa.mjs release-installer
node tools/verify-update-package.mjs release-installer
```

结果：`npm test` 通过 525/525；`npm run build` 通过。安装包和更新签名文件由 `npm run dist:win:installer` 生成后，再执行桌面包检查和更新包校验。

本次安装包：`release-installer/chaodekuai-1.4.57-setup.exe`，大小 `267,370,496` 字节，SHA-256：`e40304895e7406713606052d4c72313a2d3001320e273a73d6a61eaf6d1fa86c`。

## 客户操作

安装 1.4.57 后，在上架任务中直接对失败的三件商品点击继续/重试。第一、第三件会重新提交已经采集的 OE 代码；第二件会同时填写已经采集的用途、适用车型、电压、新旧、光通量、色温和 OE 代码。只有原始记录确实为空时，才需要编辑商品补值。
