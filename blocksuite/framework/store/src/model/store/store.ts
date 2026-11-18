/**
 * BlockSuite 的核心 Store：把一份 Y.Doc 映射成可读写的块模型树。
 *
 * 分层关系：
 *   Y.Doc (spaceDoc)
 *     └─ Y.Map('blocks')            —— Yjs 侧的块数据
 *          └─ Store                 —— 本文件：块模型树 + 生命周期 + 事件
 *               └─ Block / BlockModel —— 单个块的 CRUD 包装与响应式属性
 *
 * Store 负责：
 * - 监听 Y.Map('blocks') 的变化，增量维护内存中的 `_blocks` 映射
 * - 提供块的增删改查、移动、兄弟节点查询
 * - 通过 signals（@preact/signals-core）提供响应式的 blocks / readonly / isEmpty
 * - 通过 RxJS Subject（slots）广播 ready / blockUpdated 等事件
 * - 维护撤销历史（Y.UndoManager，由 HistoryExtension 提供）
 *
 * 一个 Y.Doc 可以有多个 Store（不同 query / readonly 组合），
 * 由 StoreContainer 按 key 缓存。
 */
import { Container, type ServiceProvider } from '@blocksuite/global/di';
import { DisposableGroup } from '@blocksuite/global/disposable';
import { BlockSuiteError, ErrorCode } from '@blocksuite/global/exceptions';
import { computed, signal } from '@preact/signals-core';
import { Subject } from 'rxjs';
import * as Y from 'yjs';

import type { ExtensionType } from '../../extension/extension.js';
import {
  BlockSchemaIdentifier,
  type Doc,
  HistoryExtension,
  StoreExtensionIdentifier,
  StoreSelectionExtension,
} from '../../extension/index.js';
import { DocIdentifier } from '../../extension/workspace/doc.js';
import { Schema } from '../../schema/index.js';
import type { TransformerMiddleware } from '../../transformer/middleware.js';
import { Transformer } from '../../transformer/transformer.js';
import {
  Block,
  type BlockModel,
  type BlockOptions,
  type BlockProps,
  type BlockSysProps,
  type PropsOfModel,
  type YBlock,
} from '../block/index.js';
import { DocCRUD } from './crud.js';
import { StoreIdentifier } from './identifier.js';
import { type Query, runQuery } from './query.js';
import { syncBlockProps } from './utils.js';

/**
 * 创建 Store 的参数。
 *
 * - `doc`：底层的 Doc（内部持有 Y.Doc），Store 从它派生数据；
 * - `readonly`：初始只读状态，可通过 `store.readonly` 动态切换；
 * - `query`：块过滤条件，只有命中 query 的块才会被渲染（Store 内部仍保存全部块）；
 * - `provider`：父级 DI 容器（Doc / Workspace 层），Store 自己的容器找不到实现时回退到这里；
 * - `extensions`：该 Store 专属的扩展（schema、命令、UI 能力等），
 *   与内置的 StoreSelectionExtension / HistoryExtension 一起装入 Store 的容器。
 * - `id`：仅由 StoreContainer 用作缓存 key，Store 构造时并不会读取它。
 */
export type StoreOptions = {
  doc: Doc;
  id?: string;
  readonly?: boolean;
  query?: Query;
  provider?: ServiceProvider;
  extensions?: ExtensionType[];
};

type StoreBlockAddedPayload = {
  /**
   * The type of the event.
   */
  type: 'add';
  /**
   * The id of the block.
   */
  id: string;
  /**
   * Whether the event is triggered by local changes.
   */
  isLocal: boolean;
  /**
   * The flavour of the block.
   */
  flavour: string;
  /**
   * The model of the block.
   */
  model: BlockModel;
  /**
   * @internal
   * Whether the event is triggered by initialization.
   * FIXME: This seems not working as expected now.
   */
  init: boolean;
};

type StoreBlockDeletedPayload = {
  /**
   * The type of the event.
   */
  type: 'delete';
  /**
   * The id of the block.
   */
  id: string;
  /**
   * Whether the event is triggered by local changes.
   */
  isLocal: boolean;
  /**
   * The flavour of the block.
   */
  flavour: string;
  /**
   * The parent id of the block.
   */
  parent: string;
  /**
   * The model of the block.
   */
  model: BlockModel;
};

type StoreBlockUpdatedPayload = {
  /**
   * The type of the event.
   */
  type: 'update';
  /**
   * The id of the block.
   */
  id: string;
  /**
   * Whether the event is triggered by local changes.
   */
  isLocal: boolean;
  /**
   * The flavour of the block.
   */
  flavour: string;
  /**
   * The changed props of the block.
   */
  props: { key: string };
};

type StoreBlockUpdatedPayloads =
  | StoreBlockAddedPayload
  | StoreBlockDeletedPayload
  | StoreBlockUpdatedPayload;

/**
 * Slots for receiving events from the store.
 * All events are rxjs Subjects, you can subscribe to them like this:
 *
 * ```ts
 * store.slots.ready.subscribe(() => {
 *   console.log('store is ready');
 * });
 * ```
 *
 * You can also use rxjs operators to handle the events.
 *
 * @interface
 * @category Store
 */
