# nbstore 阅读指南

> 目标：以"一次文档编辑"为主线，从 UI 一路读到 Postgres，理解 nbstore 的调度、持久化、同步与传输。
> 范围：`packages/common/nbstore`（TS，115 个源码文件 / 约 15.9k 行）+ 可选的原生层 `packages/frontend/native/nbstore`（Rust，3.5k 行）。

## 0. 先建立全局图

### 0.1 规模

| 目录 | 文件数 | 行数 | 内容 |
|---|---:|---:|---|
| `storage/` | 25 | 1,446 | 7 种存储抽象 + `SpaceStorage` + dummy |
| `impls/` | 51 | 7,069 | idb / sqlite / cloud / disk / broadcast-channel / v1 |
| `sync/` | 9 | 3,349 | doc / blob / indexer 同步 |
| `worker/` | 4 | 1,371 | Web Worker RPC 外壳 |
| `utils/` | 11 | 754 | 优先队列、二叉树、id 转换等 |
| `frontend/` | 5 | 790 | Doc/Blob/Indexer/Awareness Frontend |
| `telemetry/` | 3 | 498 | 遥测 |
| `realtime/` | 2 | 334 | 实时连接管理 |
| `connection/` | 3 | 279 | 连接状态 / 自动重连 |

阅读投入参考：

- 只搭骨架（约 2～3k 行）：**1.5～3 小时**
- 理解主流程（加 `sync/doc/peer.ts` + 一套 impl）：**5～8 小时**
- 完整精读（跳过重复的 idb/sqlite 对照）：**10～16 小时**
- 加测试 + Rust 原生层：再加 **5～9 小时**

### 0.2 一次编辑的完整链路（★ = nbstore 负责）

```
keystroke
  → Y.Doc 产生 update                              ✗ BlockSuite / Yjs
  → DocFrontend 放入按 docId 排队的任务队列           ★ frontend/doc.ts
  → jobs.save：mergeUpdates 成 1 个                 ★ frontend/doc.ts
  → 写本地 idb / sqlite                             ★ impls/idb|sqlite/doc.ts
  → DocSyncPeer 监听到本地 update                    ★ sync/doc/peer.ts
  → jobs.push：再次 merge 成 1 个                    ★ sync/doc/peer.ts
  → remote.pushDocUpdate()                          ★ impls/cloud/doc.ts
  → socket.emitWithAck('space:push-doc-update')     ★ impls/cloud/socket.ts
  → server 写 Postgres                              ✗ packages/backend
  → server 广播                                     ✗ packages/backend
  → 其他客户端收到并写本地                            ★ impls/cloud/doc.ts + peer.ts
```

两个关键事实，阅读时务必记住：

1. **`DocFrontend` 才持有 `Y.Doc`**，它监听 `doc.on('update')`。
2. **`DocSyncPeer` 不监听 `Y.Doc`**，它监听的是**本地 Storage 的 update 事件**（`local.subscribeDocUpdate`）。
   反向链路：远端广播 → CloudDocStorage emit → DocSyncPeer 写本地 → DocFrontend 监听到 storage update → `apply` 回 `Y.Doc`。

### 0.3 主线程与 Worker

- 主线程：`WorkspaceEngine` → `StoreManagerClient.open()` → `StoreClient` → `DocFrontend(WorkerDocStorage, WorkerDocSync)`，全是 RPC 代理。
- Worker：`StoreManagerConsumer` → `StoreConsumer` → `SpaceStorage(local/remotes)` + `Sync` → `DocSyncImpl` → `DocSyncPeer` → 真实 Storage 实现。

---

## 1. 推荐阅读顺序

### 阶段 0：前置知识（0.5 小时）

只需掌握 Yjs 的 5 个概念：

- `Y.Doc`
- `update`（二进制增量）
- `state vector`
- `mergeUpdates`
- `diffUpdate`

它们在 nbstore 里反复出现（合并、增量同步、时钟比较）。

