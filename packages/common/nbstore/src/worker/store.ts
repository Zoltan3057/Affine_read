import type { OpConsumer } from '@toeverything/infra/op';
import { isEqual } from 'lodash-es';
import { Observable } from 'rxjs';

import { type StorageConstructor } from '../impls';
import { SpaceStorage } from '../storage';
import type { AwarenessRecord } from '../storage/awareness';
import { Sync } from '../sync';
import type { PeerStorageOptions } from '../sync/types';
import { MANUALLY_STOP } from '../utils/throw-if-aborted';
import type { StoreInitOptions, WorkerOps } from './ops';

/**
 * Worker 侧的单个 store：真正持有 SpaceStorage（本地 + 各远端）与 Sync，
 * 并把它们包装成一组 RPC handler 注册到与调用方相连的 OpConsumer 上。
 *
 * 与 client.ts 的对应关系：
 * - 本类由 `StoreManagerConsumer.open` 按 key 创建，并按引用计数复用；
 * - 每个连接对应一个 `OpConsumer<WorkerOps>`，`registerHandlers` 把方法挂到它上面；
 * - client 端的 `WorkerDocStorage` 等方法调用最终都会落到这里的实现。
 *
 * 生命周期：
 * 构造时立即按 `StoreInitOptions` 装配 storage / sync 并启动；
 * `destroy()` 停止同步并销毁所有 storage；`reconfigure()` 支持运行中替换远端。
 */
export class StoreConsumer {
  /** 本地 storage + 远端 storage 集合；destroy 后为 null */
  private storages: PeerStorageOptions<SpaceStorage> | null = null;
  /** 本地与远端之间的同步协调器；destroy 后为 null */
  private sync: Sync | null = null;
  /** 当前生效的初始化参数，用于 reconfigure 时判断哪些远端需要重建 */
  private initOptions: StoreInitOptions;

  /** 获取本地 storage，未初始化（或已销毁）时抛错 */
  get ensureLocal() {
    if (!this.storages) {
      throw new Error('Not initialized');
    }
    return this.storages.local;
  }

  /** 获取 Sync 实例，未初始化（或已销毁）时抛错 */
  get ensureSync() {
    if (!this.sync) {
      throw new Error('Sync not initialized');
    }
    return this.sync;
  }

  // ── 便捷访问器：从 local / sync 中取出某一类能力 ──

  get docStorage() {
    return this.ensureLocal.get('doc');
  }

  get docSync() {
    return this.ensureSync.doc;
  }

  get blobStorage() {
    return this.ensureLocal.get('blob');
  }

  get blobSync() {
    return this.ensureSync.blob;
  }

  get docSyncStorage() {
    return this.ensureLocal.get('docSync');
  }

  get awarenessStorage() {
    return this.ensureLocal.get('awareness');
  }

  get awarenessSync() {
    return this.ensureSync.awareness;
  }

  get indexerStorage() {
    return this.ensureLocal.get('indexer');
  }

  get indexerSync() {
    return this.ensureSync.indexer;
  }

  constructor(
    private readonly availableStorageImplementations: StorageConstructor[],
    init: StoreInitOptions
  ) {
    this.initOptions = init;
    this.initWithOptions(init);
  }

  /**
   * 按配置里的 `{ name, opts }` 找到对应的 storage 实现类并实例化。
   * - 该存储类型未配置（undefined）时返回 undefined；
   * - 配置了未知的实现名则直接抛错，避免静默降级。
   */
  private createStorage(
    opt: StoreInitOptions['local'][keyof StoreInitOptions['local']]
  ) {
    if (opt === undefined) {
      return undefined;
    }
    const Storage = this.availableStorageImplementations.find(
      impl => impl.identifier === opt.name
    );
    if (!Storage) {
      throw new Error(`Storage implementation ${opt.name} not found`);
    }
    return new Storage(opt.opts);
  }

  /**
   * 按初始化参数装配整个 store：
   * 1. 本地 storage 包成 SpaceStorage（未配置的类型由内部 Dummy storage 兜底）；
   * 2. 每个远端 peer 也是一个 SpaceStorage（通常只有 doc / blob / awareness 等）；
   * 3. 用 local + remotes 创建 Sync；
   * 4. 连接所有 storage，并启动同步。
   */
  private initWithOptions(init: StoreInitOptions) {
    this.storages = {
      local: new SpaceStorage(
        Object.fromEntries(
          Object.entries(init.local).map(([type, opt]) => {
            return [type, this.createStorage(opt)];
          })
        )
      ),
      remotes: Object.fromEntries(
        Object.entries(init.remotes).map(([peer, opts]) => {
          return [
            peer,
            new SpaceStorage(
              Object.fromEntries(
                Object.entries(opts).map(([type, opt]) => {
                  return [type, this.createStorage(opt)];
                })
              )
            ),
          ];
        })
      ),
    };
    this.sync = new Sync(this.storages);
    this.storages.local.connect();
    for (const remote of Object.values(this.storages.remotes)) {
      remote.connect();
    }
    this.sync.start();
  }

