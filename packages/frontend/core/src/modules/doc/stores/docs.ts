/**
 * DocsStore 是 Workspace 作用域下，负责文档目录与元信息读写的数据访问层；
 * 正文数据由 Doc 实体上的 blockSuiteDoc 及其同步链路负责，不在 DocsStore 的职责内。
 * 它是“文档列表”这一层的数据访问层，负责文档的增删查、元信息读写、生命周期操作和同步状态查询，但不碰文档正文。
 * 
 * 上层 DocsService / Doc / DocRecord 都通过它读写数据。文档数据分两处：
 * - root Y.Doc 的 `meta.pages`：id / title / createDate / updatedDate / tags / trash
 *   —— 随工作区同步，是文档列表和元信息的唯一来源
 * - DocPropertiesStore（workspace DB）：primaryMode、createdBy 等文档属性
 *   —— 本 Store 只在 primaryMode 相关方法里转发给后者
 *
 * 大量 `watchXxx()` 返回 RxJS Observable，供 LiveData / Entity 订阅。
 * 三种 Yjs 观察方式的区别：
 * - yjsObserve：只观察当前层级（如 YArray 的增删，不关心元素内部）
 * - yjsObservePath('*.trash')：只观察指定字段的变化
 * - yjsObserveDeep：观察对象及其所有深层变化
 */
import type { DocMode } from '@blocksuite/affine/model';
import type { DocMeta } from '@blocksuite/affine/store';
import {
  Store,
  yjsGetPath,
  yjsObserve,
  yjsObserveDeep,
  yjsObservePath,
} from '@toeverything/infra';
import { nanoid } from 'nanoid';
import { distinctUntilChanged, map, switchMap } from 'rxjs';
import { applyUpdate, Array as YArray, Map as YMap, transact } from 'yjs';

import type { WorkspaceService } from '../../workspace';
import type { DocPropertiesStore } from './doc-properties';

export class DocsStore extends Store {
  constructor(
    // 提供 workspace.docCollection（BlockSuite 文档集合）和 rootYDoc
    private readonly workspaceService: WorkspaceService,
    // 文档属性存储（workspace DB）
    private readonly docPropertiesStore: DocPropertiesStore
  ) {
    super();
  }

  /**
   * 取某篇文档的 BlockSuite Store（块模型树的读写入口）。
   * 文档不存在时返回 null。
   * 正文数据（块模型树）在每篇文档自己的 spaceDoc（即 blockSuiteDoc）里
   */
  getBlockSuiteDoc(id: string) {
    return (
      this.workspaceService.workspace.docCollection
        .getDoc(id)
        ?.getStore({ id }) ?? null
    );
  }

  // 工作区的 BlockSuite 文档集合，复制/导入等需要跨文档操作时使用
  getBlocksuiteCollection() {
    return this.workspaceService.workspace.docCollection;
  }

  /**
   * 在工作区 root Y.Doc 的 `meta.pages` 中登记一篇新文档。
   * 只写元信息（id / 空标题 / 创建时间 / 空标签数组），不创建文档内容。
   *
   * @returns 文档 id（未传 docId 时用 nanoid 生成）
   *
   * 注意：如果 `meta.pages` 不存在或类型不对，事务里会直接 return，
   * 但方法仍然返回 id——调用方需要自行保证工作区数据结构已初始化。
   */
  createDoc(docId?: string) {
    const id = docId ?? nanoid();

    // 第三个参数在 Yjs 里是事务的 origin，不是选项对象；
    // 本仓库统一传 `{ force: true }` 作为这次写入的标记
    transact(
      this.workspaceService.workspace.rootYDoc,
      () => {
        const docs = this.workspaceService.workspace.rootYDoc
          .getMap('meta')
          .get('pages');

        if (!docs || !(docs instanceof YArray)) {
          return;
        }

        docs.push([
          new YMap([
            ['id', id],
            ['title', ''],
            ['createDate', Date.now()],
            ['tags', new YArray()],
          ]),
        ]);
      },
      { force: true }
    );

    return id;
  }

  /**
   * 文档 id 列表。
   * 用 yjsObserve（浅观察）只监听 YArray 的增删，标题/标签等字段变化不会触发。
   * 返回一个 RxJS Observable，持续发射当前工作区里所有文档的 id 列表，并在文档增删时自动推送新列表。
   */
  watchDocIds() {
    return yjsGetPath(
      this.workspaceService.workspace.rootYDoc.getMap('meta'),
      'pages'
    ).pipe(
      switchMap(yjsObserve),
      map(meta => {
        if (meta instanceof YArray) {
          return meta.map(v => v.get('id') as string);
        } else {
          return [];
        }
      })
    );
  }