export type StoreSlots = {
  /**
   * This fires after `doc.load` is called.
   * The Y.Doc is fully loaded and ready to use.
   */
  ready: Subject<void>;
  /**
   * This fires when the root block is added via API call or has just been initialized from existing ydoc.
   * useful for internal block UI components to start subscribing following up events.
   * Note that at this moment, the whole block tree may not be fully initialized yet.
   */
  rootAdded: Subject<string>;
  /**
   * This fires when the root block is deleted via API call or has just been removed from existing ydoc.
   * In most cases, you don't need to subscribe to this event.
   */
  rootDeleted: Subject<string>;
  /**
   * This fires when a block is updated via API call or has just been updated from existing ydoc.
   *
   * The payload can have three types:
   * - add: When a new block is added
   * - delete: When a block is removed
   * - update: When a block's properties are modified
   *
   */
  blockUpdated: Subject<StoreBlockUpdatedPayloads>;
  /** @internal */
  yBlockUpdated: Subject<
    | {
        type: 'add';
        id: string;
        isLocal: boolean;
      }
    | {
        type: 'delete';
        id: string;
        isLocal: boolean;
      }
  >;
};

// 每个 Store 都一定会装载的扩展：选区状态管理 + 撤销/重做历史
const internalExtensions = [StoreSelectionExtension, HistoryExtension];

/**
 * Core store class that manages blocks and their lifecycle in BlockSuite
 * @remarks
 * The Store class is responsible for managing the lifecycle of blocks, handling transactions,
 * and maintaining the block tree structure.
 * A store is a piece of data created from one or a part of a Y.Doc.
 *
 * @category Store
 */
export class Store {
  /** @internal */
  readonly userExtensions: ExtensionType[];

  /**
   * Group of disposable resources managed by the store
   *
   * @category Store Lifecycle
   */
  disposableGroup = new DisposableGroup();

  /** Store 的 DI 提供者：自身扩展 + 父级 provider 组成查找链 */
  private readonly _provider: ServiceProvider;

  /** 当前事务是否计入撤销历史；由 withoutTransact 临时置为 false */
  private _shouldTransact = true;

  /** 跑一次 query，更新该 block 的 visibility（display / hidden / bypass） */
  private readonly _runQuery = (block: Block) => {
    runQuery(this._query, block);
  };

  /** 底层文档，负责持有 Y.Doc、提供 id / loaded / meta 等 */
  private readonly _doc: Doc;

  /**
   * 内存中的块映射：id → Block。
   * 用 signal 包裹，整体替换对象来触发响应式更新；不要原地修改。
   */
  private readonly _blocks = signal<Record<string, Block>>({});

  /** Y.Map('blocks') 的 CRUD 封装，所有写操作最终都落到这里 */
  private readonly _crud: DocCRUD;

  /** 当前 Store 的块过滤条件；空 match + loose 表示不过滤 */
  private readonly _query: Query = {
    match: [],
    mode: 'loose',
  };

  /** 只读状态；readonly 为 true 时所有写操作都会被拒绝 */
  private readonly _readonly = signal(false);

  /** 响应式的空状态：root 为空，或 root block 自己判定为空 */
  private readonly _isEmpty = computed(() => {
    return this.root?.isEmpty() ?? true;
  });

  /** 由所有扩展注册的 BlockSchema 汇总而成的 schema 表 */
  private readonly _schema: Schema;

  /**
   * Get the id of the store.
   *
   * @category Store Lifecycle
   */
  get id() {
    return this._doc.id;
  }

  /**
   * {@inheritDoc StoreSlots}
   *
   * @category Store Lifecycle
   */
  readonly slots: StoreSlots;

  /** 快捷访问 Yjs 侧的 Y.Map('blocks') */
  private get _yBlocks() {
    return this._doc.yBlocks;
  }

  /**
   * Get the {@link AwarenessStore} instance for current store
   */
  get awarenessStore() {
    return this._doc.awarenessStore;
  }

  /**
   * Get the di provider for current store.
   *
   * @category Extension
   */
  get provider() {
    return this._provider;
  }

  /**
   * Get the {@link BlobEngine} instance for current store.
   */
  get blobSync() {
    return this.workspace.blobSync;
  }

  /**
   * Get the {@link Doc} instance for current store.
   */
  get doc() {
    return this._doc;
  }

  /**
   * @internal
   */
  get blocks() {
    return this._blocks;
  }

  /**
   * Get the number of blocks in the store
   *
   * @category Block CRUD
   */
  get blockSize() {
    // peek() 只读当前快照，不建立 signals 依赖（不会触发组件重渲染）
    return Object.values(this._blocks.peek()).length;
  }

  /**
   * Check if the store can redo
   *
   * @category History
   */
  get canRedo() {
    if (this.readonly) {
      return false;
    }
    return this._history.canRedo;
  }

  /**
   * Check if the store can undo
   *
   * @category History
   */
  get canUndo() {
    if (this.readonly) {
      return false;
    }
    return this._history.canUndo;
  }

  /**
   * Undo the last transaction.
   *
   * @category History
   */
  undo = () => {
    if (this.readonly) {
      console.error('cannot undo in readonly mode');
      return;
    }
    this._history.undoManager.undo();
  };

  /**
   * Redo the last undone transaction.
   *
   * @category History
   */
  redo = () => {
    if (this.readonly) {
      console.error('cannot undo in readonly mode');
      return;
    }
    this._history.undoManager.redo();
  };

