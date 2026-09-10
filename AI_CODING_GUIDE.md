# RD App — AI 编码规范与审查指南

> 本文件供 AI 助手（Claude / Trae 等）阅读，约束其代码生成与修改行为，确保风格统一、不破坏现有功能。
> 每次修改代码前先读本文档，修改后按「审查流程」自检。

---

## 1. 项目概述

| 项 | 值 |
|----|----|
| 应用类型 | Tauri 2 + React 19 桌面应用（SSH/SFTP 远程文件管理器） |
| 前端框架 | React 19 + TypeScript 5.8（严格模式） |
| 状态管理 | Zustand 5 |
| 国际化 | react-i18next 17 + i18next-browser-languagedetector（zh / en） |
| 图标 | lucide-react |
| 构建 | Vite 7 |
| 测试 | Vitest 2 |
| 后端 | Rust（edition 2021）+ Tauri 2 |
| 后端检查 | cargo fmt + cargo clippy |

---

## 2. 目录结构

```
remote/
├── src/                          # 前端源码
│   ├── components/               # React 组件
│   │   ├── plugin/               # 插件系统组件（Sandbox、DevConsole 等）
│   │   ├── App.tsx               # 根组件
│   │   ├── SettingsDialog.tsx    # 设置对话框（含语言切换）
│   │   └── ...
│   ├── hooks/                    # 自定义 hooks
│   ├── i18n/                     # 国际化
│   │   ├── index.ts              # i18next 配置
│   │   └── locales/
│   │       ├── zh.json           # 中文翻译
│   │       └── en.json           # 英文翻译
│   ├── store/                    # Zustand stores（hostStore、themeStore 等）
│   ├── styles/                   # CSS
│   │   ├── finder.css            # 主样式（含 CSS 变量、表单、对话框等）
│   │   ├── filebrowser.css
│   │   ├── terminal.css
│   │   └── ...
│   ├── theme/
│   │   └── palette.ts            # 主题调色板（定义 --bg-* 等 CSS 变量）
│   ├── types/                    # 全局 TypeScript 类型
│   ├── utils/                    # 工具函数 + __tests__/ 单元测试
│   └── main.tsx                  # 入口（导入 themeStore 和 i18n）
│
├── src-tauri/                    # 后端 Rust
│   └── src/
│       ├── lib.rs                # Tauri 命令注册
│       ├── plugin/               # 插件系统
│       ├── ssh/                  # SSH 连接
│       ├── sftp/                 # SFTP
│       ├── storage/              # 持久化（hosts、settings、credentials）
│       ├── tunnel/               # 隧道
│       └── pty/                  # 终端 PTY
│
├── package.json                  # 前端依赖 + scripts
├── tsconfig.json                 # strict + noUnusedLocals + noUnusedParameters
└── vite.config.ts
```

---

## 3. 前端编码规范

### 3.1 TypeScript 严格模式

`tsconfig.json` 启用了：
- `strict: true`
- `noUnusedLocals: true` — 禁止未使用的局部变量
- `noUnusedParameters: true` — 禁止未使用的函数参数
- `noFallthroughCasesInSwitch: true`

**AI 约束：**
- 所有变量/参数必须被使用，否则 `tsc` 报错。
- 类型必须显式，禁止 `any`（除非用 `// eslint-disable` 注释说明理由）。
- 优先使用 `type` 而非 `interface`（项目风格）。

### 3.2 React 组件模式

```tsx
import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Check } from 'lucide-react';

export function MyComponent() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return <div ref={ref}>...</div>;
}
```

**规则：**
- 使用函数组件 + Hooks，禁止 class 组件。
- `useEffect` 必须返回 cleanup（如有副作用）。
- 事件处理器用 `useCallback` 包装（避免不必要的重渲染）。

### 3.3 国际化（i18n）规范 ⚠️ 重点

**绝对禁止：** 组件中出现硬编码中文（注释和 console.log 除外）。

**使用方式：**
```tsx
import { useTranslation } from 'react-i18next';

function Foo() {
  const { t } = useTranslation();
  return <button>{t('common.save')}</button>;
}
```

**插值：**
```tsx
t('transfer.fileDeleted', { name: fileName })
// zh.json: "fileDeleted": "文件「{{name}}」已删除"
```

