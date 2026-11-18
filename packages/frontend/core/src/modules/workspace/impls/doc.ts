import { getStoreManager } from '@affine/core/blocksuite/manager/store';
import {
  AwarenessStore,
  type Doc,
  type ExtensionType,
  type GetStoreOptions,
  StoreContainer,
  type YBlock,
} from '@blocksuite/affine/store';
import { Awareness } from 'y-protocols/awareness.js';
import * as Y from 'yjs';

import type { WorkspaceImpl } from './workspace';

/**
 * 构造 DocImpl 的参数。
 * - id：子文档 id（同时也是 Y.Doc 的 guid）；
 * - collection：所属的工作区实现，用来访问 blobSync、meta、idGenerator 及加载/卸载钩子；
 * - doc：工作区的根 Y.Doc，所有子文档共享同一个 rootDoc。
 */
type DocOptions = {
  id: string;
  collection: WorkspaceImpl;
  doc: Y.Doc;
};

/**
 * AFFiNE 对 BlockSuite `Doc` 接口的实现：代表工作区中的一个子文档。
 *
 * 持有：
 * - `_ySpaceDoc`：该文档自己的 Y.Doc，块数据存放在其中的 `Y.Map('blocks')`；
 * - `_yBlocks`：上面那个 blocks map，Store 监听它来维护内存中的块模型；
 * - `awarenessStore`：协作光标 / 在线用户状态；
 * - `_storeContainer`：按 id / readonly / query 缓存多个 Store（同一份数据可有不同视图）。
 *
 * 生命周期：`load()` → 使用 → `dispose()`（或 `remove()` 连同元数据一起移除）。
 */
export class DocImpl implements Doc {
  /** 所属工作区，用于向上访问 blobSync / meta / idGenerator 以及加载钩子 */
  private readonly _collection: WorkspaceImpl;

  /** Store 缓存：同一个文档按 id / readonly / query 复用不同 Store 实例 */
  private readonly _storeContainer: StoreContainer;

  /**
   * 创建该文档对应的 Y.Doc。
   *
   * 旧版本把子文档挂在 rootDoc 的 `spaces` 映射下，因此这里保留一段兼容逻辑：
   * 若 `spaces` 里没有对应子文档就先创建一个（新版本已经不再依赖它）。
   *
   * 返回的 spaceDoc 与 rootDoc 对齐 clientID；
   * 同时把 _loaded 置为 false，等待 load() 时再标记为已加载。
   */
  private readonly _initSpaceDoc = () => {
    {
      // This is a piece of old version compatible code. The old version relies on the subdoc instance on `spaces`.
      // So if there is no subdoc on spaces, we will create it.
      // new version no longer needs subdoc on `spaces`.
      let subDoc = this.rootDoc.getMap('spaces').get(this.id);
      if (!subDoc) {
        subDoc = new Y.Doc({
          guid: this.id,
        });
        this.rootDoc.getMap('spaces').set(this.id, subDoc);
      }
    }

    const spaceDoc = new Y.Doc({ guid: this.id });
    spaceDoc.clientID = this.rootDoc.clientID;
    this._loaded = false;

    return spaceDoc;
  };

  /** spaceDoc 是否已完成加载；_destroy 时据此决定是否触发 onUnloadDoc */
  private _loaded!: boolean;

  /** Indicate whether the block tree is ready */
  private _ready = false;

  /** Y.Doc 中的块数据映射（Store 监听的正是它） */
  protected readonly _yBlocks: Y.Map<YBlock>;

  /**
   * @internal Used for convenient access to the underlying Yjs map,
   * can be used interchangeably with ySpace
   */
  protected readonly _ySpaceDoc: Y.Doc;

  /**
   * 绑定在文档级别、会被注入到该文档每个 Store 的扩展。
   * 由外部服务在文档创建后 push 进来，例如记录编辑者信息的 WriterInfoServiceExtension。
   */
  readonly storeExtensions: ExtensionType[] = [];

  /** 协作状态（光标、在线用户等） */
  readonly awarenessStore: AwarenessStore;

  /** 文档 id，等同于 Y.Doc 的 guid */
  readonly id: string;

  /** 工作区根文档，所有子文档共享 */
  readonly rootDoc: Y.Doc;

  /** 二进制资源同步引擎（附件、图片等），委托给工作区 */
  get blobSync() {
    return this.workspace.blobSync;
  }

  /** BlockSuite `Doc` 接口里的 workspace 即所属的 WorkspaceImpl */
  get workspace() {
    return this._collection;
  }

