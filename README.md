<div align="center">

# TRSS-Yunzai QQBot Plugin

TRSS-Yunzai QQBot 插件

</div>

# 说明

本文件是面向公开展示和部署的说明文档。历史原版说明已保存在 [READ.md](READ.md)，内容保持原样，仅供功能变更对照。

请遵守 QQ 开放平台规则、适用法律及所在群的管理规则；不得将本插件用于骚扰、营销滥发、规避平台限制或收集与功能无关的用户信息。


---

**功能优化**

- 修复重连成功误判、白名单拒连反复重试
- 适配 ref_idx 撤回与 callfl，避免撤回失败
- 好友删除后自动标记为不可召回，避免无效发送
- invite 拉入/踢出同群去重，排行支持分页查看
- 召回配置支持时间偏移、存储切换、发送延迟和每批数量
- 成员昵称缓存：群消息兜底获取昵称，无缓存时显示 openid

**新增功能**

| 功能 | 说明 |
|------|------|
| 虚拟 at_id | 纯数字 ID，去掉 self_id 前缀与手机号形态 |
| 全量忽略@全体 | 可关闭“仅回复@机器人”，忽略 @全体 的指令 |
| 群事件开关 | `#QQBot普通设置 群事件 开启/关闭`，默认关闭 |
| 进群欢迎 | 开启群事件后，任意群被动回复欢迎消息 |
| 退群通知 | 开启后仅全量已记录群主动发送退群通知 |
| 全量拉黑 | `#QQBot全量拉黑 群openid` / `#QQBot全量删黑 群openid` |
| 全量拉黑菜单 | `#QQBot全量拉黑菜单`，查看已拉黑列表 |
| 拉黑联动 | 全量查看列表标注「已拉黑/正常」，拉黑群仅 @机器人 触发 |
| 群消息角色图标 | 群主👑 管理⭐ 成员👥，机器人额外🤖 |
| 发言记录 | `this.e.raw.chat` 按用户区分群/私聊，含今日/昨日/7天/30天 |
| DAU 好友统计 | 新增好友数、删除好友数，兼容旧数据缺字段按 0 显示 |
| 高级群欢迎 | 入群事件欢迎通知、单群额度、投诉关闭、详情查看，详见 `advanced_welcome.md` |


### 存储

- 新增独立用户管理存储，路径为 `QQBot-Plugin/db/userManage`，不混用全量消息、高级欢迎等已有数据。
- 按机器人 `self_id` 分离配置与数据，多个 Bot 之间互不影响。
- 记录用户、群、群成员关系、拉黑、注销、最近发言、绑定全量缓存、全量事件检测状态。
- 频道数据不参与用户管理拉黑、查询和群/好友缓存污染写入。

### 数据与隐私

- 数据仅用于机器人管理、消息功能和故障排查，存储在本地插件数据目录，管理员应自行控制服务器与备份的访问权限。
- 用户 openid、群 openid、成员关系和发言记录属于业务数据；请仅在获得群管理者授权且确有功能需要时启用相关功能。
- 建议按实际需要配置或定期清理发言缓存、绑定记录和管理记录，不要将导出的数据、原始事件或日志公开传播。
- 机器人管理员应向群成员说明启用的记录、欢迎或管理功能，并提供可用的关闭、投诉或删除入口。

### 菜单入口

```text
#QQBot用户管理菜单
#QQBot用户管理菜单 注销菜单
#QQBot用户管理菜单 拉黑菜单
#QQBot用户管理菜单 查询菜单
#QQBot用户管理菜单 使用范围
```

- `#QQBot帮助` 中原“全量拉黑”入口已替换为“用户管理”。
- 菜单按钮遵守每排最多 2 个、最多 5 排、按钮文字不超过 6 字。
- 主菜单展示 UA 状态、UA 内容、时间偏移和用户自由开启全量命令提示。

### 注销

```text
#机器人用户注销 self_id openid
#机器人用户注销确认 确认码
#机器人用户注销撤回 self_id
#QQBot注销管理 查看 1
#QQBot注销管理 撤回 openid
#QQBot注销管理 设置注销时间 7天
#QQBot注销管理 设置注销拉黑时间 3650天
#QQBot注销管理 管理注销 openid 理由
```

- 注销为文案效果，不真实删除数据。
- 普通注销需确认码，确认码 1 分钟有效；机器人主人不能注销自己。
- 注销中和注销拉黑期会拦截外部插件命令，并提示撤回或剩余不可用天数。
- 管理注销会立即进入不可用状态，可附带理由；仅开发者可以撤回。
- `this.e.raw.iscancelled` 在注销中或注销拉黑期为 `true`，否则为 `false`。
- `#QQBot`、`#qbot`、`#机器人用户注销` 相关内部命令不受注销拦截。

注销流程示例请前往 [READ.md](READ.md) 查看，或下载其中的图片后本地查看。

### 拉黑

```text
#QQBot拉黑用户 openid 理由
#QQBot删黑用户 openid
#QQBot拉黑群 群openid 理由
#QQBot删黑群 群openid
#QQBot查看拉黑 用户 1
#QQBot查看拉黑 群 1
#QQBot拉黑设置 返回理由 开启
#QQBot拉黑设置 返回理由 关闭
```

- 支持用户和群拉黑，频道不写拉黑机制。
- 被拉黑用户或群触发外部命令时，不再分发给外部插件。
- 默认返回拉黑理由；关闭返回理由后静默拦截。
- 禁止触发命令的用户拉黑自己。
- 内部 `#QQBot/#qbot` 命令不受拉黑拦截，方便管理恢复。

### 查询

```text
#QQBot查看所有用户 1
#QQBot查看所有好友 1
#QQBot查看所有用户最近发言 1
#QQBot搜索用户 用户名 1
#QQBot查看用户所在群 openid
#QQBot查看所有群 1
#QQBot查看群成员 群openid 1
#QQBot查看群最近发言 群openid 1
#QQBot查看群最近发言 群openid #seq
#QQBot查看私聊最近发言 用户openid 1
#QQBot查看私聊最近发言 用户openid #seq
#QQBot查看最近发言
#QQBot查看所有群最近发言 1
#QQBot删除群最近发言 群openid 20
#QQBot删除群最近发言 群openid 全部
#QQBot备注群名称 群openid 群名
#QQBot备注群标识 群openid 群号
```

- 用户、群、群成员列表均支持分页，每页 10 条。
- `#QQBot查看所有用户 1` 同时包含群成员和有好友关系的用户，并提供“所有好友”和“所有用户发言”入口。
- `#QQBot查看所有好友 1` 只展示当前仍有好友关系的用户，排除已删除好友，按最近活跃时间倒序。
- `#QQBot查看所有用户最近发言 1` 聚合展示机器人好友私聊记录，每页 20 条，最多 500 页。
- `#QQBot搜索用户` 的按钮会针对第一条搜索结果提供“查询发言”和“快速拉黑”；后续搜索结果不增加快捷按钮。
- `#QQBot搜索用户` 支持按昵称、openid、所在群 openid 模糊搜索，每页 50 条，结果使用代码块输出；同一用户所在多个群会全部列出，未输入关键词会提示缺少参数。纯数字关键词会先只按昵称搜索，昵称无匹配时再提示输入更具体关键词，避免命中过多 openid。
- 群列表支持备注群名、备注群标识、全量群/非全量群标识、查看最近发言、拉黑/删黑快捷入口。
- 单群和单个好友私聊的最近发言支持分页查看，每页 20 条，也支持 `#seq` 查看对应记录的精简 `raw` JSON。
- `#QQBot查看最近发言` 提供群聊发言、私聊发言和返回按钮；查询菜单中的“最近发言”入口不会增加按钮总数。
- 所有群最近发言支持分页查看，每页 20 条，最多缓存和展示最近 500 页；历史按会话从 LevelDB 懒加载，不会一次载入全部历史。
- 最近发言索引使用版本标记；完成一次兼容迁移后，后续启动只读取索引与管理状态，不再重复扫描全部历史消息。
- 群成员、最近发言、备注等命令缺少或传入无效群 openid 时会直接提示缺少有效参数。
- 群聊缓存发言可按单群删除，也可在用户管理菜单中清空全部群聊缓存。
- `#QQBot用户管理菜单 时间加 8` 可设置用户管理展示时间偏移，`0` 表示关闭偏移。

### 使用范围

```text
#QQBot用户管理菜单 使用范围
#QQBot使用范围 群聊 开启/关闭
#QQBot使用范围 好友 开启/关闭
#QQBot使用范围 频道 开启/关闭
```

- 默认允许群聊、好友私聊和频道使用。
- 群聊与好友私聊至少需要开启一个；若手动修改配置导致两者均关闭，插件会恢复为全部开启并记录警告日志。
- 禁止的范围只拦截外部插件分发，QQBot 内部管理命令仍可使用，以便管理员解除限制。

### 历史接口

- `this.e.seq` 表示当前消息在对应群聊或私聊历史里的序号。
- `this.e.source.seq` 表示被引用消息的序号，支持消息 ID 和内容指纹回退匹配。
- `this.e.group.getChatHistory(seq, count)` 获取群聊历史。
- `this.e.friend.getChatHistory(seq, count)` 和 `this.e.friendgetChatHistory(seq, count)` 获取私聊历史。
- `count=0` 返回 `[]`，`count=1` 返回指定 `seq`，`count=2` 返回 `seq` 和 `seq-1`。
- 历史记录可保存消息内容和原始事件快照供管理与排障查询；请按最小必要原则启用并定期清理。

