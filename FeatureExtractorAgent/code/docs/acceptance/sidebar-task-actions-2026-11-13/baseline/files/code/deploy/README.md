# T1 本机 Docker 交付

本部署将现有 Next 工作台、Fastify 和 Docling CPU 子进程装在同一应用容器。Next 的固定 `127.0.0.1:3210` 网关保持生效；仅将网页发布到宿主机 `127.0.0.1:30142`。克隆示例默认模型关闭，上传、原页查看、持久保留取舍/修订和导出可用。首版可配置默认模型已定为 AGICTO `gpt-6-luna`、medium、Responses，依据兼容与低价方向，不代表医学最优。正式医学目录仍未批准，B0 保持既有实现。

这是一个小型单机部署；SQLite 单应用实例写入。不要横向复制写服务，不要将宿主普通工作台和容器指向同一 SQLite/数据目录，不要将 30142 改成公网绑定。普通30141/3210按本轮运行记录有序更新，原用户数据未迁移到验证容器。

## 准备

在 `code/` 运行命令。需要 Linux x86_64、Docker Engine/Compose v2、至少 4 CPU 和 8 GiB 可用内存，构建需要网络和至少约 25 GiB 临时磁盘空间（30 GiB 更充足；依赖和多次构建缓存可额外占用）。镜像锁定 Node 24.22.2、Ubuntu 24.04 基础镜像摘要、npm lock 和 Python CPU lock；这提供可重复的构建步骤，系统 apt 安全更新仍可能随时间变化。

本机原无 Docker。验收使用现有 sudo 安装了发行版 `docker.io`、`docker-compose-v2`、`docker-buildx`，未向 docker 组加用户。当前普通账号运行 Docker 命令需 `sudo`；以下省略该前缀，备份脚本也可整体用 `sudo --preserve-env=...` 执行。发行版 Docker 包与 Docker 官方 CE 仓库安装方式不要混装。相关系统影响及实际版本见 S7 `system-impact.json`。

Docling 模型不烘焙在镜像中。既有 `.tools/pdf-parser/models` 可直接复用；启动前校验：

```sh
python3 deploy/docling-models.py verify .tools/pdf-parser/models
```

冷机器首次获取固定提交/固定 SHA 的约 530 MB 权重：

```sh
python3 deploy/docling-models.py download .tools/pdf-parser/models
```

下载只访问 Hugging Face 固定模型文件，不发送论文，不调用生成模型。中断产生 `.partial` 文件时先检查并仅移除该临时下载再重试；工具不会覆盖已有不同内容。没有网络时应事先复制这两个固定模型目录并通过相同 SHA 检查。未准备好模型时网页可启动，但不能声称 CPU 新解析可用。Docling 运行设置 CPU 4 线程、OCR 关、表结构开、远程服务关、Hugging Face/Transformers 离线；不会在产品运行中补下载权重。

## 构建与启动

```sh
docker compose build
docker compose up -d --wait
docker compose ps
curl --fail http://127.0.0.1:30142/api/t1/workbench/capabilities
```

打开 `http://127.0.0.1:30142/`。远程机器用 SSH 转发访问，例如 `ssh -L 30142:127.0.0.1:30142 user@host`。公开部署、TLS、登录与多租户不包含在本交付。

若本机网络依赖 `127.0.0.1` HTTP 代理，Docker daemon 拉镜像需要单独复用该代理；构建阶段可使用 `docker build --network host --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY -t t1-workbench:local .`。不要将凭证写进 Dockerfile/构建参数。实际环境的无凭证本机代理仅配置给新增 Docker daemon，记录在 `system-impact.json`。构建上下文采用白名单，排除 `.env`、运行库、语料、历史验收材料、缓存及已有 node_modules/.next；两份小型、固定 SHA 的解析选择/模型别名证据随代码保留。