**Key 命名规范：**
- 按功能域分组：`common.*`、`settings.*`、`filebrowser.*`、`plugin.*`、`transfer.*`、`update.*` 等
- 小驼峰：`permissionDenied`、`rememberDirGlobal`
- 状态/动作用动词或名词：`save`、`loading`、`connected`

**添加新字符串的流程：**
1. 在 `zh.json` 和 `en.json` **同步**添加 key（两个文件必须一致）
2. 组件中用 `t('domain.key')` 引用
3. 如含插值变量，两个文件的变量名必须一致

**常用 key（已存在，直接复用）：**
| Key | 中文 | 英文 |
|-----|------|------|
| `common.ok` | 确定 | OK |
| `common.cancel` | 取消 | Cancel |
| `common.save` | 保存 | Save |
| `common.delete` | 删除 | Delete |
| `common.close` | 关闭 | Close |
| `common.confirm` | 确认 | Confirm |
| `common.yes` / `common.no` | 是 / 否 | Yes / No |
| `common.loading` | 加载中… | Loading… |
| `common.success` / `common.failed` | 成功 / 失败 | Success / Failed |
| `common.copy` / `common.copied` | 复制 / 已复制 | Copy / Copied |
| `common.apply` | 应用 | Apply |

### 3.4 CSS Class 命名规范

**命名风格：** 小写 + 连字符（kebab-case），BEM 变体用 `__` 或 `-`。

**常用 CSS 变量（定义在 finder.css `:root`，由 theme/palette.ts 切换）：**

| 变量 | 用途 |
|------|------|
| `--bg-app` | 应用最底层背景 |
| `--bg-sidebar` | 侧边栏背景（玻璃拟态） |
| `--bg-content` | 内容区背景 |
| `--bg-toolbar` | 工具栏背景 |
| `--bg-input` | **输入框/表单背景**（必须用这个，不是 `--bg-elevated`） |
| `--bg-terminal` | 终端背景 |
| `--text-primary` | 主文字色 |
| `--text-secondary` | 次要文字色 |
| `--divider` | 分割线 |
| `--accent` | 主色（蓝） |
| `--accent-soft` | 主色柔光 |
| `--danger` / `--warning` / `--success` | 语义色 |
| `--radius-control` / `--radius-dialog` | 圆角 |

**⚠️ 重要：** `--bg-elevated` 变量**不存在**，必须用 `--bg-input`。

### 3.5 表单控件 Class（必须复用现有 class）

| 控件 | Class | 说明 |
|------|-------|------|
| 输入框 | `form-input` | 标准输入框 |
| 紧凑输入框 | `form-input-compact` | 行内小输入框（设置面板用） |
| 多行文本 | `form-textarea` | |
| **下拉选择（原生）** | `select.form-input-compact` | ⚠️ 必须用 `form-input-compact`，不要用 `form-select`（无样式） |
| **下拉选择（自定义）** | `terminal-font-group` > `terminal-font-trigger` + `terminal-font-dropdown` > `terminal-font-item` | 与字体/语言下拉一致的样式，带 `▾` 箭头和 `Check` 图标 |
| 开关 | `form-switch` > `input[type=checkbox]` + `form-switch-track` | |
| 单选 | `form-radio-group` > `form-radio` | |
| 行布局 | `form-row` / `form-row-inline` / `form-row-2` | |
| 标签 | `form-label` | |
| 提示 | `form-hint` | |

**自定义下拉模板（与字体选择器一致）：**
```tsx
<div className="terminal-font-group" ref={dropdownRef}>
  <button
    type="button"
    className="form-input form-input-compact terminal-font-trigger"
    onClick={() => setOpen(!open)}
  >
    <span className="terminal-font-trigger-name">{currentLabel}</span>
    <span className={`terminal-font-trigger-arrow ${open ? 'open' : ''}`}>▾</span>
  </button>
  {open && (
    <div className="terminal-font-dropdown">
      {options.map((opt) => (
        <div
          key={opt.value}
          className={`terminal-font-item ${value === opt.value ? 'active' : ''}`}
          onClick={() => { setValue(opt.value); setOpen(false); }}
        >
          {opt.label}
          {value === opt.value && <Check size={12} className="terminal-font-item-check" />}
        </div>
      ))}
    </div>
  )}
</div>
```

### 3.6 按钮 Class