  /**
   * Reset the history of the store.
   *
   * @category History
   */
  resetHistory = () => {
    return this._history.undoManager.clear();
  };

  /**
   * Execute a transaction.
   *
   * @example
   * ```ts
   * store.transact(() => {
   *   op1();
   *   op2();
   * });
   * ```
   *
   * 事务的 origin 决定这次修改是否进入撤销历史：
   * - shouldTransact = true  → origin = spaceDoc.clientID，
   *   正好命中 HistoryExtension 的 UndoManager.trackedOrigins，可以 undo/redo
   * - shouldTransact = false → origin = null，不会进入撤销栈
   *
   * 回调内的异常会被捕获并打印，不会继续向上抛——这是为了不让一次
   * 命令失败打断整个编辑器的渲染/事件循环。
   *
   * @category History
   */
  transact(fn: () => void, shouldTransact: boolean = this._shouldTransact) {
    const spaceDoc = this._doc.spaceDoc;
    spaceDoc.transact(
      () => {
        try {
          fn();
        } catch (e) {
          console.error(
            `An error occurred while Y.doc ${spaceDoc.guid} transacting:`
          );
          console.error(e);
        }
      },
      shouldTransact ? this.spaceDoc.clientID : null
    );
  }

  /**
   * Execute a transaction without capturing the history.
   *
   * @example
   * ```ts
   * store.withoutTransact(() => {
   *   op1();
   *   op2();
   * });
   * ```
   *
   * 通过临时把 _shouldTransact 置为 false 实现：期间调用 transact 会使用
   * origin = null，因此不会进入 UndoManager。
   *
   * 注意：fn 必须是同步的，并且这里没有 try/finally——如果 fn 抛异常，
   * _shouldTransact 会停留在 false。需要处理异常时请自行 try/finally。
   *
   * @category History
   */
  withoutTransact(fn: () => void) {
    this._shouldTransact = false;
    fn();
    this._shouldTransact = true;
  }

  /**
   * Force the following history to be captured into a new stack.
   *
   * @example
   * ```ts
   * op1();
   * op2();
   * store.captureSync();
   * op3();
   *
   * store.undo(); // undo op3
   * store.undo(); // undo op1, op2
   * ```
   *
   * @category History
   */
  captureSync = () => {
    // stopCapturing 会在撤销栈里切一刀：之后的修改属于新的 stack item，
    // 撤销时不会和之前的修改合并成一步
    this._history.undoManager.stopCapturing();
  };

  /**
   * Get the {@link Workspace} instance for current store.
   */
  get workspace() {
    return this._doc.workspace;
  }

  /**
   * Get the {@link Y.UndoManager} instance for current store.
   *
   * @category History
   */
  get history() {
    return this._history;
  }

  /**
   * Check if there are no blocks in the store.
   *
   * @category Block CRUD
   */
  get isEmpty() {
    return this._isEmpty.peek();
  }

  /**
   * Get the signal for the empty state of the store.
   *
   * @category Block CRUD
   */
  get isEmpty$() {
    return this._isEmpty;
  }

  /**
   * Check if the store is loaded.
   *
   * @category Store Lifecycle
   */
  get loaded() {
    return this._doc.loaded;
  }

  /**
   * Get the meta data of the store.
   *
   * @internal
   */
  get meta() {
    return this._doc.meta;
  }

  /**
   * Check if the store is readonly.
   *
   * @category Block CRUD
   */
  get readonly() {
    return this._readonly.value === true;
  }

  /**
   * Get the signal for the readonly state of the store.
   *
   * @category Block CRUD
   */
  get readonly$() {
    return this._readonly;
  }

  /**
   * Set the readonly state of the store.
   *
   * @category Block CRUD
   */
  set readonly(value: boolean) {
    this._readonly.value = value;
  }

  /**
   * Check if the store is ready.
   * Which means the Y.Doc is loaded and the root block is added.
   *
   * @category Store Lifecycle
   */
  get ready() {
    return this._doc.ready;
  }

  /**
   * Get the root block of the store.
   *
   * 根块 id 由 DocCRUD 记录；Y.Doc 尚未初始化根块（或根块已被删除）时返回 null。
   *
   * @category Block CRUD
   */
  get root() {
    const rootId = this._crud.root;
    if (!rootId) return null;
    return this.getBlock(rootId)?.model ?? null;
  }

  /**
   * @internal
   * Get the root Y.Doc of sub Y.Doc.
   * In the current design, store is on a sub Y.Doc, and all sub docs have the same root Y.Doc.
   */
  get rootDoc() {
    return this._doc.rootDoc;
  }

  /**
   * Get the {@link Schema} instance of the store.
   */
  get schema() {
    return this._schema;
  }

  /**
   * @internal
   * Get the Y.Doc instance of the store.
   */
  get spaceDoc() {
    return this._doc.spaceDoc;
  }

  /** 是否已 dispose；load 时据此决定是否需要重建事件订阅 */
  private _isDisposed = false;

  /** 懒查找 HistoryExtension（每个 Store 的容器都会注册，父级 provider 作为兜底） */
  private get _history() {
    return this._provider.get(HistoryExtension);
  }

