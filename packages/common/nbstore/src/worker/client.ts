/**
 * Worker RPC 的「调用方」侧（通常运行在主线程）。
 *
 * 结构分两层：
 * - `StoreManagerClient` 持有一条到 worker 的管理通道（`WorkerManagerOps`），
 *   负责打开 / 关闭 store、遥测、实时（realtime）请求；
 * - 每次 `open(key, options)` 会新建一个 MessageChannel，把 port2 转移给 worker，
 *   本地保留 port1 并用它创建 `StoreClient`（`WorkerOps` 通道）。
 *
 * 打开同一个 key 会复用 worker 端同一个 `StoreConsumer`（引用计数），
 * 但每次 open 都会得到独立的通道与 `StoreClient`，因此可以各自 dispose。
 *
 * 本文件里的 `Worker*` 类都是「代理」：方法体只做 RPC。
 * 真正的 storage / sync 实现位于 worker 中的 `store.ts`；
 * 而 Y.Doc 本身由本侧的 `DocFrontend` 持有，storage / sync 只是它的远程依赖。
 */
import type {
  RealtimeConfigureInput,
  RealtimeRequestInputOf,
  RealtimeRequestName,
  RealtimeRequestOutputOf,
  RealtimeStatus,
  RealtimeSubscriptionReady,
  RealtimeTopicEventOf,
  RealtimeTopicInputOf,
  RealtimeTopicName,
} from '@affine/realtime';
import { OpClient, transfer } from '@toeverything/infra/op';
import type { Observable } from 'rxjs';
import { v4 as uuid } from 'uuid';

import { DummyConnection } from '../connection';
import {
  AwarenessFrontend,
  BlobFrontend,
  DocFrontend,
  IndexerFrontend,
} from '../frontend';
import {
  type AggregateOptions,
  type AggregateResult,
  type AwarenessRecord,
  type BlobRecord,
  type BlobSource,
  type BlobStorage,
  type DocLifecycle,
  type DocLifecycleResult,
  type DocRecord,
  type DocStorage,
  type DocUpdate,
  type IndexerSchema,
  type ListedBlobRecord,
  type Query,
  type SearchOptions,
  type SearchResult,
} from '../storage';
import type { AwarenessSync } from '../sync/awareness';
import type { BlobSync } from '../sync/blob';
import type { DocSync } from '../sync/doc';
import type { IndexerPreferOptions, IndexerSync } from '../sync/indexer';
import type {
  TelemetryAck,
  TelemetryContext,
  TelemetryEvent,
  TelemetryQueueState,
} from '../telemetry/types';
import type { StoreInitOptions, WorkerManagerOps, WorkerOps } from './ops';

export type { StoreInitOptions as WorkerInitOptions } from './ops';

/**
 * realtime 相关 op 在 `WorkerManagerOps` 中的输入/输出是联合类型，
 * 直接调用时类型收窄不理想，因此这里用更精确的签名做一次类型断言
 * （见 RealtimeClient.request / subscribe 中的 `as unknown as`）。
 */
type RealtimeWorkerClient = {
  call<Op extends RealtimeRequestName>(
    name: 'realtime.request',
    payload: {
      op: Op;
      input: RealtimeRequestInputOf<Op>;
      timeoutMs?: number;
    }
  ): Promise<RealtimeRequestOutputOf<Op>>;
  ob$<Topic extends RealtimeTopicName>(
    name: 'realtime.subscribe',
    payload: {
      topic: Topic;
      input: RealtimeTopicInputOf<Topic>;
    }
  ): Observable<RealtimeTopicEventOf<Topic> | RealtimeSubscriptionReady>;
};

/**
 * 构造与 DOMException/AbortError 形状一致的对象，
 * 让调用方可以像处理 fetch 取消一样通过 `error.name === 'AbortError'` 识别。
 */
function realtimeAbortError(op: RealtimeRequestName) {
  const error = new Error(`Realtime request aborted: ${op}`);
  error.name = 'AbortError';
  return error;
}

/**
 * 管理通道的客户端：
 * - `open` / `close` 打开或关闭一个 store 通道；
 * - 遥测与 realtime 也复用同一条管理通道；
 * - 维护所有打开的连接，便于统一 dispose / 暂停 / 恢复。
 */
export class StoreManagerClient {
  /**
   * closeKey → 连接。
   * 用 closeKey（而不是 store key）作键：同一个 store key 可以被打开多次，
   * worker 端按 key 复用 StoreConsumer，但每次 open 有独立的通道和关闭标识。
   */
  private readonly connections = new Map<
    string,
    {
      store: StoreClient;
      dispose: () => void;
    }
  >();

