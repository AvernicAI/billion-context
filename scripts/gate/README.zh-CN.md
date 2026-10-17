# Plugin Lanes(Lane P)— 真实宿主 CLI × 真实模型(中文版,英文版见 [README.md](./README.md))

这些车道用**真实的宿主 CLI**(dsh / pi / codex / claude-code / opencode)+ **真实模型**
驱动 billion-context 的两条激活路径,把 #3416 的盲区补上:老 gate 只测代理模式,
#3401 那类「插件会话里工具明明在、提示却被关」的回归在 gate 里全程绿灯。

## 两条激活路径

| 路径 | 宿主 | 机制 |
|------|------|------|
| native | dsh, pi, opencode(v1/v2) | 薄插件/原生扩展拦截宿主 fetch,盖 `x-bili-plugin` 头,**自起代理(port 0)**——外部绝不手动起代理 |
| prefix | codex, claude | 宿主配置指向 bili 代理的 `/bili/` URL 前缀(代理模式),代理由本脚本手动起 |

## 断言什么(wire 是真相源)

`upstream-recorder.mjs` 垫在 bili 和真模型之间,JSONL 记录每个请求体/响应;
所有断言直接从模型实际收到的东西上做——内部日志可以被抑制类 bug 骗过(#3401),
wire 骗不了:

- 上游有流量(请求真的到了模型)
- ACP 工具(compress/acp_status/…)真的出现在 wire 的 tools 里
- 插件 claim:会话文件 `payload.metadata.pluginAgent == "<agent>"`
- **nudge 硬断言**:wire 上必须出现 nudge 文本(不接受「日志里有 INJECT」——
  注入可能落在永不转发的 in-band 错误响应里,那是假绿)
- fold 触发(`acp-compress-obs] shrink N%`)
- 折叠前后暗号回忆(corpus 40 段,S07 早段/S40 末段 CODEWORDS 暗号)
- 无 `unknown tool` 空转

## 车道流程

1. **t1 @ 大窗**:读 corpus,回显 S40 暗号(此阶段 fold 必须不触发)
2. **窗口收缩**:改**宿主自己的**模型配置(dsh cordis / pi models.json /
   opencode.json limit / codex config.toml / claude 模型别名)——有效窗口经
   `x-bili-plugin-context-window` 头进 bili,native 代理的 zone 端口是粘滞的,
   每请求重读,不用杀代理
3. **t2 @ 中窗**:S07 回忆(intact)+ nudge wire 硬断言;中窗从 t1/t2 实际
   usage 自校准,目标 75-95% 压力带
4. **t3 @ 小窗**:"DONE"——preflight fold 必须开火
5. **t4**:S07 折后回忆

## 怎么跑

前置:node ≥ 20、各宿主 CLI 装好(dsh / pi / codex / claude / opencode)、
一个 OpenAI 兼容真模型端点、候选拿 `npm pack` 打出 tarball。

```sh
TGZ=/path/to/billion-context-x.y.z.tgz \
REPO=/path/to/billion-context-checkout \
MODEL1_BASE_URL=http://127.0.0.1:8199 \
MODEL1_MODEL=<model-id> \
GATE_AGENTS=dsh,pi,codex,opencode,claude \
node scripts/gate/plugin-lanes.mjs
```

- `GATE_AGENTS` 选车道子集;`GATE_TURN_TIMEOUT_MS`(默认 300000)、
  `GATE_BIG/MID/SMALL_WINDOW`、`PLUGIN_LANES_WORK`(工件目录,默认
  `./plugin-lanes/`)可调
- 每车道工件:`<work>/<agent>/turn-t{1..4}.txt`、`upstream.jsonl`、`bili.log`
- opencode2 车道不进默认集:transport websocket 直通 Responses-WS(HTTP-only
  上游握手必死)、transport http 依赖上游 /v1/responses 质量——见 #3461;
  车道仍断言 tools/claim/流量
- **红绿对照**(#3416 验收):master 构建(含 #3401 病)在本车道报
  nudge wire MISSING / log:ARMED-SUPPRESSED;含 #3403 的构建全绿

## 与仓库外 harness 的关系

车道脚本随仓库走(和被测代码同版本);容器化包装(Dockerfile、 verdaccio、
自建镜像、模型端点)在各自的 gate harness 仓库/机器上,不进本仓库。
远程 CI 默认不跑:`.github/workflows/ci-gate-plugins.yml` 仅 workflow_dispatch
手动触发,没有 push/PR 触发器。