容器以 UID/GID 10001 运行，根文件系统只读、所有 capabilities 移除、无权限提升、PID 上限 512、内存上限 8 GiB、CPU 上限 4。`/tmp` 是 512 MiB 临时文件系统；SQLite、源 PDF、IR、整图、候选版本、审核、事件、导出及 CPU 原生结果均在专用 `t1-workbench-data` 卷的 `/app/runtime-data`。模型只读挂载。监督进程同时管理 Next/Fastify：任一退出就停止另一进程，正常 SIGTERM 最多给 65 秒清理，Compose 给 75 秒后停止。活动任务重启后保留已有成果并转中断；不自动恢复，用户新开任务从头。

查看日志与重启：

```sh
docker compose logs --tail 100 -f app
docker compose restart app
```

Docker JSON 日志每文件 10 MB、最多 3 份。持续业务事件另存 SQLite 并支持 SSE 游标重连。不要将 `docker inspect` 或渲染后的带凭证 Compose 输出贴入公开日志。健康检查同时请求内部 Fastify 和 Next 业务代理，表示服务可达与当前提取能力，不承载阶段验收或模型/医学质量结论。

## 数据与模型配置

可通过 `T1_COMPOSE_PROJECT`、`T1_IMAGE`、`T1_WEB_PORT`、`T1_DATA_VOLUME`、`T1_DOCLING_MODELS` 选择项目、镜像、loopback 端口、独立卷和模型目录。首次卷由镜像目录 UID 10001 初始化。既有宿主历史库依赖的外部 evaluation/docs 文件没有复制进新镜像；默认 `T1_IMPORT_RETAINED=false`，新部署为空库。不要只复制原 SQLite 后声称历史原件已迁移。

Compose 使用独立 `T1_DEPLOY_*` 名称，避免自动读取宿主 `.env` 的旧凭证/开关。按 `deploy/compose.env.example` 在私有配置中填写模型 key，并由服务端明确设置 `T1_DEPLOY_MODEL_ENABLED=true`。可用 `docker compose --env-file /private/path up -d`，不要把该文件提交或构建进镜像。预算为每新运行的 `T1_DEPLOY_MAX_REQUESTS`、`T1_DEPLOY_MAX_INPUT_TOKENS`、`T1_DEPLOY_MAX_OUTPUT_TOKENS`，默认 80/2000000/120000。固定两 FIFO 槽；第三个任务持久排队且可取消，等待时长单列。30 分钟从拿到执行槽开始，包括 PDF 解析、模型与 summary，排队不耗该时长；120 秒/请求、最多 2 次瞬态重试。token 是本地预留/回报预算，不是供应商账单绝对硬截断。浏览器可在既有AGICTO内新增/选择模型档案，provider、密钥、端点及硬限额仍由服务器管理；只有用户点击开始才调用；上传与浏览不调用模型。每新 run 都建新账本，不继承旧实验额度。普通用户仍一次开始，无实验签字流程。

宿主普通服务使用既有私有 `code/.env` 中的 key，公开配置可分放 `deploy/local/workbench.env`，避免覆盖 key 字节：

```sh
mkdir -p deploy/local
if [ ! -e deploy/local/workbench.env ]; then
  cp deploy/host.env.example deploy/local/workbench.env
fi
# 在私有配置中决定是否启用；示例保持 false。先确认旧实例无活动任务。
sh deploy/start-host.sh
```

脚本显式加载两个 env-file；后一个公开配置覆盖旧 provider/model/switch，key 不需重复。普通 `npm run dev:server` 本身不会自动加载 WORKBENCH 开关。不要同时启动第二个宿主写服务；实际服务切换由运维精确关闭旧 PID 后执行。新公开默认配置仍不授权任何旧实验脚本再次付费。

前端通过`GET/POST /api/t1/workbench/models`读取/新增AGICTO模型档案，服务端对应`/api/workbench/models`。新增仅接受`model_id`、`api`（`openai-responses`/`openai-completions`）、`reasoning_effort`（`medium`/`none`）、`context_window`与`max_output_tokens`；不接收密钥、端点或每run预算。档案存入新增`workbench_model_profiles(id,payload_json)`表，仅添加且相同用户配置去重，修改按新档案保存；默认服务器Luna档案保持。Start只传已保存的`model_profile_id`，缺省兼容旧请求；准入保存完整profile快照，队列执行与重试沿用，批量首次开始冻结范围/submission/profile，之后选择不会改动已冻结任务。新增配置不继承Luna的精确别名或已验证能力；新增默认本地上下文/输出为32768/4096 token，未做真实调用验证。原每run80/200万/12万/1800秒及2槽FIFO保持，添加模型不产生模型请求。

