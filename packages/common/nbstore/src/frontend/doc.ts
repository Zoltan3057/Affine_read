import { groupBy } from 'lodash-es';
import { nanoid } from 'nanoid';
import {
  combineLatest,
  filter,
  first,
  lastValueFrom,
  map,
  Observable,
  ReplaySubject,
  share,
  Subject,
  throttleTime,
} from 'rxjs';
import {
  applyUpdate,
  type Doc as YDoc,
  encodeStateAsUpdate,
  Map as YMap,
  mergeUpdates,
  type Transaction as YTransaction,
} from 'yjs';

import type { DocRecord, DocStorage } from '../storage';
import type { DocSync } from '../sync/doc';
import { AsyncPriorityQueue } from '../utils/async-priority-queue';
import { isEmptyUpdate } from '../utils/is-empty-update';
import { takeUntilAbort } from '../utils/take-until-abort';
import { MANUALLY_STOP, throwIfAborted } from '../utils/throw-if-aborted';

/**
 * 由 nbstore 把 storage / 远端数据写入 Y.Doc 时使用的 Yjs 事务 origin。
 *
 * 作用：
 * 1. `handleDocUpdate` 发现 origin 是它时直接忽略，避免「写进 doc 的远程数据」
 *    又被当成用户编辑 save 回 storage（回声）；
 * 2. 借此区分「用户本地编辑」与「nbstore 应用的外部更新」。
 */
const NBSTORE_ORIGIN = 'nbstore-frontend';

/**
 * 前端任务队列中的任务类型。
 *
 * - load：文档连接后，从本地 storage 读取存量数据；
 * - save：把 Y.Doc 产生的本地 update 合并后写回 storage；
 * - apply：把 storage 上收到的 update（远端协作者或其它来源）应用到 Y.Doc。
 *
 * 同一 docId 的任务会累积在 `status.jobMap` 中，由 mainLoop 按 docId 批量取出，
 * 并固定按 load → apply → save 的顺序执行。
 */
type Job =
  | {
      type: 'load';
      docId: string;
    }
  | {
      type: 'save';
      docId: string;
      update: Uint8Array;
    }
  | {
      type: 'apply';
      docId: string;
      update: Uint8Array;
    };

/**
 * DocFrontend 的可选配置。
 * `mergeUpdates` 允许替换默认的合并实现（例如 Worker / native 侧的高效版本）。
 */
interface DocFrontendOptions {
  mergeUpdates?: (updates: Uint8Array[]) => Promise<Uint8Array> | Uint8Array;
}

/**
 * 单个文档的前端状态。前四项由本文件维护，后四项合并自 DocSync（远端同步）。
 *
 * - ready：Y.Doc 中已经应用过非空的 storage / 远端数据；
 * - loaded：load 任务已执行完（已完成一次 storage 读取流程）；
 * - updating：该文档还有排队中或正在执行的任务；
 * - syncing / synced / syncRetrying / syncErrorMessage：远端同步状态。
 */
export type DocFrontendDocState = {
  /**
   * some data is available in yjs doc instance
   */
  ready: boolean;
  /**
   * data is loaded from local doc storage and applied to yjs doc instance
   */
  loaded: boolean;
  /**
   * some data is being applied to yjs doc instance, or some data is being saved to local doc storage
   */
  updating: boolean;
  /**
   * the doc is syncing with remote peers
   */
  syncing: boolean;
  /**
   * the doc is synced with remote peers
   */
  synced: boolean;
  /**
   * the doc is retrying to sync with remote peers
   */
  syncRetrying: boolean;
  /**
   * the error message when syncing with remote peers
   */
  syncErrorMessage: string | null;
};

/**
 * 整个前端（全部已连接文档）的聚合状态。
 *
 * - total：已知文档总数（取自 DocSync，即各远端上报值的最大值；未提供时回退到本地连接数）；
 * - loaded：已完成 load 的文档数；
 * - updating：任一文档还有未完成的任务；
 * - syncing：正在与远端同步的文档数；
 * - synced：所有文档都已完成远端同步；
 * - syncRetrying / syncErrorMessage：远端同步的重试与错误信息。
 */