  /**
   * @internal
   * In most cases, you don't need to use the constructor directly.
   * The store is created by the {@link Doc} instance.
   *
   * 构造过程：
   * 1. 创建事件 slots 和空的 schema 注册表
   * 2. 建一个 Store 自己的 DI 容器：先注册内置扩展（选区、历史），再注册调用方扩展
   * 3. 把容器挂到父 provider（Doc / Workspace 层）上，形成查找链
   * 4. 从扩展里收集 BlockSchema 并注册
   * 5. 通过父 provider 拿到当前 Doc（DocIdentifier），建立 CRUD 封装
   * 6. 监听 Y.Map('blocks')，并把已存在的块补建为内存中的 Block 实例
   * 7. 订阅 yBlockUpdated，把之后 Yjs 的块增删事件转换成内存 Block 的创建 / 销毁
   */
  constructor({ readonly, query, provider, extensions }: StoreOptions) {
    this.slots = {
      ready: new Subject(),
      rootAdded: new Subject(),
      rootDeleted: new Subject(),
      blockUpdated: new Subject(),
      yBlockUpdated: new Subject(),
    };
    this._schema = new Schema();

    // 每个 Store 有独立的 DI 容器，便于不同 query / readonly 的 Store 拥有不同扩展
    const container = new Container();
    container.addImpl(StoreIdentifier, () => this);

    // 内置扩展：选区（StoreSelectionExtension）和撤销历史（HistoryExtension）
    internalExtensions.forEach(ext => {
      ext.setup(container);
    });

    // 调用方传入的扩展（各 block 的 schema、命令、UI 能力等）
    const userExtensions = extensions ?? [];
    this.userExtensions = userExtensions;
    userExtensions.forEach(extension => {
      extension.setup(container);
    });

    // provider 链：先查 Store 自己的扩展，找不到再回退到父级（Doc / Workspace）
    this._provider = container.provider(undefined, provider);
    // 所有扩展注册的 BlockSchema 汇总到 Store 的 schema 中
    this._provider.getAll(BlockSchemaIdentifier).forEach(schema => {
      this._schema.register([schema]);
    });
    // 当前 Store 对应的 Doc（由父 provider 提供）
    this._doc = this._provider.get(DocIdentifier);
    this._crud = new DocCRUD(this._yBlocks, this._schema);
    if (readonly !== undefined) {
      this._readonly.value = readonly;
    }
    if (query) {
      this._query = query;
    }

    // 监听 Y.Map('blocks') 的深层变化（块的增删以及块内属性变化）
    this._yBlocks.observeDeep(this._handleYEvents);
    // 初始化时把 Y.Doc 中已有的块补建为 Block 实例。
    // 这里先同步广播一次 yBlockUpdated('add')，再真正创建 Block；
    // 如果该 id 已经处理过则跳过，避免重复。
    this._yBlocks.forEach((_, id) => {
      this._handleYBlockAdd(id, false);

      if (id in this._blocks.peek()) {
        return;
      }
      this._onBlockAdded(id, false, true);
    });

    // 订阅放在补建之后：初始化阶段的块已直接处理过，后续变化才走订阅回调
    // （_onBlockAdded 内也有幂等判断，重复触发不会创建重复 Block）
    this._subscribeToSlots();
  }

  /**
   * 把内部事件流接到具体逻辑上：
   * - yBlockUpdated 是 Yjs 事件的「原始」通道，在这里转为 Block 的创建 / 移除；
   * - 其余 slots 只是交由 disposableGroup 托管，dispose 时统一 complete。
   */
  private readonly _subscribeToSlots = () => {
    this.disposableGroup.add(
      this.slots.yBlockUpdated.subscribe(({ type, id, isLocal }) => {
        switch (type) {
          case 'add': {
            this._onBlockAdded(id, isLocal, false);
            return;
          }
          case 'delete': {
            this._onBlockRemoved(id, isLocal);
            return;
          }
        }
      })
    );
    // Subject 也交给 disposableGroup 托管：dispose 时会对其调用 complete()
    this.disposableGroup.add(this.slots.ready);
    this.disposableGroup.add(this.slots.blockUpdated);
    this.disposableGroup.add(this.slots.rootAdded);
    this.disposableGroup.add(this.slots.rootDeleted);
  };

  /**
   * 兄弟节点查询的公共逻辑：先找到 block 的父节点及其在父节点 children 中的下标，
   * 再把「父节点 + 下标」交给调用方决定取前驱 / 后继。
   * 找不到父节点或 block 不在父节点中时返回 null。
   */
  private _getSiblings<T>(
    block: BlockModel | string,
    fn: (parent: BlockModel, index: number) => T
  ) {
    const parent = this.getParent(block);
    if (!parent) return null;

    const blockModel =
      typeof block === 'string' ? this.getBlock(block)?.model : block;
    if (!blockModel) return null;

    const index = parent.children.indexOf(blockModel);
    if (index === -1) return null;

    return fn(parent, index);
  }