  /** 把一个连接（OpConsumer）接到本 store 上，之后该通道上的调用由 registerHandlers 处理 */
  bindConsumer(consumer: OpConsumer<WorkerOps>) {
    this.registerHandlers(consumer);
  }

  /**
   * 运行中替换远端配置（本地配置不允许变化）。
   *
   * 策略：只重建发生变化的远端，未变化的直接复用；
   * 先让 Sync 切换到新的 remotes，成功后再销毁被替换掉的旧远端；
   * 若中途失败，清理本次新建的远端并抛出，保持原状态可用。
   */
  async reconfigure(init: StoreInitOptions) {
    // 完全相同的配置：无需任何操作
    if (isEqual(this.initOptions, init)) return;
    // 本地 storage 的配置在 store 打开期间不可变
    if (!isEqual(this.initOptions.local, init.local)) {
      throw new Error(
        'Local storage configuration cannot change while a store is open'
      );
    }
    const storages = this.storages;
    if (!storages) throw new Error('Store is closed');
    const previous = storages.remotes;
    const remotes: Record<string, SpaceStorage> = {};
    const created: SpaceStorage[] = [];
    try {
      for (const [id, options] of Object.entries(init.remotes)) {
        // 配置没变：复用现有实例
        if (isEqual(this.initOptions.remotes[id], options)) {
          remotes[id] = storages.remotes[id];
        } else {
          // 配置变了：新建并连接
          const remote = new SpaceStorage(
            Object.fromEntries(
              Object.entries(options).map(([type, opt]) => [
                type,
                this.createStorage(opt),
              ])
            )
          );
          created.push(remote);
          remotes[id] = remote;
          remote.connect();
        }
      }
      // 交给 Sync 重建 peer 列表；成功后才算配置生效
      await this.ensureSync.reconfigure(remotes);
      this.initOptions = init;
    } catch (error) {
      // 失败：回滚本次新建的远端，避免资源泄漏
      for (const remote of created) {
        remote.disconnect();
        await remote.destroy();
      }
      throw error;
    }
    // 成功：销毁不再使用的旧远端
    for (const [id, remote] of Object.entries(previous)) {
      if (remote !== remotes[id]) {
        remote.disconnect();
        await remote.destroy();
      }
    }
  }

  /**
   * 销毁 store：先恢复同步（防止暂停状态遗留在 Sync 内部），
   * 再停止 Sync、断开并销毁本地与所有远端 storage，最后清空引用。
   * 任一步失败都会向上抛出，但不会回滚已完成的步骤。
   */
  async destroy() {
    this.resumeSync();
    await this.sync?.stop();
    this.storages?.local.disconnect();
    await this.storages?.local.destroy();
    for (const remote of Object.values(this.storages?.remotes ?? {})) {
      remote.disconnect();
      await remote.destroy();
    }

    this.sync = null;
    this.storages = null;
  }

  /**
   * 暂停同步的延迟（毫秒）。
   * 页面失焦时并不立刻暂停，给用户切回来的机会，避免反复启停同步。
   */
  private readonly ENABLE_BATTERY_SAVE_MODE_DELAY = 1000;
  /** 等待中的暂停定时器；resume 会取消它 */
  private syncPauseTimeout: NodeJS.Timeout | null = null;
  /** 是否已经真正暂停（定时器到期后置为 true） */
  private syncPaused = false;

  /**
   * 延迟暂停同步（只暂停索引器同步，文档同步不受影响）：
   * - 已有定时器或已暂停时忽略重复调用；
   * - 到期后调用 indexerSync.pauseSync()。
   */
  private pauseSync() {
    if (this.syncPauseTimeout || this.syncPaused) {
      return;
    }
    this.syncPauseTimeout = setTimeout(() => {
      if (!this.syncPaused) {
        this.indexerSync.pauseSync();
        this.syncPaused = true;
        console.log('[IndexerSync] paused');
      }
    }, this.ENABLE_BATTERY_SAVE_MODE_DELAY);
  }

  /** 取消待执行的暂停并恢复已暂停的索引器同步 */
  private resumeSync() {
    if (this.syncPauseTimeout) {
      clearTimeout(this.syncPauseTimeout);
      this.syncPauseTimeout = null;
    }
    if (this.syncPaused) {
      this.indexerSync.resumeSync();
      this.syncPaused = false;
      console.log('[IndexerSync] resumed');
    }
  }