export type DocFrontendState = {
  /**
   * total number of docs
   */
  total: number;
  /**
   * number of docs that have been loaded to yjs doc instance
   */
  loaded: number;
  /**
   * some data is being applied to yjs doc instance, or some data is being saved to local doc storage
   */
  updating: boolean;
  /**
   * number of docs that are syncing with remote peers
   */
  syncing: number;
  /**
   * whether all docs are synced with remote peers
   */
  synced: boolean;
  /**
   * whether the doc is retrying to sync with remote peers
   */
  syncRetrying: boolean;
  /**
   * the error message when syncing with remote peers
   */
  syncErrorMessage: string | null;
};

/**
 * nbstore 的前端门面：持有真实的 Y.Doc，并负责它们与本地 storage 之间的读写调度。
 *
 * 两条数据流：
 *
 *   Y.Doc --'update' 事件--> handleDocUpdate --schedule(save)--> storage.pushDocUpdate
 *   storage --subscribeDocUpdate--> onStorageUpdate --schedule(apply)--> applyUpdate(Y.Doc)
 *
 * 调度模型：
 * - 所有任务按 docId 进入 AsyncPriorityQueue，出队时从 jobMap 取出该文档累积的全部任务；
 * - mainLoop 串行处理，单个文档内固定按 load → apply → save 执行；
 * - 远端同步由注入的 DocSync 负责，本类只把它的状态合并进 state$。
 *
 * 典型部署位置：
 * - 本类运行在调用方（通常是主线程），是真正持有 Y.Doc 的一层；
 * - 注入的 DocStorage / DocSync 是 Worker 代理（WorkerDocStorage / WorkerDocSync），
 *   因此持久化与网络同步发生在 Worker，而 Y.Doc 及其变更调度留在主线程。
 */
export class DocFrontend {
  /** 本实例的唯一标识：既作为写入 storage 时的 origin，也用于过滤自己写入产生的回声 */
  private readonly uniqueId = `frontend:${nanoid()}`;

  /**
   * docId → 累积优先级。
   * 基础优先级来自 addPriority 的加减，任务入队时读取它。
   */
  private readonly prioritySettings = new Map<string, number>();

  /**
   * 所有可变运行时状态：
   * - docs：已连接的文档（docId → Y.Doc），本层真正持有 Y.Doc；
   * - connectedDocs：load 任务已完成的文档；
   * - readyDocs：Y.Doc 中已应用过非空数据的文档；
   * - jobDocQueue：按优先级等待处理的 docId 队列（同一 docId 在队列中只保留一份）；
   * - jobMap：每个 docId 累积的待执行任务；
   * - currentJob：mainLoop 当前正在处理的文档及其任务，用于计算 updating。
   */
  private readonly status = {
    docs: new Map<string, YDoc>(),
    connectedDocs: new Set<string>(),
    readyDocs: new Set<string>(),
    jobDocQueue: new AsyncPriorityQueue(),
    jobMap: new Map<string, Job[]>(),
    currentJob: null as { docId: string; jobs: Job[] } | null,
  };

  /** 状态变更通知，携带受影响的 docId；各个 state$ Observable 据此重算 */
  private readonly statusUpdatedSubject$ = new Subject<string>();

  /** 控制 mainLoop 的生命周期，stop() 时 abort */
  private readonly abort = new AbortController();

  constructor(
    public readonly storage: DocStorage,
    private readonly sync: DocSync,
    readonly options: DocFrontendOptions = {}
  ) {}

  /**
   * 批量修改文档生命周期（移入回收站 / 恢复 / 彻底删除）。
   * 是否支持取决于具体 storage 实现（例如 Dummy storage 不提供）。
   */
  applyDocLifecycle(docId: string, lifecycle: 'trash' | 'restore' | 'delete') {
    if (!this.storage.applyDocLifecycle) {
      throw new Error('Document lifecycle is unavailable');
    }
    return this.storage.applyDocLifecycle(docId, lifecycle);
  }