  constructor(private readonly client: OpClient<WorkerManagerOps>) {
    this.telemetry = new TelemetryClient(this.client);
    this.realtime = new RealtimeClient(this.client);
  }

  /** 遥测客户端（与 worker 端的 TelemetryManager 对应） */
  readonly telemetry: TelemetryClient;

  /** 实时连接客户端（与 worker 端的 RealtimeManager 对应） */
  readonly realtime: RealtimeClient;

  /**
   * 打开一个 store（key 相同则 worker 端复用同一个 StoreConsumer）。
   *
   * 步骤：
   * 1. 创建 MessageChannel：port1 留在本地给 StoreClient 用，port2 转移给 worker；
   * 2. 生成 closeKey，调用管理通道的 'open'，把 port2 和初始化参数交给 worker；
   * 3. 本地用 port1 创建 OpClient，再包装成 StoreClient；
   * 4. 返回 { store, dispose }，dispose 会调用 'close' 并断开本地通道。
   */
  open(key: string, options: StoreInitOptions) {
    const { port1, port2 } = new MessageChannel();

    const client = new OpClient<WorkerOps>(port1);
    const closeKey = uuid();

    this.client
      .call(
        'open',
        // MessagePort 必须作为 transferable 转移给 worker，否则无法跨线程使用
        transfer(
          {
            key,
            closeKey,
            options,
            port: port2,
          },
          [port2]
        )
      )
      .catch(err => {
        console.error('error opening', err);
      });

    const connection = {
      store: new StoreClient(client),
      dispose: () => {
        // 通知 worker 关闭该通道对应的 consumer（按 closeKey 查找），并释放本地记录
        this.client.call('close', closeKey).catch(err => {
          console.error('error closing', err);
        });
        this.connections.delete(closeKey);
      },
    };

    this.connections.set(closeKey, connection);

    return connection;
  }

  /** 关闭所有已打开的连接（通常在窗口卸载时调用） */
  dispose() {
    this.connections.forEach(connection => {
      connection.dispose();
    });
  }

  /** 暂停所有 store 的同步（页面失去焦点时调用，省电） */
  pause() {
    this.connections.forEach(connection => {
      connection.store.pauseSync().catch(err => {
        console.error('error pausing', err);
      });
    });
  }

  /** 恢复所有 store 的同步（页面重新聚焦 / 用户交互时调用） */
  resume() {
    this.connections.forEach(connection => {
      connection.store.resumeSync().catch(err => {
        console.error('error resuming', err);
      });
    });
  }
}

/**
 * 遥测 RPC 的薄封装：每个方法对应 worker 端 TelemetryManager 的一个 op。
 * 事件由 worker 端的 TelemetryManager 入队、批量发送并在失败时重试，
 * 主线程只负责把事件投递过去。
 */
class TelemetryClient {
  constructor(private readonly client: OpClient<WorkerManagerOps>) {}

  /** 设置全局上下文（随每个事件一起上报） */
  setContext(context: TelemetryContext): Promise<void> {
    return this.client.call('telemetry.setContext', context);
  }

  track(event: TelemetryEvent): Promise<{ queued: boolean }> {
    return this.client.call('telemetry.track', event);
  }

  pageview(event: TelemetryEvent): Promise<{ queued: boolean }> {
    return this.client.call('telemetry.pageview', event);
  }

  flush(): Promise<TelemetryAck> {
    return this.client.call('telemetry.flush');
  }

  getQueueState(): Promise<TelemetryQueueState> {
    return this.client.call('telemetry.getQueueState');
  }
}

/**
 * 实时连接 RPC 客户端：配置、请求、拓扑订阅、状态。
 * 真正的连接与协议处理在 worker 端的 RealtimeManager。
 */
export class RealtimeClient {
  constructor(private readonly client: OpClient<WorkerManagerOps>) {}

  configure(context: RealtimeConfigureInput): Promise<void> {
    return this.client.call('realtime.configure', context);
  }

