# 上传文件冲突处理设计文档

## 1. 背景与现状

### 1.1 当前实现

当前上传流程中，当本地文件名与远程已有文件名相同时，使用浏览器原生 `confirm()` 对话框提示：

```typescript
// uploadFromLocal.ts L354-L367
const choice = confirm(
  `文件 "${item.relPath}" 已存在。\n\n是否覆盖？\n"取消" = 跳过，"确定" = 覆盖。`,
);
if (choice) {
  const all = confirm('对所有后续冲突文件也执行覆盖操作？');
  if (all) setGlobalOverride('overwrite');
} else {
  const skipAll = confirm('对所有后续冲突文件也执行跳过？');
  if (skipAll) setGlobalOverride('skip');
}
```

**存在的问题：**

| 问题 | 说明 |
|---|---|
| 只能"覆盖"或"跳过" | 用户无法查看文件差异再决定 |
| 原生 confirm 体验差 | 无自定义样式，信息展示有限 |
| 冲突检测仅限顶层 | `remoteEntriesCheck` 只检查顶层文件名，子目录同名文件不会触发提示 |
| 无文件信息对比 | 用户不知道远程文件的大小、修改时间，盲目选择 |
| 无"应用于全部"的视觉提示 | 用户在第二次 confirm 时才能设置全局策略 |

### 1.2 相关代码位置

| 文件 | 关键行 | 作用 |
|---|---|---|
| `src/utils/uploadFromLocal.ts` | L342-L367 | 冲突检测与处理逻辑 |
| `src/utils/uploadFromLocal.ts` | L121 | `OverrideChoice` 类型定义 |
| `src/components/FileBrowser.tsx` | L435-L436 | `remoteEntriesCheck` 实现 |
| `src/components/LocalFilePane.tsx` | L210 | `overrideRef` 初始化 |

---

## 2. 功能需求

### 2.1 核心需求

1. **冲突检测**：上传前检测远程是否存在同名文件（支持子目录）
2. **信息展示**：展示本地 vs 远程的文件元信息（大小、修改时间）
3. **三种操作**：
   - **覆盖**：用本地文件覆盖远程
   - **跳过**：保留远程文件，不上传
   - **比较**：在对比视图中并排展示两个文件的差异
4. **批量策略**：支持"对所有后续冲突应用此操作"

### 2.2 交互流程

```
用户选择文件 → 点击上传
       ↓
  遍历每个文件
       ↓
  ┌─ 远程是否存在同名文件？ ─┐
  │                         │
  是                        否
  │                         │
  ↓                         ↓
  显示冲突对话框             直接上传
  ┌─────────────────┐
  │  📄 文件对比视图  │
  │                  │
  │  本地:           │  远程:
  │  📊 16.2 KB      │  📊 15.8 KB
  │  🕐 08-20 10:30  │  🕐 08-19 14:00
  │                  │
  │  [覆盖] [跳过]   │
  │  [比较详情]      │
  │  ☐ 应用于全部    │
  └─────────────────┘
       ↓
  用户选择操作
       ↓
  执行对应行为
```

---

## 3. 技术设计

### 3.1 数据流

```
┌─────────────────────────────────────────────────────────────────┐
│                        前端 (TSX)                                │
│                                                                 │
│  1. 上传前检测冲突                                              │
│     remoteEntriesCheck() → 检查远程缓存列表                     │
│                                                                 │
│  2. 对冲突文件获取远程元信息                                     │
│     invoke('sftp_stat_file') → 获取远程文件 size/mtime           │
│                                                                 │
│  3. 弹出 CompareDialog 组件                                     │
│     显示本地 vs 远程 对比信息                                    │
│                                                                 │
│  4. 用户选择操作                                                │
│     ├─ overwrite: 继续上传 (TRUNCATE 模式)                      │
│     ├─ skip: 取消任务                                          │
│     └─ compare: 打开文件对比视图                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                        后端 (Rust)                               │
│                                                                 │
│  sftp_stat_file(host_id, path) → FileEntry                     │
│    返回: { name, size, mtime, is_dir, ... }                     │
│                                                                 │
│  sftp_upload_chunk() 现有逻辑不变                               │
│    首片使用 TRUNCATE 覆盖写入                                   │
│                                                                 │
│  sftp_download_file() 用于"比较"场景                           │
│    将远程文件下载到临时路径供对比                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 新增后端命令

```rust
/// 获取远程文件/目录的元信息（轻量 stat，不读取内容）
#[tauri::command]
pub async fn sftp_stat_file(
    host_id: String,
    path: String,
    ssh_state: tauri::State<'_, SshState>,
    sftp_state: tauri::State<'_, SftpState>,
    app_handle: tauri::AppHandle,
) -> Result<Option<FileEntry>, String> {
    // 如果文件不存在返回 Ok(None)
    // 如果存在返回 Ok(Some(FileEntry)) 包含 size, mtime 等
}
```

### 3.3 新增前端类型

```typescript
// src/utils/uploadFromLocal.ts

