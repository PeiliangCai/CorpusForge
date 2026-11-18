# CorpusForge

CorpusForge 是面向医学影像任务的毕业设计项目。第一个模块 T1 从医学论文中提取影像特征及其原文依据，为后续训练数据制备提供素材。

## 项目导航

| 路径 | 内容 |
| --- | --- |
| [方案/](方案/) | 毕设总体实施方案、任务分解、模块职责与验收清单。各阶段的开发计划分别放在本目录的子文件夹中。 |
| [方案/子任务T1/](方案/子任务T1/) | 第一阶段的 T1 智能体开发计划与执行说明。 |
| [FeatureExtractorAgent/code/](FeatureExtractorAgent/code/README.md) | T1 特征抽取工作台的实现、配置、启动脚本与测试。安装与运行从这里开始。 |
| [FeatureExtractorAgent/research/](FeatureExtractorAgent/research/) | T1 模块的调研资料。 |
| [doc/](doc/) | 后续数据增广模块的算法参考论文，目前收录一篇关于流形启发式优化的图像分类数据增广论文。 |

## 恢复本项目的 Codex 对话

仓库保存了截至 2026-11-15 的 **5 份脱敏会话快照**。先安装 Python 3 和 Codex CLI，退出 Codex 并停止使用相关 Codex home 的后台服务，再在新服务器的普通 shell 中执行：

```bash
git clone https://github.com/PeiliangCai/CorpusForge.git
cd CorpusForge

python3 FeatureExtractorAgent/code/scripts/codex-history.py restore --merge --project-root "$PWD" &&
unset CODEX_HOME &&
codex resume --all -C "$PWD"
```

导入命令直接合并到默认 `$HOME/.codex`，不建立第二套 Codex home；`$PWD` 自动取当前项目目录。已有登录、配置、数据库、无关会话和本机名称保留；默认 home 尚未登录时才执行 `codex login`。随后在选择器中打开会话即可查看历史并继续对话。

若以前在 `~/.bashrc`、`~/.profile` 或 `~/.zshrc` 写过指向日期目录的 `export CODEX_HOME=...`，请移除对应旧设置，避免新终端再次切回旧目录；导入脚本不会修改这些启动文件。

**如果已经在 `.codex-t1-agent-20261115` 或 `.codex-t1-agent-20261117` 中续聊，先 `git pull`，改按[已有独立目录的迁移说明](FeatureExtractorAgent/code/codex-history/README.md#已有独立目录的迁移)运行 `merge-home --source-home`。** 它复制你选定旧目录里的实际会话与名称，保留 11 月 15 日后的续聊；请先选真正包含最新续聊的源目录。同 ID 内容不同时会提前停止并报冲突，保留两边。

快照的保留范围、恢复限制与详细说明见 [Codex 对话说明](FeatureExtractorAgent/code/codex-history/README.md)。