### 阶段 1：全景与装配（1～1.5 小时）

| 顺序 | 文件 | 关注点 |
|---|---|---|
| 1 | `packages/common/nbstore/README.md` | 独立 storage 与 `SpaceStorage` 两种用法 |
| 2 | `src/storage/storage.ts` | 7 种 `StorageType` |
| 3 | `src/storage/index.ts` | `SpaceStorage` 按类型聚合、缺省 Dummy |
| 4 | `src/sync/types.ts` | `{ local, remotes }` 结构 |
| 5 | `src/worker/store.ts` | **最关键装配图**：实例化哪些 Storage、`new Sync(...)`、`start()` |
| 6 | `src/worker/client.ts`（略读） | 主线程代理：`StoreManagerClient` / `StoreClient` / `WorkerDocStorage` |
| 7 | `packages/frontend/core/src/modules/workspace-engine/impls/cloud.ts`（略读） | 业务层实际注册的 storage 名字与选项 |

读完应能回答：

- 打开一个 workspace 时创建了哪些 Storage？
- 本地和 remote 分别是谁？
- 为什么 UI 拿到的是 `DocFrontend` 而不是 Storage？

### 阶段 2：本地写路径（2～3 小时）

| 顺序 | 文件 | 关注点 |
|---|---|---|
| 1 | `src/frontend/doc.ts` | 通读：`Job` 类型、`schedule`、`mainLoop` 按 docId 批处理、`jobs.load/save/apply`、`handleDocUpdate`、`connectDoc/disconnectDoc` |
| 2 | `src/storage/doc.ts` | `DocStorage` 接口、`DocStorageBase`（事件/lock/merge）、`SnapshotDocStorageBase`（读取时 snapshot + updates 合并） |
| 3 | `src/storage/doc-sync.ts` | peer 时钟元数据接口 |
| 4 | `src/impls/idb/doc.ts` + `src/impls/idb/schema.ts` | 写了哪几张表、`pushDocUpdate` 如何 `emit`、`clocks` 的作用 |
| 5 | `src/impls/sqlite/doc.ts`（对照） | 与 idb 一一对应，只看差异；压缩在 Rust 侧 |

读完应能回答：

- 为什么 UI 不等网络也算"保存完成"？
- 多个 update 在哪里、被合并了几次？
- 本地的 `snapshots` / `updates` / `clocks` 各自作用是什么？
- `emit('update')` 的两个订阅者分别是谁？

### 阶段 3：同步核心（4～8 小时，最难）

| 顺序 | 文件 | 关注点 |
|---|---|---|
| 1 | `src/utils/priority-queue.ts` + `async-priority-queue.ts` | 很小，先理解任务调度 |
| 2 | `src/sync/doc/index.ts` | `DocSyncImpl` 如何为每个 remote 建 `DocSyncPeer`、状态聚合 |
| 3 | `src/sync/doc/peer.ts` | **分块读**（见下） |
| 4 | `src/storage/doc-sync.ts` + `storage/dummy/doc-sync.ts` | peer clock 的语义 |
| 5 | `src/__tests__/sync.spec.ts` | 用测试验证理解 |

`peer.ts`（约 1000 行）建议按以下顺序读：

1. 顶部工具函数：`diffUpdate`、时钟比较
2. `constructor` + `status` 结构
3. `retryLoop`：连接三个 storage、订阅 local/remote、初始化 clocks
4. `mainLoop`：按 docId 批量取 job（`connect` / `pullAndPush` / `pull` / `push` / `save`）
5. `events.localUpdated` / `events.remoteUpdated`
6. `jobs.connect / pull / push / save / pullAndPush`
7. `setPeerPushedClock / setPeerPulledRemoteClock` 与 `actions.updateRemoteClock`

读完应能回答：

- 多端编辑时谁推谁拉？如何避免回环？
- 断线重连后如何补齐？
- `pushedClock` / `pulledRemoteClock` 分别代表什么？
- 为什么 push 前要做 diff，而不是发整篇文档？

