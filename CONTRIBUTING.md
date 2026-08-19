# Contributing to dsh-compaction-tool

感谢你的兴趣！本插件是 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) 的社区插件。

## 开发环境

- Node.js ≥ 22.13（需要原生 TypeScript 类型剥离）
- npm 或 pnpm

## 构建

```bash
npm run build   # src/compaction-tool.ts → lib/index.mjs
```

构建使用 Node 内置的 `stripTypeScriptTypes`，无需外部转译器。

## 本地测试

```bash
# 在 profile 目录安装本地版本
cd ~/.dsh/profiles/<your-profile>
npm install file:<path-to>/dsh-compaction-tool
# 重启 DSH，新开一个会话测试
```

## 发布

```bash
npm run build
npm pack   # 生成 .tgz
# 或
npm publish --access public
```

## 代码风格

- TypeScript（`src/compaction-tool.ts`），编译为 ESM
- 浏览器端（`lib/client.js`）使用纯 JS + `React.createElement`，不用 JSX
- 遵循 DSH 插件四命名导出约定：`name`、`inject`、`Config`、`apply`

## 提交规范

- 小步提交，每个 commit 解决一个问题
- 提交信息用英文，简洁描述 what + why
- PR 描述里说明改了什么、为什么改、怎么测的

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