  /**
   * 文档状态的原始流（未做节流，供内部 waitFor* 使用）：
   * - 前端部分手动从 status 计算，并且只在该 docId 发生变化时重算；
   * - 同步部分来自 DocSync.docState$；
   * - 两者 combineLatest 合并成完整状态。
   */
  private _docState$(docId: string): Observable<DocFrontendDocState> {
    const frontendState$ = new Observable<{
      ready: boolean;
      loaded: boolean;
      updating: boolean;
    }>(subscribe => {
      const next = () => {
        subscribe.next({
          ready: this.status.readyDocs.has(docId),
          loaded: this.status.connectedDocs.has(docId),
          updating:
            (this.status.jobMap.get(docId)?.length ?? 0) > 0 ||
            this.status.currentJob?.docId === docId,
        });
      };
      next();
      return this.statusUpdatedSubject$.subscribe(updatedId => {
        if (updatedId === docId) next();
      });
    });
    const syncState$ = this.sync.docState$(docId);
    return combineLatest([frontendState$, syncState$]).pipe(
      map(([frontend, sync]) => ({
        ...frontend,
        synced: sync.synced,
        syncing: sync.syncing,
        syncRetrying: sync.retrying,
        syncErrorMessage: sync.errorMessage,
      }))
    );
  }

  /**
   * 对外暴露的文档状态流：做 1s 节流（首尾都发），避免高频任务调度导致 UI 频繁刷新。
   */
  docState$(docId: string): Observable<DocFrontendDocState> {
    return this._docState$(docId).pipe(
      throttleTime(1000, undefined, {
        trailing: true,
        leading: true,
      })
    );
  }

  /**
   * 全局状态的原始流：把前端统计（文档数 / 已加载数 / 是否有任务）与同步状态合并。
   * 用 share + ReplaySubject(1) 缓存最近一次值，保证多个订阅者共享同一份计算，
   * 也方便晚订阅者立即拿到当前状态。
   */
  private readonly _state$ = combineLatest([
    new Observable<{ total: number; loaded: number; updating: boolean }>(
      subscriber => {
        const next = () => {
          subscriber.next({
            total: this.status.docs.size,
            loaded: this.status.connectedDocs.size,
            updating:
              this.status.jobMap.size > 0 || this.status.currentJob !== null,
          });
        };
        next();
        return this.statusUpdatedSubject$.subscribe(() => {
          next();
        });
      }
    ),
    this.sync.state$,
  ]).pipe(
    map(([frontend, sync]) => ({
      // total 取自 DocSync（远端已知的文档数，可能包含本地尚未连接的文档）；
      // `?? frontend.total` 仅作运行时兜底
      total: sync.total ?? frontend.total,
      loaded: frontend.loaded,
      updating: frontend.updating,
      syncing: sync.syncing,
      synced: sync.synced,
      syncRetrying: sync.retrying,
      syncErrorMessage: sync.errorMessage,
    })),
    share({
      connector: () => new ReplaySubject(1),
    })
  ) satisfies Observable<DocFrontendState>;

  /** 对外暴露的全局状态流：同样做 1s 节流 */
  state$ = this._state$.pipe(
    throttleTime(1000, undefined, {
      leading: true,
      trailing: true,
    })
  );

  /**
   * 启动主循环（只能启动一次）。
   * mainLoop 内部通过 AbortSignal 退出，因此这里不需要额外保存 Promise。
   */
  start() {
    if (this.abort.signal.aborted) {
      throw new Error('doc frontend can only start once');
    }
    this.mainLoop(this.abort.signal).catch(error => {
      console.error(error);
    });
  }

  /** 停止主循环：abort 会让队列等待与任务执行尽快结束 */
  stop() {
    this.abort.abort(MANUALLY_STOP);
  }

