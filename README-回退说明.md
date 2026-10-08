# AstriaX v0.2.1 源码副本

**用途**：在独立的 0.2.0 源码快照基础上修复问题；原快照保持不变。

## 为什么有它

0.2 周期累计 **275 个文件未提交**（`git status` 可见），也就是说
0.2 的绝大部分改动**不在任何 git 提交里**。给 0.2 打 tag 只能记下
一个提交点，靠它回退会丢掉整个 0.2 的工作。

所以这份快照是**独立于 git 的**：即使之后 git 被 reset / checkout /
误删，这个目录仍然完好。

## 怎么回退

```powershell
# 1. 先把当前（0.3 开发中）的工作区整个挪走，别混在一起
Move-Item E:\MX\launcher-acb E:\MX\launcher-acb-inprogress

# 2. 把快照复制回项目位置
Copy-Item -Recurse "E:\MX\AstriaX-source-v0.2.0\*" "E:\MX\launcher-acb\"

# 3. 装依赖（快照里没有 node_modules）
cd E:\MX\launcher-acb
pnpm install
```

## 核对有没有恢复对

快照里有 `MANIFEST.json`，列出**每个文件的 sha256**。
恢复后可以逐个核对：

```powershell
cd E:\MX\launcher-acb
node -e "const m=require('./MANIFEST.json');console.log('应有',m.fileCount,'个文件')"
```

（本快照不含 `MANIFEST.json` 自身。）

## 快照里没有什么（以及为什么）

| 排除项 | 原因 |
|---|---|
| `node_modules/` | 可用 `pnpm install` 重建，且体积大 |
| `out/` `dist/` | 构建产物，`npm run build` 就有 |
| `data/` | **用户数据**——绝不该混进源码备份 |
| `data-test/` | 测试残留（临时目录），可再生 |
| `release-staging/` `_archive/` | 历史构建产物，几百 MB |
| `*.log` | 运行日志 |

## 版本信息

- 源码基线：0.2.0；本目录应用版本：0.2.1
- git HEAD（仅供参考，快照本身不依赖它）：d727357a534cdcf78b9c1ccd329d101a21f1c2e1
- 备份时间：2026-09-30T12:50:57.656Z
- 文件数：基线快照 369；本目录新增开发文档并包含 0.2.1 修改，原 MANIFEST 仅用于识别基线文件，不再代表修改后文件的校验值