  /** 开启省电模式：同样只作用于索引器同步 */
  private enableBatterySaveMode() {
    console.log('[IndexerSync] enable battery save mode');
    this.indexerSync.enableBatterySaveMode();
  }

  /** 关闭省电模式 */
  private disableBatterySaveMode() {
    console.log('[IndexerSync] disable battery save mode');
    this.indexerSync.disableBatterySaveMode();
  }

  /**
   * 注册所有 worker op 的具体实现。
   *
   * 约定：
   * - 普通方法返回 Promise，对应 client 端的 `call`；
   * - 返回 Observable 的 handler 对应 client 端的 `ob$`，
   *   teardown（unsubscribe）时执行清理；
   * - handler 的第二个参数 `ctx` 携带 RPC 上下文（如 `ctx.signal`，客户端取消时触发）。
   *
   * awareness 的「收集」是一个反向请求：worker 需要调用方提供本地 awareness，
   * 因此用 collectJobs 按自增 collectId 保存待完成的 Promise，
   * 等调用方通过 `*.collect` op 回传结果后再 resolve。
   */
  private registerHandlers(consumer: OpConsumer<WorkerOps>) {
    /** collectId → 等待调用方回传 awareness 的 resolve 函数 */
    const collectJobs = new Map<
      string,
      (awareness: AwarenessRecord | null) => void
    >();
    let collectId = 0;
    consumer.registerAll({
      'docStorage.getDoc': (docId: string) => this.docStorage.getDoc(docId),
      'docStorage.getDocDiff': ({ docId, state }) =>
        this.docStorage.getDocDiff(docId, state),
      'docStorage.pushDocUpdate': ({ update, origin }) =>
        this.docStorage.pushDocUpdate(update, origin),
      'docStorage.getDocTimestamps': after =>
        this.docStorage.getDocTimestamps(after ?? undefined),
      'docStorage.getDocTimestamp': docId =>
        this.docStorage.getDocTimestamp(docId),
      'docStorage.deleteDoc': (docId: string) =>
        this.docStorage.deleteDoc(docId),
      'docStorage.applyDocLifecycle': async ({ docId, lifecycle }) => {
        // 生命周期操作由支持它的远端（通常是云端）执行；本地 storage 不实现该能力
        const remote = Object.values(this.storages?.remotes ?? {})
          .map(storage => storage.get('doc'))
          .find(storage => storage.applyDocLifecycle);
        if (!remote?.applyDocLifecycle) {
          throw new Error('Document lifecycle is unavailable');
        }
        return await remote.applyDocLifecycle(docId, lifecycle);
      },
      // 把 storage 的「回调式」订阅包装成 Observable，供 client 端 ob$ 使用；
      // 返回的 unsubscribe 就是 Observable 的 teardown
      'docStorage.subscribeDocUpdate': () =>
        new Observable(subscriber => {
          return this.docStorage.subscribeDocUpdate((update, origin) => {
            subscriber.next({ update, origin });
          });
        }),
      'docStorage.waitForConnected': (_, ctx) =>
        this.docStorage.connection.waitForConnected(ctx.signal),
      'blobStorage.getBlob': key => this.blobStorage.get(key),
      'blobStorage.setBlob': blob => this.blobStorage.set(blob),
      'blobStorage.deleteBlob': ({ key, permanently }) =>
        this.blobStorage.delete(key, permanently),
      'blobStorage.releaseBlobs': () => this.blobStorage.release(),
      'blobStorage.listBlobs': () => this.blobStorage.list(),
      'blobStorage.waitForConnected': (_, ctx) =>
        this.blobStorage.connection.waitForConnected(ctx.signal),
      'awarenessStorage.update': ({ awareness, origin }) =>
        this.awarenessStorage.update(awareness, origin),
      'awarenessStorage.subscribeUpdate': docId =>
        new Observable(subscriber => {
          return this.awarenessStorage.subscribeUpdate(
            docId,
            (update, origin) => {
              subscriber.next({
                type: 'awareness-update',
                awareness: update,
                origin,
              });
            },
            // onCollect：storage 需要调用方提供本地 awareness。
            // 注册一个待 resolve 的 Promise，调用方稍后通过 'awarenessStorage.collect' 回传。
            () => {
              const currentCollectId = collectId++;
              const promise = new Promise<AwarenessRecord | null>(resolve => {
                collectJobs.set(currentCollectId.toString(), awareness => {
                  resolve(awareness);
                  collectJobs.delete(currentCollectId.toString());
                });
              });
              return promise;
            }
          );
        }),
      // 按 collectId 找到等待中的 Promise 并 resolve（无匹配时静默忽略）
      'awarenessStorage.collect': ({ collectId, awareness }) =>
        collectJobs.get(collectId)?.(awareness),
      'awarenessStorage.waitForConnected': (_, ctx) =>
        this.awarenessStorage.connection.waitForConnected(ctx.signal),
      'docSync.state': () => this.docSync.state$,
      'docSync.docState': docId =>
        new Observable(subscriber => {
          const subscription = this.docSync
            .docState$(docId)
            .subscribe(state => {
              subscriber.next(state);
            });
          return () => subscription.unsubscribe();
        }),
      // 优先级提升靠「订阅存活」表示：订阅时 addPriority，退订时执行 undo
      'docSync.addPriority': ({ docId, priority }) =>
        new Observable(() => {
          const undo = this.docSync.addPriority(docId, priority);
          return () => undo();
        }),
      'docSync.waitForSynced': (docId, ctx) =>
        this.docSync.waitForSynced(docId ?? undefined, ctx.signal),
      'docSync.resetSync': () => this.docSync.resetSync(),
      'blobSync.state': () => this.blobSync.state$,
      'blobSync.blobState': blobId => this.blobSync.blobState$(blobId),
      'blobSync.downloadBlob': key => this.blobSync.downloadBlob(key),
      'blobSync.registerSource': source => this.blobSync.registerSource(source),
      'blobSync.unregisterSource': source =>
        this.blobSync.unregisterSource(source),
      'blobSync.uploadBlob': ({ blob, force }) =>
        this.blobSync.uploadBlob(blob, force),
      // Promise 形式的全量下载适配成 Observable：成功时 next + complete，
      // 客户端退订时通过 abort 中止下载
      'blobSync.fullDownload': peerId =>
        new Observable(subscriber => {
          const abortController = new AbortController();
          this.blobSync
            .fullDownload(peerId ?? undefined, abortController.signal)
            .then(() => {
              subscriber.next();
              subscriber.complete();
            })
            .catch(error => {
              subscriber.error(error);
            });
          return () => abortController.abort(MANUALLY_STOP);
        }),
      'awarenessSync.update': ({ awareness, origin }) =>
        this.awarenessSync.update(awareness, origin),
      'awarenessSync.subscribeUpdate': docId =>
        new Observable(subscriber => {
          return this.awarenessSync.subscribeUpdate(
            docId,
            (update, origin) => {
              subscriber.next({
                type: 'awareness-update',
                awareness: update,
                origin,
              });
            },
            // onCollect：先把 collectId 推给调用方，再等待它通过 'awarenessSync.collect' 回传
            // 本地 awareness（client 端的 WorkerAwarenessSync 已实现这一来回收发）
            () => {
              const currentCollectId = collectId++;
              const promise = new Promise<AwarenessRecord | null>(resolve => {
                collectJobs.set(currentCollectId.toString(), awareness => {
                  resolve(awareness);
                  collectJobs.delete(currentCollectId.toString());
                });
              });
              subscriber.next({
                type: 'awareness-collect',
                collectId: currentCollectId.toString(),
              });
              return promise;
            }
          );
        }),
      'awarenessSync.collect': ({ collectId, awareness }) =>
        collectJobs.get(collectId)?.(awareness),
      'indexerSync.state': () => this.indexerSync.state$,
      'indexerSync.docState': (docId: string) =>
        this.indexerSync.docState$(docId),
      // 同 docSync.addPriority：用订阅生命周期表示优先级提升的持续范围
      'indexerSync.addPriority': ({ docId, priority }) =>
        new Observable(() => {
          const undo = this.indexerSync.addPriority(docId, priority);
          return () => undo();
        }),
      'indexerSync.waitForCompleted': (_, ctx) =>
        this.indexerSync.waitForCompleted(ctx.signal),
      'indexerSync.waitForDocCompleted': (docId: string, ctx) =>
        this.indexerSync.waitForDocCompleted(docId, ctx.signal),
      'indexerSync.aggregate': ({ table, query, field, options }) =>
        this.indexerSync.aggregate(table, query, field, options),
      'indexerSync.search': ({ table, query, options }) =>
        this.indexerSync.search(table, query, options),
      'indexerSync.subscribeSearch': ({ table, query, options }) =>
        this.indexerSync.search$(table, query, options),
      'indexerSync.subscribeAggregate': ({ table, query, field, options }) =>
        this.indexerSync.aggregate$(table, query, field, options),
      // 省电 / 暂停相关（见上方 pauseSync / resumeSync 的实现）
      'sync.enableBatterySaveMode': () => this.enableBatterySaveMode(),
      'sync.disableBatterySaveMode': () => this.disableBatterySaveMode(),
      'sync.pauseSync': () => this.pauseSync(),
      'sync.resumeSync': () => this.resumeSync(),
    });
  }
}