  /**
   * 所有文档的更新时间。
   * 只在任意文档的 `updatedDate` 变化时重新发射整个列表。
   */
  watchAllDocUpdatedDate() {
    return yjsGetPath(
      this.workspaceService.workspace.rootYDoc.getMap('meta'),
      'pages'
    ).pipe(
      switchMap(pages => yjsObservePath(pages, '*.updatedDate')),
      map(pages => {
        if (pages instanceof YArray) {
          return pages.map(v => ({
            id: v.get('id') as string,
            updatedDate: v.get('updatedDate') as number | undefined,
          }));
        } else {
          return [];
        }
      })
    );
  }

  // 所有文档的标签；YArray 会转成普通数组，兼容旧数据里的普通数组
  watchAllDocTagIds() {
    return yjsGetPath(
      this.workspaceService.workspace.rootYDoc.getMap('meta'),
      'pages'
    ).pipe(
      switchMap(pages => yjsObservePath(pages, '*.tags')),
      map(pages => {
        if (pages instanceof YArray) {
          return pages.map(v => ({
            id: v.get('id') as string,
            tags: (() => {
              const tags = v.get('tags');
              if (tags instanceof YArray) {
                return tags.toJSON() as string[];
              }
              return (tags ?? []) as string[];
            })(),
          }));
        } else {
          return [];
        }
      })
    );
  }

  // 所有文档的创建时间；缺失时按 0 处理
  watchAllDocCreateDate() {
    return yjsGetPath(
      this.workspaceService.workspace.rootYDoc.getMap('meta'),
      'pages'
    ).pipe(
      switchMap(pages => yjsObservePath(pages, '*.createDate')),
      map(pages => {
        if (pages instanceof YArray) {
          return pages.map(v => ({
            id: v.get('id') as string,
            createDate: (v.get('createDate') ?? 0) as number,
          }));
        } else {
          return [];
        }
      })
    );
  }

  // 所有文档的标题；缺失时按空字符串处理
  watchAllDocTitle() {
    return yjsGetPath(
      this.workspaceService.workspace.rootYDoc.getMap('meta'),
      'pages'
    ).pipe(
      switchMap(pages => yjsObservePath(pages, '*.title')),
      map(pages => {
        if (pages instanceof YArray) {
          return pages.map(v => ({
            id: v.get('id') as string,
            title: (v.get('title') ?? '') as string,
          }));
        } else {
          return [];
        }
      })
    );
  }

  // 非回收站文档 id：trash 为真时过滤掉
  watchNonTrashDocIds() {
    return yjsGetPath(
      this.workspaceService.workspace.rootYDoc.getMap('meta'),
      'pages'
    ).pipe(
      switchMap(pages => yjsObservePath(pages, '*.trash')),
      map(meta => {
        if (meta instanceof YArray) {
          return meta
            .map(v => (v.get('trash') ? null : v.get('id')))
            .filter(Boolean) as string[];
        } else {
          return [];
        }
      })
    );
  }

  // 回收站文档 id
  watchTrashDocIds() {
    return yjsGetPath(
      this.workspaceService.workspace.rootYDoc.getMap('meta'),
      'pages'
    ).pipe(
      switchMap(pages => yjsObservePath(pages, '*.trash')),
      map(meta => {
        if (meta instanceof YArray) {
          return meta
            .map(v => (v.get('trash') ? v.get('id') : null))
            .filter(Boolean) as string[];
        } else {
          return [];
        }
      })
    );
  }

  /**
   * 观察单篇文档的元信息，输出普通对象（Partial<DocMeta>）。
   *
   * 三步：
   * 1. 观察 `meta.pages` 数组本身，数组增删（新增/删除文档）时重新查找
   * 2. 按 id 找到对应的 YMap；用 docMetaIndexCache 缓存上次命中的下标，
   *    避免每次 O(n) 扫描（数组元素在本地编辑时通常不会乱序）
   * 3. switchMap(yjsObserveDeep) 深度观察该 YMap，任意字段变化都会 toJSON 发射
   *
   * 找不到文档时下游最终会收到空对象 `{}`（而不是 null）。
   */
  watchDocMeta(id: string) {
    let docMetaIndexCache = -1;
    return yjsGetPath(
      this.workspaceService.workspace.rootYDoc.getMap('meta'),
      'pages'
    ).pipe(
      switchMap(yjsObserve),
      map(meta => {
        if (meta instanceof YArray) {
          // 先检查缓存下标是否仍然指向目标文档
          if (docMetaIndexCache >= 0) {
            const doc = meta.get(docMetaIndexCache);
            if (doc && doc.get('id') === id) {
              return doc as YMap<any>;
            }
          }

          // meta is YArray, `for-of` is faster then `for`
          let i = 0;
          for (const doc of meta) {
            if (doc && doc.get('id') === id) {
              docMetaIndexCache = i;
              return doc as YMap<any>;
            }
            i++;
          }
          return null;
        } else {
          return null;
        }
      }),
      switchMap(yjsObserveDeep),
      map(meta => {
        if (meta instanceof YMap) {
          return meta.toJSON() as Partial<DocMeta>;
        } else {
          return {};
        }
      })
    );
  }