| Class | 用途 |
|-------|------|
| `btn` | 基础按钮（必须加） |
| `btn-primary` | 主操作（渐变蓝） |
| `btn-secondary` | 次要操作 |
| `btn-ghost` | 幽灵按钮（透明） |
| `btn-danger` | 危险操作（红） |
| `btn-compact` | 紧凑小按钮（工具栏用） |
| `btn-sm` | 小按钮 |

### 3.7 对话框结构

```tsx
<div className="dialog-overlay" onClick={onClose}>
  <div className="dialog" onClick={(e) => e.stopPropagation()}>
    <div className="dialog-header">
      <div className="dialog-title">{t('xxx.title')}</div>
      <button className="dialog-close" onClick={onClose}><X size={16} /></button>
    </div>
    <div className="dialog-body">
      {/* 内容 */}
    </div>
    <div className="dialog-footer">
      <button className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
      <button className="btn btn-primary" onClick={onConfirm}>{t('common.confirm')}</button>
    </div>
  </div>
</div>
```

### 3.8 设置面板行结构

```tsx
<div className="settings-row">
  <div className="settings-row-main">
    <div className="settings-row-label">{t('settings.xxx')}</div>
    <div className="settings-row-desc">{t('settings.xxxDesc')}</div>
  </div>
  {/* 右侧控件：switch / select / input */}
</div>
```

### 3.9 图标

- 使用 `lucide-react`，禁止使用 emoji 作为功能图标。
- 导入时按需引入：`import { X, Check } from 'lucide-react'`
- 尺寸用 `size={16}` 等数字。

### 3.10 状态管理（Zustand）

```ts
import { create } from 'zustand';

interface MyState {
  data: string;
  setData: (d: string) => void;
}

export const useMyStore = create<MyState>((set) => ({
  data: '',
  setData: (d) => set({ data: d }),
}));
```

- Store 放在 `src/store/`，文件名 `xxxStore.ts`。
- 跨 store 引用用 `useXxxStore.getState()` 避免循环依赖。

### 3.11 调用后端

```ts
import { invoke } from '@tauri-apps/api/core';

const result = await invoke<ReturnType>('command_name', { param1, param2 });
```

- 命令名用 snake_case（与 Rust `#[tauri::command]` 函数名一致）。

---

## 4. 后端（Rust）编码规范

### 4.1 基本规则

- Edition 2021，遵循 `cargo fmt` 和 `cargo clippy`。
- 4 空格缩进，无分号结尾的表达式返回值。
- 注释用 `///`（文档注释）或 `//`。

### 4.2 Tauri 命令

```rust
/// 前端调用：获取 xxx
/// 返回说明...
#[tauri::command]
async fn get_xxx(app: tauri::AppHandle, id: String) -> Result<String, String> {
    // 成功返回 Ok(value)，失败返回 Err("错误信息")
    Ok("result".to_string())
}
```

- 所有命令注册在 `lib.rs` 的 `invoke_handler` 中。
- 错误返回 `Err(String)`，前端用 try/catch 捕获。
- 需要 `AppHandle` 或 `State` 时作为参数传入。

### 4.3 错误处理

- 优先使用 `anyhow::Result`，Tauri 命令用 `Result<T, String>`。
- 用 `?` 传播错误，避免 `unwrap()`（除非确定安全并加注释）。

### 4.4 日志

- 后端日志用 `debug_log(app, level, msg)`，自动加 `[BE]` 标签。
- 级别：`info`（仅调试开启时写文件）、`warn`/`error`（始终写入）。
- 日志写入 `APP_DATA/updates/update.log`。

---

## 5. 测试规范

- 框架：Vitest。
- 测试文件放在被测文件同级的 `__tests__/` 目录，命名 `xxx.test.ts`。
- 工具函数必须有单元测试。

```ts
import { describe, test, expect } from 'vitest';
import { myFunc } from '../myFunc';

describe('myFunc', () => {
  test('case description', () => {
    expect(myFunc(input)).toBe(expected);
  });
});
```

---

## 6. 构建与验证命令

| 命令 | 作用 |
|------|------|
| `npx tsc --noEmit` | 前端类型检查（必须通过） |
| `npm test` | 运行 Vitest 单元测试（必须通过） |
| `npm run build` | 构建前端（tsc + vite build） |
| `cd src-tauri && cargo fmt -- --check` | Rust 格式化检查（必须通过） |
| `cd src-tauri && cargo clippy` | Rust 代码规范检查（必须通过） |

