/**
 * 工作区内的「文档服务」（Workspace-scoped）
 *
 * 统一管理当前工作区里的文档，是 UI 操作文档的主要入口：
 * - 文档列表：`list`（DocRecordList）订阅 workspace root Y.Doc 中的 `meta.pages`，
 *   提供 docId → DocRecord 的映射，以及表示列表是否同步完成的 `isReady$`
 * - 文档实例：`pool`（ObjectPool）按 docId 缓存已打开的 Doc，并用引用计数复用
 * - 生命周期：open / createDoc / duplicate 等
 * - 查询流：allDocIds$、allDocTitle$ 等，主要供搜索和索引使用
 *
 * 两个容易混淆的类型：
 * - DocRecord：文档元信息（id / title / trash / tags / properties），轻量、常驻
 * - Doc：真正打开的文档实体，持有 DocScope 和 BlockSuite Store；
 *   必须通过 `open()` 获取，用完调用返回的 `release()`
 */
import { DebugLogger } from '@affine/debug';
import { Unreachable } from '@affine/env/constant';
import { replaceIdMiddleware } from '@blocksuite/affine/shared/adapters';
import type { AffineTextAttributes } from '@blocksuite/affine/shared/types';
import type { DeltaInsert } from '@blocksuite/affine/store';
import { Slice, Text, Transformer } from '@blocksuite/affine/store';
import { ObjectPool, Service } from '@toeverything/infra';
import { combineLatest, map } from 'rxjs';

import { initDocFromProps } from '../../../blocksuite/initialization';
import { getAFFiNEWorkspaceSchema } from '../../workspace/global-schema';
import type { Doc } from '../entities/doc';
import { DocRecordList } from '../entities/record-list';
import { DocCreated, DocInitialized } from '../events';
import type { DocCreateMiddleware } from '../providers/doc-create-middleware';
import { DocScope } from '../scopes/doc';
import type { DocPropertiesStore } from '../stores/doc-properties';
import type { DocsStore } from '../stores/docs';
import type { DocCreateOptions } from '../types';
import { DocService } from './doc';
import { getDuplicatedDocTitle } from './duplicate-title';

const logger = new DebugLogger('DocsService');

export class DocsService extends Service {
  // 文档记录列表：订阅 root Y.Doc 里的文档 id 列表（meta.pages）。
  // 它只提供元信息，不代表文档内容已经加载。
  list = this.framework.createEntity(DocRecordList);

  // Doc 实例池：按 docId 复用已打开的 Doc，内部维护引用计数。
  // 引用计数归零后由 ObjectPool 延迟回收，回收时释放整个 DocScope。
  pool = new ObjectPool<string, Doc>({
    onDelete(obj) {
      obj.scope.dispose();
    },
  });

  /**
   * Get all property values of a property, used for search
   *
   * Results may include docs in trash or deleted docs
   * Legacy property data such as old `journal` will not be included in the values
   *
   * 取某个属性在所有文档上的值，供搜索使用：
   * - 把文档 id 列表与属性存储的值合并成 Map<docId, value>
   * - 可能包含回收站或已删除文档
   * - 旧版属性（如 `journal`）不在此列
   */
  propertyValues$(propertyKey: string) {
    return combineLatest([
      this.store.watchDocIds(),
      this.docPropertiesStore.watchPropertyAllValues(propertyKey),
    ]).pipe(
      map(([docIds, propertyValues]) => {
        const result = new Map<string, string | undefined>();
        for (const docId of docIds) {
          result.set(docId, propertyValues.get(docId));
        }
        return result;
      })
    );
  }

  // ===== 以下均为供搜索 / 索引使用的只读数据流 =====
  // 它们都订阅 root Y.Doc 的 `meta.pages`，文档元信息变化时自动推送新值。

  /**
   * used for search
   */
  allDocsCreatedDate$() {
    return this.store.watchAllDocCreateDate();
  }

  /**
   * used for search
   */
  allDocsUpdatedDate$() {
    return this.store.watchAllDocUpdatedDate();
  }

  // 所有文档的标签
  allDocsTagIds$() {
    return this.store.watchAllDocTagIds();
  }

  // 所有文档 id（含回收站）
  allDocIds$() {
    return this.store.watchDocIds();
  }