### UA 设置

```text
#QQBot用户管理 设置ua QQBotPlugin/9.9.9 (Node/20.11.0; Linux; QQbot/1.0.19)
#QQBot用户管理 ua开启
#QQBot用户管理 ua关闭
```

- UA 配置按机器人分离，默认关闭。
- 未设置 UA 时开启，会使用默认值 `QQBotPlugin/9.9.9 (Node/20.11.0; Linux; QQbot/1.0.19)`。
- UA 会应用到 `getAppAccessToken`、`/gateway/bot` HTTPS 请求和 WSS 握手。
- UA 开关或内容修改后，需要重启框架或等待 WS 机制重连才完全生效。
- 非 ASCII UA 内容会自动编码，避免 Node HTTP header 报错。

### 用户自由开启全量

```text
#我要开启全量 群号
#我要开启全量群号
#我要开启全量
我要开启全量 群号
我要开启全量群号
我要开启全量
#QQBot查看用户绑定全量 1
#QQBot删除用户绑定全量缓存
```

- `#` 可选，群号前空格可选；群号必须是 5 到 10 位纯数字，非法输入不会回显。
- 未输入群号时提示“没有输入群号”，并返回 `我要开启全量` qbotcmd 与指令按钮，保留开启步骤说明。
- 命令仅 QQ 群群主可用，非群主会提示当前身份：群主、管理员或群员。
- 机器人主人可代为进入授权入口；非主人且非群主仍按普通用户提示。
- 机器人 `self_id` 自动取当前机器人，无需用户输入。
- 回复官方授权 Markdown，并带“点击开启全量”链接按钮，按钮仅触发者可点击。
- 同一用户同一群只信任第一次输入的群号，绑定成功后后续错误输入不会覆盖缓存群号。
- 收到该群一次 `GROUP_MESSAGE_CREATE` 全量事件后，用户管理独立记录为已开启，不依赖“全量消息设置 记录群”开关。
- 当前群已检测到全量时，再次发送开启命令会提示“当前群已经开启全量，再次访问链接可以关闭”，并保留第 5 条高级功能说明。
- `#QQBot查看用户绑定全量 1` 展示触发用户 openid、群 openid、昵称、时间和是否检测到开启。

### 其他修复

- gl/fl 缓存清理频道形态数据，避免 `qg_`、``、频道来源字段和异常值污染群/好友列表。
- 高级群欢迎重复开启或关闭时提示“当前群已经开启/关闭”。
- `/gateway/bot`、频率限制、可恢复 400 错误日志增加 trace 信息，便于定位 SDK 与网关错误。
- 重连状态机区分官方 reset 等待和失败重试等待，并使用轮次 token 避免旧流程覆盖新状态。

### `this.e.raw.chat`

`this.e.raw.chat` 来自发言统计，常见结构如下：

```js
{
  user_openid: '...',
  scope: 'group' | 'private' | '',
  target_openid: '...',
  today: 0,
  yesterday: 0,
  week: 0,
  month: 0,
  total: {
    today: 0,
    yesterday: 0,
    week: 0,
    month: 0
  },
  breakdown: {
    today: { group: 0, private: 0 },
    yesterday: { group: 0, private: 0 },
    week: { group: 0, private: 0 },
    month: { group: 0, private: 0 }
  }
}
```

说明：

- `Breakdown` 表示按会话类型拆分后的明细统计。
- `group` 是群聊发言数，`private` 是私聊发言数。
- 顶层的 `today / yesterday / week / month` 是当前 `scope` 对应会话的统计值。
- `total` 是不区分会话类型的合计值。
- `scope` 为空时，通常表示只拿到了汇总统计，没有指定当前会话。

外部插件可通过 `await this.e.otherchat(userOpenid, groupOpenid)` 查询指定用户发言统计：

- `userOpenid` 必填，传用户 openid。
- `groupOpenid` 可选，传群 openid 时返回该用户在指定群的统计。
- 返回结构与 `this.e.raw.chat` 一致，包含 `today / yesterday / week / month`。
# QQBot 高级群欢迎

高级群欢迎用于在用户入群事件触发时发送官方 Markdown 服务通知。功能按机器人 QQ 分开配置，数据独立存储在 LevelDB，不依赖普通群事件开关。

## 入口

主菜单中的原“QQ转换”入口已替换为“高级群欢迎”。

```text
#QQBot高级群欢迎菜单
```

菜单按钮：`高级群欢迎`

qbotcmd：`高级群欢迎菜单`

## 工作方式

- 使用官方入群事件作为被动服务通知发送依据；仅限群主或管理员明确授权的群使用。
- 不受 `#QQBot普通设置 群事件 开启/关闭` 影响，该开关只控制外部插件群事件通知。
- 按机器人 QQ 独立配置，多个 Bot 不互相影响。
- 高频数据使用独立 LevelDB，路径为 `QQBot-Plugin/db/advancedWelcome`。
- 成功发送才计入次数额度，失败不计入成功次数。
- 退群事件只记录统计，不发送欢迎通知。

## 基础配置

```text
#QQBot高级群欢迎菜单
#QQBot高级群欢迎设置 总开关 开启
#QQBot高级群欢迎设置 总开关 关闭
#QQBot高级群欢迎设置 Markdown ><@openid>欢迎新人！
#QQBot高级群欢迎设置 button {按钮JSON}
#QQBot高级群欢迎设置 删除按钮
#QQBot高级群欢迎预览
```

说明：

- 必须先配置 Markdown 才能开启总开关。
- 按钮可选；未配置按钮时只发送 Markdown。
- 删除按钮会把按钮恢复为未配置，不影响 Markdown 和总开关。
- Markdown 中的 `<@openid>` 会在发送时替换为入群用户 openid。

## 推荐配置

```text
#QQBot高级群欢迎设置 推荐MD
#QQBot高级群欢迎设置 推荐按钮
```

推荐 Markdown：

```text
><@openid>欢迎新人！
```

推荐按钮会自动生成当前机器人 QQ 的两个操作：

- `关闭通知`：`#我要关闭通知 当前机器人QQ`
- `投诉通知`：`#我要投诉通知 当前机器人QQ`

## 次数限制

支持以下单群额度：

```text
#QQBot高级群欢迎设置 单群总次数 3
#QQBot高级群欢迎设置 单群天次数 0
#QQBot高级群欢迎设置 单群周次数 0
#QQBot高级群欢迎设置 单群5小时次数 0
#QQBot高级群欢迎设置 单群1小时次数 0
#QQBot高级群欢迎设置 单群5分钟次数 0
#QQBot高级群欢迎设置 单群1分钟次数 0
```

规则：

- `0` 或 `无限` 表示不限制。
- 单群总次数默认 `3`。
- 其余额度默认不限制。
- 展示格式示例：`5时: 7/无限`。

## 限发与发言限制

```text
#QQBot高级群欢迎设置 限发间隔 15
#QQBot高级群欢迎设置 发言限制 30
#QQBot高级群欢迎设置 自动关闭菜单
#QQBot高级群欢迎设置 投诉自动关闭 3
#QQBot高级群欢迎设置 单群错误自动关闭 50
```

说明：

- 限发间隔按秒计算，避免短时间重复欢迎。
- 发言限制只统计全量群消息 `GROUP_MESSAGE_CREATE`。
- 不可用时仅显示“全量群消息状态: 不可用”；可用且统计次数大于 0 时才追加“已统计N次”。
- 非全量群不会因为发言限制卡住发送。
- 不得将本功能用于营销、诱导、骚扰或重复触达群成员。
- 入群事件没有官方真实 `event_id` 时，高级群欢迎会直接拒绝发送，并记录错误群，错误理由为 `无event_id`。
- 自动关闭菜单支持单群投诉次数自动关闭，以及单群连续错误次数自动关闭；连续错误默认阈值 50，默认关闭。
- 投诉相关机器人回复会在 1 分钟后尝试撤回，避免刷屏。
- 使用他人投诉确认码会提示“请不要使用别人的投诉确认，请明确自己有投诉需求”。

## 查看与管理

```text
#QQBot高级群欢迎查看 1
#QQBot高级群欢迎查看关闭 1
#QQBot高级群欢迎查看投诉 1
#QQBot高级群欢迎查看错误 1
#QQBot高级群欢迎查看详情 群openid
#QQBot高级群欢迎关闭 群openid
#QQBot高级群欢迎开启 群openid
```

说明：

- 查看列表会展示每个群的状态、额度、加退群、发送失败、投诉等信息。
- 查看列表每个群条目后提供快捷 qbotcmd：开启/关闭此群、查看详情。
- qbotcmd 不放在代码块内，避免客户端无法识别。
- 如果群 openid 还没有记录，关闭/开启命令会提前创建状态并提示“群记录不存在，已提前关闭/开启”。
- 新操作会标记来源：开发者命令显示“开发者”，群主/管理员命令显示“群内管理”，投诉或连续错误自动关闭显示“系统”；旧记录不补来源标签。

## 群员命令

```text
#我要关闭通知 当前机器人QQ
#我要开启通知 当前机器人QQ
#我要投诉通知 当前机器人QQ
#我要投诉通知 确认 确认码
#我要撤回投诉 当前机器人QQ
#我要撤回投诉通知 当前机器人QQ
```

权限规则：

