# 执行可靠性协议（让位 / 分段输入 / 回执 / generation）

本文描述 `feiniu-computer-use` 0.2.0 的代码实际做的事。

> 验收状态见 README 末尾「当前状态」：静态测试已通过；真实桌面只观察过"空闲时动作 / 分段输入计数 / 重启后不重放 / 重复动作防护 / 越界坐标"；"主人动鼠标或按键时让位、长文本中途接管、Esc、锁屏"仍只有静态测试证据。

## 1. 统一让位

激活窗口、移动鼠标、点击、拖动、滚动、按键、输入、`set_value` 和启动程序，执行前都先经过同一个检查：

1. Esc / 锁屏检查；
2. 等待主人静止——用 Windows 最后输入时间 `GetLastInputInfo`、当前按住的键/鼠标键判断，肥牛自己 `SendInput` 发出的事件会被排除；
3. （依赖旧观察的输入）光标是否被移动过。

等到 `user_idle_max_wait_ms` 仍未停手，就**不发送任何输入**并返回 `user_active`。让位不是故障：肥牛会如实说"主人在操作，我先让位"，旧观察作废，等主人停手后重新观察。

## 2. 分段输入

逐字输入模式按 `type_chunk_size` 个 Unicode 字符一段发送（按字符计，不是字节，也不是 UTF-16 单元；`\r\n` 算 2 个，不会被拆开）。每段之间停 `type_chunk_gap_ms` 并重新检查 Esc、锁屏、主人是否开始操作或移动鼠标；一旦需要让位就停止后续输入，回执给出 `typed` / `input_total`，肥牛据此说"已输入 n/m 字，其余没有输入"，并只补缺的部分。控制字符在发送任何内容之前整体拒绝。

## 3. 统一回执字段

成功写在 `result`，失败写在 `error.details`：

`yielded`、`waited_ms`、`yield_source`、`typed`、`input_total`、`completed`、`foreground`、`cursor`、`stopped_reason`（`user_active` / `esc` / `locked` / `timeout` / `worker_error`）、`result_known`、`injected`、`generation`。

`timeout` 与 worker 崩溃由 JS 侧标记为 `result_known=false`。工具文本、提示条、审计日志和 `computer_doctor` 只读这些字段，不从异常文字猜状态。

## 4. 结果未知不重放

超时、worker 崩溃/重启、注入之后的内部错误都标为"结果未知"，插件不会自动重试；旧观察、待确认动作和"上一个窗口"全部作废。worker 每次启动有新的 `generation`，观察和待确认动作都记着自己的 generation。执行期间被 Esc/停止/重启打断的回执标为过期，不再自动观察。

## 5. 热更新

五个让位/分段参数（`user_idle_yield`、`user_idle_ms`、`user_idle_max_wait_ms`、`type_chunk_size`、`type_chunk_gap_ms`）改完立刻通过 `configure` 推给运行中的 worker，不重启、不作废观察。自主控制开关仍只在 worker 启动时传入。

## 6. 审计与提示条

审计日志（`data/action-log-*.jsonl`）带 `facts` 字段，只含数量、分类、前台进程名和光标，没有输入原文、没有窗口标题；`text` / `value` 参数只记长度，长度按 Unicode 字符数计（和回执、摘要同一单位）。提示条会显示"等待主人停手…""你在操作，肥牛先让位（已输入 n/m 字）""结果未确认，肥牛先重新观察"，同样不含原文。

## 7. worker 侧坐标校验

`click` / `click_element` / `drag` / `scroll` / `move_mouse` 的目标只要不在整个虚拟屏幕内（多显示器的物理像素外包矩形），worker 在等待主人和发送任何输入**之前**就返回 `out_of_screen`（`injected=false`，`result_known=true`），非数字坐标返回 `bad_args`。插件层原有的截图范围检查仍在前面。无法取得屏幕尺寸时跳过校验而不是卡住。`computer_doctor` 会显示"worker 坐标范围校验=有/无"。

## 8. `hello` 不会倒退 generation

缺少、格式错误、为 0 或比当前更旧的 `generation` 都被忽略（回执里带 `generation_ignored`），generation 在一个 worker 进程里只增不减；插件正常启动时总是传新的 generation。

## 9. 旧观察被重启作废时的提示

观察在 worker 退出/重启之后被拒绝时，会明确说"桌面执行层（worker）已重启或退出，动作没有发送，也没有被重放"；观察若已被某个动作用掉，则如实说"已经执行过动作"。

## 已知限制

- 系统"最后输入时间"分不清肥牛自己和主人的输入：只有晚于肥牛最后一次注入 60 ms 以上的输入才算主人的。主人恰好在两次注入之间的极短窗口里按键，可能被当作肥牛自己的输入；按住的键、鼠标键和光标位移仍会被检测到。
- 键盘接管只能在分段之间（`type_chunk_gap_ms`）检测到；鼠标移动在每段之间检测。段间隔设得太小会漏检。
- 剪贴板输入模式是一次粘贴，**不能分段，也不能中途停止**（`computer_doctor` 显示"剪贴板模式可分段=否"）。
- 没有单独的 `user_active_after_action` 状态：动作完成之后主人接管，要靠下一步的让位检查和重新观察发现。
- 切换窗口（`activate_window`）也会让位，所以主人一直在动鼠标时连"观察"都可能返回 `user_active`；这是预期行为。
- 锁屏拒绝没有在真实锁屏上验证过。