  // 非回收站文档 id
  allNonTrashDocIds$() {
    return this.store.watchNonTrashDocIds();
  }

  // 回收站文档 id
  allTrashDocIds$() {
    return this.store.watchTrashDocIds();
  }

  // 所有文档标题
  allDocTitle$() {
    return this.store.watchAllDocTitle();
  }

  constructor(
    // 负责读写 root Y.Doc 中的文档元信息
    private readonly store: DocsStore,
    // 文档属性（properties）存储
    private readonly docPropertiesStore: DocPropertiesStore,
    // 创建文档前后的扩展点，按注册顺序依次执行
    private readonly docCreateMiddlewares: DocCreateMiddleware[]
  ) {
    super();
  }

  /**
   * 查询某篇文档是否已经打开。
   * 只读查询，不会触发加载；找不到返回 null。
   *
   * 注意：底层 pool.get 会增加引用计数，拿到结果后同样需要 release()。
   */
  loaded(docId: string) {
    const exists = this.pool.get(docId);
    if (exists) {
      return { doc: exists.obj, release: exists.release };
    }
    return null;
  }

  /**
   * 打开一篇文档，返回 Doc 实体和用于释放的 release 函数。
   *
   * 流程：
   * 1. 校验 DocRecord 与 BlockSuite Store 都存在
   * 2. 若对象池中已有该 Doc，直接复用（引用计数 +1）
   * 3. 否则创建 DocScope（注入 docId / record / Store），从中取出 Doc 实体
   * 4. 调用 blockSuiteDoc.load() 把 Y.Doc 内容加载成块树
   * 5. 广播 DocInitialized 事件，并把 Doc 放入对象池
   *
   * 调用方必须在结束时调用 release()，否则 Doc 不会被回收。
   */
  open(docId: string) {
    const docRecord = this.list.doc$(docId).value;
    if (!docRecord) {
      throw new Error('Doc record not found');
    }
    const blockSuiteDoc = this.store.getBlockSuiteDoc(docId);
    if (!blockSuiteDoc) {
      throw new Error('Doc not found');
    }

    // 已经打开过则复用同一个实例，避免重复加载
    const exists = this.pool.get(docId);
    if (exists) {
      return { doc: exists.obj, release: exists.release };
    }

    // 为这篇文档创建独立的作用域，Doc / Editor 等实体都挂在它下面
    const docScope = this.framework.createScope(DocScope, {
      docId,
      blockSuiteDoc,
      record: docRecord,
    });

    try {
      // 把 Y.Doc 同步到 BlockSuite 的块模型
      blockSuiteDoc.load();
    } catch (e) {
      logger.error('Failed to load doc', {
        docId,
        error: e,
      });
    }

    const doc = docScope.get(DocService).doc;

    // 通知其他模块：这篇文档已经初始化完成
    doc.scope.emitEvent(DocInitialized, doc);

    // 放入对象池，引用计数从 1 开始
    const { obj, release } = this.pool.put(docId, doc);

    return { doc: obj, release };
  }

