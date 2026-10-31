# TokenBar — 菜单栏 Z.ai API 用量插件（原型 v3）

macOS 菜单栏（右上角）小插件，显示 **Z.ai API 账户用量**（账户级、覆盖所有 agent，
不限于 ZCode——其他 agent 用同一个账号的 API key 消耗的用量都算在内）。

菜单栏标题：`⚡5h% · 周% ❄`（两个窗口百分比 + peak 状态图标）。
点击展开下拉面板：今日 / 近 7 天总用量与调用次数、按模型明细（GLM-5.3、Flash…）、
今日逐小时用量走势（字符走势图）。

## 构建与运行

```bash
swiftc -O -o TokenBar main.swift
./TokenBar        # 退出：点菜单栏图标 → 退出 TokenBar（或 ⌘Q）
```

## 数据来源

`GET https://api.z.ai/api/monitor/usage/model-usage?startTime=…&endTime=…`

- 与 ZCode 客户端 / z.ai 官网控制台同款接口，账户级统计
- API key 自动从 `~/.zcode/v2/config.json`（`builtin:zai-coding-plan` → options.apiKey）读取
- 请求头 `authorization` 直接传 key（不加 Bearer 前缀）
- 时间参数格式 `yyyy-MM-dd HH:mm:ss`（本地时区），今日与近 7 天各查一次
- 每 5 分钟自动刷新，点开菜单或「立即刷新」也会拉取
- 接口不可用时显示模拟数据（面板标题会标注），便于纯 UI 评审（`TOKENBAR_MOCK=1` 同效）

## Peak 时段（官方规则，本地换算）

peak/off-peak 计费时段的显示（接口不返回，按官方文档静态内置，规则集中在
`PeakPolicy`，官方调整时只改这一处）：

- 官方定义：peak = **周一至周五 14:00–18:00 UTC+8**（新加坡时间，无夏令时），
  其余时间（晚间、清晨、周末）均为 off-peak；计费倍率 GLM-5.3 为 peak 3× / off-peak 1×，
  GLM-5.3-Flash 为 peak 1.2× / off-peak 0.4×
- 促销覆盖期：`promos` 列表内置「全天 off-peak」的特殊期（如 2026-09-25 ~ 10-07），到期自动失效
- 菜单栏标题百分比后跟状态图标：peak 🔥（橙 flame）/ off-peak ❄（青 snowflake），
  SF Symbol 着色嵌入，取不到符号时退回 emoji
- 下拉菜单「Peak 时段」小节：当前状态 + 倒计时、换算到**本机时区**的时段（大偏移时区
  会跨午夜且星期平移，如美西 → 周日至周四 23:00–03:00（+1d））、计费倍率说明
- 判定为纯本地计算（在 SGT 日历中进行，不受本机时区/夏令时影响），mock 模式下照常显示；
  标题与菜单随现有 30s 渲染定时器刷新，倒计时保持新鲜

## 重置卡（Reset Card）

z.ai 官网订阅页「Usage Reset」卡片（5 小时 / 周 两种重置卡）的同款接口，已接入：

- `GET  /api/biz/customer-package-reset/list?targetType=PERSONAL` → 查询可用重置卡
  （返回 `fiveHourResets` / `weekResets`，每张含 `recordId`、`grantType`、`expireTime`、`available`）
- `POST /api/biz/customer-package-reset/use` → 使用一张，body：
  `{targetType:"PERSONAL", resetType:"FIVE_HOUR"|"WEEK", recordId, grantType, requestId:<uuid>}`

行为与官网一致：周卡使用后同时恢复 5h 额度；多张可用时自动优先消耗**最早到期**的一张；
菜单里点「使用…重置卡」先弹确认框，成功后自动刷新窗口百分比。
注意：该端点未在官方文档公开（属于官网控制台内部接口），随时可能变动。


## 与 Coding Plan 窗口的关系

之前版本显示的 5h/周窗口是 **Coding Plan** 配额（`/api/monitor/usage/quota/limit`），
本版本已改为 **API 账户总用量**（用户主要需求：其他 agent 也在消耗同一账号）。
如需两者并存，把 quota 接口的解析加回来即可（代码历史里有实现）。

## 已知简化（原型阶段）

- 官方未提供余额/费用端点（客户端代码里没有），只能显示用量，不能显示剩余额度
- 每次刷新串行两个 HTTP 请求；走势图按「今日」逐小时，7 天未做按天走势
- key 读取只支持 zai-coding-plan 一个 provider，多 key 账户未处理