  /**
   * 把一个 Yjs 块补建为内存中的 Block（及其 BlockModel）。
   *
   * 触发来源：
   * - 构造时遍历已有 yBlocks（init = true）
   * - 运行中 slots.yBlockUpdated 收到 'add' 事件（init = false）
   */
  private _onBlockAdded(id: string, isLocal: boolean, init: boolean) {
    try {
      // 已经创建过则跳过（初始化和事件可能对同一个块各触发一次）
      if (id in this._blocks.peek()) {
        return;
      }
      const yBlock = this._yBlocks.get(id);
      if (!yBlock) {
        console.warn(`Could not find block with id ${id}`);
        return;
      }

      // 块内属性变化时：先通知 BlockModel 自己的 propsUpdated，
      // 再通过 store.slots.blockUpdated 广播（UI 组件订阅这两个来源）
      const options: BlockOptions = {
        onChange: (block, key, isLocal) => {
          if (key) {
            block.model.propsUpdated.next({ key });
          }

          this.slots.blockUpdated.next({
            type: 'update',
            id,
            flavour: block.flavour,
            props: { key },
            isLocal,
          });
        },
      };

      const block = new Block(this._schema, yBlock, this, options);
      // 若 Store 带 query（部分视图），按 query 计算该块的可见类型
      // （display / hidden / bypass），供渲染层过滤；块本身仍在映射中
      this._runQuery(block);

      // 用新对象整体赋值，而不是原地修改，确保 signals 能感知变化
      this._blocks.value = {
        ...this._blocks.value,
        [id]: block,
      };
      // BlockModel 自身的 created 事件（由 UI 组件按模型粒度订阅）
      block.model.created.next();

      // 根块有单独的事件
      if (block.model.role === 'root') {
        this.slots.rootAdded.next(id);
      }

      this.slots.blockUpdated.next({
        type: 'add',
        id,
        init,
        flavour: block.model.flavour,
        model: block.model,
        isLocal,
      });
    } catch (e) {
      console.error('An error occurred while adding block:');
      console.error(e);
    }
  }

  /**
   * 块从 Y.Map('blocks') 中删除后的清理：
   * 先广播事件（此时还能读到 parent），再从内存映射中移除并销毁 Block。
   */
  private _onBlockRemoved(id: string, isLocal: boolean) {
    try {
      const block = this.getBlock(id);
      if (!block) return;

      if (block.model.role === 'root') {
        this.slots.rootDeleted.next(id);
      }

      this.slots.blockUpdated.next({
        type: 'delete',
        id,
        flavour: block.flavour,
        parent: this.getParent(block.model)?.id ?? '',
        model: block.model,
        isLocal,
      });

      // 同样用新对象替换，触发 signals 更新
      const { [id]: _, ...blocks } = this._blocks.peek();
      this._blocks.value = blocks;

      // 先通知，再释放块内部的响应式资源
      block.model.deleted.next();
      block.model.dispose();
    } catch (e) {
      console.error('An error occurred while removing block:');
      console.error(e);
    }
  }

  /**
   * Creates and adds a new block to the store
   * @param flavour - The block's flavour (type)
   * @param blockProps - Optional properties for the new block
   * @param parent - Optional parent block or parent block ID
   * @param parentIndex - Optional index position in parent's children
   * @returns The ID of the newly created block
   * @throws {BlockSuiteError} When store is in readonly mode
   *
   * @category Block CRUD
   */
  addBlock<T extends BlockModel = BlockModel>(
    flavour: string,
    blockProps: Partial<(PropsOfModel<T> & BlockSysProps) | BlockProps> = {},
    parent?: BlockModel | string | null,
    parentIndex?: number
  ): string {
    if (this.readonly) {
      throw new BlockSuiteError(
        ErrorCode.ModelCRUDError,
        'cannot modify data in readonly mode'
      );
    }

    // 允许调用方指定 id（导入 / 复制时需要保持 id 稳定），否则由工作区生成
    const id = blockProps.id ?? this._doc.workspace.idGenerator();

    // 所有写操作都包在事务里，保证一次调用只产生一个 Yjs update
    this.transact(() => {
      this._crud.addBlock(
        id,
        flavour,
        { ...blockProps },
        typeof parent === 'string' ? parent : parent?.id,
        parentIndex
      );
    });

    return id;
  }

  /**
   * Add multiple blocks to the store
   * @param blocks - Array of blocks to add
   * @param parent - Optional parent block or parent block ID
   * @param parentIndex - Optional index position in parent's children
   * @returns Array of IDs of the newly created blocks
   *
   * @category Block CRUD
   */
  addBlocks(
    blocks: Array<{
      flavour: string;
      blockProps?: Partial<BlockProps & Omit<BlockProps, 'flavour' | 'id'>>;
    }>,
    parent?: BlockModel | string | null,
    parentIndex?: number
  ): string[] {
    const ids: string[] = [];
    blocks.forEach(block => {
      const id = this.addBlock(
        block.flavour as never,
        block.blockProps ?? {},
        parent,
        parentIndex
      );
      ids.push(id);
      // 连续插入同一个位置时索引要递增，否则后一个块会插到前一个块前面
      typeof parentIndex === 'number' && parentIndex++;
    });

    return ids;
  }