- 群主/管理员可以直接关闭或开启当前群通知。
- 普通成员不能直接关闭；无权限时会提示投诉入口，并带 qbotcmd 与按钮。
- 普通成员投诉需要确认码，确认码 1 分钟有效。
- 同一用户同一群只记录一次有效投诉。
- 撤回投诉兼容 `#我要撤回投诉` 和 `#我要撤回投诉通知` 两种写法。

## 详情信息

```text
#QQBot高级群欢迎查看详情 群openid
```

详情包含：

- 群 openid
- 当前开启/关闭状态
- 加群/退群统计
- 发送/失败统计
- 全量群消息状态和统计次数
- 总/天/周/5时/1时/5分/1分额度
- 最近发送时间
- 最近失败原因
- 投诉用户 openid 与时间
- 撤回投诉用户 openid 与时间

## 关联能力

### this.e.chatrank()

新增 `await this.e.chatrank(groupOpenid)`，返回当前群今日/昨日发言排行：

```js
{
  today: [],
  yesterday: [],
  todayWithBot: [],
  yesterdayWithBot: []
}
```

说明：

- 只对群聊有效。
- 默认排行排除机器人。
- `todayWithBot`、`yesterdayWithBot` 包含机器人。
- 已退群成员不再计入排行。

### this.e.recallMsg()

新增 `this.e.recallMsg(messageId, targetId, targetType)`，并兼容旧插件的 `e.group.recallMsg()` / `e.friend.recallMsg()`。

支持能力：

- 使用真实 `ROBOT1.0_...` 消息 ID 撤回。
- 自动处理外层事件 ID 与真实消息 ID 的映射。
- 支持 `REFIDX_...` 回复索引撤回。
- 当官方只给引用内容时，使用内容指纹回退匹配近期真实消息 ID。
- URL 编码消息 ID，避免 `/` 等字符破坏接口路径。
- 保护群主/管理员消息，不盲撤。

### 召回管理

```text
#QQBot召回菜单
#QQBot开始召回
#QQBot召回配置
#QQBot召回配置 存储 level
#QQBot召回配置 发送延迟 1秒
#QQBot召回配置 每批数量 2
#QQBot召回配置 button 删除
#QQBot召回查看
#QQBot单独召回 用户openid
#QQBot全部召回设置数量 数量
#QQBot全部召回确认
#QQBot召回结果 1
#QQBot召回成功 1
#QQBot召回失败 1
#QQBot召回失败重发 结果序号
#QQBot召回失败重发 结果序号 确认
#QQBot召回结果删除 结果序号
#QQBot召回结果删除 结果序号 确认
#QQBot召回结果删除 全部
#QQBot召回结果删除 全部 确认
```

- `#QQBot开始召回` 集中提供可用对象的任务入口和结果查看；召回菜单顶部也提供该按钮。
- 仅可向平台允许发送、已建立有效会话或已获得授权的对象发送消息；不得尝试绕过会话、事件或频率限制。
- `#QQBot全部召回设置数量` 只从可发送列表取指定数量，确认后执行任务。
- 默认每批并发发送 2 条，批次之间等待 1 秒；发送延迟和每批数量可在召回配置中修改。
- 成功和失败结果按任务保存；失败详情每页 20 条。发送应遵守官方频率和会话规则，遇到频率限制时应降低频率或停止任务。
- `#QQBot召回结果` 为每条任务提供按序号失败重发和删除结果 qbotcmd，也支持确认后删除全部结果；删除后剩余结果重新编号。
- 失败重发仅针对仍符合平台发送规则的失败项，不重发已跳过项。
- 删除好友事件或错误码 `40054004` 会标记为删除好友并跳过；用户重新添加好友后自动解除该标记。
- 批量结果优先回复确认命令的消息 ID；私聊 ID 按 1 小时、群聊 ID 按 5 分钟判断有效期，失败后依次尝试当前私聊召回、当前环境和主人通知。
- 旧 `#QQBot召回设置` 命令继续兼容，但菜单统一使用 `#QQBot召回配置`。

## 注意事项

- 高级群欢迎只作用于群聊。
- Markdown 删除不提供快捷入口；如果不想继续发送，关闭总开关即可。
- 按钮删除只影响按钮，不影响 Markdown。
- 投诉/关闭等 qbotcmd 必须放在代码块外。
- 全量群消息统计是发言限制判断依据，不是欢迎发送额度。



**关键命令速查**

```text
#QQBot普通设置 群事件 开启
#QQBot全量拉黑菜单
#QQBot全量拉黑 群openid
#QQBot全量删黑 群openid
#QQBot全量消息设置 忽略@全体的指令 开启
#QQBot召回菜单
#QQBot开始召回
#QQBot召回配置
#QQBot召回配置 时间偏移 8
#QQBot召回配置 发送延迟 1秒
#QQBot召回配置 每批数量 2
#QQBot召回结果
#QQBot召回失败 1
#QQBot普通设置 查看拉入排行
#QQBot普通设置 查看踢出排行
#QQBot高级群欢迎菜单
```



## 运行与兼容性
   - 新增 QQ 机器人认证错误处理、会话恢复和文件/语音发送适配
   - 新增只读错误、取消错误、WebSocket错误检测
   - 新增运行时定时器清理
   - 优化了ws超时的报错重连
   - `toCallback` 默认改为 `false`
   - 新增 `forceSilk` 配置
   - 新增 `icebreaker` 和 `recall` 配置对象
   - `fullMessageDB` 改为 `level` 存储
   
上传图片用法(需要自己的上传插件加载成功)

```js
// 网络图片
await Bot.uploadImage("https://example.com/a.png")

// 本地图片路径
await Bot.uploadImage("/root/qqbot/data/images/a.png")

// file 协议本地图片
await Bot.uploadImage("file:///root/qqbot/data/images/a.png")

// base64 图片
await Bot.uploadImage("base64://iVBORw0KGgoAAAANSUhEUgAA...")

// 图片 Buffer
const buffer = fs.readFileSync("/root/qqbot/data/images/a.png")
await Bot.uploadImage(buffer)
```

最简单写法：

```js
const image = await Bot.uploadImage("https://example.com/a.png")
```

返回：

```js
{
  url: "https://上传后的图片地址",
  width: 640,
  height: 360
}
```

如果要指定某个 QQBot 账号上传：

```js
const image = await Bot[3889000008].uploadImage("https://example.com/a.png")
```

>优化多机器人配置、消息统计、原生 Markdown 与模板按钮，并修复回调按钮的消息 ID 权限校验。

>提供原生按钮生成、连接状态检测与异常重连能力。请按 QQ 开放平台规则使用消息事件和接口能力。

```javascript
// 1. 网络文件，自动文件名
segment.file("https://example.com/file.pdf")

// 2. 网络文件，自定义文件名；文件内容应与扩展名保持一致
segment.file("https://example.com/document.pdf", "文档.pdf")
segment.file("https://example.com/audio.mp3", "音频.mp3", 1)

// 3. 本地文件，绝对路径
segment.file("/root/yunzai/data/file.pdf", "文件.pdf")

// 4. 本地文件，相对路径
segment.file("./data/file.pdf", "文件.pdf")

// 5. file:// 协议本地文件
segment.file("file:///root/yunzai/data/file.pdf", "文件.pdf")

// 6. 分片上传
segment.file({
  file: "https://example.com/large.zip",
  name: "大文件.zip",
  force_chunk: 1
})

// 7. 自动选择上传方式
segment.file({
  file: "https://example.com/file.pdf",
  name: "文件.pdf"
})

// 8. Buffer 文件上传
segment.file(buffer, "文件.pdf")

```
## 文件撤回示例

### 基础用法
```javascript
// 发送文件，20秒后自动撤回
segment.file("https://example.com/file.pdf", "文档.pdf", 0, 20)

// 参数说明：
// 参数1: 文件URL或路径
// 参数2: 文件名
// 参数3: force_chunk (0=自动判断, 1=分片上传)
// 参数4: recall_time (撤回时间，单位：秒，0=不撤回)
```

### 更多示例
```javascript
// 1. 普通文件，60秒后撤回
segment.file("https://example.com/data.zip", "人机模块.zip", 0, 60)

// 2. 分片上传，30秒后撤回
segment.file("https://example.com/large.mp4", "视频.mp4", 1, 30)

// 3. 本地文件，120秒后撤回
segment.file("file:///data/report.xlsx", "报表.xlsx", 0, 120)

// 4. 对象形式参数
segment.file({
  file: "https://example.com/file.txt",
  name: "文本.txt",
  force_chunk: 0,
  recall_time: 45
})

// 5. 私聊文件（自动分片），10秒后撤回
segment.file("https://example.com/document.doc", "文档.doc", 0, 10)
```

### 注意事项
- `recall_time` 为 `0` 或不填时，不会自动撤回
- 撤回时间从文件发送成功开始计算
- 超过2分钟的消息无法撤回（QQ官方限制）
- 私聊文件会自动使用分片上传，`force_chunk` 参数无效

---

## 账号掉线检测与重连命令

### 总开关
```bash
# 开启掉线检测（总开关，必须先开启此项其他功能才生效）
#QQBot账号掉线检测 开启

# 关闭掉线检测
#QQBot账号掉线检测 关闭
```

### 掉线提醒
```bash
# 开启掉线提醒（会向所有管理员发送掉线通知）
#QQBot账号掉线提醒 开启

# 关闭掉线提醒
#QQBot账号掉线提醒 关闭
```