  /**
   * 发起一次实时请求，可选超时与 abort。
   *
   * 注意：signal 只让「本地的 Promise」尽快以 AbortError 拒绝，
   * worker 侧的请求不会被取消（请求本身可能仍会完成）。
   */
  request<Op extends RealtimeRequestName>(
    op: Op,
    input: RealtimeRequestInputOf<Op>,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<RealtimeRequestOutputOf<Op>> {
    const request = (this.client as unknown as RealtimeWorkerClient).call(
      'realtime.request',
      {
        op,
        input,
        timeoutMs: options?.timeoutMs,
      }
    );
    // 未传 signal：无需取消能力，直接返回原始请求
    if (!options?.signal) {
      return request;
    }
    // signal 已经 abort：不再发起等待，直接拒绝
    if (options.signal.aborted) {
      return Promise.reject(realtimeAbortError(op));
    }
    let abortHandler: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortHandler = () => reject(realtimeAbortError(op));
      // once: true 保证首次 abort 后自动移除
      options.signal?.addEventListener('abort', abortHandler, { once: true });
    });
    // 谁先完成用谁的结果；结束时移除监听，避免 signal 泄漏监听器
    return Promise.race([request, aborted]).finally(() => {
      if (abortHandler) {
        options.signal?.removeEventListener('abort', abortHandler);
      }
    });
  }

  /**
   * 订阅某个实时主题：worker 端把事件流通过 ob$ 推回，
   * unsubscribe 时会通知 worker 释放对应的订阅资源。
   */
  subscribe<Topic extends RealtimeTopicName>(
    topic: Topic,
    input: RealtimeTopicInputOf<Topic>
  ): Observable<RealtimeTopicEventOf<Topic> | RealtimeSubscriptionReady> {
    return (this.client as unknown as RealtimeWorkerClient).ob$(
      'realtime.subscribe',
      {
        topic,
        input,
      }
    );
  }

  /** 查询实时连接状态 */
  status(): Promise<RealtimeStatus> {
    return this.client.call('realtime.status');
  }
}

/**
 * 单个 store 的客户端门面，按「代理 + 本地前端」两层组装：
 *
 * - WorkerXxxStorage / WorkerXxxSync：接口实现只是把调用 RPC 到 worker；
 * - DocFrontend / BlobFrontend / AwarenessFrontend / IndexerFrontend：
 *   运行在调用方（主线程），持有 Y.Doc / Blob 等本地数据，
 *   通过上面的代理访问 worker 中的真实 storage 与同步逻辑。
 *
 * 因此 `docFrontend.connectDoc(yDoc)` 里的 Y.Doc 始终留在本线程，
 * 网络与持久化都发生在 worker。
 */
export class StoreClient {
  constructor(private readonly client: OpClient<WorkerOps>) {
    // 先创建各 storage / sync 的 RPC 代理
    this.docStorage = new WorkerDocStorage(this.client);
    this.blobStorage = new WorkerBlobStorage(this.client);
    this.docSync = new WorkerDocSync(this.client);
    this.blobSync = new WorkerBlobSync(this.client);
    this.awarenessSync = new WorkerAwarenessSync(this.client);
    // 再用代理组装本地 frontend（frontend 内部会创建订阅、调度任务）
    this.docFrontend = new DocFrontend(this.docStorage, this.docSync);
    this.blobFrontend = new BlobFrontend(this.blobStorage, this.blobSync);
    this.awarenessFrontend = new AwarenessFrontend(this.awarenessSync);
    this.indexerSync = new WorkerIndexerSync(this.client);
    this.indexerFrontend = new IndexerFrontend(this.indexerSync);
  }

  private readonly docStorage: WorkerDocStorage;
  private readonly blobStorage: WorkerBlobStorage;
  private readonly docSync: WorkerDocSync;
  private readonly blobSync: WorkerBlobSync;
  private readonly awarenessSync: WorkerAwarenessSync;
  private readonly indexerSync: WorkerIndexerSync;

  readonly docFrontend: DocFrontend;
  readonly blobFrontend: BlobFrontend;
  readonly awarenessFrontend: AwarenessFrontend;
  readonly indexerFrontend: IndexerFrontend;

  /** 开启省电模式：交给 worker 端的 indexer 同步处理（降低后台索引频率） */
  enableBatterySaveMode(): Promise<void> {
    return this.client.call('sync.enableBatterySaveMode');
  }
  /** 关闭省电模式 */
  disableBatterySaveMode(): Promise<void> {
    return this.client.call('sync.disableBatterySaveMode');
  }

  /** 暂停同步（worker 端会有 1s 延迟，避免频繁切换） */
  pauseSync() {
    return this.client.call('sync.pauseSync');
  }
  /** 恢复同步 */
  resumeSync() {
    return this.client.call('sync.resumeSync');
  }
}