  /**
   * Add sibling blocks to the store
   * @param targetModel - The target block model
   * @param props - Array of block properties
   * @param placement - Optional position to place the new blocks ('after' or 'before')
   * @returns Array of IDs of the newly created blocks
   *
   * @category Block CRUD
   */
  addSiblingBlocks(
    targetModel: BlockModel,
    props: Array<Partial<BlockProps>>,
    placement: 'after' | 'before' = 'after'
  ): string[] {
    if (!props.length) return [];
    const parent = this.getParent(targetModel);
    if (!parent) return [];

    // 找到目标块在父节点中的位置，再决定插到它前面还是后面
    const targetIndex =
      parent.children.findIndex(({ id }) => id === targetModel.id) ?? 0;
    const insertIndex = placement === 'before' ? targetIndex : targetIndex + 1;

    if (props.length <= 1) {
      if (!props[0]?.flavour) return [];
      const { flavour, ...blockProps } = props[0];
      const id = this.addBlock(
        flavour as never,
        blockProps,
        parent.id,
        insertIndex
      );
      return [id];
    }

    const blocks: Array<{
      flavour: string;
      blockProps: Partial<BlockProps>;
    }> = [];
    props.forEach(prop => {
      const { flavour, ...blockProps } = prop;
      if (!flavour) return;
      blocks.push({ flavour, blockProps });
    });
    return this.addBlocks(blocks, parent.id, insertIndex);
  }

  /**
   * Updates a block's properties or executes a callback in a transaction
   * @param modelOrId - The block model or block ID to update
   * @param callBackOrProps - Either a callback function to execute or properties to update
   * @throws {BlockSuiteError} When the block is not found or schema validation fails
   *
   * @category Block CRUD
   */

  updateBlock<T extends BlockModel = BlockModel>(
    modelOrId: T | string,
    callBackOrProps:
      | (() => void)
      | Partial<(PropsOfModel<T> & BlockSysProps) | BlockProps>
  ) {
    if (this.readonly) {
      console.error('cannot modify data in readonly mode');
      return;
    }

    // 两种用法：
    // - 传入回调：在事务中执行任意操作（常用于组合多个修改）
    // - 传入对象：按 props 做增量更新
    const isCallback = typeof callBackOrProps === 'function';

    // 参数既可以是 BlockModel，也可以只是 id
    const model =
      typeof modelOrId === 'string'
        ? this.getBlock(modelOrId)?.model
        : modelOrId;
    if (!model) {
      throw new BlockSuiteError(
        ErrorCode.ModelCRUDError,
        `updating block: ${modelOrId} not found`
      );
    }

    if (!isCallback) {
      // 更新 children 前先做 schema 校验：父/子 flavour 组合必须合法
      const parent = this.getParent(model);
      this.schema.validate(
        model.flavour,
        parent?.flavour,
        callBackOrProps.children?.map(child => child.flavour)
      );
    }

    const yBlock = this._yBlocks.get(model.id);
    if (!yBlock) {
      throw new BlockSuiteError(
        ErrorCode.ModelCRUDError,
        `updating block: ${model.id} not found`
      );
    }

    const block = this.getBlock(model.id);
    if (!block) return;

    this.transact(() => {
      if (isCallback) {
        // 回调可能移动块或改属性，执行完后重新跑一次 query
        callBackOrProps();
        this._runQuery(block);
        return;
      }

      if (callBackOrProps.children) {
        this._crud.updateBlockChildren(
          model.id,
          callBackOrProps.children.map(child => child.id)
        );
      }

      const schema = this.schema.flavourSchemaMap.get(model.flavour);
      if (!schema) {
        throw new BlockSuiteError(
          ErrorCode.ModelCRUDError,
          `schema for flavour: ${model.flavour} not found`
        );
      }
      // 把提交的普通对象写回 Y.Map，同时触发 BlockModel 的响应式更新
      syncBlockProps(schema, model, yBlock, callBackOrProps);
      this._runQuery(block);
      return;
    });
  }

  /**
   * Delete a block from the store
   * @param model - The block model or block ID to delete
   * @param options - Optional options for the deletion
   * @param options.bringChildrenTo - Optional block model to bring children to
   * @param options.deleteChildren - Optional flag to delete children
   *
   * @category Block CRUD
   */
  deleteBlock(
    model: BlockModel | string,
    options: {
      bringChildrenTo?: BlockModel;
      deleteChildren?: boolean;
    } = {
      deleteChildren: true,
    }
  ) {
    if (this.readonly) {
      console.error('cannot modify data in readonly mode');
      return;
    }

    // 把 bringChildrenTo 的 BlockModel 参数转换成 id，交给底层 CRUD 层
    const opts = (
      options && options.bringChildrenTo
        ? {
            ...options,
            bringChildrenTo: options.bringChildrenTo.id,
          }
        : options
    ) as {
      bringChildrenTo?: string;
      deleteChildren?: boolean;
    };

    this.transact(() => {
      this._crud.deleteBlock(
        typeof model === 'string' ? model : model.id,
        opts
      );
    });
  }

  /**
   * Gets a block by its ID
   * @param id - The block's ID
   * @returns The block instance if found, undefined otherwise
   *
   * @category Block CRUD
   */
  getBlock(id: string): Block | undefined {
    // peek() 不建立 signals 依赖：适合命令、事件回调等非响应式场景
    return this._blocks.peek()[id];
  }

  /**
   * Gets a block by its ID
   * @param id - The block's ID
   * @returns The block instance in signal if found, undefined otherwise
   *
   * @category Block CRUD
   */
  getBlock$(id: string): Block | undefined {
    // .value 会建立 signals 依赖：在 computed / effect 中调用才能随块变化重算
    return this._blocks.value[id];
  }