### 自动重连
```bash
# 开启自动重连（检测到掉线后自动尝试重连）
#QQBot账号掉线自动重连 开启

# 关闭自动重连
#QQBot账号掉线自动重连 关闭
```

### 检测时间间隔
```bash
# 设置检测间隔为1分钟（最小值）
#QQBot账号掉线检测时间设置 1分钟

# 设置检测间隔为5分钟（推荐值）
#QQBot账号掉线检测时间设置 5分钟

# 设置检测间隔为10分钟
#QQBot账号掉线检测时间设置 10分钟

# 设置检测间隔为30分钟（最大值）
#QQBot账号掉线检测时间设置 30分钟

# 支持范围：1-30 分钟
#QQBot账号掉线检测时间设置 15分钟
```

### 工作原理
1. **检测机制**：定时调用 `/gateway/bot` 接口查询 `session_start_limit.remaining`
2. **掉线判断**：`remaining === 0` 表示账号已掉线，无剩余连接次数
3. **重连流程**：
   - 检测到 `remaining === 0` 时，记录 `reset_after`（重置等待时间）
   - 发送掉线提醒（如已开启）
   - 等待 `reset_after` 毫秒后，再次检查 `remaining` 是否恢复
   - 若 `remaining > 0`，执行 `logout()` → `login()` 重连
   - 重连成功后发送通知（如已开启）

### 配置示例
```yaml
# config.yaml
offlineDetect:
  enabled: true           # 总开关
  notify: true            # 掉线提醒
  autoReconnect: true     # 自动重连
  interval: 5             # 检测间隔（分钟）
```

### 通知消息示例
```
掉线提醒：
[3889000008] 账号下线：[下线通知]你的帐号当前登录已失效，请5小时6分钟7秒后重新登录。
发送 /Bot上线3889000008 重新登录

重连成功：
[3889000008] 账号重连成功！

重连失败：
[3889000008] 自动重连失败：Connection timeout
```

1. 转发消息改为渲染成图片,需要安装`ws-plugin`
2. `#QQBot设置转换开启`配合`#ws绑定`实现互通数据
3. `#QQBotDAU` and `#QQBotDAUpro`
4. `Model/template/groupIncreaseMsg_default.js`中可配置入群服务通知模板；仅限群管理者授权的服务场景使用。
5. `config/QQBot.yaml`中使用以下自定义模版,如果设置了全局md会优先使用自定义模版,配合`e.toQQBotMD = true`将特定消息`转换`成md,亦可在`全局md模式下`通过`e.toQQBotMD = false`将特定消息`不转换`成md
   - 方法1: 直接修改`config/QQBot.yaml` **(推荐)**
     ```yml
     customMD:
       BotQQ:
         custom_template_id: 模版id
         keys:
           - key1 # 对应的模版key名字
           - key2
           # ... 最多10个
     ```
   - 方法2: 在`Model/template`目录下新建`markdownTemplate.js`文件,写入以下内容 **(不推荐)**
     ```js
     // params为数组,每一项为{key:string,values: ['\u200B']} // values固定为['\u200B']
     export defalut {
       custom_template_id: '',
       params: []
     }
     ```
6. `#QQBot调用统计` 根据`e.reply()`发送的消息进行统计,每条消息仅统计一次,未做持久化处理,默认关闭,`#QQBot设置调用统计开启`
7. `config/QQBot.yaml`中使用以下配置项,在`全局MD`时会`以MD的模式`自动加入`params`中
   ```yml
   mdSuffix:
     BotQQ:
       - key: key1
         values:
           - value # 如果用到了key则不会添加
       - key: key2
         values:
           # \ 需转义 \\
           - "{{ e.msg.replace(/^#/g, '\\/') }}" # {{}}中为动态参数,会在发送时替换成对应值,目前仅有e可用,也可以传入js表达式等等, 后续可能会添加自定义方法
       # ...
   ```
8. `config/QQBot.yaml`中使用以下配置项,在`全局MD`时会`以button的模式`自动加入`按钮指定行数并独占一行`,当`超过`5排按钮时`不会添加`
   ```yml
   btnSuffix:
     BotQQ:
       position: 1 # 位置:第几行 1 - 5
       values:
         - text: test
           callback: test
           show: # 达成什么条件才会显示
             type: random # 目前仅支持 random
             data: 50 # 0-100
         - text: test2
           input: test2
         # ... 最多10个
   ```
9. `#QQBot用户统计`: 对比昨日的用户数据,默认关闭,`#QQBot设置用户统计开启`
10. `config/QQBot.yaml`中可配置本地控制台日志过滤，减少高频日志刷屏；也可以使用`#QQBot添加/删除过滤日志`。该设置仅影响本地控制台输出，不影响平台审核、消息记录或安全审计。
    - **自定义消息采取完整消息匹配，非关键词匹配**
    - **非必要不建议开启此项**
      > 注意：_只会过滤部分QQBot的日志_
    ```yml
    filterLog:
      BotQQ:
         - 示例高频消息
         - 示例机器人提示
        # ...
    ```
11. `config/QQBot.yaml`中`simplifiedSdkLog`是否简化sdk日志,若设置为`true`则不会打印` recv from Group(xxx):  xxx`,并且会简化发送为`send to Group(xxx): <markdown><button>`
12. ~~`#QQBot一键群发`: 需要先配置模版 `template/oneKeySendGroupMsg_default.js`~~
13. `config/QQBot.yaml`中`markdownImgScale: 1`是否对markdown中的图片进行等比例缩放,0.5为缩小50%,1.5为放大50%,以此类推
14. `config/QQBot.yaml`中`sendButton: true`未开启全局MD时是否单独发送按钮
15. `config/QQBot.yaml`中`dauDB: level`选择存储dau数据的数据库,可选: `level`, `redis`,以及`false`关闭dau统计(仅每日发言用户和群)
    - `level`
      - 优点: 统计了大部分数据
      - 缺点: 缓存存一份,level存一份
    - `redis`
      - 优点: 大部分使用redis存储,不会缓存
      - 缺点: 没有缓存所以有些没统计
16. 已适配YePanel,提供dau统计和设置功能
17. `config/QQBot.yaml`中`bus`是否使用 WebSocket 中转部署
 - 中转部署可用于网络连通性和公网入口管理；使用前请确保符合 QQ 开放平台、网络服务商及服务器所在地的安全要求。