---

## 7. AI 修改代码的约束

### 7.1 硬性禁止

1. **禁止硬编码中文**到用户可见的 UI 文本（按钮、标签、提示、标题等）。注释和 `console.log` 可以用中文。
2. **禁止引入新的 npm 依赖**，除非用户明确要求。
3. **禁止使用不存在的 CSS 变量**（如 `--bg-elevated`），用 `--bg-input`。
4. **禁止新增未使用的变量/参数**（tsc 会报错）。
5. **禁止使用 `any` 类型**，除非加注释说明理由。
6. **禁止修改 `package.json` 的 scripts 和已有依赖版本**。

### 7.2 必须遵守

1. **新增 UI 字符串必须同步添加 zh.json 和 en.json 翻译**，且 key 在两个文件中完全一致。
2. **表单控件必须复用现有 class**（`form-input`、`form-input-compact`、`btn btn-primary` 等），不要自创样式。
3. **下拉选择优先用自定义下拉模式**（`terminal-font-group` 等），与字体/语言下拉保持一致；简单场景可用 `select.form-input-compact`。
4. **对话框必须用 `dialog-overlay > dialog > dialog-header/body/footer` 结构**。
5. **图标用 lucide-react**，不要用 emoji 做功能图标。
6. **调用 Tauri 命令用 `invoke('snake_case_name', {...})`**。
7. **后端命令必须加 `///` 文档注释**说明用途和参数。
8. **后端修改后必须跑 `cargo fmt --check` 和 `cargo clippy`**。

### 7.3 风格统一

- 引号：双引号 `"`（tsx/ts），单引号可选（项目里混用，跟随所在文件风格）。
- 缩进：2 空格（前端），4 空格（Rust）。
- 行尾分号：前端有分号，Rust 表达式无分号。
- import 顺序：第三方库 → 项目模块 → 样式/CSS。

---

## 8. CHANGELOG 更新规范

每次修改代码后，**必须更新 `CHANGELOG.md`**。按修改内容提取关键词，归入对应分类。

### 8.1 位置与格式

- 文件：`CHANGELOG.md`（项目根目录）
- 遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式
- 新版本段落插入在 `---` 分隔线之后、上一版本段落之前（即文件顶部第二条 `---` 之后）
- **版本号取下一个版本号**（不是 `package.json` 当前版本）：通常在当前版本号基础上 `patch +1`（如 `0.1.100` → `0.1.101`）；若涉及重大功能/破坏性变更则 `minor +1`（如 `0.1.100` → `0.2.0`）
- 日期取当天（`YYYY-MM-DD`）
- 段落结构：`## [x.y.z] - YYYY-MM-DD` → `### 新增/变更/修复` → 列表项

### 8.2 分类关键词映射

根据修改内容的关键词，归入以下三类之一：

| 分类 | 触发关键词 | 说明 |
|------|-----------|------|
| **新增** | 新增、添加、创建、引入、实现、支持、首次、`add`、`create`、`implement`、`support`、`new feature` | 新功能、新组件、新 API、新依赖、新配置项、新文档 |
| **变更** | 重构、优化、调整、改进、统一、升级、迁移、改为、`refactor`、`optimize`、`change`、`update`、`migrate` | 对已有功能的行为/接口/结构调整，不含 bug 修复 |
| **修复** | 修复、修正、解决、fix、bug、panic、crash、error、leak、失效、不生效、显示异常 | Bug 修复、崩溃、内存泄漏、显示异常、逻辑错误 |

**判断规则：**
- 同一个修改可能涉及多个分类，每条归入最贴切的一类。
- 纯样式调整（改 class、改 CSS 变量）归入「变更」，除非是修复显示异常则归「修复」。
- 依赖升级归入「变更」。

### 8.3 条目撰写规范

每条变更记录格式：

```
- **<模块/功能名>**：<一句话描述做了什么>。<可选：技术细节/影响范围>
```

**要求：**
- 加粗的模块名用实际文件名或功能域名，如 `SettingsDialog`、`pluginSdk.ts`、`i18n`
- 一句话说清「改了什么」，必要时补充「怎么改的」「影响什么」
- 涉及 API/类型变更时注明签名变化
- 涉及新增文件时注明路径
- 中文描述，技术术语保留英文（如 `i18next`、`useState`）