  /**
   * Get a model by its ID
   * @param id - The model's ID
   * @returns The model instance if found, null otherwise
   *
   * @category Block CRUD
   */
  getModelById<Model extends BlockModel = BlockModel>(
    id: string
  ): Model | null {
    return (this.getBlock(id)?.model ?? null) as Model | null;
  }

  /**
   * Gets all blocks of specified flavour(s)
   * @param blockFlavour - Single flavour or array of flavours to filter by
   * @returns Array of matching blocks
   *
   * @category Block CRUD
   */
  getBlocksByFlavour(blockFlavour: string | string[]): Block[] {
    // 单个 flavour 或 flavour 数组都可以
    const flavours =
      typeof blockFlavour === 'string' ? [blockFlavour] : blockFlavour;

    return Object.values(this._blocks.peek()).filter(({ flavour }) =>
      flavours.includes(flavour)
    );
  }

  /**
   * Get all models in the store
   * @returns Array of all models
   *
   * @category Block CRUD
   */
  getAllModels() {
    return Object.values(this._blocks.peek()).map(block => block.model);
  }

  /**
   * Get all models of specified flavour(s)
   * @param blockFlavour - Single flavour or array of flavours to filter by
   * @returns Array of matching models
   *
   * @category Block CRUD
   */
  getModelsByFlavour(blockFlavour: string | string[]): BlockModel[] {
    return this.getBlocksByFlavour(blockFlavour).map(x => x.model);
  }

  /**
   * Gets the parent block of a given block
   * @param target - Block model or block ID to find parent for
   * @returns The parent block model if found, null otherwise
   *
   * @category Block CRUD
   */
  getParent(target: BlockModel | string): BlockModel | null {
    const targetId = typeof target === 'string' ? target : target.id;
    const parentId = this._crud.getParent(targetId);
    if (!parentId) return null;

    const parent = this._blocks.peek()[parentId];
    if (!parent) return null;

    return parent.model;
  }

  /**
   * Get the previous sibling block of a given block
   * @param block - Block model or block ID to find previous sibling for
   * @returns The previous sibling block model if found, null otherwise
   *
   * @category Block CRUD
   */
  getPrev(block: BlockModel | string) {
    return this._getSiblings(
      block,
      (parent, index) => parent.children[index - 1] ?? null
    );
  }

  /**
   * Get all previous sibling blocks of a given block
   * @param block - Block model or block ID to find previous siblings for
   * @returns Array of previous sibling blocks if found, empty array otherwise
   *
   * @category Block CRUD
   */
  getPrevs(block: BlockModel | string) {
    return (
      this._getSiblings(block, (parent, index) =>
        parent.children.slice(0, index)
      ) ?? []
    );
  }

  /**
   * Get the next sibling block of a given block
   * @param block - Block model or block ID to find next sibling for
   * @returns The next sibling block model if found, null otherwise
   *
   * @category Block CRUD
   */
  getNext(block: BlockModel | string) {
    return this._getSiblings(
      block,
      (parent, index) => parent.children[index + 1] ?? null
    );
  }

  /**
   * Get all next sibling blocks of a given block
   * @param block - Block model or block ID to find next siblings for
   * @returns Array of next sibling blocks if found, empty array otherwise
   *
   * @category Block CRUD
   */
  getNexts(block: BlockModel | string) {
    return (
      this._getSiblings(block, (parent, index) =>
        parent.children.slice(index + 1)
      ) ?? []
    );
  }

  /**
   * Check if a block exists by its ID
   * @param id - The block's ID
   * @returns True if the block exists, false otherwise
   *
   * @category Block CRUD
   */
  hasBlock(id: string) {
    return id in this._blocks.peek();
  }

  /**
   * Move blocks to a new parent block
   * @param blocksToMove - Array of block models to move
   * @param newParent - The new parent block model
   * @param targetSibling - Optional target sibling block model
   * @param shouldInsertBeforeSibling - Optional flag to insert before sibling
   *
   * @category Block CRUD
   */
  moveBlocks(
    blocksToMove: BlockModel[],
    newParent: BlockModel,
    targetSibling: BlockModel | null = null,
    shouldInsertBeforeSibling = true
  ) {
    if (this.readonly) {
      console.error('Cannot modify data in read-only mode');
      return;
    }

    this.transact(() => {
      this._crud.moveBlocks(
        blocksToMove.map(model => model.id),
        newParent.id,
        targetSibling?.id ?? null,
        shouldInsertBeforeSibling
      );
    });
  }

  /**
   * Creates a new transformer instance for the store
   * @param middlewares - Optional array of transformer middlewares
   * @returns A new Transformer instance
   *
   * @category Transformer
   */
  getTransformer(middlewares: TransformerMiddleware[] = []) {
    return new Transformer({
      schema: this.schema,
      blobCRUD: this.workspace.blobSync,
      // 导入 / 复制内容时可能引用其他文档，因此通过 Workspace 级别的
      // createDoc / getDoc / removeDoc 来操作子文档
      docCRUD: {
        create: (id: string) => this.workspace.createDoc(id).getStore({ id }),
        get: (id: string) =>
          this.workspace.getDoc(id)?.getStore({ id }) ?? null,
        delete: (id: string) => this.workspace.removeDoc(id),
      },
      middlewares,
    });
  }