  /**
   * 文档列表是否已经同步完成。
   *
   * 来自 nbstore 的 docState$.synced（root 文档同步状态）：
   * - false：列表还没拉下来，此时"找不到文档"不代表文档不存在
   * - true：可以安全地据此判断 404
   */
  watchDocListReady() {
    return this.workspaceService.workspace.engine.doc
      .docState$(this.workspaceService.workspace.id)
      .pipe(map(state => state.synced));
  }

  // 写入文档元信息（走 BlockSuite 的 meta 管理器，最终落到 root Y.Doc）
  setDocMeta(id: string, meta: Partial<DocMeta>) {
    this.workspaceService.workspace.docCollection.meta.setDocMeta(id, meta);
  }

  /**
   * 执行文档生命周期操作：移入回收站 / 恢复 / 永久删除。
   * 不算正文保存，但它对元数据做了持久化写入：本地工作区：setDocMeta 写回收站标记，removeDoc 删文档。
   *
   * - 本地工作区：直接改本地数据。删除调用 removeDoc；回收站/恢复只改 meta
   * - 云端工作区：由服务端裁定，返回 root Y.Doc 的增量更新，再 applyUpdate；
   *   永久删除时还要清理本地 nbstore 中的文档数据
   */
  async applyDocLifecycle(
    id: string,
    lifecycle: 'trash' | 'restore' | 'delete'
  ) {
    const workspace = this.workspaceService.workspace;
    // 判断当前工作区是不是“本地工作区”。
    if (workspace.flavour === 'local') {
      if (lifecycle === 'delete') {
        workspace.docCollection.removeDoc(id);
      } else {
        this.setDocMeta(
          id,
          lifecycle === 'trash'
            ? { trash: true, trashDate: Date.now() }
            : { trash: false, trashDate: undefined }
        );
      }
      return;
    }
    // 云端：服务端返回 rootYDoc 的更新，应用到本地
    // 这是 DocsStore.applyDocLifecycle 在云端工作区分支里，把单篇文档的生命周期操作委托给同步引擎（engine.doc）。engine.doc 是一个服务，它内部会向服务端发起请求，服务端裁定后返回 root Y.Doc 的增量更新，然后这里用 applyUpdate 应用到本地。它处理的是一篇文档，不是多篇。
    const result = await workspace.engine.doc.applyDocLifecycle(id, lifecycle);
    applyUpdate(workspace.rootYDoc, result.rootUpdate, 'server-lifecycle');
    if (lifecycle === 'delete') {
      // 永久删除：清掉本地存储中的文档数据
      await workspace.engine.doc.storage.deleteDoc(id);
    }
  }

  // 文档主模式（page / edgeless）保存在文档属性里
  setDocPrimaryModeSetting(id: string, mode: DocMode) {
    return this.docPropertiesStore.updateDocProperties(id, {
      primaryMode: mode,
    });
  }

  getDocPrimaryModeSetting(id: string) {
    return this.docPropertiesStore.getDocProperties(id)?.primaryMode;
  }

  // 观察主模式变化；distinctUntilChanged 避免相同值重复通知
  watchDocPrimaryModeSetting(id: string) {
    return this.docPropertiesStore.watchDocProperties(id).pipe(
      map(config => config?.primaryMode),
      distinctUntilChanged((p, c) => p === c)
    );
  }

  // 等待文档完成同步加载（nbstore 的 doc sync）
  waitForDocLoadReady(id: string) {
    return this.workspaceService.workspace.engine.doc.waitForDocLoaded(id);
  }

  // 临时提高文档的同步优先级，返回释放函数
  addPriorityLoad(id: string, priority: number) {
    return this.workspaceService.workspace.engine.doc.addPriority(id, priority);
  }
}