/** 文件冲突信息 */
export interface FileConflict {
  relPath: string;          // 相对路径
  localSize: number;        // 本地大小 (bytes)
  localMtime: number;       // 本地修改时间 (unix ms)
  remoteSize: number;       // 远程大小 (bytes)
  remoteMtime: number;      // 远程修改时间 (unix ms)
}

/** 冲突处理选择 */
export type ConflictChoice = 'overwrite' | 'skip' | 'compare';

/** 全局冲突策略 */
export type ConflictStrategy = ConflictChoice | 'ask';

// 修改原有 OverrideChoice
// 旧: type OverrideChoice = 'skip' | 'overwrite' | 'ask';
// 新: 扩展为支持 compare
export type OverrideChoice = ConflictStrategy;
```

### 3.4 新增组件：CompareDialog

```
src/components/CompareDialog.tsx
```

**Props:**

```typescript
interface CompareDialogProps {
  open: boolean;
  conflict: FileConflict | null;
  onChoice: (choice: ConflictChoice, applyToAll: boolean) => void;
  onClose: () => void;
  onCompareDetail?: () => void;  // 打开详细对比视图
}
```

**UI 布局:**

```
┌─────────────────────────────────────────────────────┐
│  ⚠️  文件已存在                                       │
│  server.js                                          │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─── 本地 ──────┐    ┌─── 远程 ─────┐              │
│  │               │    │               │              │
│  │  📊 16.2 KB   │    │  📊 15.8 KB   │              │
│  │  🕐 08-20     │    │  🕐 08-19     │              │
│  │     10:30     │    │     14:00     │              │
│  │               │    │               │              │
│  │  状态: 🆕 更新 │    │  状态: 👤 他人 │              │
│  │               │    │               │              │
│  └───────────────┘    └───────────────┘              │
│                                                     │
│  差异: 本地比远程大 409 字节 (2.6%)                    │
│  本地修改时间比远程晚约 20 小时                        │
│                                                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│  [🔍 详细对比]                                      │
│                                                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│  [覆盖]    [跳过]                                    │
│                                                     │
│  ☐ 对后续冲突文件执行相同操作                         │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 3.5 冲突检测增强

**当前限制**：`remoteEntriesCheck` 只检查顶层文件名，基于已加载的 `entries` 列表。

**增强方案**：

```typescript
// 方案 A: 基于已有 entries 缓存（快速但仅限当前目录）
function checkConflictFromCache(
  relPath: string,
  remoteEntries: FileEntry[],
): FileEntry | null {
  const fileName = basename(relPath);
  return remoteEntries.find((e) => e.name === fileName) || null;
}

// 方案 B: 主动 stat 查询（精确但需要 RPC 调用）
async function checkConflictByStat(
  hostId: string,
  remotePath: string,
): Promise<FileEntry | null> {
  return invoke<FileEntry | null>('sftp_stat_file', {
    hostId,
    path: remotePath,
  });
}
```

**推荐混合策略**：
1. 先用方案 A 快速检测（零延迟）
2. 对于子目录中的文件，使用方案 B 精确检测
3. 批量上传时，先批量 stat 所有待上传文件的远程状态

### 3.6 "详细对比"功能

点击"详细对比"后，展示文件内容差异：

**实现方案：**

```typescript
async function compareFileContent(
  hostId: string,
  remotePath: string,
  localPath: string,
): Promise<CompareResult> {
  // 1. 读取本地文件片段 (前 1MB)
  const localData = await readLocalFile(localPath, 1024 * 1024);
  
  // 2. 下载远程文件片段 (前 1MB)
  const remoteData = await invoke('sftp_read_chunk', {
    hostId,
    path: remotePath,
    offset: 0,
    length: 1024 * 1024,
  });
  
  // 3. 计算差异
  return diffContent(localData, remoteData);
}
```

**对比展示选项：**
- 二进制文件：展示 hex 对比
- 文本文件：展示行级 diff
- 大文件（>1MB）：只对比头部 + 尾部 + 中间采样

---

## 4. 实现计划

### 阶段 1：基础冲突检测 + 三种操作（核心功能）

| 任务 | 优先级 | 说明 |
|---|---|---|
| 添加 `sftp_stat_file` 后端命令 | P0 | 用于获取远程文件元信息 |
| 扩展 `OverrideChoice` 类型 | P0 | 增加 `compare` 选项 |
| 实现 `CompareDialog` 组件 | P0 | 自定义 UI 替代原生 confirm |
| 增强冲突检测逻辑 | P0 | 支持子目录冲突检测 |
| 实现"应用于全部" | P0 | 三种策略的全局应用 |