  /**
   * 任务调度主循环（串行、按文档批量处理）：
   *
   * 1. 等待 storage 连接成功，随后订阅 storage 的 update 事件
   *    （远端 / 其它来源写入本地 storage 后，会转成 apply 任务）；
   * 2. 循环从优先级队列取 docId——队列为空时 asyncPop 会挂起，
   *    直到有新任务 push 进来或被 abort；
   * 3. 取走该 docId 累积的全部任务，按类型分组，并固定以
   *    load → apply → save 的顺序执行（保证先有存量数据，再应用增量，最后落盘）；
   * 4. 用 currentJob 标记正在处理的任务，供 updating 状态与 waitForUpdated 使用。
   */
  private async mainLoop(signal?: AbortSignal) {
    await this.storage.connection.waitForConnected(signal);
    const dispose = this.storage.subscribeDocUpdate((record, origin) => {
      this.event.onStorageUpdate(record, origin);
    });
    try {
      // wait for storage to connect
      // 注：上面已经等待过一次连接；这里的 Promise.race 额外保证 abort 时能立即退出
      await Promise.race([
        this.storage.connection.waitForConnected(signal),
        new Promise((_, reject) => {
          signal?.addEventListener('abort', reason => {
            reject(reason);
          });
        }),
      ]);

      while (true) {
        throwIfAborted(signal);

        // 阻塞直到某个 docId 有待处理任务（或 abort）
        const docId = await this.status.jobDocQueue.asyncPop(undefined, signal);
        const jobs = this.status.jobMap.get(docId);
        this.status.jobMap.delete(docId);

        // 任务可能在出队前已经被处理掉（例如重复入队），直接跳过
        if (!jobs) {
          this.statusUpdatedSubject$.next(docId);
          continue;
        }

        this.status.currentJob = { docId, jobs };
        this.statusUpdatedSubject$.next(docId);

        const { apply, load, save } = groupBy(jobs, job => job.type) as {
          [key in Job['type']]?: Job[];
        };

        // load 至多一个：建立文档与 storage 的初始连接
        if (load?.length) {
          await this.jobs.load(load[0] as any, signal);
        }

        // apply 保持入队顺序：外部 update 依次应用到 Y.Doc
        for (const applyJob of apply ?? []) {
          await this.jobs.apply(applyJob as any, signal);
        }

        // save 只有一个：所有本地 update 合并后一次写入
        if (save?.length) {
          await this.jobs.save(docId, save as any, signal);
        }

        this.status.currentJob = null;
        this.statusUpdatedSubject$.next(docId);
      }
    } finally {
      // 循环退出（abort 或异常）时取消对 storage 的订阅
      dispose();
    }
  }

  /**
   * Connect a doc to the frontend, the doc will sync with the doc storage.
   * @param doc - The doc to connect
   */
  connectDoc(doc: YDoc) {
    this._connectDoc(doc);
  }