  /**
   * 创建一篇新文档，返回它的 DocRecord（只含元信息，不是打开后的 Doc）。
   *
   * 完整流程：
   * 1. beforeCreate：依次执行创建中间件，允许改写创建参数
   *    （例如设置默认的 page/edgeless 模式、注入初始 docProps）。
   *    中间件可以返回一个新对象，因此每一步都要把返回值赋回 `options`。
   * 2. 在 root Y.Doc 的 `meta.pages` 中登记元信息（id / 空标题 / 创建时间 / 空标签）。
   *    这一步不创建文档内容；写入是同步的，文档列表会立即更新。
   * 3. 取出该文档对应的 BlockSuite Store（块数据的读写入口）。
   * 4. 初始化文档内容：默认创建 page → surface/note → paragraph 等初始块；
   *    内容取决于 docProps，标题取自 options.title。skipInit 时跳过。
   * 5. 从文档列表里取出 DocRecord，写入 primaryMode / isTemplate 等元信息。
   * 6. afterCreate：记录此时已经存在，中间件可以继续设置属性、标签或关联关系。
   * 7. 显式写入创建时间 / 更新时间。
   * 8. 广播 DocCreated 事件（监听方可以刷新 UI、建立索引等），返回 DocRecord。
   *
   * 注意：
   * - 本方法不会打开文档，也不会创建 Doc / DocScope 或加载编辑器；
   *   需要访问文档内容时请再调用 `open(id)`。
   * - 因为 beforeCreate 可能抛错，第 1 步失败时不会产生任何写入。
   */
  createDoc(options: DocCreateOptions = {}) {
    // 1. beforeCreate：按注册顺序执行；每个中间件都可以修改或替换参数
    for (const middleware of this.docCreateMiddlewares) {
      options = middleware.beforeCreate
        ? middleware.beforeCreate(options)
        : options;
    }
    // 2. 在 root Y.Doc 中登记新文档（只写 meta.pages 元信息），返回生成的 id。
    //    options.id 为空时由 store 用 nanoid 生成。
    const id = this.store.createDoc(options.id);
    // 3. 取该文档的 BlockSuite Store：内部先找到 DocImpl，再取它的 Store。
    //    正常情况一定存在；为 null 说明工作区数据结构异常，直接失败。
    const docStore = this.store.getBlockSuiteDoc(id);
    if (!docStore) {
      throw new Error('Failed to create doc');
    }
    // 4. 写入初始内容（标题、默认块等）：initDocFromProps 会创建
    //    page → surface / note → paragraph，标题取自 options.title，
    //    最后清空 undo 历史，避免用户一撤销就把初始内容删光。
    //    skipInit 用于导入 / 复制等场景：它们会自行控制内容，
    //    避免这里先创建出空段落或多余的初始块。
    if (options.skipInit !== true) {
      initDocFromProps(docStore, options.docProps, options);
    }
    // 5. 从 DocRecordList 取出刚登记的记录。
    //    meta.pages 的写入是同步的，因此这里应当能立刻拿到；拿不到属于不可达状态。
    const docRecord = this.list.doc$(id).value;
    if (!docRecord) {
      throw new Unreachable();
    }
    // 主编辑模式（page / edgeless），作为文档属性 primaryMode 存储。
    // 未指定时保持默认，读取侧默认按 page 处理。
    if (options.primaryMode) {
      docRecord.setPrimaryMode(options.primaryMode);
    }
    // 标记为模板文档：TemplateDocService 以 isTemplate 属性筛选模板列表
    // （日志模板、模板选择器等会用到）。
    if (options.isTemplate) {
      docRecord.setProperty('isTemplate', true);
    }
    // 6. afterCreate：DocRecord 已存在，中间件可以设置属性、标签、建立关联等
    for (const middleware of this.docCreateMiddlewares) {
      middleware.afterCreate?.(docRecord, options);
    }
    // 7. 写入时间戳：createDate 覆盖登记时的值，updatedDate 首次写入。
    //    放在中间件之后，保证最终时间反映的是创建完成的时刻。
    docRecord.setCreatedAt(Date.now());
    docRecord.setUpdatedAt(Date.now());
    // 8. 广播创建完成事件；此时元信息已完整，文档内容也已按需初始化
    this.eventBus.emit(DocCreated, {
      doc: docRecord,
      docCreateOptions: options,
    });
    return docRecord;
  }

  // 读取自定义属性。存储时统一加 `custom:` 前缀，避免和内置属性重名。
  getCustomPropertyById(docId: string, propertyId: string) {
    return this.docPropertiesStore.getDocProperties(docId)?.[
      'custom:' + propertyId
    ] as string | undefined;
  }

  // 写入自定义属性
  setCustomPropertyById(docId: string, propertyId: string, value: string) {
    return this.docPropertiesStore.updateDocProperties(docId, {
      ['custom:' + propertyId]: value,
    });
  }

  /**
   * 在 targetDocId 中插入一个指向 linkedDocId 的行内链接（LinkedPage）。
   *
   * 因为需要修改文档内容，先 open 并提高同步优先级、等待文档加载完成，
   * 然后往第一个 affine:note 块里追加一个段落；结束后释放引用。
   * 如果文档里没有 note 块，则什么也不做。
   */
  async addLinkedDoc(targetDocId: string, linkedDocId: string) {
    const { doc, release } = this.open(targetDocId);
    // 临时提高加载优先级，避免等待后台同步
    const disposePriorityLoad = doc.addPriorityLoad(10);
    await doc.waitForSyncReady();
    disposePriorityLoad();
    const text = new Text([
      {
        insert: ' ',
        attributes: {
          reference: {
            type: 'LinkedPage',
            pageId: linkedDocId,
          },
        },
      },
    ] as DeltaInsert<AffineTextAttributes>[]);
    // 插入到第一个 note 块中
    const [frame] = doc.blockSuiteDoc.getBlocksByFlavour('affine:note');
    frame &&
      doc.blockSuiteDoc.addBlock(
        'affine:paragraph' as never, // TODO(eyhn): fix type
        { text },
        frame.id
      );
    release();
  }