### 阶段 4：网络传输（1.5～2.5 小时）

| 顺序 | 文件 | 关注点 |
|---|---|---|
| 1 | `src/impls/cloud/doc.ts` | `pushDocUpdate`、`getDoc`、`onServerUpdates`、`joinDoc`、`doConnect/doDisconnect` |
| 2 | `src/impls/cloud/socket.ts` | 事件表、`SocketManager` 引用计数、base64 编解码、自建服务 polling→websocket |
| 3 | `src/connection/connection.ts` + `shared-connection.ts` | `AutoReconnectConnection`、断线状态、连接复用 |
| 4 | `src/impls/cloud/http.ts` + `doc-static.ts` + `blob.ts` | 对照 HTTP 场景：只读文档、blob 上传下载 |

读完应能回答：

- 哪些场景走 WebSocket，哪些走 HTTP？
- `emitWithAck` 是什么语义？
- 断线时任务如何积压与重试？
- `StaticCloudDocStorage` 为什么是只读的？

### 阶段 5：横向扩展（按需，各 1 小时左右）

- `src/frontend/blob.ts` / `indexer.ts` / `awareness.ts`：与 doc 同构，快速过
- `src/sync/blob/peer.ts`、`src/sync/indexer/index.ts`：blob / 索引同步
- `src/storage/indexer/*`、`src/impls/idb/indexer/*`：BM25 / 倒排索引
- `src/utils/id-converter.ts`、`universal-id.ts`：文档 id ↔ UUID
- `src/worker/client.ts` + `consumer.ts`：Worker RPC 外壳（端到端调试时再看）

### 阶段 6：服务端（可选，2～4 小时）

- `packages/backend/server/src/core/sync/gateway.ts`：`space:push-doc-update` 入口
- `packages/backend/native/src/runtime/backend_runtime/doc_writer.rs`：追加 update、广播
- `packages/backend/native/src/runtime/backend_runtime/doc_storage.rs`：snapshot / history 写入
- `packages/backend/server/schema.prisma`：`Update` / `Snapshot` / `SnapshotHistory` 模型

读完应能回答：

- Postgres 里到底存的是什么形态？（Yjs 二进制 update + snapshot，不是文本）
- 为什么 local-first 仍然需要服务端？

---

## 2. 类层级速查

### Storage

```
Storage
├── DocStorage
│   └── DocStorageBase (abstract)
│       ├── SnapshotDocStorageBase (abstract)
│       │   ├── IndexedDBDocStorage
│       │   ├── CloudDocStorage
│       │   ├── StaticCloudDocStorage
│       │   ├── DiskDocStorage
│       │   └── IndexedDBV1DocStorage / SqliteV1DocStorage
│       └── SqliteDocStorage          // 合并压缩在 Rust 侧
├── BlobStorage        → BlobStorageBase       → IndexedDB / Cloud / Sqlite / Dummy
├── DocSyncStorage     → DocSyncStorageBase    → IndexedDB / Sqlite / Dummy
├── IndexerStorage     → IndexerStorageBase    → IndexedDB / Sqlite / Cloud / Dummy
├── IndexerSyncStorage → IndexerSyncStorageBase
└── AwarenessStorage   → AwarenessStorageBase  → BroadcastChannel / Cloud / Dummy
```

### Connection

```
Connection
├── AutoReconnectConnection
│   ├── IDBConnection
│   ├── NativeDBConnection            // SQLite / Rust
│   ├── SocketConnection
│   │   └── CloudDocStorageConnection
│   ├── DiskSyncConnection
│   └── BroadcastChannelConnection
└── DummyConnection
    ├── HttpConnection
    └── WorkerDocConnection
```

### Sync

```
Sync
├── DocSyncImpl        → DocSyncPeer[]   // 每个 remote 一个 peer
├── BlobSyncImpl
├── AwarenessSyncImpl
└── IndexerSyncImpl
```