  /**
   * Get an extension instance from the store
   * @returns The extension instance
   *
   * @example
   * ```ts
   * const extension = store.get(SomeExtension);
   * ```
   *
   * @category Extension
   */
  get get() {
    return this.provider.get.bind(this.provider);
  }

  /**
   * Optional get an extension instance from the store.
   * The major difference between `get` and `getOptional` is that `getOptional` will not throw an error if the extension is not found.
   *
   * @returns The extension instance
   *
   * @example
   * ```ts
   * const extension = store.getOptional(SomeExtension);
   * ```
   *
   * @category Extension
   */
  get getOptional() {
    return this.provider.getOptional.bind(this.provider);
  }

  /**
   * Initializes and loads the store
   * @param initFn - Optional initialization function
   * @returns The store instance
   *
   * @category Store Lifecycle
   */
  load(initFn?: () => void) {
    // dispose 之后再次 load：重建资源组并重新订阅 slots
    if (this._isDisposed) {
      this.disposableGroup = new DisposableGroup();
      this._subscribeToSlots();
      this._isDisposed = false;
    }

    // 加载 Y.Doc 与根块（initFn 用于创建初始块）
    this._doc.load(initFn);
    this._provider.getAll(StoreExtensionIdentifier).forEach(ext => {
      ext.loaded();
    });
    // 通知外部：文档与扩展均已就绪；
    // rootAdded 平时由块新增触发，这里在 load 后补发一次，方便晚订阅的 UI 初始化
    this.slots.ready.next();
    this.slots.rootAdded.next(this.root?.id ?? '');
    return this;
  }

  /**
   * Disposes the store and releases all resources
   *
   * @category Store Lifecycle
   */
  dispose() {
    // 先让扩展释放资源（例如 HistoryExtension 解绑 UndoManager 事件），
    // 再解除 Yjs 监听，最后 complete 所有事件流；
    // 结尾把 _isDisposed 置为 true，load() 可据此重新订阅 slots、复用该 Store
    this._provider.getAll(StoreExtensionIdentifier).forEach(ext => {
      ext.disposed();
    });
    if (this._doc.ready) {
      this._yBlocks.unobserveDeep(this._handleYEvents);
    }
    this.slots.ready.complete();
    this.slots.rootAdded.complete();
    this.slots.rootDeleted.complete();
    this.slots.blockUpdated.complete();
    this.slots.yBlockUpdated.complete();
    this.disposableGroup.dispose();
    this._isDisposed = true;
  }

  /**
   * 把 Yjs 的「块新增」事件转成内部事件。
   * 单独抽出来是为了让构造阶段也能同步处理已有块（直接调用本方法），
   * 而不依赖订阅是否已建立。
   */
  private _handleYBlockAdd(id: string, isLocal: boolean) {
    this.slots.yBlockUpdated.next({ type: 'add', id, isLocal });
  }

  /**
   * 把 Yjs 的「块删除」事件转成内部事件（由 _subscribeToSlots 消费并清理 Block）。
   */
  private _handleYBlockDelete(id: string, isLocal: boolean) {
    this.slots.yBlockUpdated.next({ type: 'delete', id, isLocal });
  }

  /**
   * 解析单个 Yjs 事件：只关心顶层 Y.Map('blocks') 上的 add / delete，
   * 并判断变更来源是否为本机（isLocal），供上层区分远端协作者的改动。
   */
  private _handleYEvent(event: Y.YEvent<YBlock | Y.Text | Y.Array<unknown>>) {
    // event on top-level block store
    // 只处理直接作用于顶层 Y.Map('blocks') 的事件；
    // 块内部的属性变化由 Block 自己订阅，不在这里重复响应
    if (event.target !== this._yBlocks) {
      return;
    }
    // 判断是否本地来源：
    // - 没有 origin（程序内部直接写入）
    // - UndoManager 触发的 undo/redo
    // - BlockSuite 响应式代理（reactive proxy，origin.proxy === true）
    // 都视为本地；否则只有 origin === clientID 才算本地。
    // 远端同步过来的 update 使用的是 provider 的 origin，因此为 false。
    const isLocal =
      !event.transaction.origin ||
      !this._yBlocks.doc ||
      event.transaction.origin instanceof Y.UndoManager ||
      event.transaction.origin.proxy
        ? true
        : event.transaction.origin === this._yBlocks.doc.clientID;
    event.keys.forEach((value, id) => {
      try {
        if (value.action === 'add') {
          this._handleYBlockAdd(id, isLocal);
          return;
        }
        if (value.action === 'delete') {
          this._handleYBlockDelete(id, isLocal);
          return;
        }
      } catch (e) {
        console.error('An error occurred while handling Yjs event:');
        console.error(e);
      }
    });
  }

  /**
   * observeDeep 的回调：逐条分发给 _handleYEvent。
   * 使用箭头函数字段保证引用稳定，unobserveDeep 时才能正确解绑。
   */
  private readonly _handleYEvents = (events: Y.YEvent<YBlock | Y.Text>[]) => {
    events.forEach(event => this._handleYEvent(event));
  };
}