### 阶段 2：详细对比功能

| 任务 | 优先级 | 说明 |
|---|---|---|
| 添加 `sftp_read_chunk` 后端命令 | P1 | 读取远程文件片段 |
| 实现文件内容对比 | P1 | 文本 diff / hex diff |
| 实现对比视图组件 | P1 | 并排展示差异 |

### 阶段 3：智能提示

| 任务 | 优先级 | 说明 |
|---|---|---|
| 智能状态标记 | P2 | "本地更新"/"远程更新"/"两者都修改" |
| 差异摘要 | P2 | 大小差异、时间差异自动总结 |
| 批量预检 | P2 | 上传前批量检测所有冲突 |

---

## 5. 关键代码变更点

### 5.1 `src/utils/uploadFromLocal.ts`

```typescript
// 新增类型
export type OverrideChoice = 'skip' | 'overwrite' | 'compare' | 'ask';

// 修改冲突处理逻辑（伪代码）
async function handleConflict(
  item: LocalFlatItem,
  remotePath: string,
  hostId: string,
  strategyRef: { current: OverrideChoice },
): Promise<{ needWrite: boolean; compare: boolean }> {
  
  // 1. 检查全局策略
  if (strategyRef.current === 'skip') return { needWrite: false, compare: false };
  if (strategyRef.current === 'overwrite') return { needWrite: true, compare: false };
  if (strategyRef.current === 'compare') return { needWrite: false, compare: true };
  
  // 2. 获取远程文件信息
  const remoteEntry = await invoke<FileEntry | null>('sftp_stat_file', {
    hostId, path: remotePath,
  });
  
  if (!remoteEntry) return { needWrite: true, compare: false };
  
  // 3. 弹出对比对话框
  const localMtime = item.mtime || 0;
  const remoteMtime = remoteEntry.mtime || 0;
  
  // 4. 返回用户选择
  return new Promise((resolve) => {
    showCompareDialog({
      localSize: item.size,
      localMtime,
      remoteSize: remoteEntry.size,
      remoteMtime,
      onChoice: (choice, applyToAll) => {
        if (applyToAll) strategyRef.current = choice;
        resolve({
          needWrite: choice === 'overwrite',
          compare: choice === 'compare',
        });
      },
    });
  });
}
```

### 5.2 `src-tauri/src/sftp/mod.rs`

```rust
/// 获取远程文件元信息
#[tauri::command]
pub async fn sftp_stat_file(
    host_id: String,
    path: String,
    ssh_state: tauri::State<'_, SshState>,
    sftp_state: tauri::State<'_, SftpState>,
    app_handle: tauri::AppHandle,
) -> Result<Option<FileEntry>, String> {
    // 尝试 fstat，若文件不存在返回 Ok(None)
    // 存在则返回 Ok(Some(FileEntry))
}
```

### 5.3 `src/components/CompareDialog.tsx` (新文件)

```tsx
interface CompareDialogProps {
  open: boolean;
  conflict: {
    relPath: string;
    localSize: number;
    localMtime: number;
    remoteSize: number;
    remoteMtime: number;
  } | null;
  onChoice: (choice: 'overwrite' | 'skip' | 'compare', applyToAll: boolean) => void;
  onClose: () => void;
  onCompareDetail?: () => void;
}
```

---

## 6. 回退与兼容

### 6.1 降级策略

| 场景 | 处理方式 |
|---|---|
| `sftp_stat_file` 调用失败 | 降级为原有逻辑（仅基于本地列表检测） |
| 远程文件不存在 | 直接上传，不弹窗 |
| 用户关闭对话框 | 等同于"跳过" |
| 网络断开导致 stat 失败 | 不阻断上传流程 |

### 6.2 性能影响

| 操作 | 额外开销 | 优化措施 |
|---|---|---|
| 每次冲突检测 | 1 次 SFTP stat RPC | 批量上传时可并行 stat |
| 对话框渲染 | 可忽略 | 纯本地组件 |
| 详细对比 | 下载 1MB 文件片段 | 懒加载，按需触发 |

---

## 7. 测试计划

| 测试场景 | 测试方式 |
|---|---|
| 同目录同名文件冲突 | 手动测试 |
| 子目录同名文件冲突 | 手动测试 |
| "应用于全部" 功能 | 手动测试 |
| stat 失败降级 | Mock SFTP 失败 |
| compare 模式下打开详细对比 | 手动测试 |
| 混合场景（部分冲突部分不冲突） | 手动测试 |

---

## 8. 后续扩展

- **智能合并**：对文本文件支持三路合并（本地版本、远程版本、共同祖先）
- **版本历史**：保留被覆盖文件的历史版本
- **Git 风格 diff**：更丰富的文件差异展示
- **同步模式**：双向同步，自动解决冲突
