import type {
  StoreClient,
  WorkerInitOptions,
} from '@affine/nbstore/worker/client';
import { Entity } from '@toeverything/infra';

import type { FeatureFlagService } from '../../feature-flag';
import type { NbstoreService } from '../../storage';
import { WorkspaceEngineBeforeStart } from '../events';
import type { WorkspaceService } from '../services/workspace';

/**
 * 工作区的数据引擎实体：封装一个 nbstore `StoreClient`，
 * 向外提供 doc / blob / indexer / awareness 四个 frontend。
 *
 * 在 AFFiNE 的分层中，它位于「工作区业务」和「nbstore Worker 通道」之间：
 * - 由 `WorkspaceEngineService` 懒创建（首次访问 `workspace.engine` 时）；
 * - 由 `WorkspaceRepo.instantiate` 在打开工作区时调用 `start()`；
 * - 随 WorkspaceScope 销毁而 `dispose()`，disposables 中登记的回调会被执行。
 *
 * 注意：`start()` 之前 `client` 为 undefined，此时访问 getter 会抛错。
 */
export class WorkspaceEngine extends Entity<{
  /** 是否以分享模式打开：会改变底层 store 的 key，避免和普通打开模式互相复用 */
  isSharedMode?: boolean;
  /** 传给 worker 端 StoreConsumer 的 storage 初始化配置（由工作区 flavour 提供） */
  engineWorkerInitOptions: WorkerInitOptions;
}> {
  /** nbstore 的 store 客户端；start() 成功后才有值 */
  client?: StoreClient;
  /** 防重复启动标记 */
  started = false;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly nbstoreService: NbstoreService,
    private readonly featureFlagService: FeatureFlagService
  ) {
    super();
  }

  // ── 四个 frontend：运行在主线程，真正持有 Y.Doc / Blob / awareness 数据，
  //    通过 StoreClient 内部的 RPC 代理访问 worker 中的 storage 与同步逻辑 ──

  /** 文档前端：持有 Y.Doc，并负责与本地 storage 的读写调度（见 frontend/doc.ts） */
  get doc() {
    if (!this.client) {
      throw new Error('Engine is not initialized');
    }
    return this.client.docFrontend;
  }

  /** Blob 前端：图片、附件等二进制资源 */
  get blob() {
    if (!this.client) {
      throw new Error('Engine is not initialized');
    }
    return this.client.blobFrontend;
  }

  /** 索引器前端：全文检索 / 聚合 */
  get indexer() {
    if (!this.client) {
      throw new Error('Engine is not initialized');
    }
    return this.client.indexerFrontend;
  }

  /** 协作前端：处理远端 awareness（光标、在线状态）的接收与分发 */
  get awareness() {
    if (!this.client) {
      throw new Error('Engine is not initialized');
    }
    return this.client.awarenessFrontend;
  }

  /**
   * 启动引擎（只能调用一次）：
   *
   * 1. 通过 NbstoreProvider 打开底层 store（key 决定是否与其它标签页共享）；
   * 2. 按特性开关/工作区类型决定是否开启省电模式；
   * 3. 保存 client 并登记关闭回调，然后发出 BeforeStart 事件
   *    （此时 client 已就绪，监听方可以访问 doc/blob 等 frontend 做额外配置）；
   * 4. 提升根文档在 doc / indexer 中的加载优先级；
   * 5. 启动 DocFrontend 的主循环（开始处理 load/save/apply 任务）；
   * 6. 触发一次 v1 blob 的全量下载，完成从旧存储版本到新版的迁移。
   */
  start() {
    if (this.started) {
      throw new Error('Engine is already started');
    }
    this.started = true;

    // store key 的格式：`[shared:]workspace:<flavour>:<workspaceId>`
    // 同一个 key 在 worker 端会复用同一个 StoreConsumer；分享模式加前缀以区分
    const { store, dispose } = this.nbstoreService.openStore(
      (this.props.isSharedMode ? 'shared:' : '') +
        `workspace:${this.workspaceService.workspace.flavour}:${this.workspaceService.workspace.id}`,
      this.props.engineWorkerInitOptions
    );
    // 开启省电模式（仅非 local 工作区；local 工作区不启用该特性）
    if (
      this.featureFlagService.flags.enable_battery_save_mode.value &&
      this.workspaceService.workspace.flavour !== 'local'
    ) {
      store.enableBatterySaveMode().catch(err => {
        console.error('error enabling battery save mode', err);
      });
    }
    // 先赋值再发事件：保证监听方在回调里能直接使用 this.doc / this.blob 等
    this.client = store;
    this.disposables.push(dispose);
    this.eventBus.emit(WorkspaceEngineBeforeStart, this);

    const rootDoc = this.workspaceService.workspace.docCollection.doc;
    // priority load root doc
    // 根文档包含工作区元数据（标题、页面列表等），优先加载，避免 UI 等待
    this.doc.addPriority(rootDoc.guid, 100);
    this.indexer.addPriority(rootDoc.guid, 100);
    // 启动文档前端的主循环，开始消费任务队列；dispose 时同步停止
    this.doc.start();
    this.disposables.push(() => this.doc.stop());

    // fully migrate blobs from v1 to v2, its won't do anything if v1 storage is not exist
    // 'v1' 是旧版 blob 的远端 peer：这里从它全量拉取一次，把旧数据迁到当前存储
    store.blobFrontend.fullDownload('v1').catch(() => {
      // should never reach here
    });
  }
}