## 备份与空卷恢复

备份脚本短暂停止选中 Compose 项目的 app，流式打包整个数据卷，生成文件 SHA manifest，随后自动重启 app；这避免 SQLite/WAL 和源文件同时变化。模型、镜像和凭证不入备份；私下另外保存配置与镜像摘要。备份包含原论文及审核，应存放于私有目录。

```sh
mkdir -p deploy/backups
sh deploy/backup.sh deploy/backups/t1-20261109.tar.gz
sha256sum --check deploy/backups/t1-20261109.tar.gz.sha256
```

恢复总是指向一个新的空卷。工具拒绝被运行中容器挂载的目标、非空目标、路径逃逸、链接/特殊文件及 SHA 不符的归档，不覆盖原卷：

```sh
T1_DATA_VOLUME=t1-workbench-restored-20261109 sh deploy/restore.sh deploy/backups/t1-20261109.tar.gz
T1_DATA_VOLUME=t1-workbench-restored-20261109 docker compose up -d --force-recreate --wait
```

核对论文/独立 run、当前版本/审核和原 PDF 后再决定后续迁移。原 `t1-workbench-data` 卷仍保留，可用相同命令切回。恢复动作不产生新审批或自动恢复模型任务。不要执行 `docker compose down -v` 或全局 prune 来清理本项目。

## 上传至 T2 证据出口

上传保留“选择文件”多选PDF，并支持“选择文件夹”递归筛选用户电脑文件夹与子文件夹中的.pdf（扩展名不区分大小写），显示PDF数和跳过其它文件数；不读取或上传其它文件，不开放服务器目录读取。每批最多20篇、单篇50MiB；超过当前可添加数时整次拒绝并保留原清单，提示总数/上限及分批或选子文件夹，无PDF明确提示。逐文件串行上传，独立成败/失败重试与未提交项移除；上传不调用模型，同名文件不合并，目录相对路径作为默认标题区分。首次开始按有效未移除成员数（含可重试上传失败项）固定单篇/批量类型、同一范围和模型配置；批量剩1项重试仍属批量，专用单篇入口为单篇。类型仅在左侧论文列表显示，并对应当前显式打开的run或历史输出；无显式选择时按有候选优先、再该论文首run的默认打开规则显示。既无run也无输出不标，旧run/历史输出缺submission显示“类型未记录”，不追改历史；每篇独立run并沿用2槽FIFO及原每run预算。工作台标签切换保留本批，关闭/整页重载不恢复未提交草稿，已上传论文与已提交任务仍持久。手动刷新仍保留区域灰罩、唯一居中箭头和全局悬浮提示，不推挤布局或重置选择。范围三层默认不限；未批准医学目录不开放受限范围。用户点击开始使用Docling CPU→既有Pi/B0，进度与候选逐条持久化。普通结果默认保留，可排除/恢复；来源重选和标签修订保留版本，禁止自由改写论文。阅读段只连接有offset/结构依据的原片段，缺口明确分隔。旧真实审核历史独立，保留文字不批准图片；缺源/错SHA阻止新抽取与保留结果导出。

`deploy/t2-evidence-contract.json`说明T2边界。日常保留结果提供JSONL、CSV和图文tar.gz，旧candidate/approved接口兼容。直接导出本次运行当前未排除的内容，称“保留结果”，无需逐条确认或整篇统一确认；排除项不进入保留结果，主目标与背景仍分别保存。 包内保留manifest/coverage、原fragment及页/bbox/版本、独立selection/保留状态、review结构、图注、整图及关系状态。retained中的human_confirmation为null、reviews.json为空，完整旧真实评价仍在独立存储/approved兼容接口，不承诺随保留包附带。T2应先检查这些状态；retained只表示用户未排除，不能直接变成confirmed医学知识或生成约束，保留背景不提升primary。同源组不合并或传播取舍/批准；文字和图片医学确认分开，T2消费实现另属任务。没有未排除条目时提示无保留内容；旧candidate空JSONL/带表头CSV/coverage包保持兼容。