### 从 UI 到 Worker 的装配链

```
BlockSuite DocCollection
  → WorkspaceEngine
    → StoreManagerClient.open()
      → StoreClient (主线程，RPC 代理)
        → DocFrontend(WorkerDocStorage, WorkerDocSync)

Worker:
  StoreManagerConsumer
    → StoreConsumer
      → SpaceStorage(local / remotes)
      → Sync → DocSyncImpl → DocSyncPeer
        → IndexedDBDocStorage / SqliteDocStorage / CloudDocStorage
```

---

## 3. 三条关键调用链

### A. 打开文档

```
onLoadDoc(doc)
→ WorkspaceEngine.doc.connectDoc(doc)
→ DocFrontend.connectDoc → _connectDoc
   - schedule({type:'load'})
   - ydoc.on('update', handleDocUpdate)
→ DocFrontend.start → mainLoop
   - storage.connection.waitForConnected()
   - storage.subscribeDocUpdate(cb)
→ jobs.load
   - storage.getDoc(docId)                    // RPC → Worker
   - SnapshotDocStorageBase.getDoc
       snapshot + updates → squash → 写回
   - applyUpdate → 合并进 Y.Doc
```

### B. 本地编辑 → 云端

```
ydoc 'update'
→ DocFrontend.handleDocUpdate → schedule({type:'save'})
→ jobs.save
   - mergeUpdates
   - storage.pushDocUpdate(...)               // RPC → Worker
→ IndexedDBDocStorage.pushDocUpdate
   - 写 updates + clocks
   - emit('update')
→ DocSyncPeer.retryLoop 的 local.subscribeDocUpdate
   - schedule({type:'push'})
→ DocSyncPeer.jobs.push
   - mergeUpdates
   - remote.pushDocUpdate(...)
→ CloudDocStorage.pushDocUpdate
   - socket.emitWithAck('space:push-doc-update', { update: base64 })
→ server → Postgres → broadcast
```

### C. 远端更新 → 本地 Y.Doc

```
server broadcast
→ CloudDocStorage.onServerUpdates → emit('update')
→ DocSyncPeer 的 remote.subscribeDocUpdate
   - schedule({type:'save'})
→ jobs.save
   - local.pushDocUpdate(...)
→ IndexedDBDocStorage 写入 + emit
→ DocFrontend 的 RPC 订阅 onStorageUpdate
   - origin 不是自己 → schedule({type:'apply'})
→ jobs.apply
   - Y.applyUpdate(doc, bin, NBSTORE_ORIGIN)
```

---

## 4. 验证理解的方式

按顺序跑/读这些测试，能对照主链路：

| 测试 | 验证内容 |
|---|---|
| `src/__tests__/frontend.spec.ts` | DocFrontend 的 load / save / apply 与优先级 |
| `src/__tests__/sync.spec.ts` | DocSyncPeer 的 push / pull / clocks |
| `src/__tests__/cloud-doc-updates.spec.ts` | CloudDocStorage 与 server 事件 |
| `src/__tests__/cloud-blob.spec.ts` | Blob 上传下载 |
| `src/impls/idb/indexer/__tests__/*` | BM25 / tokenizer / highlighter |
| `src/impls/disk/sync.integration.spec.ts` | Disk remote 同步 |

建议的验证方法：读完阶段 2 后跑 `frontend.spec.ts`，读完阶段 3 后跑 `sync.spec.ts`，能独立解释每个断言的来龙去脉即算掌握。

---

## 5. 一句话路线

```
storage/index.ts（全景）
  → frontend/doc.ts（本地写 + 队列）
  → sync/doc/peer.ts（同步核心）
  → impls/cloud/doc.ts + socket.ts（传输）
  → 其他 impl / blob / indexer（横向）
  → backend（端到端，可选）
```

**约 1 天能讲清主链路，2 天能覆盖 nbstore 全部设计。**