- 填写格式:
```
  bus: {
    BotQQ: "example.com"
  }
```
- 后端搭建[[QQBotWs](https://github.com/Admilkk/QQBotWs)]

## 安装教程

1. 准备：[TRSS-Yunzai](../../../Yunzai)
2. ~~输入：`#安装QQBot-Plugin`~~
3. 打开：[QQ 开放平台](https://q.qq.com) 创建 Bot：
   ① 创建机器人  
   ② 开发设置 → 得到 `机器人QQ号:AppID:AppSecret`
4. 输入：`#QQBot设置机器人QQ号:AppID:AppSecret:[01]`

最后一位表示是否启用频道私域，`1` 为启用，`0` 为关闭。群 Bot 能力已完全开放，不再需要配置开关；Token 已弃用，获取 access token 只使用 AppID 和 AppSecret。

## 格式示例

- 机器人QQ号 `114` AppID `514` AppSecret `810`，启用频道私域

```
#QBot设置114:514:810:1
```

旧格式仍可输入，例如 `#QBot设置114:514:1919:810:1:1`。旧格式中的 Token 和群 Bot 开关必须保留非空占位，但不会被使用或保存；插件启动时会自动迁移旧配置。

### 扫码登录

```text
#QBot设置 扫码登录
```

扫码登录会重置 AppSecret，请确保机器人没有在其他地方使用，二维码固定 4 分钟有效。只有当前事件来自本 QQBot 适配器且 `self_id` 是官方机器人时，才通过 QQBot 图片上传通道发送二维码和 `[点击登录](官方链接)`；其他适配器直接发送 `segment.image` 二维码和官方登录链接，不使用 Markdown。机器人 QQ 号会从 `/users/@me` 接口自动获取。扫码登录默认关闭频道私域；登录成功后如需开启频道私域或删除配置，请自行修改或查看 `config/QQBot.yaml`。请勿在截图、日志、聊天记录或公开仓库中泄露 AppSecret。

### 新旧接口切换

接口模式是全局配置，对所有 QQBot 生效，不按机器人分离。

```text
#QQBot接口切换菜单
#QQBot接口查看
#QQBot接口切换 确认
#QQBot接口切换 开始切换
```

- 老接口使用 `api.sgroup.qq.com`，新接口使用 `api.bot.qq.com`。
- REST 请求在切换后的下一次发消息时使用新配置。
- WSS 地址在重启或 WebSocket 自动重连后生效。
- `#QQBot其他菜单` 提供接口切换的 qbotcmd 和按钮入口。

## 高阶能力

<details><summary>Markdown 消息</summary>

支持原生 Markdown 消息能力，请按 QQ 开放平台规范配置和发送。

</details>

## 使用教程

- #QQBot账号
- #QQBot设置 + `机器人QQ号:AppID:AppSecret:是否频道私域`（是1 否0）
- #QBot设置 扫码登录
- #QQBot接口切换菜单
- #QQBotMD + `机器人QQ号:模板ID`
- #QQBotMD + `机器人QQ号:raw` 开启原生MD
- #QQBotMD + `机器人QQ号:` 关闭原生MD

---

# 附录：事件对象与本次8月大更新


---

## 一、dau.js 修复

### 1. 时间口径修复

- 移除 `import { getTime } from './common.js'`。
- 新增本地辅助函数：

```js
const getDauDate = (offset = 0) => moment().add(offset, 'day').format('YYYY-MM-DD')
```

- `init()` 中：

```js
this.today = getDauDate()
this.yesterday = getDauDate(-1)
```

- `ensureCurrentDay()` 中：

```js
const currentDay = getDauDate()
```

- 行为变化：DAU 不再使用 `getTime()`（该函数在系统时间上额外 +8 小时）。现在 DAU 与 `node-schedule` 的 `0 0 0 * * ?` 使用同一本地时间口径。生产环境时区为北京时间（UTC+8），`node-schedule` 零点即北京时间零点，DAU 日期与之一致，不会出现“昨天数据累加到今天”的边界错误。
- 每次 `setDau()` 写入前仍会调用 `ensureCurrentDay()`，即使零点任务延迟或进程暂停，跨日后第一次写入也会先归档旧日数据并初始化新日。

### 2. numToChinese 补充

- 原来只有 1~30，补全到 31（日期最大 31，无需更高）：

```js
31: '三十一'
```

- 影响：`#QQBotdau` 的“最近XX天平均”在 31 天时显示中文（`三十一`），不会再显示英文数字。

---

## 二、this.e 事件对象完整字段(可能部分无法调用)

> 事件对象由插件构造后交给 Yunzai loader 统一补字段。下面按“插件注入 → loader 补全 → 按事件类型存在”三部分列全。标了“条件”的字段只在对应事件/配置下存在。

### 1. 插件在 makeMessage 中注入的字段（所有消息事件）

| 字段 | 说明 |
| --- | --- |
| `this.e.raw` | 官方 SDK 原始事件对象，插件会追加缓存/兼容字段（见第三节） |
| `this.e.bot` | 当前机器人对象（见第六节） |
| `this.e.client` | bot 的兼容客户端对象，额外提供 `getSystemMsg()`（见第八节） |
| `this.e.self_id` | 当前机器人 QQ |
| `this.e.post_type` | 事件类型，消息为 `message` |
| `this.e.message_type` | `private` / `group` / `guild` / `direct` |
| `this.e.sub_type` | 如 `friend`、`callback` 等 |
| `this.e.message_id` | 当前消息 ID |
| `this.e.user_id` | getter，返回 `this.e.sender.user_id` |
| `this.e.message` | 标准 segment 消息数组 |
| `this.e.raw_message` | 规范化纯文本消息 |
| `this.e.reply` | 回复当前会话：`this.e.reply(msg, quote?, data?)` |
| `this.e.recallMsg` | 撤回：`this.e.recallMsg(messageId, targetId?, targetType?)` |
| `this.e.chatrank` | 函数：`this.e.chatrank(groupOpenid?)`，返回 `{ today, yesterday, week, month, todayWithBot, yesterdayWithBot, weekWithBot, monthWithBot }`，均为数组 |
| `this.e.otherchat` | 函数：`this.e.otherchat(userOpenid, groupOpenid?)`，返回该用户在私聊/群聊的发言统计 |
| `this.e.reply_id` | 被引用消息 ID（无引用为空） |
| `this.e.getReply` | 异步函数：`await this.e.getReply()` 返回 `{ message_id }` 或 `null` |
| `this.e.source` | 存在引用时为 `{ seq }`；`seq` 为本地最近发言序号，匹配后更新 |
| `this.e.at` | 条件：全量群消息或好友私聊且被 @ 时存在，为虚拟 @ 用户 ID |
| `this.e.seq` | 条件：消息被本地记录后存在，为发言记录序号 |
| `this.e.full_message` | 条件：GROUP_MESSAGE_CREATE 全量群消息存在，为过滤/判定结果对象 |
| `this.e.atBot` | 条件：全量群消息判定应分发时为 `true` |
| `this.e.recall` | loader 绑定：`this.e.recall()` 撤回当前消息（群聊/私聊，有 `message_id` 且有 `friend/group.recallMsg` 时） |

### 2. loader 统一补全的字段（dealEvent / prepareEvent）

| 字段 | 说明 |
| --- | --- |
| `this.e.msg` | 拼接后的文本消息（多行合并），`xml`/`json` 段也会拼入 |
| `this.e.img` | 图片 URL 数组（`image` 段） |
| `this.e.file` | 文件段对象（`file` 段） |
| `this.e.atBot` | 是否 @ 了机器人（`at` 段且 `qq === self_id`） |
| `this.e.at` | 最后被 @ 的用户（loader 从 `at` 段补充） |
| `this.e.reply_id` | loader 从 `reply` 段补充 |
| `this.e.getReply` | loader 补充：`this.e.group.getMsg?.(id)` 或 `friend.getMsg?.(id)`，若存在 |
| `this.e.isPrivate` | 私聊或好友通知时为 `true` |
| `this.e.isGroup` | 群聊或群通知时为 `true` |
| `this.e.isMaster` | 用户是否为该机器人的主人（来自 `config.other.master`） |
| `this.e.hasAlias` | 群聊中以机器人别名开头时，别名被移除且为 `true` |
| `this.e.only_reply_at` | 是否仅回复 @ 消息 |
| `this.e.logText` | 日志用户串 |
| `this.e.logFnc` | 日志方法串（发送统计使用） |
| `this.e.sender` | 发送人对象（见第四节） |
| `this.e.group_name` | 群名（无则 fallback） |
| `this.e.adapter_id` | 适配器 ID |
| `this.e.adapter_name` | 适配器名称，QQBot 为 `QQBot` |
| `this.e.friend` | 好友对象（见第五节） |
| `this.e.group` | 群对象（见第七节） |
| `this.e.member` | 群成员对象（见第七节群成员部分） |

### 3. 群聊消息追加

| 字段 | 说明 |
| --- | --- |
| `this.e.group_id` | 群标识，官方群格式为 `机器人QQ:群openid`，频道为 `qg_频道ID-子频道ID` |
| `this.e.group_openid` | 官方群 openid（32 位十六进制），频道无 |
| `this.e.group` | `this.e.bot.pickGroup(this.e.group_id)` 结果 |
| `this.e.member` | 群成员对象（含官方作者信息） |
| `this.e.sender.role` | 成员角色（`owner` / `admin` / `member`） |
| `this.e.sender.permission` | 同 role |

### 4. 私聊消息追加

| 字段 | 说明 |
| --- | --- |
| `this.e.friend` | `this.e.bot.pickFriend(this.e.user_id)` 结果 |
| `this.e.friend.getChatHistory(seq?, count?)` | 读取该好友的本地发言记录 |
| `this.e.friendgetChatHistory(seq?, count?)` | 同上的兼容别名（仅好友私聊） |

### 5. 群对象追加（makeMessage 后）

| 字段 | 说明 |
| --- | --- |
| `this.e.group.getChatHistory(seq?, count?)` | 读取该群的本地发言记录 |

### 6. this.e.raw 的插件追加字段

| 字段 | 说明 |
| --- | --- |
| `this.e.raw.self_openid` | 机器人自身 self openid（getter，来自配置缓存） |
| `this.e.raw._qqbotFullMessageCreate` | 是否 GROUP_MESSAGE_CREATE 全量消息 |
| `this.e.raw._qqbotFullMessageRecorded` | 是否已记录为全量群 |
| `this.e.raw.seq` | 本地发言序号 |
| `this.e.raw.reply_id` | 被引用消息 ID |
| `this.e.raw.at_id` | 虚拟 @ 用户 ID |
| `this.e.raw.v_id` | 用户虚拟 @ ID |
| `this.e.raw.is_has_new_join_request` | 该机器人是否有未读加群申请 |
| `this.e.raw.iscancelled` | 用户是否处于注销/封禁 |
| `this.e.raw.invite` | 邀请/好友/召回本地状态（群聊、私聊、通知事件） |
| `this.e.raw.chat` | 用户/群发言统计（全量群消息、好友私聊） |
| `this.e.raw.qqbot_group_info` | 群 info 官方缓存 |
| `this.e.raw.qqbot_bot_state` | bot_state 官方缓存 |
| `this.e.raw.group_name` | 缓存群名 |
| `this.e.raw.group_member_num` | 缓存群人数 |
| `this.e.raw.member_openid` | 机器人群内 openid |
| `this.e.raw.member_role` | 机器人群角色 |
| `this.e.raw.allow_proactive_msg` | 是否允许主动消息 |
| `this.e.raw.qqbot_group_cache_status` | `{ info: 'ok'\|'missing'\|'error', bot_state: 'ok'\|'missing'\|'error'\|'不是管理员' }` |

### 7. 按钮回调事件（sub_type = 'callback'）

| 字段 | 说明 |
| --- | --- |
| `this.e.raw` / `this.e.bot` / `this.e.self_id` | 同消息事件 |
| `this.e.post_type` | `message` |
| `this.e.message_id` | 按钮绑定的消息 ID |
| `this.e.message_type` | `private` / `group` 等 |
| `this.e.sub_type` | `callback` |
| `this.e.sender` / `this.e.user_id` | 点击者 |
| `this.e.message` | `[reply段, text段]`，text 为按钮命令 |
| `this.e.raw_message` | 按钮命令文本 |
| `this.e.reply` | 回复回调（带 event_id 引用） |
| `this.e.friend` / `this.e.group` | 按事件类型存在 |
| `this.e.group_id` / `this.e.group_openid` | 群按钮回调存在 |

### 8. 通知事件对象（经 Bot.em 发射，字段按类型存在）

| 字段 | 说明 |
| --- | --- |
| `this.e.raw` / `this.e.bot` / `this.e.self_id` | 同消息事件 |
| `this.e.post_type` | `notice` |
| `this.e.notice_type` | `group` / `friend` / `guild` / `channel` / `forum` 等 |
| `this.e.sub_type` | `increase` / `decrease` / `member.increase` / `member.decrease` / `receive_open` / `receive_close` 等 |
| `this.e.notice_id` | 通知 ID |
| `this.e.group_id` / `this.e.group_openid` | 群通知存在 |
| `this.e.user_id` / `this.e.member_openid` | 相关用户 |
| `this.e.sender` / `this.e.member` | 部分通知存在 |
| `this.e.reply` | 部分群通知注入（可回复原会话） |
| `this.e.raw.invite` | 群成员进出、好友增删时存在 |
| `this.e.raw._qqbotFullMessageRecorded` | 机器人进群通知时存在 |

### 9. 消息审核通知（主动消息审核）

| 字段 | 说明 |
| --- | --- |
| `this.e.post_type` | `notice` |
| `this.e.notice_type` | `message_audit` |
| `this.e.sub_type` | `pass` / `reject` |
| `this.e.notice_id` / `this.e.audit_id` | 审核 ID |
| `this.e.message_id` | 被审核消息 ID |
| `this.e.audit_time` / `this.e.create_time` | 时间 |
| `this.e.is_passed` | 是否通过 |
| `this.e.group_id` / `this.e.user_id` | 相关群/用户 |

---

## 三、this.e.sender

| 字段 | 说明 |
| --- | --- |
| `this.e.sender.user_id` | 发送者用户 ID |
| `this.e.sender.nickname` | 昵称 |
| `this.e.sender.card` | 群名片（群聊） |
| `this.e.sender.avatar` | 头像（部分事件） |
| `this.e.sender.role` / `this.e.sender.permission` | 群聊时为成员角色 |
| `this.e.sender.guild_id` / `this.e.sender.channel_id` | 频道事件 |
| `this.e.sender.src_guild_id` / `this.e.sender.src_channel_id` | 频道私聊来源 |

---

## 四、this.e.group（pickGroup 返回，含全部方法）

字段：

```js
this.e.group.self_id
this.e.group.bot
this.e.group.group_id
this.e.group.group_openid
this.e.group.group_name
this.e.group.group_finger_memo
this.e.group.group_class_text
this.e.group.group_tags
this.e.group.group_member_num
this.e.group.bot_state        // { member_openid, joined_at, allow_proactive_msg, recv_msg_setting, member_role, fetched_at, error }
this.e.group.info             // { group_openid, group_name, group_finger_memo, group_class_text, group_tags, group_member_num, fetched_at, error }
```

方法：

```js
this.e.group.sendMsg(message)                 // 发消息
this.e.group.sendFile(file, name?)            // 发文件（loader 补全）
this.e.group.makeForwardMsg(message)          // 构造转发（loader 补全）
this.e.group.sendForwardMsg(message)          // 发送转发（loader 补全）
this.e.group.getInfo()                        // 返回缓存对象（loader 补全）
this.e.group.pickMember(userOpenid)
this.e.group.recallMsg(messageId, targetId?, targetType?)
this.e.group.getMemberMap()                   // 群成员 Map
this.e.group.getChatHistory(seq?, count?)     // 本地发言记录（官方群消息后存在）

this.e.group.getjoinMsg(force?)               // 加群申请：false/0 读缓存，true/1 刷新官方接口
this.e.group.setGroupAddRequest(flagOrSequence, approve, reason?, block?)  // 审批加群
this.e.group.getMuteMemberList()              // 禁言列表
this.e.group.muteMember(userOpenid, duration?)// 禁言/解禁（duration 秒，0 解禁）

this.e.group.getGroupInfo()                   // 刷新群 info 接口并返回缓存
this.e.group.getBotState()                    // 刷新 bot_state 接口并返回缓存
this.e.group.refreshInfo()                    // 刷新 info + bot_state 并返回缓存
this.e.group.getinfo()                        // 读取当前缓存，不改动
this.e.group.refreshinfo()                    // 强制刷新 info + bot_state；同类请求在途时复用，不重复请求
```

### getinfo() 返回结构

```js
{
  self_id,
  group_openid,
  created_at,
  last_seen_at,
  pending_refresh: { reason, options, created_at } | null,
  info: { group_openid, group_name, group_finger_memo, group_class_text, group_tags, group_member_num, fetched_at, error },
  bot_state: { member_openid, joined_at, allow_proactive_msg, recv_msg_setting, member_role, fetched_at, error }
}
```

`error` 结构：`{ status?, code?, err_code?, message, trace_id?, at }`；`bot_state.error.message` 为 `不是管理员` 表示机器人在该群不是管理员（不是致命错误）。

---

## 五、this.e.member（pickMember 返回）

字段：

```js
this.e.member.self_id
this.e.member.bot
this.e.member.group_id
this.e.member.group_openid
this.e.member.user_id
this.e.member.user_openid
this.e.member.member_openid
this.e.member.nickname
this.e.member.card
this.e.member.avatar
this.e.member.bot            // 是否机器人
this.e.member.role           // owner / admin / member
this.e.member.permission     // 同 role
this.e.member.is_owner       // role === 'owner'
this.e.member.is_admin       // role === 'admin' || role === 'owner'
```

方法：

```js
this.e.member.sendMsg(message)
this.e.member.sendFile(file, name?)
this.e.member.makeForwardMsg(message)
this.e.member.sendForwardMsg(message)
this.e.member.getInfo()
this.e.member.recallMsg(messageId, targetId?, targetType?)
this.e.member.getAvatarUrl()
this.e.member.muteMember(duration?)       // 禁言/解禁
this.e.member.getMuteMemberList()
```

---

## 六、this.e.friend（pickFriend 返回）

字段：

```js
this.e.friend.self_id
this.e.friend.bot
this.e.friend.user_id
this.e.friend.nickname
this.e.friend.avatar
```

方法：

```js
this.e.friend.sendMsg(message)
this.e.friend.sendFile(file, name?)
this.e.friend.makeForwardMsg(message)
this.e.friend.sendForwardMsg(message)
this.e.friend.getInfo()
this.e.friend.recallMsg(messageId, targetId?, targetType?)
this.e.friend.getAvatarUrl()
this.e.friend.getChatHistory(seq?, count?)   // 好友私聊消息后存在
```

---

## 七、this.e.bot（机器人对象，插件构造）

稳定字段：

```js
this.e.bot.adapter          // QQBotAdapter 实例
this.e.bot.sdk              // qq-official-bot 实例
this.e.bot.uin              // 机器人 QQ
this.e.bot.info             // { id, ...连接配置 }
this.e.bot.nickname         // SDK nickname getter
this.e.bot.avatar           // QQ 头像 URL getter
this.e.bot.version          // { id, name, version }
this.e.bot.stat             // { start_time, recv_msg_cnt }
this.e.bot.fl               // 好友 Map
this.e.bot.gl               // 群 Map
this.e.bot.gml              // 群成员 Map
this.e.bot.dau              // DAU 实例
this.e.bot.callback         // 按钮回调暂存表
```

方法：

```js
this.e.bot.login()
this.e.bot.logout()
this.e.bot.pickFriend(userOpenid)
this.e.bot.pickUser          // 同 pickFriend
this.e.bot.pickMember(groupOpenid, userOpenid)
this.e.bot.pickGroup(groupOpenid)
this.e.bot.getFriendMap()
this.e.bot.getGroupMap()
this.e.bot.getSystemMsg()
this.e.bot.setGroupAddRequest(flagOrSequence, approve, reason?, block?)
this.e.bot.setGroupBan(groupOpenid, userOpenid, duration?)
this.e.bot.getMuteMemberList(groupOpenid)
this.e.bot.uploadImage(file, opts?)
```

运行态标志（不建议作为长期 API 依赖）：

```js
this.e.bot.heartbeatTimer
this.e.bot.reconnectCount
this.e.bot.isReconnecting
this.e.bot.lastHeartbeatTime
this.e.bot._heartbeatMessageListener
this.e.bot._heartbeatMessageWs
this.e.bot.tokenExpireTime
this.e.bot.tokenRefreshPromise
this.e.bot.readOnlyMode
this.e.bot.defaultWsMode
this.e.bot.gatewayRateLimitedMode
this.e.bot.gatewayNetworkFallbackMode
this.e.bot.gatewayBusyFallbackMode
this.e.bot.disabledRuntime
this.e.bot.disabledReason
```

---

## 八、this.e.bot.sdk（qq-official-bot 实例）

稳定字段：

```js
this.e.bot.sdk.config          // { appid, secret, sandbox, timeout, maxRetry, dataDir, removeAt, delay, intents, logLevel }
this.e.bot.sdk.sessionManager  // 见第九节
this.e.bot.sdk.request         // axios 实例（interceptor 自动带 QQBot 鉴权头）
this.e.bot.sdk.ws              // WebSocket 实例
this.e.bot.sdk.self_id
this.e.bot.sdk.nickname
this.e.bot.sdk.status
this.e.bot.sdk.logger          // trace/debug/info/mark/warn/error/fatal
```

事件方法：

```js
this.e.bot.sdk.on(event, cb)
this.e.bot.sdk.once(event, cb)
this.e.bot.sdk.off(event, cb)
this.e.bot.sdk.emit(event, ...args)
this.e.bot.sdk.start()
this.e.bot.sdk.stop()
```

官方方法：

```js
this.e.bot.sdk.getSelfInfo()
this.e.bot.sdk.uploadMedia(target_id, target_type, file_data, file_type, decode?)

this.e.bot.sdk.sendPrivateMessage(user_id, message, source?)
this.e.bot.sdk.recallPrivateMessage(user_id, message_id)
this.e.bot.sdk.sendGroupMessage(group_id, message, source?)
this.e.bot.sdk.recallGroupMessage(group_id, message_id)

// 频道（guild）
this.e.bot.sdk.getGuildList()
this.e.bot.sdk.getGuildInfo(guild_id)
this.e.bot.sdk.getGuildMessage(channel_id, message_id)
this.e.bot.sdk.getGuildMemberList(guild_id)
this.e.bot.sdk.getGuildMemberInfo(guild_id, member_id)
this.e.bot.sdk.getChannelList(guild_id)
this.e.bot.sdk.getChannelInfo(channel_id)
this.e.bot.sdk.createDirectSession(guild_id, user_id)
this.e.bot.sdk.sendDirectMessage(guild_id, message, source?)
this.e.bot.sdk.getDirectMessage(guild_id, message_id)
this.e.bot.sdk.recallDirectMessage(guild_id, message_id, hidetip?)
this.e.bot.sdk.sendGuildMessage(channel_id, message, source?)
this.e.bot.sdk.recallGuildMessage(channel_id, message_id, hidetip?)
this.e.bot.sdk.addGuildMessageReaction(channel_id, message_id, type, id)
this.e.bot.sdk.reactionGuildMessage(channel_id, message_id, type, id)
this.e.bot.sdk.deleteGuildMessageReaction(channel_id, message_id, type, id)
this.e.bot.sdk.getGuildMessageReactionMembers(channel_id, message_id, type, id)
this.e.bot.sdk.getChannelSchedules(channel_id, since?)
this.e.bot.sdk.getChannelScheduleInfo(channel_id, schedule_id)
this.e.bot.sdk.createChannelSchedule(channel_id, schedule)
this.e.bot.sdk.updateChannelSchedule(channel_id, schedule_id, schedule)
this.e.bot.sdk.deleteChannelSchedule(channel_id, schedule_id)
this.e.bot.sdk.controlChannelAudio(channel_id, audio_control)
this.e.bot.sdk.setOnlineMic(channel_id)
this.e.bot.sdk.setOfflineMic(channel_id)
this.e.bot.sdk.getChannelThreads(channel_id)
this.e.bot.sdk.getChannelThreadInfo(channel_id, thread_id)
this.e.bot.sdk.publishThread(channel_id, title, content, format?)
this.e.bot.sdk.deleteThread(channel_id, thread_id)
this.e.bot.sdk.replyAction(action_id, code?)
```

SDK 中会抛 UnsupportedMethodError 的方法（官方群/好友不支持）：

```js
this.e.bot.sdk.getGroupMemberList(group_id)   // 抛错
this.e.bot.sdk.getGroupMemberInfo(group_id, member_id)  // 抛错
this.e.bot.sdk.getFriendList()                // 抛错
this.e.bot.sdk.getFriendInfo(friend_id)       // 抛错
```

插件额外挂到 sdk 的兼容方法：

```js
this.e.bot.sdk.pickFriend(userOpenid)
this.e.bot.sdk.pickGroup(groupOpenid)
this.e.bot.sdk.pickMember(groupOpenid, userOpenid)
this.e.bot.sdk.getSystemMsg()
this.e.bot.sdk.setGroupAddRequest(flagOrSequence, approve, reason?, block?)
this.e.bot.sdk.setGroupBan(groupOpenid, userOpenid, duration?)
this.e.bot.sdk.getMuteMemberList(groupOpenid)
this.e.bot.sdk.recallPrivateMessage(userOpenid, messageId)
this.e.bot.sdk.recallGroupMessage(groupOpenid, messageId)
```

---

## 九、this.e.bot.sdk.sessionManager

字段：

```js
sessionManager.access_token
sessionManager.wsUrl
sessionManager.retry
sessionManager.alive
sessionManager.heartbeatInterval
sessionManager.isReconnect
sessionManager.userClose
sessionManager.sessionRecord      // { sessionID, seq }
sessionManager.heartbeatParam     // { op, d }
```

方法：

```js
sessionManager.getAccessToken()
sessionManager.getWsUrl()
sessionManager.getValidIntends()
sessionManager.start()
sessionManager.stop()
sessionManager.connect()
sessionManager.reconnectWs()
sessionManager.sendWs(msg)
sessionManager.authWs()
sessionManager.startListen()
```

---

## 十、this.e.client

- `this.e.client` 是 bot 的兼容客户端对象（原型继承 `this.e.bot`），额外提供：

```js
this.e.client.getSystemMsg()   // 汇总所有机器人的加群申请（只轮询管理员/群主的群）
```

---

## 十一、安全边界

以下字段包含敏感凭证，禁止出现在群消息、日志、截图、图片、外部插件、任何公开位置：

```js
this.e.bot.sdk.config.secret
this.e.bot.sdk.config.appid
this.e.bot.sdk.sessionManager.access_token
this.e.bot.sdk.request.defaults.headers.Authorization
this.e.bot.sdk.ws 的握手鉴权头
```


---
## A1. 群管菜单

```text
#QQBot用户管理菜单 群管菜单
```

菜单内含命令与按钮：

| 命令 | 说明 |
| --- | --- |
| `#QQBot刷新已保存群聊昵称` | 批量刷新所有已记录群的官方群名（只刷新 info），按钮“刷新所有昵称” |
| `#QQBot刷新所有群身份` | 批量刷新所有群的 bot_state（只刷新身份），按钮“刷新所有群身份” |
| `#QQBot刷新所有群` | 同时刷新 info + bot_state |
| `#QQBot刷新全量群` | 只刷新全量已记录群的 bot_state |
| `#QQBot刷新群名 群openid` | 单个群刷新官方群名 |
| `#QQBot查看机器管理 页码` | 分页展示机器人为管理员/群主的群（每页 20 个） |
| `#QQBot群人数排行 页码` | 全部缓存群按人数从多到少分页，每页 20 个，无人数显示“未知人” |
| `#QQBot加群通知 开启/关闭` | 加群通知总开关 |
| `#QQBot加群通知方式` | 通知方式配置（见 A3） |

批量刷新规则：

- 同一机器人、同一类型（info / bot_state）只允许一个批量刷新队列；重复发送相同命令会拒绝并提示“已有……刷新队列正在执行，请等待完成后再试”。
- info 与 bot_state 是独立队列，可同时运行；`#QQBot刷新所有群` 同时占用两者，任一被占用即拒绝。
- 刷新完成后更新缓存并同步运行时 `Bot.gl`，`pickGroup()` 立即看到新数据。
- 每个群每类接口 10 分钟最多刷新一次（TTL）；`e.group.refreshinfo()` 忽略 TTL 强制刷新。

## A2. 群资料与机器人状态缓存（info / bot_state）

官方接口：

- `GET /v2/groups/{group_openid}/info`：群名、简介、分类、标签、成员数。
- `GET /v2/groups/{group_openid}/bot_state`：机器人 member_openid、入群时间、主动消息权限、收消息设置、角色。

缓存结构（`this.e.raw.qqbot_group_info` / `this.e.raw.qqbot_bot_state`）：

```js
info: {
  group_openid, group_name, group_finger_memo,
  group_class_text, group_tags, group_member_num,
  fetched_at, error
}
bot_state: {
  member_openid, joined_at, allow_proactive_msg,
  recv_msg_setting, member_role,
  fetched_at, error
}
```

`error` 结构：`{ status?, code?, err_code?, message, trace_id?, at }`。`bot_state.error.message === '不是管理员'` 表示机器人在该群不是管理员（非致命，缓存保留旧数据）。

自动刷新触发：

- info：机器人入群；普通群累计 20 条消息、全量群累计 200 条；首次收到 `GROUP_MSG_RECEIVE` / `INTERACTION_CREATE` / `GROUP_AT_MESSAGE_CREATE` / `GROUP_MESSAGE_CREATE`；群成员首次变动及累计 20 次；机器人首次发言及累计 10 次。每群每接口 10 分钟最多一次。
- bot_state：首次禁言、首次读取禁言列表、首次撤回非自身消息、首次主动获取加群申请、首次收到全量消息、群聊消息时缓存缺少机器人本体 openid。
- 接口无权限或不是管理员时保留旧缓存并标记 `error`，不影响原数据。

所有内部命令与事件通知显示群 openid 时同时显示缓存官方群名，格式 `官方群名(群openid)`。

## A3. 加群申请系统

事件：`GROUP_JOIN_REQUEST`，映射为 `request.group.add`，`unhandled event` 日志会带事件名。

注意：该事件**不能被动回复消息**（官方 `event_id` 回复会报 40034027），只用于记录与审批。

### 加群申请菜单

```text
#QQBot查看加群申请
#QQBot查看加群申请 待处理 1
#QQBot查看加群申请 已通过 1
#QQBot查看加群申请 已拒绝 1
#QQBot查看加群申请 无法处理 1
#QQBot查看加群申请 已失效 1
#QQBot查看加群申请 已过期 1
#QQBot查看加群申请 全部 1
#QQBot查看加群申请详情 序号/flag
#QQBot清空加群申请
#QQBot清空加群申请确认
```

- 状态：`pending`（待处理）、`approved`（已通过）、`declined`（已拒绝）、`unprocessable`（无法处理）、`invalidated`（已失效）、`expired`（已过期）。
- 每条记录有稳定 `store_order` 序号，重启不变；审批和详情均支持“序号”或完整 `join_request_id`。
- 详情页展示本地审批状态 JSON 和官方原始 JSON（`official_payload`，独立保存并递归合并多次来源字段）。
- 待处理列表页对首条提供“同意首条 / 拒绝首条”快捷按钮。

### 审批

```text
#QQBot审批加群 序号/flag 通过
#QQBot审批加群 序号/flag 拒绝 [理由]
#QQBot审批加群 序号/flag 拒绝并拉黑 [理由]
```

- 官方审批接口 `POST /v2/groups/{group_openid}/approval_join_request/{member_openid}`。
- 错误映射：
  - `11293` / “机器人非群成员” → 记录状态 `unprocessable`，回复“无法处理：机器人非群成员”。
  - `120162002` / `already agree` → 记录状态 `approved`，回复“已通过加群申请（官方已通过该申请）”。
- 审批命令发错机器人时，会查找记录归属并提示目标机器人 QQ 与 `@me` 返回的跳转链接：
  ```text
  该加群申请属于机器人xxx(名称)，请前往机器人xxx处理
  [点击前往](@me share_url 或 https://q.qq.com/qqbot/profile/?robot_uin=机器人QQ)
  ```
  `/users/@me` 结果按机器人缓存到进程重启（`qqbotMeInfoPromises`）。
- 同一个人同一群重复申请：只要同意了最新一个，其他 pending 立即失效（invalidated）。

### 兼容 API

```js
this.e.client.getSystemMsg()                 // 全部机器人的申请（只轮询缓存角色为 admin/owner 的群）
Bot[xxx].getSystemMsg()                      // 单机器人
e.group.getjoinMsg() / (false) / (0)         // 仅本群已收到的被动事件
e.group.getjoinMsg(true) / (1)               // 强制请求本群 join_request_list
Bot.pickGroup(xxx).getjoinMsg(force?)        // 同 pickGroup
Bot[xxx].setGroupAddRequest(flag, approve, reason?, block?)   // 审批；approve/decline、true/false、1/0、yes/no
this.e.bot.sdk.getSystemMsg() / setGroupAddRequest(...)       // sdk 同样挂载
```

- 申请列表接口无权限时静默处理：先刷新 bot_state 确认管理员，再最多重试一次，仍失败就跳过，不再报 `11703 not group admin`。
- 本地无记录时只对“7 天内活跃且缓存角色为 admin/owner”的群补拉列表。

### 加群通知（默认关闭）

```text
#QQBot加群通知 开启/关闭
#QQBot加群通知方式
#QQBot加群通知方式 群内
#QQBot加群通知方式 本人私信
#QQBot加群通知方式 所有主人
```

- 群内（默认）：优先发送到申请所在群；群不允许主动消息或发送失败时降级 `sendMasterMsg` 通知所有主人。
- 本人私信：主动私信执行设置命令的管理者 openid；失败或未设置接收人时降级所有主人。
- 所有主人：直接 `sendMasterMsg`。
- 通知为原生 Markdown（非代码块），带 `qqbot-cmd-input`（详情/待处理/同意/拒绝/拒绝并拉黑）与两排按钮；群名、用户、验证信息转义 Markdown 特殊字符。
- 通知正文包含“官方原始JSON”代码块，以及字段名含 risk/warning/danger/security/fraud/abuse/blacklist 的风险相关字段代码块。
- 通知显示 `[机器人QQ]` 与 `@me` 缓存机器人名称。
- 通知为内部发送，不附加“消息后缀”配置，不走外部模板钩子。

## A4. 群聊主动消息

```text
#QQBot普通设置 群聊主动菜单
#QQBot群聊主动菜单
#QQBot群聊主动配置
#QQBot群聊主动配置 Markdown 内容
#QQBot群聊主动配置 button JSON
#QQBot群聊主动预览
#QQBot群聊主动发送 数量
#QQBot群聊主动结果 1
#QQBot群聊主动查看可主动群 页码
```

- 只向缓存 `allow_proactive_msg === true` 的群发送，间隔 2 秒，结果按运行保存最多 100 次。
- 可主动群列表分页展示官方群名、openid、机器人角色。
- 平台禁止单发按钮：必须先设置消息内容才能开启按钮。

## A5. 官方接口记录

```text
#QQBot查看官方接口记录 页码
```

- 只枚举全量消息已记录的群，输出 `groupInfoStore` 保存的完整 `bot_state` JSON（即 `#QQBot刷新所有群身份` 的结果），统一放在一个 `text` 代码块内，每页 10 个。
- 按钮：刷新身份（`#QQBot刷新全量群`）、返回清查记录。

## A6. 高级搜索

```text
#QQBot高级搜索 内容
#QQBot高级搜索 内容 页码
```

- 原 `#QQBot搜索用户` / `#QQBot全局搜索` 入口统一改为 `#QQBot高级搜索`。
- 群结果优先使用 `groupInfoStore` 官方缓存显示官方群名、成员数、群简介；用户结果保留昵称、openid、所在群列表（带群名）。
- 首条为群时快捷按钮为“群聊发言 + 拉黑群”，首条为用户时为“私聊发言 + 拉黑用户”。

## A7. 所有群最近发言快照

- `#QQBot查看所有群最近发言` 取消 500 页硬上限，改为最多 5000 页。
- 每 500 页为一个窗口，窗口首次加载时生成 2 分钟快照（`RECENT_GROUP_SNAPSHOT_TTL`）；缓存期内同一机器人同一窗口页码结果一致。
- 第 501 页起才懒加载后续历史，不预读全部。
- 删除发言、清空缓存会立即失效对应机器人快照。

## A8. DAU 增强

- `GROUP_DEL_ROBOT` 正确计入“减少群数”（按群 openid 去重，同一群多次退按一个群）。
- `/qbotdau`、`/qbotdaupro` 支持日期输入：`08-10`、`0810`（支持 `/`、`.` 分隔）。
  - 只允许查询最近一年内（含今天）的日期。
  - 未来日期、格式错误、超过一年、无历史数据分别提示。
- `#QQBotdau` 按钮：私聊触发所有人可点；群聊按钮仅命令触发人可点。
- `#QQBot调用统计`、`#QQBot用户统计` 未开启时回复“未开启”，不再静默。
- DAU 日期口径修复（见第一节）：不再使用 `getTime()` 的 +8 小时，与 node-schedule 本地（北京时间）零点一致；写入前自检跨日归档，昨天不会累加到今天。
- `numToChinese` 补全到 31（“最近三十一天”）；DAU 天数最大 31（取 30 天窗口时不会出现 31 以上）。

## A9. 禁言与兼容 API

```js
e.group.muteMember(userOpenid, duration?)       // 当前群禁言，duration 秒，0 解禁
Bot[xxx].setGroupBan(group_openid, user_openid, duration?)
Bot[xxx].pickGroup(x).pickMember(y).muteMember(duration?)
e.group.getMuteMemberList()                     // 禁言列表
Bot[xxx].getMuteMemberList(group_openid)
this.e.bot.sdk.setGroupBan(...) / getMuteMemberList(...)
```

- 时长范围 0~2592000 秒（30 天），按系统时间生成 RFC3339 到期时间。
- 时长为 0 解禁：先 `del`，失败则 `update` 且到期时间为当前时间。
- 官方限制：禁言设置 60 QPM，禁言列表 30 QPM。

## A10. segment.txt 与帮助 raw 模式

- `segment.txt("文本")`：原生 Markdown 模式下发送普通文本；只能与 `segment.image` 组合成图文，与其他 segment 混用时不处理。
- `#qbot帮助`：每次重启后首次触发且当前不是 raw 原生 Markdown 时，默认尝试用 raw 模式发送；成功则额外发送“已自动开启原生 Markdown”提示与恢复按钮；失败回退到下次重启前不再尝试。

## A11. 其他实现项

- `this.e.raw.v_id`：群聊/私聊事件取触发用户 openid 计算虚拟 ID（复用缓存），频道事件不写；无 @ 时不改变 `this.e.at` / `this.e.raw.at_id`。
- `this.e.raw.is_has_new_join_request`：收到新加群申请且未查看时为 `true`；调用 `getjoinMsg` / `getSystemMsg` 后清除。
- 群消息附件 `attachments` 映射为图片 segment，`this.e.img` 可获取群/私聊图片 URL 数组。
- `#QQBot全量查看` 展示机器人角色、允许主动消息、机器人 member_openid 与缓存状态。
- `#QQBot全量消息设置` 显示机器人 member_openid。
- `#QQBot全量清/查记录` 菜单增加“刷新全量群”（刷新全量已记录群的 bot_state）。
- 按钮回调（INTERACTION_CREATE）触发群 info 刷新。
