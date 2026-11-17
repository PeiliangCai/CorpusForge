# T1 智能体

面向医学读片任务的智能体项目，用于从医学资料中提取图像特征、建立任务与约束，并支持后续训练数据制备。

应用代码、依赖、运行脚本和测试位于 [code/](code/README.md)，开发方案位于 [方案/](方案/)，调研资料位于 [research/](research/)。应用安装与运行见 [code/README.md](code/README.md)。

## 恢复本项目的 Codex 对话

仓库保存了截至 2026-11-15 的 **5 份脱敏会话快照**。先安装 Python 3 和 Codex CLI，退出 Codex 并停止使用相关 Codex home 的后台服务，再在新服务器的普通 shell 中执行：

```bash
git clone https://github.com/PeiliangCai/t1-agent.git
cd t1-agent

python3 code/scripts/codex-history.py restore --merge --project-root "$PWD" &&
unset CODEX_HOME &&
codex resume --all -C "$PWD"
```

导入命令直接合并到默认 `$HOME/.codex`，不建立第二套 Codex home；`$PWD` 自动取当前项目目录。已有登录、配置、数据库、无关会话和本机名称保留；默认 home 尚未登录时才执行 `codex login`。随后在选择器中打开会话即可查看历史并继续对话。

若以前在 `~/.bashrc`、`~/.profile` 或 `~/.zshrc` 写过指向日期目录的 `export CODEX_HOME=...`，请移除对应旧设置，避免新终端再次切回旧目录；导入脚本不会修改这些启动文件。

**如果已经在 `.codex-t1-agent-20261115` 或 `.codex-t1-agent-20261117` 中续聊，先 `git pull`，改按[已有独立目录的迁移说明](code/codex-history/README.md#已有独立目录的迁移)运行 `merge-home --source-home`。** 它复制你选定旧目录里的实际会话与名称，保留 11 月 15 日后的续聊；请先选真正包含最新续聊的源目录。同 ID 内容不同时会提前停止并报冲突，保留两边。

快照的保留范围、恢复限制与详细说明见 [Codex 对话说明](code/codex-history/README.md)。
