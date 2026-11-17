# T1 智能体

面向医学读片任务的智能体项目，用于从医学资料中提取图像特征、建立任务与约束，并支持后续训练数据制备。

应用代码、依赖、运行脚本和测试位于 [code/](code/README.md)，开发方案位于 [方案/](方案/)，调研资料位于 [research/](research/)。应用安装与运行见 [code/README.md](code/README.md)。

## 恢复本项目的 Codex 对话

仓库保存了截至 2026-11-15 的 **5 份脱敏会话快照**，名称与本机 Codex 中对应会话一致。先安装 Python 3 和 Codex CLI，再在新服务器的普通 shell 中执行；以下命令适用于尚未使用过的隔离目录：

```bash
git clone https://github.com/PeiliangCai/t1-agent.git
cd t1-agent

python3 code/scripts/codex-history.py restore \
  --codex-home "$HOME/.codex-t1-agent-20261115" \
  --project-root "$PWD"

export CODEX_HOME="$HOME/.codex-t1-agent-20261115"
codex login
codex resume --all -C "$PWD"
```

`$PWD` 会自动取当前项目目录，无需手动替换。请先恢复，再设置 `CODEX_HOME`；新服务器需自行登录。启动后选择会话即可查看历史并继续对话。

如果已导入旧版 6 份会话，请先 `git pull`，按[已有导入的更新说明](code/codex-history/README.md#已导入旧版会话)改用新的隔离目录；旧目录中的续聊内容会保留。

快照的保留范围、恢复限制与详细说明见 [Codex 对话说明](code/codex-history/README.md)。