/**
 * DocStorage 的 worker 代理：每个方法都对应 worker 端注册的 `docStorage.*` op。
 * 本地不保存任何文档数据，仅做序列化 / 反序列化与错误透传。
 */
class WorkerDocStorage implements DocStorage {
  constructor(private readonly client: OpClient<WorkerOps>) {}
  /** 占位值：真实 spaceId 由 worker 端的 storage 持有 */
  spaceId = '';

  readonly storageType = 'doc';
  readonly isReadonly = false;

  async getDoc(docId: string) {
    return this.client.call('docStorage.getDoc', docId);
  }

  async getDocDiff(docId: string, state?: Uint8Array) {
    return this.client.call('docStorage.getDocDiff', { docId, state });
  }

  async pushDocUpdate(update: DocUpdate, origin?: string) {
    return this.client.call('docStorage.pushDocUpdate', { update, origin });
  }

  async getDocTimestamp(docId: string) {
    return this.client.call('docStorage.getDocTimestamp', docId);
  }

  async getDocTimestamps(after?: Date) {
    return this.client.call('docStorage.getDocTimestamps', after ?? null);
  }

  async deleteDoc(docId: string) {
    return this.client.call('docStorage.deleteDoc', docId);
  }

  async applyDocLifecycle(
    docId: string,
    lifecycle: DocLifecycle
  ): Promise<DocLifecycleResult> {
    return this.client.call('docStorage.applyDocLifecycle', {
      docId,
      lifecycle,
    });
  }

  /**
   * 把 worker 端的块更新事件流桥接成回调形式。
   * 返回值用于取消订阅（会通知 worker 释放对应 Observable）。
   */
  subscribeDocUpdate(callback: (update: DocRecord, origin?: string) => void) {
    const subscription = this.client
      .ob$('docStorage.subscribeDocUpdate')
      .subscribe(value => {
        callback(value.update, value.origin);
      });
    return () => {
      subscription.unsubscribe();
    };
  }

  connection = new WorkerDocConnection(this.client);
}

/**
 * 连接状态的代理。
 *
 * 继承 DummyConnection：本地不维护真实连接（connect/disconnect 都是空操作），
 * 仅覆盖 waitForConnected，把等待转发到 worker 端真正的 storage 连接。
 */
class WorkerDocConnection extends DummyConnection {
  constructor(private readonly client: OpClient<WorkerOps>) {
    super();
  }

  /** 缓存等待中的 Promise，重复调用共享同一个 RPC，避免并发重复请求 */
  promise: Promise<void> | undefined;

  override waitForConnected(): Promise<void> {
    if (this.promise) {
      return this.promise;
    }
    this.promise = this.client.call('docStorage.waitForConnected');
    return this.promise;
  }
}

/**
 * BlobStorage 的 worker 代理（图片、附件等二进制资源）。
 * 参数中的 AbortSignal 未转发到 worker，仅保留接口签名。
 */
class WorkerBlobStorage implements BlobStorage {
  constructor(private readonly client: OpClient<WorkerOps>) {}

  readonly storageType = 'blob';
  readonly isReadonly = false;

  get(key: string, _signal?: AbortSignal): Promise<BlobRecord | null> {
    return this.client.call('blobStorage.getBlob', key);
  }
  set(blob: BlobRecord, _signal?: AbortSignal): Promise<void> {
    return this.client.call('blobStorage.setBlob', blob);
  }

  delete(
    key: string,
    permanently: boolean,
    _signal?: AbortSignal
  ): Promise<void> {
    return this.client.call('blobStorage.deleteBlob', { key, permanently });
  }

  release(_signal?: AbortSignal): Promise<void> {
    return this.client.call('blobStorage.releaseBlobs');
  }

  list(_signal?: AbortSignal): Promise<ListedBlobRecord[]> {
    return this.client.call('blobStorage.listBlobs');
  }

  connection = new WorkerBlobConnection(this.client);
}

/** Blob 连接状态的代理，行为同 WorkerDocConnection */
class WorkerBlobConnection extends DummyConnection {
  constructor(private readonly client: OpClient<WorkerOps>) {
    super();
  }

  promise: Promise<void> | undefined;

  override waitForConnected(): Promise<void> {
    if (this.promise) {
      return this.promise;
    }
    this.promise = this.client.call('blobStorage.waitForConnected');
    return this.promise;
  }
}