  /**
   * 修改文档标题。
   *
   * 同样先等文档同步完成再改，避免本地标题覆盖掉尚未拉取的远端内容。
   * 标题同时写入 BlockSuite 的 page 块和 DocRecord 的 meta。
   */
  async changeDocTitle(docId: string, newTitle: string) {
    const { doc, release } = this.open(docId);
    const disposePriorityLoad = doc.addPriorityLoad(10);
    await doc.waitForSyncReady();
    disposePriorityLoad();
    doc.changeDocTitle(newTitle);
    release();
  }

  /**
   * 复制一篇文档（内容 + 标签 + 标题 + 属性）。
   *
   * @param sourceDocId 源文档 id
   * @param _targetDocId 可选的已有目标文档 id；不传则新建一篇
   * @returns 目标文档 id
   *
   * 复制内容的方式：
   * 1. 清空目标文档现有的根级块
   * 2. 用 BlockSuite Transformer 把源文档根级块转成 Snapshot，再写回目标
   * 3. replaceIdMiddleware 会重新生成块 id，避免两篇文档 id 冲突
   * 4. docCRUD 用于处理复制过程中引用到的子文档（如嵌入文档）
   *
   * 注意：源文档在回收站中时直接跳过；失败只记录日志，不向外抛。
   */
  async duplicate(sourceDocId: string, _targetDocId?: string) {
    // 没有指定目标时，先创建一篇空白文档
    const targetDocId = _targetDocId ?? this.createDoc().id;

    // check if source doc is removed
    // 源文档已被移入回收站：不再复制
    if (this.list.doc$(sourceDocId).value?.trash$.value) {
      console.warn(
        `Template doc(id: ${sourceDocId}) is removed, skip duplicate`
      );
      return targetDocId;
    }

    const { release: sourceRelease, doc: sourceDoc } = this.open(sourceDocId);
    const { release: targetRelease, doc: targetDoc } = this.open(targetDocId);
    // 等源文档同步完成，否则可能只复制到部分内容
    await sourceDoc.waitForSyncReady();

    // duplicate doc content
    try {
      const sourceBsDoc = this.store.getBlockSuiteDoc(sourceDocId);
      const targetBsDoc = this.store.getBlockSuiteDoc(targetDocId);
      if (!sourceBsDoc) throw new Error('Source doc not found');
      if (!targetBsDoc) throw new Error('Target doc not found');

      // clear the target doc (both surface and note)
      // 先清空目标文档根级的所有块
      targetBsDoc.root?.children.forEach(child =>
        targetBsDoc.deleteBlock(child)
      );

      const collection = this.store.getBlocksuiteCollection();
      const transformer = new Transformer({
        schema: getAFFiNEWorkspaceSchema(),
        blobCRUD: collection.blobSync,
        docCRUD: {
          // 复制过程中遇到引用的子文档时，目标工作区里也创建一份
          create: (id: string) => {
            this.createDoc({ id });
            const store = collection.getDoc(id)?.getStore({ id });
            if (!store) {
              throw new Error('Failed to create doc');
            }
            return store;
          },
          get: (id: string) => collection.getDoc(id)?.getStore({ id }) ?? null,
          delete: (id: string) => collection.removeDoc(id),
        },
        // 重新生成块 id，避免与源文档冲突
        middlewares: [replaceIdMiddleware(collection.idGenerator)],
      });
      // 源文档根级块 → Snapshot → 目标文档
      const slice = Slice.fromModels(sourceBsDoc, [
        ...(sourceBsDoc.root?.children ?? []),
      ]);
      const snapshot = transformer.sliceToSnapshot(slice);
      if (!snapshot) {
        throw new Error('Failed to create snapshot');
      }
      await transformer.snapshotToSlice(
        snapshot,
        targetBsDoc,
        targetBsDoc.root?.id
      );
    } catch (e) {
      logger.error('Failed to duplicate doc', {
        sourceDocId,
        targetDocId,
        originalTargetDocId: _targetDocId,
        error: e,
      });
    } finally {
      // 无论成功失败都要归还引用
      sourceRelease();
      targetRelease();
    }

    // duplicate doc meta
    // 复制标签
    targetDoc.record.setMeta({
      tags: sourceDoc.meta$.value.tags,
    });

    // duplicate doc title
    // 标题加 "(n)" 后缀，例如 "笔记" → "笔记(1)"
    targetDoc.changeDocTitle(getDuplicatedDocTitle(sourceDoc.title$.value));

    // duplicate doc properties
    // 复制属性，但排除只属于文档自身的字段
    const properties = sourceDoc.getProperties();
    const removedProperties = ['id', 'isTemplate', 'journal'];
    removedProperties.forEach(key => {
      delete properties[key];
    });
    targetDoc.updateProperties(properties);

    return targetDocId;
  }

