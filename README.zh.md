# dsh-health-readout

**声明「去哪取数、什么算健康、坏了算哪一档」—— 得到一个总判定。**

一个只读的 [dsh](https://github.com/deepseek-harness) 插件。它把**已经存在**的读数（文件、
JSON 端点、日志尾部）合成一个总判定，并逐条给出细节。**它不写任何东西、不存状态、不成为新的真源。**

```jsonc
{
  "readings": [{
    "id": "queue-depth",
    "title": "队列深度在阈值以下",
    "source":  { "kind": "json-field", "path": "status.json", "field": "queueDepth" },
    "healthy": { "op": "lt", "value": 8, "bad": "degraded" },
    "blind":   "只是单点采样：一个「排空又涨回」的队列与一个一直很闲的队列，在这里看起来一样。"
  }]
}
```

## 三条规矩（写进 API，不是写在文档里）

每一条都来自一次真事故。在这里它们由**数据形状**和**测试**保证，而不是靠自觉：

1. **「量不到」绝不是 0。** 读不到的源一律是 `unknown` —— 不是 `ok`、不是 `0`、不是 `false`。
   `unknown` 永远会被印出来，而且**它自己就能把总判定顶上去**。
2. **每条判据都必须能开火。** `selftest: true` 会给每条判据喂一个它自己的反例，并报出
   任何「怎么都不红」的判据 —— 没人能证伪的判据是装饰品，而装饰品会被点名。
3. **每条读数必须写出它的盲区。** `blind` 是**必填**。没写盲区的读数，读起来就像没有盲区。

## 安装

```
dsh plugin --profile <name> add dsh-health-readout      # npm
dsh plugin --profile <name> add ./dsh-health-readout-0.1.0.tgz
dsh plugin --profile <name> add <git-url>               # 预构建：无构建步骤、无 postinstall
```

包里就是真正在跑的那些文件（不构建、无 `prepare`、零运行时依赖），所以从 git 安装**不需要**
用户给构建授权。

## 配置

优先级：插件行的 `config:` → 环境变量 → 内置默认。

| 设置 | config 键 | 环境变量 | 默认 |
|---|---|---|---|
| 读数放哪 | `dataDir` | `DSH_HEALTH_READOUT_DATA_DIR` | `~/.dsh-health-readout` |
| 声明文件 | `specFile` | `DSH_HEALTH_READOUT_SPEC` | `readings.json`（在 `dataDir` 内） |
| 只算哪些 | `only` | `DSH_HEALTH_READOUT_ONLY` | 全部 |

> **数据目录刻意不放在 dsh 平台目录里。** dsh 在版本更新时可能重建自己的目录；用户的读数
> 不该待在一个能被重建掉的地方。把 `dataDir` 指到你自己控制的位置。

spec 里的相对路径相对 `dataDir` 解析；`~` 与 `${dataDir}` 会被展开。

## spec

把 `examples/readings.example.json` 拷成 `<dataDir>/readings.json` 再改。

**取数方式（source kind）**

| kind | 读什么 | 必填字段 |
|---|---|---|
| `file-age-seconds` | 文件最后写入距今多少秒 | `path` |
| `file-size` | 字节数 | `path` |
| `file-exists` | 路径在不在（`false` 是「知道」，不是「不知道」） | `path` |
| `json-field` | JSON 文件里某个点号路径 | `path`、`field` |
| `jsonl-last-field` | JSONL 最后一条**可解析**行里的点号路径（只读尾部） | `path`、`field`、`maxBytes?` |
| `text-count` | 文件尾部 `maxBytes` 内的正则命中数 | `path`、`pattern`、`maxBytes?`、`flags?` |
| `dir-count` | 目录里的文件数，可按后缀过滤 | `path`、`suffix?` |
| `http-json-field` | JSON 端点里的点号路径（**必定带超时**） | `url`、`field`、`timeoutMs?` |

**算子**（`healthy.op`）：`lt` `lte` `gt` `gte` `eq` `neq` `between` `matches` `exists` `absent`。

**档位**（`healthy.bad`，默认 `degraded`），按严重度排序，**最差的那条决定总判定**：

`ok` < `notice` < `unknown` < `degraded` < `broken`

`unknown` 故意排在 `notice` 之上：一个看不全世界的读数，不该报出一个自信的 `ok`。

## 工具

`health_readout` —— 只读一次调用，两个可选参数：`only`（逗号分隔的 id）、`selftest`（顺带证明每条判据都能红）。

渲染出来的正文逐条列出：值、档位、原因、**盲区**；读不到的那些单独再报一遍
（`"Could not read" is not "fine".`）。

## 测试

```
node --test test/criteria.test.mjs test/sources.test.mjs test/spec.test.mjs test/readout.test.mjs
```

套件会自己打印条数 —— 写这一行时是 **46**；两者不一致时，过时的是这一行。不用测试框架、不依赖
盘上夹具。值得知道的臂：**删掉被观测的文件，总判定必须变 `unknown`**（不许留在 `ok`）；一条故意
不可伪造的判据（`matches: ".*"`）**必须被 `selftest` 点出来**；以及**默认数据目录**与**随包发布的
`cordis.patch.yml` 里那一个**，都必须待在 `~/.dsh` 之外 —— 各自被指进去时都会红（是这么验的，
不是这么声明的）。

## 限制（写出来，不藏起来）

- **没有跨行折叠。** 一条读数就是「一个地方的、一个值」。想读「还有几条没结」需要把多行 JSONL
  折成一个状态 —— 那是**查询**，不是读数。把 spec 指向**一份已经算好这个数**的派生文件，把折叠留在
  生产它的那个东西里：本插件做的是合成读数，不变成查询引擎。
- **没有历史。** 每条读数都是当下的一次采样；趋势需要记录器，而记录器就是写方 —— 不在只读件的范围内。
- **没有 `changed-within` 算子。** 跟上一次比需要状态；同上。
- **`unknown` 按设计是吵的。** 文件不在就会顶判定。这是刻意的取舍：对盲区沉默，比对一个盲区大声更贵。
- **spec 能读 dsh 进程能读的任何文件。** 信任模型就是这样：spec 是用户自己写的，路径是用户自己的。
- **只有宿主半。** 没有浏览器面、没有设置界面；判定以工具结果的形式到达模型。

## 许可

MIT。
