# AI 额度 App

一个本机运行的 macOS 菜单栏用量看板，用来把 Claude Code 与 Codex 的本地使用记录整理成统一的额度和用量视图。

## 功能

- 菜单栏常驻胶囊，显示当前最紧的 5h / 7d 额度使用情况。
- 左键打开弹窗，查看 Claude Code / Codex 的实时限额、重置时间和近 7 天用量。
- 支持胶囊偏好：自动显示最紧额度，或固定查看 Claude Code / Codex。
- 可打开完整窗口，查看工具分页、Token/美元切换、趋势图、价格表和限额卡片。
- 支持开机自启。

## 隐私边界

数据引擎只读取本机日志里的用量、模型、时间与计费相关字段，不读取或展示对话正文。

生成的 `usage.json` 包含真实 token、等价金额与限额百分比，属于个人数据，已在 `.gitignore` 中排除，不应提交到 GitHub。

## 运行数据服务

```bash
node engine/usage-data.mjs --serve 7799
```

启动后访问：

- `http://127.0.0.1:7799/`
- `http://127.0.0.1:7799/api/usage.json`

## 打包 macOS App

```bash
./app/build.sh
```

打包结果：

```text
app/build/用量看板.app
```

`app/build/` 是构建产物，已在 `.gitignore` 中排除。

## 项目结构

```text
engine/  数据采集、归一化与本地服务
web/     用量看板页面
app/     macOS 菜单栏 App 外壳
```