## 独立工程验收

仅验收时叠加 `-f compose.yaml -f deploy/compose.verify.yaml`，并显式设置独立 `T1_COMPOSE_PROJECT`、`T1_DATA_VOLUME`、`T1_WEB_PORT`。该入口使用全新人工 PDF、真实 CPU 解析、已装 Pi/B0 与固定本地 scripted Responses；不读取凭证、不调用外部生成服务。其人工审核只在隔离卷，不能当真实医学批准。恢复普通部署时不要带该覆盖文件。自动验收可在空闲 30142 上运行 `node deploy/verify.mjs`（需 Docker 权限），再次运行须设置全新 `T1_S7_VERIFY_ID`，保留旧卷不覆盖。实际执行结果、信号/重启/备份检查与未验证事项以 S7 `report.json` 为准。

医学目录由服务端可选 `T1_WORKBENCH_CATALOG_FILE` 指向符合 `EvidenceCatalogSchema` 的只读 JSON；容器需另外将该文件只读挂载并设置容器内路径。未配置仍为 unavailable，三层默认不限。文件须经真实授权批准且非 fixture，条目与同义词也须 approved；应用不提供、不自动批准医学目录。格式、审批状态或关联错误会阻止启动，不会退回不限。相同目录版本从工作流传至实际 B0 执行器，旧版本、空选择、无效 ID 保持拒绝；API 不返回配置路径或原始配置文件。更换目录需重启服务并刷新范围。

## 当前交付与实测状态（2026-11-13）

当前普通入口为`http://127.0.0.1:30141/`，后端`http://127.0.0.1:3210`；[本轮文案、左栏类型与AGICTO模型配置记录](../docs/acceptance/ui-model-switch-2026-11-13/report.json)对应同一验证构建。本轮上传文案、左栏类型与AGICTO内模型配置已完成限定工程核验并以同一构建上线30141/3210。18项后端/SDK、11项前端、额外Luna别名隔离、typecheck、生产构建及隔离Chromium7场景通过，线上桌面/手机只读检查通过。原15表内容与四份env字节保持，新增模型档案表仅1条服务器默认配置，共16表；原9run不变，0新run、0提交、0活动任务和0新增付费调用。默认Luna medium、2槽及原每run硬额度保持；新增模型供应商兼容性/容量和医学效果未实测，过小本地上下文可能中止抽取，浏览器仅覆盖Chromium；不升级医学或完整S2/S6/S7结论。 当前共16张业务表，原15张表的历史内容保持，新增模型档案表含1条服务器默认配置；新增模型的供应商能力和医学效果均未经本轮真实调用验证。

前轮目录/类型交付时普通入口为`http://127.0.0.1:30141/`，后端`http://127.0.0.1:3210`；目录递归选PDF与单篇/批量类型标记已按同一验证构建上线，见[本次验收记录](../docs/acceptance/folder-task-types-2026-11-13/report.json)。15项相关自动检查、完整typecheck和独立生产构建通过；隔离Chromium11场景、既有源只读刷新6场景及线上只读6场景通过，最大布局位移和居中偏差均0px。前后端健康；15表行数/逻辑hash与两份env字节保持，integrity ok，9个旧run保持“类型未记录”，前后0活动任务、0用户任务中断、0新增付费调用和0真实数据测试写。该轮未新增表；类型存现有run.payload_json，属于运行元数据。

前轮[批量提交/幂等交付](../docs/acceptance/batch-submission-2026-11-13/report.json)和[单箭头居中刷新记录](../docs/acceptance/batch-submission-2026-11-13/refresh-center.json)保留原时点；居中箭头、默认保留、可恢复排除、三导出及20篇/50MiB、每run预算与2槽继续使用。旧Docker镜像未重建；浏览器实测目前覆盖Chromium，未做20篇真实长期负载或新增真实付费抽取验收，医学和完整S2/S6/S7结论不升级。