/**
 * DocSync 的 worker 代理。
 * 状态通过 `ob$` 订阅远端 Observable；带 AbortSignal 的等待会被透传，
 * 由 OpClient 在 abort 时向 worker 发送取消消息。
 */
class WorkerDocSync implements DocSync {
  constructor(private readonly client: OpClient<WorkerOps>) {}

  /** 全局同步状态流 */
  get state$() {
    return this.client.ob$('docSync.state');
  }

  /** 单个文档的同步状态流 */
  docState$(docId: string) {
    return this.client.ob$('docSync.docState', docId);
  }

  async waitForSynced(docId?: string, abort?: AbortSignal): Promise<void> {
    // AbortSignal 作为最后一个参数会被 OpClient 识别并用于取消 RPC
    await this.client.call('docSync.waitForSynced', docId ?? null, abort);
  }

  /**
   * 提升文档同步优先级。
   *
   * 这里用「保持订阅」来维持优先级：订阅建立时 worker 端开始加速，
   * 取消订阅时执行 undo 恢复原优先级，因此返回的正是订阅的取消函数。
   */
  addPriority(docId: string, priority: number) {
    const subscription = this.client
      .ob$('docSync.addPriority', { docId, priority })
      .subscribe();
    return () => {
      subscription.unsubscribe();
    };
  }

  /** 重置同步状态（重建 peer / 重新同步） */
  resetSync(): Promise<void> {
    return this.client.call('docSync.resetSync');
  }
}

/** BlobSync 的 worker 代理：下载 / 上传 / 注册资源源 / 全量下载 */
class WorkerBlobSync implements BlobSync {
  constructor(private readonly client: OpClient<WorkerOps>) {}
  get state$() {
    return this.client.ob$('blobSync.state');
  }
  blobState$(blobId: string) {
    return this.client.ob$('blobSync.blobState', blobId);
  }

  downloadBlob(blobId: string): Promise<boolean> {
    return this.client.call('blobSync.downloadBlob', blobId);
  }
  registerSource(source: BlobSource): Promise<void> {
    return this.client.call('blobSync.registerSource', source);
  }
  unregisterSource(source: BlobSource): Promise<void> {
    return this.client.call('blobSync.unregisterSource', source);
  }
  uploadBlob(blob: BlobRecord, force?: boolean): Promise<true> {
    return this.client.call('blobSync.uploadBlob', { blob, force });
  }
  /**
   * 触发全量下载，并把它适配成 Promise：
   * worker 端用 Observable 表示进度/完成，这里在第一次 next 时视为完成；
   * abort 时取消订阅（worker 端的 teardown 会中止下载）并拒绝。
   */
  fullDownload(peerId?: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abortListener = () => {
        reject(signal?.reason);
        subscription.unsubscribe();
      };

      signal?.addEventListener('abort', abortListener);

      const subscription = this.client
        .ob$('blobSync.fullDownload', peerId ?? null)
        .subscribe({
          next() {
            signal?.removeEventListener('abort', abortListener);
            resolve();
          },
          error(err) {
            signal?.removeEventListener('abort', abortListener);
            reject(err);
          },
        });
    });
  }
}

/**
 * AwarenessSync 的 worker 代理：同步协作者的光标 / 在线状态等临时数据。
 *
 * 订阅采用一个小协议（消息由 worker 端推来）：
 * - 'awareness-update'：远端 awareness 变化，直接回调 onUpdate；
 * - 'awareness-collect'：worker 请求收集本地 awareness，本地调用 onCollect()，
 *   再通过 'awarenessSync.collect' 携带 collectId 回传结果，完成这一次收集。
 */
class WorkerAwarenessSync implements AwarenessSync {
  constructor(private readonly client: OpClient<WorkerOps>) {}

  /** 提交本地 awareness 记录（origin 仅用于事件溯源，不会被存储或传输） */
  update(record: AwarenessRecord, origin?: string): Promise<void> {
    return this.client.call('awarenessSync.update', {
      awareness: record,
      origin,
    });
  }

  subscribeUpdate(
    id: string,
    onUpdate: (update: AwarenessRecord, origin?: string) => void,
    onCollect: () => Promise<AwarenessRecord | null>
  ): () => void {
    const subscription = this.client
      .ob$('awarenessSync.subscribeUpdate', id)
      .subscribe({
        next: update => {
          // 远端 awareness 更新：直接交给调用方
          if (update.type === 'awareness-update') {
            onUpdate(update.awareness, update.origin);
          }
          // worker 请求收集本地 awareness：执行 onCollect 并把结果按 collectId 回传
          if (update.type === 'awareness-collect') {
            onCollect()
              .then(record => {
                if (record) {
                  this.client
                    .call('awarenessSync.collect', {
                      awareness: record,
                      collectId: update.collectId,
                    })
                    .catch(err => {
                      console.error('error feedback collected awareness', err);
                    });
                }
              })
              .catch(err => {
                console.error('error collecting awareness', err);
              });
          }
        },
      });
    return () => {
      subscription.unsubscribe();
    };
  }
}