  /**
   * 三类任务的具体实现。
   * 它们只由 mainLoop 调用，因此无需自行加锁；执行期间该文档的任务已被移出 jobMap。
   */
  readonly jobs = {
    /**
     * load：把文档接入 storage。
     *
     * 1. 若 Y.Doc 在连接前就有内容（例如新建文档时已写入初始块），先补一个 save 任务落盘；
     * 2. 向 Yjs 监听者发出本地同步完成的 'sync' 事件；
     * 3. 从 storage 读取存量数据（SnapshotDocStorageBase 会把 snapshot + updates 合并），
     *    非空则 apply 到 Y.Doc 并标记 ready；
     * 4. 标记 connected，此后到达的 apply 任务才会真正写入 Y.Doc。
     */
    load: async (job: Job & { type: 'load' }, signal?: AbortSignal) => {
      const doc = this.status.docs.get(job.docId);
      if (!doc) {
        return;
      }
      // 连接前 Y.Doc 可能已有内容（例如新建文档时 initFn 刚写入的初始块），
      // 需要确保它也会被持久化，因此额外补一个 save 任务
      const existingData = encodeStateAsUpdate(doc);

      if (!isEmptyUpdate(existingData)) {
        this.schedule({
          type: 'save',
          docId: doc.guid,
          update: existingData,
        });
      }

      // mark doc as loaded
      // 通知 Yjs 生态的监听者（如 provider）：本地状态已可用；
      // 注意此时还没读取 storage 中的存量数据
      doc.emit('sync', [true, doc]);

      // 读取本地存量数据（SnapshotDocStorageBase 的实现会把 snapshot 与增量 updates 合并）
      const docRecord = await this.storage.getDoc(job.docId);
      throwIfAborted(signal);

      if (docRecord && !isEmptyUpdate(docRecord.bin)) {
        // 直接同步应用（不经任务队列），把存量数据写入 Y.Doc
        this.applyUpdate(job.docId, docRecord.bin);

        this.status.readyDocs.add(job.docId);
      }

      // 标记 connected 之后，后续 apply 任务才会真正写入 Y.Doc，
      // 避免与上面读取存量数据的过程交叉
      this.status.connectedDocs.add(job.docId);
      this.statusUpdatedSubject$.next(job.docId);
    },
    /**
     * save：把一批本地 update 合并后写入 storage。
     *
     * - 文档已断开或尚未 load 完成时跳过，避免读到存量数据前就写库；
     * - 多个 update 合并成一次写入，显著减少存储与后续同步的负担；
     * - 以 uniqueId 作为 origin 写入，storage 广播时带回该 origin，
     *   本实例的 onStorageUpdate 据此忽略自己的写入（防回声）。
     */
    save: async (
      docId: string,
      jobs: (Job & { type: 'save' })[],
      signal?: AbortSignal
    ) => {
      // 文档已断开，无需保存
      if (!this.status.docs.has(docId)) {
        return;
      }
      // 只有 load 完成后才写回，避免与存量数据的读取交叉
      if (this.status.connectedDocs.has(docId)) {
        // 过滤空 update 后合并成一个
        const merged = await this.mergeUpdates(
          jobs.map(j => j.update).filter(update => !isEmptyUpdate(update))
        );
        throwIfAborted(signal);
        await this.storage.pushDocUpdate(
          {
            docId,
            bin: merged,
          },
          this.uniqueId
        );
      }
    },
    /**
     * apply：把 storage 上收到的 update 应用到 Y.Doc（通常是远端协作者的改动）。
     *
     * - 文档已断开则丢弃；
     * - 文档尚未 load 完成时也丢弃：因为 load 会从 storage 读取合并后的全量数据，
     *   这段窗口内的 update 已经包含在其中，不会丢数据；
     * - 非空 update 应用后把文档标记为 ready。
     */
    apply: async (job: Job & { type: 'apply' }, signal?: AbortSignal) => {
      throwIfAborted(signal);
      if (!this.status.docs.has(job.docId)) {
        return;
      }
      if (this.status.connectedDocs.has(job.docId)) {
        this.applyUpdate(job.docId, job.update);
      }
      if (!isEmptyUpdate(job.update)) {
        this.status.readyDocs.add(job.docId);
        this.statusUpdatedSubject$.next(job.docId);
      }
    },
  };

  event = {
    /**
     * storage 写入了新数据的回调。
     * 若 origin 是自己（pushDocUpdate 时传的 uniqueId），说明这条数据正是本实例刚写的，
     * 跳过即可；否则（远端同步、其它实例）排一个 apply 任务回写到 Y.Doc。
     */
    onStorageUpdate: (update: DocRecord, origin?: string) => {
      if (origin !== this.uniqueId) {
        this.schedule({
          type: 'apply',
          docId: update.docId,
          update: update.bin,
        });
      }
    },
  };

