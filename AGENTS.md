# 项目 Agent 入口规则

## Atmo Agent Team

如果项目存在 `.agent-team/协作协议说明.md`，开始任何任务前必须先读取它，并按其中规则维护状态、任务、消息、文件变更、Review 和问题追责记录。

聊天只作通知，`.agent-team/` 文件才是正式事实来源。

## 本项目默认规则

- 中文为主，必要的代码术语、路径、命令、Codex、thread_id、worktree、Review、JSONL、ID 可保留英文。
- 多 Agent 协作时，先落盘再跨会话发送消息。
- 修改文件后，按 `.agent-team/文件变更记录.md` 登记变更；重要任务同步更新 `.agent-team/溯源索引.md`。
- Review Agent 默认只读实现文件，只写 Review 结论，除非用户明确授权。
