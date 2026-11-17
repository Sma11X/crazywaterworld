# 前端架构与渐进迁移

## 当前边界

控制台仍由一个 Node.js 进程提供 HTML、HTTP API、SSE 与游戏任务执行。新增 React 客户端不持有游戏凭证，不直接连接游戏，不改变后端账号队列、预算账本或重连调度。

目前完整迁移的页面是 **登录设置**。其他页面继续使用原有静态标记和原生 JavaScript，后续按页面迁移，避免两套系统同时写入同一片 DOM。

| 路径 | 职责 |
| --- | --- |
| `src/ui/client/entry.ts` | 监听页面可见性和账号身份，首次打开登录设置时动态加载 React 页面 |
| `src/ui/client/pages/` | React 页面与局部 CSS Modules |
| `src/ui/client/contracts/` | 接口类型、响应校验与表单校验 |
| `src/ui/client/lib/api.ts` | 显式绑定账号的 HTTP 请求；不自动重试写入 |
| `src/ui/client/lib/time.ts` | Day.js 北京时间展示；不替换后端计时与换日规则 |
| `src/ui/theme.css` | Tailwind v4、主题变量与通用控件样式 |
| `src/ui-assets.mjs` | 提供生成的客户端资源、gzip、ETag 与缓存头 |
| `src/ui/dist/client/` | Vite 生产产物，应随源代码一起提交 |

原页面在 `login-settings-root` 的 `data-account` 上发布当前账号；客户端入口通过 MutationObserver 读取。入口同时观察导航的可见状态，不另建账号轮询、SSE 或路由系统。React 挂载后独占根节点内部，原脚本不再直接读写表单。

## 构建与检查

Node.js 要求为 **20.19+（20.x）或 22.12+**；建议使用满足要求的 LTS 版本。

- `npm run build:ui`：esbuild 构建现有服务端标记，Tailwind 编译共享样式，Vite 构建客户端分块。
- `npm run build:client`：只构建客户端。
- `npm run typecheck`：账本 JSDoc 检查及全部 UI TS/TSX 的严格类型检查。
- `npm run check:ui`：检查已迁移代码、客户端资源服务和新增测试的 Biome 规范。
- `npm run format:ui`：对上述明确范围执行格式化、导入整理和安全修复。
- `npm run test:client`：接口契约、账号隔离、冲突、未知保存结果、日期显示及静态资源测试。
- `npm run test:client:browser`：构建并使用隔离账号运行浏览器验收，截图保存在 `output/react-client/`。
- `npm run test:offline`：构建、类型检查及全部核心离线回归，包含新客户端测试。

Biome 的 `files.includes` 是迁移范围清单。不要为快速通过检查而全局关闭推荐规则，也不要一次格式化未迁移的大文件。共享 UI TSX 已纳入 TypeScript 检查，存量 JS 通过导入推断类型；后端严格检查仍由独立账本配置承担。

修改客户端、TSX 或主题后重新构建并重启控制台。客户端资源在服务启动时形成快照，更新后旧页面应刷新。资源入口采用 ETag 重新验证，带内容哈希的分块和样式使用长期缓存。首屏不预加载 React；当前预算测试限制入口 gzip 小于 4 KiB，首张页面的单个 JS 分块 gzip 小于 115 KiB。这是体积预算，不是运行速度承诺。

## 状态与请求规则

1. API 客户端必须捕获明确的账号 ID，不依赖服务端当前选中账号。以后引入角色缓存时还须纳入区服/角色身份。
2. 只读请求在切号或离开页面时可以取消；同账号离开再返回保留编辑草稿。
3. 保存显式携带 `revision`。版本冲突时保留用户草稿，用户可点击“载入最新设置”放弃草稿后重读，不能静默覆盖。
4. 保存发送后不自动重试，也不把切号或取消请求理解为写入已撤销。迟到的响应只能更新原账号页面；连续提交由同步锁拦截。
5. 调度、消费和登录恢复保持后端控制；React Effect 只承担读取与订阅，不触发游戏消费。
6. 服务端返回的数据先经契约校验；表单字段显示校验错误，并由服务端再次验证。

## 样式与日期

普通布局和通用控件使用 Tailwind 与现有组件。复杂页面布局放入局部 `.module.css`，使用现有主题变量，并放在 `page` 层；不在每个 CSS Module 中再次导入 Tailwind。全局主题、颜色和控件外观仍在 `theme.css` 维护。

Day.js 仅负责界面格式化，通过 `utc` 与 `timezone` 插件明确使用 `Asia/Shanghai`。游戏请求时间、心跳、倒计时和预算换日继续沿用现有后端实现及服务器时间偏差。

## 后续迁移顺序

下一步可迁移账号卡片及详情，再迁移配置编辑器、运行日志和地图。每次迁移先确定状态归属与接口契约，补充账号切换和失败场景验收，再移除对应旧脚本。请求缓存和列表虚拟化在发现重复请求或渲染瓶颈后按需引入。