  /**
   * Duplicate a doc from template
   * @param sourceDocId - the id of the source doc to be duplicated
   * @param _targetDocId - the id of the target doc to be duplicated, if not provided, a new doc will be created
   * @returns the id of the new doc
   *
   * 从模板复制一篇文档。与 `duplicate` 的区别：
   * - 只复制内容（块）和属性，不复制标签和标题
   * - 新文档沿用目标文档自己的标题，不会带上 "(n)" 后缀
   */
  async duplicateFromTemplate(sourceDocId: string, _targetDocId?: string) {
    const targetDocId = _targetDocId ?? this.createDoc().id;

    // check if source doc is removed
    if (this.list.doc$(sourceDocId).value?.trash$.value) {
      console.warn(
        `Template doc(id: ${sourceDocId}) is removed, skip duplicate`
      );
      return targetDocId;
    }

    const { release: sourceRelease, doc: sourceDoc } = this.open(sourceDocId);
    const { release: targetRelease, doc: targetDoc } = this.open(targetDocId);
    await sourceDoc.waitForSyncReady();

    // duplicate doc content
    // 内容复制逻辑与 duplicate 完全一致
    try {
      const sourceBsDoc = this.store.getBlockSuiteDoc(sourceDocId);
      const targetBsDoc = this.store.getBlockSuiteDoc(targetDocId);
      if (!sourceBsDoc) throw new Error('Source doc not found');
      if (!targetBsDoc) throw new Error('Target doc not found');

      // clear the target doc (both surface and note)
      targetBsDoc.root?.children.forEach(child =>
        targetBsDoc.deleteBlock(child)
      );

      const collection = this.store.getBlocksuiteCollection();
      const transformer = new Transformer({
        schema: getAFFiNEWorkspaceSchema(),
        blobCRUD: collection.blobSync,
        docCRUD: {
          create: (id: string) => {
            this.createDoc({ id });
            const store = collection.getDoc(id)?.getStore({ id });
            if (!store) {
              throw new Error('Failed to create doc');
            }
            return store;
          },
          get: (id: string) => collection.getDoc(id)?.getStore({ id }) ?? null,
          delete: (id: string) => collection.removeDoc(id),
        },
        middlewares: [replaceIdMiddleware(collection.idGenerator)],
      });
      const slice = Slice.fromModels(sourceBsDoc, [
        ...(sourceBsDoc.root?.children ?? []),
      ]);
      const snapshot = transformer.sliceToSnapshot(slice);
      if (!snapshot) {
        throw new Error('Failed to create snapshot');
      }
      await transformer.snapshotToSlice(
        snapshot,
        targetBsDoc,
        targetBsDoc.root?.id
      );
    } catch (e) {
      logger.error('Failed to duplicate doc', {
        sourceDocId,
        targetDocId,
        originalTargetDocId: _targetDocId,
        error: e,
      });
    } finally {
      sourceRelease();
      targetRelease();
    }

    // duplicate doc properties
    // 模板只复制属性；标题、标签保持目标文档原样
    const properties = sourceDoc.getProperties();
    const removedProperties = ['id', 'isTemplate', 'journal'];
    removedProperties.forEach(key => {
      delete properties[key];
    });
    targetDoc.updateProperties(properties);

    return targetDocId;
  }
}