/**
 * IndexerSync 的 worker 代理：全文检索与聚合。
 *
 * - search / aggregate：一次性查询；
 * - search$ / aggregate$：持续订阅，worker 端在数据变化时推送新结果；
 * - waitFor*：把 worker 端的 Observable「完成」事件桥接成 Promise；
 * - addPriority：与 DocSync 相同，用保持订阅来表示优先级提升。
 */
class WorkerIndexerSync implements IndexerSync {
  constructor(private readonly client: OpClient<WorkerOps>) {}

  /** 一次性查询 */
  search<T extends keyof IndexerSchema, const O extends SearchOptions<T>>(
    table: T,
    query: Query<T>,
    options?: O & { prefer?: IndexerPreferOptions }
  ): Promise<SearchResult<T, O>> {
    return this.client.call('indexerSync.search', { table, query, options });
  }
  /** 一次性聚合查询 */
  aggregate<T extends keyof IndexerSchema, const O extends AggregateOptions<T>>(
    table: T,
    query: Query<T>,
    field: keyof IndexerSchema[T],
    options?: O & { prefer?: IndexerPreferOptions }
  ): Promise<AggregateResult<T, O>> {
    return this.client.call('indexerSync.aggregate', {
      table,
      query,
      field: field as string,
      options,
    });
  }
  /** 持续订阅查询结果（索引变化时重新推送） */
  search$<T extends keyof IndexerSchema, const O extends SearchOptions<T>>(
    table: T,
    query: Query<T>,
    options?: O & { prefer?: IndexerPreferOptions }
  ): Observable<SearchResult<T, O>> {
    return this.client.ob$('indexerSync.subscribeSearch', {
      table,
      query,
      options,
    });
  }
  /** 持续订阅聚合结果 */
  aggregate$<
    T extends keyof IndexerSchema,
    const O extends AggregateOptions<T>,
  >(
    table: T,
    query: Query<T>,
    field: keyof IndexerSchema[T],
    options?: O & { prefer?: IndexerPreferOptions }
  ): Observable<AggregateResult<T, O>> {
    return this.client.ob$('indexerSync.subscribeAggregate', {
      table,
      query,
      field: field as string,
      options,
    });
  }

  /**
   * 等待索引任务全部完成：worker 端在完成时向事件流发送 complete，
   * 这里据此 resolve；abort 时取消订阅并拒绝。
   */
  waitForCompleted(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abortListener = () => {
        reject(signal?.reason);
        subscription.unsubscribe();
      };

      signal?.addEventListener('abort', abortListener);

      const subscription = this.client
        .ob$('indexerSync.waitForCompleted')
        .subscribe({
          complete() {
            signal?.removeEventListener('abort', abortListener);
            resolve();
          },
          error(err) {
            signal?.removeEventListener('abort', abortListener);
            reject(err);
          },
        });
    });
  }
  /** 等待单个文档的索引完成，实现方式同 waitForCompleted */
  waitForDocCompleted(docId: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abortListener = () => {
        reject(signal?.reason);
        subscription.unsubscribe();
      };

      signal?.addEventListener('abort', abortListener);

      const subscription = this.client
        .ob$('indexerSync.waitForDocCompleted', docId)
        .subscribe({
          complete() {
            signal?.removeEventListener('abort', abortListener);
            resolve();
          },
          error(err) {
            signal?.removeEventListener('abort', abortListener);
            reject(err);
          },
        });
    });
  }
  /** 全局索引状态流 */
  get state$() {
    return this.client.ob$('indexerSync.state');
  }
  /** 单文档索引状态流 */
  docState$(docId: string) {
    return this.client.ob$('indexerSync.docState', docId);
  }
  /** 临时提高文档的索引优先级（保持订阅期间生效，取消订阅即恢复） */
  addPriority(docId: string, priority: number) {
    const subscription = this.client
      .ob$('indexerSync.addPriority', { docId, priority })
      .subscribe();
    return () => {
      subscription.unsubscribe();
    };
  }
}