  /**
   * Disconnect a doc from the frontend, the doc will stop syncing with the doc storage.
   * It's not recommended to use this method directly, better to use `doc.destroy()`.
   *
   * @param doc - The doc to disconnect
   */
  /**
   * 断开文档：清空该文档在所有状态结构中的记录、移除队列中的待处理项，
   * 并摘掉 Y.Doc 的 update 监听。
   *
   * 注意：这里不会销毁 Y.Doc；通常应由调用方 `doc.destroy()` 触发
   * （'destroy' 事件会再回调本方法）。
   */
  disconnectDoc(doc: YDoc) {
    this.status.docs.delete(doc.guid);
    this.status.connectedDocs.delete(doc.guid);
    this.status.readyDocs.delete(doc.guid);
    this.status.jobDocQueue.remove(doc.guid);
    this.status.jobMap.delete(doc.guid);
    this.statusUpdatedSubject$.next(doc.guid);
    doc.off('update', this.handleDocUpdate);
  }

  /**
   * 临时提高某文档的调度优先级（累加，可被多次调用叠加），
   * 同时把相同优先级同步给 DocSync，保证本地处理与远端同步一起加速。
   *
   * 返回一个恢复函数，用于撤销本次提高；应只调用一次。
   */
  addPriority(id: string, priority: number) {
    const undoSyncPriority = this.sync?.addPriority(id, priority);
    const oldPriority = this.prioritySettings.get(id) ?? 0;
    const newPriority = oldPriority + priority;

    this.prioritySettings.set(id, newPriority);
    this.status.jobDocQueue.setPriority(id, newPriority);

    return () => {
      const currentPriority = this.prioritySettings.get(id) ?? 0;
      const restoredPriority = currentPriority - priority;
      this.prioritySettings.set(id, restoredPriority);
      this.status.jobDocQueue.setPriority(id, restoredPriority);

      undoSyncPriority?.();
    };
  }

  /**
   * 连接一个 Y.Doc：
   * - 先排一个 load 任务，再登记 docs（两者之间没有 await，主循环不会插队）；
   * - 监听 'update'：本地编辑会转成 save 任务；
   * - 监听 'destroy'：销毁时自动断开。
   */
  private _connectDoc(doc: YDoc) {
    if (this.status.docs.has(doc.guid)) {
      throw new Error('doc already connected');
    }
    this.schedule({
      type: 'load',
      docId: doc.guid,
    });

    this.status.docs.set(doc.guid, doc);
    this.statusUpdatedSubject$.next(doc.guid);

    doc.on('update', this.handleDocUpdate);

    doc.on('destroy', () => {
      this.disconnectDoc(doc);
    });
  }

  /**
   * 把任务加入调度：
   * - 队列按 docId 去重（相同优先级重复 push 无效果），只负责「唤醒」主循环；
   * - 真正的任务内容累积在 jobMap 中，同文档的任务一次性取走；
   * - 通知状态变更，驱动 state$ 重新计算。
   */
  private schedule(job: Job) {
    const priority = this.prioritySettings.get(job.docId) ?? 0;
    this.status.jobDocQueue.push(job.docId, priority);

    const existingJobs = this.status.jobMap.get(job.docId) ?? [];
    existingJobs.push(job);
    this.status.jobMap.set(job.docId, existingJobs);
    this.statusUpdatedSubject$.next(job.docId);
  }

  /**
   * 是否正在把外部 update 应用到 Y.Doc。
   * 用于在 debug 模式下检测「应用远端数据的过程中又触发了本地修改」这种编码错误，
   * 否则会把文档的「最后编辑者」错误地记到当前用户头上。
   */
  private isApplyingUpdate = false;

  /**
   * 把一份 update 同步应用到指定 Y.Doc：
   * - 文档不存在或 update 为空时直接忽略；
   * - 以 NBSTORE_ORIGIN 作为 origin，handleDocUpdate 会据此跳过回写；
   * - 应用失败不会抛出（只打印日志），避免单个坏 update 中断主循环。
   */
  applyUpdate(docId: string, update: Uint8Array) {
    const doc = this.status.docs.get(docId);
    if (doc && !isEmptyUpdate(update)) {
      try {
        this.isApplyingUpdate = true;
        applyUpdate(doc, update, NBSTORE_ORIGIN);
      } catch (err) {
        console.error('failed to apply update yjs doc', err);
      } finally {
        this.isApplyingUpdate = false;
      }
    }
  }

