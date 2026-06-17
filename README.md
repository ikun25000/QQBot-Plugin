<div align="center">

# TRSS-Yunzai QQBot Plugin

TRSS-Yunzai QQBot 嘿群主壳 插件

</div>

# Tip

建议使用TRSS原版,此版本为`嘿壳`版,会在`任意时间`直接进行罚壳,且`不会`与TRSS一致


---

**功能优化**

- 修复重连成功误判、白名单拒连反复重试
- 适配 ref_idx 撤回与 callfl，避免撤回失败
- 好友删除后自动标记为不可召回，避免无效发送
- invite 拉入/踢出同群去重，排行支持分页查看
- 召回设置支持时间偏移（1-23 小时），偏移后所有时间跟随调整
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

**关键命令速查**

```text
#QQBot普通设置 群事件 开启
#QQBot全量拉黑菜单
#QQBot全量拉黑 群openid
#QQBot全量删黑 群openid
#QQBot全量消息设置 忽略@全体的指令 开启
#QQBot召回设置 时间偏移 8
#QQBot普通设置 查看拉入排行
#QQBot普通设置 查看踢出排行
```



## 自用人机群主版
   - 新增QQ机器人认证错误处理，破冰，召回功能，发送语音适配官方文档
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

>为了感谢龙虾，新增模拟龙虾在线。优化全量部分内容，优化多机器人配置，修复非本适配器可以触发命令的问题

>修复了dau无法统计的bug 修复了原生MD加模板按钮，单发按钮和原生MD的问题 修复了点击回调按钮msg_id越权的问题

>新增发送嘿壳的文件

>原生按钮开放，新增按钮生成器

>由于龙虾占用腾讯服务器，增加了ws断线检测和通知，24小时内没有次数了，机器人会被罚壳。已经增加嘿壳的自动重连(应该不会掉线？)

>新增掉线检测相关和全量消息相关命令，交互式按钮，请开启原生MD后使用 #qbot帮助查看

```javascript
// 1. 网络文件，自动文件名
segment.file("https://example.com/file.pdf")

// 2. 网络文件，自定义文件名(利用机制发送嘿壳.jpg，嘿壳.mp3)
segment.file("https://bbs.hycdn.cn/image/2026/01/24/500031/b3fcde82eed9639923cf532d84d6412e.jpg?a=https://嘿壳.jpg","无效参数.jpg")
segment.file("http://game.gtimg.cn/images/up/act/a20170301pre/media/bg.mp3","嘿壳.mp3",1)

// 3. 本地文件，绝对路径
segment.file("/root/yunzai/data/file.pdf", "文件.pdf")

// 4. 本地文件，相对路径
segment.file("./data/file.pdf", "文件.pdf")

// 5. file:// 协议本地文件
segment.file("file:///root/yunzai/data/file.pdf", "文件.pdf")

// 6. 强制分片上传
segment.file({
  file: "https://example.com/large.zip",
  name: "大文件.zip",
  force_chunk: 1
})

// 7. 不强制分片上传
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
// 参数3: force_chunk (0=自动判断, 1=强制分片上传)
// 参数4: recall_time (撤回时间，单位：秒，0=不撤回)
```

### 更多示例
```javascript
// 1. 普通文件，60秒后撤回
segment.file("https://example.com/data.zip", "人机模块.zip", 0, 60)

// 2. 强制分片上传，30秒后撤回
segment.file("https://example.com/large.mp4", "人机视频.mp4", 1, 30)

// 3. 本地文件，120秒后撤回
segment.file("file:///data/report.xlsx", "人机群主.xlsx", 0, 120)

// 4. 对象形式参数
segment.file({
  file: "https://example.com/file.txt",
  name: "文本.txt",
  force_chunk: 0,
  recall_time: 45
})

// 5. 私聊文件（自动分片），10秒后撤回
segment.file("https://example.com/secret.doc", "机密的嘿壳模块.doc", 0, 10)
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
4. `Model/template/groupIncreaseMsg_default.js`中`自定义入群发送主动消息`
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
10. `config/QQBot.yaml`中使用前台日志消息过滤（~~自欺欺人大法~~），将会不在前台打印自定的消息内容，防log刷屏（~~比如修仙、宝可梦等~~），也可以使用`#QQBot添加/删除过滤日志垃圾机器人`
    - **自定义消息采取完整消息匹配，非关键词匹配**
    - **非必要不建议开启此项**
      > 注意：_只会过滤部分QQBot的日志_
    ```yml
    filterLog:
      BotQQ:
        - 群主是机器人
        - 垃圾bot
        - 垃圾Bot
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
17. `config/QQBot.yaml`中`bus`是否使用ws中转站
- 使用ws中转站可以降低成本,只需要一台低性能云服务器即可通过IP白名单验证,后端可使用本地服务器
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
3. 打开：[QQ 收缩平台](https://q.qq.com) 创建 Bot：  
   ① 创建机器人  
   ② 开发设置 → 得到 `机器人QQ号:AppID:Token:AppSecret`
4. 输入：`#QQBot设置机器人QQ号:AppID:Token:AppSecret:[01]:[01]`

## 格式示例

- 机器人QQ号 `114` AppID `514` Token `1919` AppSecret `810` 群Bot 频道私域

```
#QBot设置114:514:1919:810:1:1
```

## 高阶能力

<details><summary>Markdown 消息</summary>

已经嘿壳，感谢龙虾🦞

</details>

## 使用教程

- #QQBot账号
- #QQBot设置 + `机器人QQ号:AppID:Token:AppSecret:是否群Bot:是否频道私域`（是1 否0）
- #QQBotMD + `机器人QQ号:模板ID`
- #QQBotMD + `机器人QQ号:raw` 开启原生MD
- #QQBotMD + `机器人QQ号:` 关闭原生MD
