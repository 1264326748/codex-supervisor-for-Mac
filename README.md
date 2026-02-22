# codex-supervisor-for-Mac（任务主管控制台）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Platform: macOS](https://img.shields.io/badge/Platform-macOS-0f172a)](https://github.com/1264326748/codex-supervisor-for-Mac)
[![Issues](https://img.shields.io/github/issues/1264326748/codex-supervisor-for-Mac)](https://github.com/1264326748/codex-supervisor-for-Mac/issues)
[![Stars](https://img.shields.io/github/stars/1264326748/codex-supervisor-for-Mac?style=social)](https://github.com/1264326748/codex-supervisor-for-Mac/stargazers)

一个本地桌面控制台，用来把“一个复杂目标”拆成多窗口并行执行任务，统一观察输出、处理确认、回收结果。

> English: A local desktop control plane that coordinates one supervisor terminal and multiple worker terminals, with real-time logs, approval queue, structured dispatch, and recovery.

---

## 这个项目解决什么问题

在多终端并行执行时，经常会遇到这些问题：

1. 子任务分配混乱，谁做什么不清晰；
2. 多窗口输出难看、难追踪；
3. 确认提示分散在各终端里，容易漏处理；
4. 窗口崩溃或重开后，进度衔接困难。

本项目的目标就是把这些痛点集中收敛到一个桌面应用里：

- 左侧创建会话并管理运行时；
- 中间看拓扑 + 各窗口实时输出并可手动插话；
- 右侧统一处理待确认队列（支持批量）。

---

## 核心能力

1. 输入目标 + 执行窗口数量，一键创建会话；
2. 启动 1 个主管窗口 + N 个执行窗口；
3. 主管结构化分解后自动下发执行任务；
4. 识别确认提示并汇总到右侧队列（支持批量 1/2/3）；
5. 实时查看 supervisor / worker 输出，支持直接发送新指令；
6. 支持会话落盘、日志回放、重启后重连 tmux 会话；
7. 对示例占位下发做拦截，避免误派发。

---

## 最新稳定性增强（2026-02）

- 主管继续建议默认自动续跑，减少“发了命令但主管卡住”；
- 主管遗留继续建议待处理会自动解阻塞；
- 增加“手动发送但被 pending 阻塞”的日志与前端提示；
- 增加“发送后无新输出超时”提示；
- 严格拦截占位下发（例如“具体执行指令”“新的执行指令”）；
- 结构化下发支持 `dispatch_json` / `dispatch_batch_json` / `dispatch_all_json`，并带去重。

---

## 技术栈

- Electron（桌面主进程 + 安全桥接）
- React + Vite（渲染层）
- tmux / subprocess 运行时
- Node.js（编排、解析、事件落盘）

---

## 目录结构

```text
electron/
  main.js                        # Electron 主进程入口
  preload.cjs                    # 渲染层桥接
  orchestrator/                  # 运行时编排、下发、确认处理
  ipc/                           # IPC 注册
  store/                         # 会话与日志落盘
renderer/
  src/                           # React 页面与组件
shared/
  parsers.js                     # 结构化解析器
tests/
  *.test.mjs                     # 单元测试
scripts/
  build-local-launcher.sh        # 生成本地 .app 启动器
```

---

## 本地运行

### 1) 安装依赖

```bash
cd "/Users/ywlukiya/Projects/codex-supervisor-desktop"
pnpm install
```

### 2) 开发模式

```bash
pnpm dev
```

### 3) 构建

```bash
pnpm build
```

### 4) 测试

```bash
pnpm test
```

### 5) 生成可双击启动的本地应用（macOS）

```bash
pnpm app:launcher
```

生成路径：

`/Users/ywlukiya/Applications/任务主管控制台.app`

---

## 运行前提

1. 建议系统可用 `tmux`（不可用时会回退 subprocess）；
2. 需要已安装 `codex` 命令；
3. 建议在目标工作目录下创建会话，避免在错误路径执行。

---

## 常见排查

### 双击后秒退

```bash
tail -n 200 "/tmp/codex-supervisor-desktop-launcher.log"
tail -n 200 "/tmp/codex-supervisor-desktop-main.log"
```

### 白屏

```bash
tail -n 200 "/tmp/codex-supervisor-desktop-main.log"
```

### 主管看起来“无响应”

重点看事件日志里是否出现：

- `manual_input_blocked_by_pending`
- `manual_input_no_output_timeout`
- `approval_auto_continued`

---

## 开源协作

欢迎提 Issue / PR。建议先看：

- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- [SECURITY.md](./SECURITY.md)

---

## 项目路线（Roadmap）

- [ ] 提供安装包自动打包流程（Release 附件）
- [ ] 增加会话筛选与关键事件过滤
- [ ] 增加更细粒度的策略配置面板（按窗口/提示类型）
- [ ] 补充更多端到端稳定性测试样例

---

## License

MIT License，见 [LICENSE](./LICENSE)