  /**
   * Y.Doc 'update' 事件的处理器：本地编辑的入口。
   *
   * - origin 为 NBSTORE_ORIGIN：这是 nbstore 自己从 storage 应用进来的数据，
   *   无需再保存回去（否则会形成写库 → 收到事件 → 再写库的循环）；
   * - 应用远端更新期间若又检测到本地修改，debug 模式下打印警告；
   * - 其余情况说明是用户（或其它本地代码）产生的真实编辑，排一个 save 任务。
   */
  private readonly handleDocUpdate = (
    update: Uint8Array,
    origin: any,
    doc: YDoc,
    transaction: YTransaction
  ) => {
    if (origin === NBSTORE_ORIGIN) {
      return;
    }
    if (this.isApplyingUpdate && BUILD_CONFIG.debug) {
      // 收集本次事务中被修改的 Y.Map 字段，帮助定位是哪段代码在 apply 期间改动了文档
      let changedList = '';
      for (const [changed, keys] of transaction.changed) {
        for (const key of keys) {
          if (changed instanceof YMap && key) {
            changedList += `${key} => ${changed.get(key)}\n`;
          }
        }
      }
      console.warn(`⚠️ When nbstore applies a remote update, some code triggers a local change to the doc.
This will causes the document's 'edited by' to become the current user, even if the user has not actually modified the document.
This is usually caused by a coding error and needs to be fixed by the developer.
Changed:
${changedList}
`);
    }
    // 文档已断开（例如 destroy 之后才收到事件）则忽略
    if (!this.status.docs.has(doc.guid)) {
      return;
    }

    // 真实的本地编辑：排一个 save 任务，等待主循环合并后落盘
    this.schedule({
      type: 'save',
      docId: doc.guid,
      update,
    });
  };

  /**
   * 合并多个 Yjs update；可被 options.mergeUpdates 覆盖以使用更高效的实现。
   * 空 update 会被过滤掉。
   */
  protected mergeUpdates(updates: Uint8Array[]) {
    const merge = this.options?.mergeUpdates ?? mergeUpdates;

    return merge(updates.filter(bin => !isEmptyUpdate(bin)));
  }

  /**
   * 等待任务处理完（updating 变为 false）。
   * - 不传 docId：等待所有文档的队列清空；
   * - 传 docId：只等该文档。
   * 内部使用未节流的原始流，避免 1s 节流带来的额外等待。
   */
  async waitForUpdated(docId?: string, abort?: AbortSignal) {
    const source$: Observable<DocFrontendDocState | DocFrontendState> = docId
      ? this._docState$(docId)
      : this._state$;
    await lastValueFrom(
      source$.pipe(
        filter(status => !status.updating),
        takeUntilAbort(abort),
        first()
      )
    );
    return;
  }

  /** 等待该文档完成 load（即已完成一次 storage 读取流程） */
  async waitForDocLoaded(docId: string, abort?: AbortSignal) {
    await lastValueFrom(
      this._docState$(docId).pipe(
        filter(state => state.loaded),
        takeUntilAbort(abort),
        first()
      )
    );
  }

  /**
   * 等待「本地处理完成 + 远端同步完成」。
   * 先确保本地队列清空（数据已落盘），再等待 DocSync 完成远端同步。
   */
  async waitForSynced(docId?: string, abort?: AbortSignal) {
    await this.waitForUpdated(docId, abort);
    await this.sync.waitForSynced(docId, abort);
  }

  /** 等待该文档 ready（Y.Doc 中已有可用数据） */
  async waitForDocReady(docId: string, abort?: AbortSignal) {
    await lastValueFrom(
      this._docState$(docId).pipe(
        filter(state => state.ready),
        takeUntilAbort(abort),
        first()
      )
    );
  }

  /** 重置远端同步状态（重建 peer / 重新走一轮同步），委托给 DocSync */
  async resetSync() {
    await this.sync.resetSync();
  }
}