  /** 块映射为空即视为空文档（不检查根块内部的子节点） */
  get isEmpty() {
    return this._yBlocks.size === 0;
  }

  get loaded() {
    return this._loaded;
  }

  /** 文档元数据（标题、创建时间、标签等）存放在工作区级别的 meta 中 */
  get meta() {
    return this.workspace.meta.getDocMeta(this.id);
  }

  /** 块树是否可用：load() 成功后才会置为 true */
  get ready() {
    return this._ready;
  }

  get spaceDoc() {
    return this._ySpaceDoc;
  }

  get yBlocks() {
    return this._yBlocks;
  }

  /**
   * 构造一个子文档：
   * 1. 记录 id 与 rootDoc；
   * 2. 初始化 spaceDoc（含旧版 `spaces` 子文档兼容逻辑）；
   * 3. 基于 spaceDoc 创建 awareness 协作状态；
   * 4. 取出 Y.Map('blocks') 作为块数据的读写入口；
   * 5. 创建 StoreContainer，按需生成 Store。
   */
  constructor({ id, collection, doc }: DocOptions) {
    this.id = id;
    this.rootDoc = doc;
    this._ySpaceDoc = this._initSpaceDoc() as Y.Doc;
    this.awarenessStore = new AwarenessStore(new Awareness(this._ySpaceDoc));

    this._yBlocks = this._ySpaceDoc.getMap('blocks');
    this._collection = collection;
    this._storeContainer = new StoreContainer(this);
  }

  /** 清空全部块（Yjs 层面删除，会触发 Store 的块移除流程） */
  clear() {
    this._yBlocks.clear();
  }

  /** 代理到 StoreContainer，供上层移除缓存的 Store */
  get removeStore() {
    return this._storeContainer.removeStore;
  }

  /**
   * 释放底层资源：通知工作区卸载 spaceDoc（断开同步 provider），
   * 销毁 awareness 与 Y.Doc，并标记为未加载。
   */
  private _destroy() {
    if (this._loaded) {
      this.workspace.onUnloadDoc?.(this._ySpaceDoc);
    }
    this.awarenessStore.destroy();
    this._ySpaceDoc.destroy();
    this._loaded = false;
  }

  /**
   * 销毁文档：先释放底层资源，再清空块映射。
   * 只有 ready 过（曾经加载成功）才需要清理；之后该实例不应再被使用。
   */
  dispose() {
    this._destroy();

    if (this.ready) {
      this._yBlocks.clear();
    }
  }

  /**
   * 获取一个 Store 实例（由 StoreContainer 缓存复用）。
   *
   * 扩展来源有三部分，合并后用 Set 去重：
   * 1. 全局 store manager 的扩展（受 feature flag 影响，决定启用哪些 AFFiNE 能力）；
   * 2. 调用方本次传入的扩展；
   * 3. 文档级别的 storeExtensions。
   */
  getStore({
    readonly,
    query,
    provider,
    extensions,
    id,
  }: GetStoreOptions = {}) {
    const storeExtensions = getStoreManager()
      .config.init()
      .featureFlag(this.workspace.featureFlagService)
      .value.get('store');
    const exts = storeExtensions
      .concat(extensions ?? [])
      .concat(this.storeExtensions);
    const extensionSet = new Set(exts);

    return this._storeContainer.getStore({
      id,
      readonly,
      query,
      provider,
      extensions: Array.from(extensionSet),
    });
  }

  /**
   * 加载文档（幂等：已经 ready 时直接返回 this）。
   *
   * 顺序：
   * 1. `spaceDoc.load()` 标记 Y.Doc 已加载；
   * 2. 通知工作区把该文档接入同步引擎 / awareness
   *    （WorkspaceImpl 的 onLoadDoc 会执行 engine.doc.connectDoc 等）；
   * 3. 执行 initFn 创建初始块——放在连接之后，保证初始内容也会被同步与持久化；
   * 4. 置 loaded / ready。
   */
  load(initFn?: () => void): this {
    if (this.ready) {
      return this;
    }

    this.spaceDoc.load();
    this.workspace.onLoadDoc?.(this.spaceDoc);
    this.workspace.onLoadAwareness?.(this.awarenessStore.awareness);

    initFn?.();

    this._loaded = true;
    this._ready = true;

    return this;
  }

  /**
   * 从工作区彻底移除该文档：释放资源后，同时删除 rootDoc `spaces` 中
   * 旧版兼容用的子文档记录（新版数据不再依赖它）。
   */
  remove() {
    this._destroy();
    this.rootDoc.getMap('spaces').delete(this.id);
  }
}