**示例：**
```
### 新增
- **国际化（i18n）基础设施**：安装 `i18next` / `react-i18next`；`src/i18n/index.ts` 配置语言检测顺序 `localStorage → navigator → fallback 'zh'`

### 变更
- **核心组件接入 i18n**：`SettingsDialog` / `FileBrowser` 等组件用户可见文本全部改为 `t()` 调用，无硬编码中文

### 修复
- **权限错误前缀匹配失败**：`friendlyPermissionError` 改用无插值的 `plugin.permissionDeniedPrefix` 做匹配，修复 en 下无法识别权限错误的问题
```

### 8.4 操作步骤（AI 每次修改后执行）

1. 回顾本次修改涉及的文件和功能点
2. 按 8.2 的关键词映射，将每个变更点归入「新增 / 变更 / 修复」
3. 按 8.3 的格式撰写每条记录
4. 计算下一个版本号：当前 `package.json` 版本 `patch +1`（重大变更 `minor +1`）
5. 打开 `CHANGELOG.md`，在顶部第二个 `---` 之后插入新版本段落（如已存在同版本号则追加到对应分类下）
6. 确认日期为当天，版本号为第 4 步计算的下一个版本号

---

## 9. 代码修改后审查流程（Checklist）

每次修改代码后，**必须按以下顺序自检**：

### 9.1 功能审查

- [ ] 修改的功能逻辑是否正确？有没有改变原有行为？
- [ ] 是否有边界情况未处理（空值、异常、并发）？
- [ ] i18n key 是否在 zh.json 和 en.json 中都存在且值正确？
- [ ] 插值变量名在两个语言文件中是否一致？

### 9.2 规范审查

- [ ] 有没有硬编码中文？（搜 `[\u4e00-\u9fa5]` 检查 tsx/ts 文件，排除注释和 console）
- [ ] 有没有使用不存在的 CSS 变量？（重点检查 `--bg-elevated`）
- [ ] 表单控件用的是不是现有 class？
- [ ] 对话框结构是否正确？
- [ ] 图标是不是用的 lucide-react？
- [ ] 有没有未使用的变量/导入？

### 9.3 编译/测试审查

- [ ] `npx tsc --noEmit` 通过（无类型错误）
- [ ] `npm test` 通过（所有测试通过）
- [ ] `npm run build` 通过
- [ ] （后端）`cargo fmt -- --check` 通过
- [ ] （后端）`cargo clippy` 通过（无 warning）

### 9.4 回归审查

- [ ] 修改是否影响了其他组件？（检查 import 关系）
- [ ] 状态管理是否有循环依赖？
- [ ] 事件监听是否正确 cleanup？

### 9.5 CHANGELOG 审查

- [ ] 是否已按第 8 章规范更新 `CHANGELOG.md`？
- [ ] 变更条目是否归入正确分类（新增/变更/修复）？
- [ ] 版本号是否为**下一个版本号**（当前 `package.json` 版本 patch +1）？日期是否为当天？

---

## 10. 常见错误速查

| 错误 | 原因 | 修复 |
|------|------|------|
| `TS6133: 'x' is declared but never used` | 未使用变量 | 删除或加 `_` 前缀（如 `_unused`） |
| i18n 显示原始 key 如 `common.apply` | key 不存在于 locale 文件 | 在 zh.json 和 en.json 中添加 |
| 下拉文字看不清 | 用了不存在的 `--bg-elevated` | 改为 `--bg-input` |
| `cargo fmt --check` 报错 | 格式不规范 | 运行 `cargo fmt` 自动修复 |
| `clippy` warning | 代码不简洁 | 按提示修复或加 `#[allow]` |

---

## 11. 关键文件速查

| 需求 | 文件 |
|------|------|
| 翻译字典 | `src/i18n/locales/zh.json`、`src/i18n/locales/en.json` |
| 主 CSS（变量、表单、对话框） | `src/styles/finder.css` |
| 主题调色板 | `src/theme/palette.ts` |
| 全局类型 | `src/types/index.ts`、`src/types/plugin.ts` |
| 入口 | `src/main.tsx` |
| 根组件 | `src/App.tsx` |
| 设置对话框 | `src/components/SettingsDialog.tsx` |
| 后端命令注册 | `src-tauri/src/lib.rs` |