本次已验证的宿主前端构建为`apps/pi-web/build/folder-task-types-20261113`，BUILD_ID为`m-Ego_yBjEjvFl6Lq2PJq`。若要复用它重启前端，先确认原前端进程已停止，再从`code/`运行：

```bash
T1_NEXT_DIST_DIR=build/folder-task-types-20261113 bash scripts/with-node.sh npm run start:web
```

常规重新构建仍按`code/README.md`的`build:web`流程执行；这条复用命令不修改私有或公开env。

上轮交付快照镜像为 `t1-workbench:delivery-20261111`，本机ID `sha256:4d2a334b0bf50663503b33a6ddc7d9631bc9a05551a198c0053409ab3a2e9904`。它复用既有依赖与已接受UI产物，叠加冻结源码，非冷构建；[构造、1176源码和161个UI产物核验](../docs/acceptance/resume-2026-11-11/final-stack-image/delivery-image-report.json)记录完整链。该镜像未重建，不含后续宿主日常保留取舍、阅读段、批量/刷新、目录导入/任务类型及本轮AGICTO模型配置变更；如需查看上轮快照，可用既有本机镜像运行独立部署：

```sh
T1_IMAGE=t1-workbench:delivery-20261111 docker compose up -d --wait
```

克隆配置仍默认关闭模型，按上文独立配置选择是否启用；不要覆盖现有配置或迁移30141数据到验证卷。镜像内README是构造时快照，当前workspace说明在真实测试后更新，不修改冻结pins；说明文件更新后不能声称整树仍与执行镜像逐字节相同。

最后付费执行镜像为 `t1-workbench:s7-final-sdk-diagnostic-20261111`（`sha256:32a0e53ab6be8bed82c579b8be589cbb25787f076d5133f74163999724d76977`）。IN04早期流程完成389授权文本块、同次summary与8条待核交付，仍有14字形块缺口；最终栈IN06/IN07分别1/2请求后SDK失败、均0候选，S7完整真实门槛仍未通过。两源多段图注修复及本地0API完整闭环通过不替代真实成功；IN07首检独立结构失败保留，修后仅作回归，完整S6与医学目录S2亦未通过。

精确SDK提示 `Service load is too high, please try again later` 已纳入既有最多2次有限重试：仅在响应尚无输出时重发同一payload，已执行工具不重放，取消、时间、预算与身份守卫仍生效。30项相关测试（含9项新边界）及4项旧回归通过；[最后补丁冻结记录](../docs/acceptance/resume-2026-11-11/delivery-source-freeze.json)明确只有离线SDK实证，无新增付费验证，不保证上游恢复，也不独立认证厂商真实负载。

普通策略接纳 `gpt-6-luna`→`data-zone-standard-gpt-6-luna` 精确返回对，依据用户/委托部署选择，非厂商确认或权重验证；旧gpt/igpt厂商确认独立留证，其它未知名仍停止。[完整最终记录](../docs/acceptance/resume-2026-11-11/report.json)分列三轮实际调用、原失败、修复与未完门槛：全窗24物理请求，已报告288117输入/10185输出，2次缺usage按395982输入/26569输出保守计量；48未用请求及其余额度全部关闭，货币费用未知。普通开启不等于医学、独立或完整真实阶段验收通过。

源 PDF 的字形疑点会被隔离，不能作为已处理内容或交付引文；coverage 明示缺口。旧 IR 未做字形检查时仍可浏览，保留结果和旧approved出口保持保守来源守卫。新目录配置不替代真实医学批准。终态保存阶段会显示 reconciling，`result_ready=true` 后才给最终完成信息和导出，避免把较早的空 coverage 缓存在终态下。

## 历史验证（2026-11-09）

11月9日容器、备份恢复和受控流程已有实证，真实IN04先因summary契约失败，唯一修后回归再因当时未接纳的新返回名停止；当时没有扩大别名或续费。该轮81请求及所有未用额度已关闭，原失败与下载保留在[原S7记录](../docs/acceptance/finalization-2026-11-09/s7/report.json)。这段只记录原时点，当前模型政策与部署结果以上文和11月11日最终记录为准。
