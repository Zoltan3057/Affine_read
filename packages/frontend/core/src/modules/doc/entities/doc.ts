/**
 * 文档实体（Doc Entity）
 *
 * 由 `DocsService.open()` 在 DocScope 中创建，代表一篇「已打开」的文档。
 * 与 DocRecord 的分工：
 * - DocRecord：轻量元信息，文档未打开时也能用（标题、标签、回收站状态等）
 * - Doc：DocRecord + BlockSuite Store + Y.Doc，可以读写文档内容
 *
 * 同一篇文档在这里有三种视图：
 * - `yDoc`          —— 底层 Y.Doc，CRDT 同步的最小单位（nbstore 读写的对象）
 * - `blockSuiteDoc` —— BlockSuite Store，把 Y.Doc 映射成块模型树，供编辑器使用
 * - `record`        —— DocRecord，元信息与属性的统一入口
 *
 * 实例通常被 DocsService 的对象池按 docId 复用，生命周期由引用计数管理。
 */
import type { DocMode, RootBlockModel } from '@blocksuite/affine/model';
import { Entity } from '@toeverything/infra';
import { throttle } from 'lodash-es';
import type { Transaction } from 'yjs';

import type { DocProperties } from '../../db';
import type { WorkspaceService } from '../../workspace';
import type { DocScope } from '../scopes/doc';
import type { DocsStore } from '../stores/docs';

export class Doc extends Entity {
  constructor(
    // 这篇文档的 DI 作用域。DocsService.open() 创建 DocScope 时注入
    // docId / DocRecord / BlockSuite Store；外部要用它包裹 <FrameworkScope>，
    // 所以是 public readonly。
    // DocScope 在这里指的是 一篇已打开文档专属的依赖注入（DI）作用域。
    public readonly scope: DocScope,
    // 文档数据访问层：读写 root Y.Doc 中的元信息、等待同步完成、调整同步优先级
    private readonly store: DocsStore,
    // 当前工作区服务：通过下面的 `workspace` getter 暴露 engine / docCollection 等
    private readonly workspaceService: WorkspaceService
  ) {
    super();

    // 监听本篇文档 Y.Doc 的事务，用本地编辑时间更新 updatedDate。
    // - 只处理本地事务（trx.local），远端同步过来的更新不算用户修改
    // - 用 throttle(1000ms, leading + trailing) 合并连续输入，
    //   避免每敲一个字就写一次元信息
    // - updatedDate 写在 workspace root Y.Doc 的 meta 里，属于另一个 Y.Doc，
    //   因此不会反过来再次触发这里的 afterTransaction

    // 限制高频回调的执行频率，同时配合生命周期管理做清理。

    // throttle 保证在持续触发期间按固定频率执行；debounce 是等触发停止后才执行一次
    const handleTransactionThrottled = throttle(
      (trx: Transaction) => {
        if (trx.local) {
          this.setUpdatedAt(Date.now());
        }
      },
      1000,
      {
        leading: true, // 时间窗口的第一次触发立即执行。
        trailing: true, // 时间窗口结束时再补执行一次。
      }
    );
    // 在 Yjs 文档 yDoc 上注册一个监听器，每当一个事务（Transaction）结束时，就调用 handleTransactionThrottled
    this.yDoc.on('afterTransaction', handleTransactionThrottled);

    // throttle 返回的函数内部可能还挂着定时器。如果在定时器触发前组件/实体已销毁，回调仍可能执行，造成泄漏或报错。所以 Doc 实体在 disposables 里做了两件事：
    // 注册到 Entity 的 disposables：dispose 时自动解除监听并取消节流
    this.disposables.push(() => {
      this.yDoc.off('afterTransaction', handleTransactionThrottled);// 解除事件监听
      handleTransactionThrottled.cancel();// 取消节流中等待的调用
    });

    // 提高本篇文档在同步引擎中的优先级（100），保证当前打开的文档优先同步。
    // addPriority 返回的函数用于释放优先级，同样交给 disposables 管理。
    this.disposables.push(
      this.workspaceService.workspace.engine.doc.addPriority(this.id, 100)
    );

    // 索引引擎也提升优先级，让搜索索引尽快跟上当前文档
    this.disposables.push(
      this.workspaceService.workspace.engine.indexer.addPriority(this.id, 100)
    );
  }

  /**
   * for convenience
   * 快捷访问当前工作区
   */
  get workspace() {
    return this.workspaceService.workspace;
  }

  // 文档 id 来自创建 DocScope 时注入的 props
  get id() {
    return this.scope.props.docId;
  }

  // 底层 CRDT 文档：nbstore / 同步引擎直接操作它
  // 一个 space 对应一份 Yjs 文档，文档里的块树数据、元信息变更都通过这个 Y.Doc 同步。
  public readonly yDoc = this.scope.props.blockSuiteDoc.spaceDoc;
  // BlockSuite 的 Store：块模型树的读写入口，编辑器使用它
  public readonly blockSuiteDoc = this.scope.props.blockSuiteDoc;
  // 文档元信息（标题、标签、回收站、属性等）的统一入口
  public readonly record = this.scope.props.record;

  // 把 DocRecord 上的 LiveData 直接透出，组件可以订阅这些流自动重渲染
  // DocRecord：轻量元信息，文档未打开时也能用（标题、标签、回收站状态等）。
  readonly meta$ = this.record.meta$; // 文档元信息整体快照（标题、标签、日期等聚合对象），修改任意元信息都会发射新值
  readonly properties$ = this.record.properties$; // 文档属性集合（pageWidth、primaryMode、createdBy 等），来自 workspace DB
  readonly primaryMode$ = this.record.primaryMode$; // 文档主模式：'page'（文档视图）或 'edgeless'（白板视图），决定默认打开哪种视图
  readonly title$ = this.record.title$; // 文档标题，与 BlockSuite 页块上的 Y.Text 标题保持同步，列表和搜索也读它
  readonly trash$ = this.record.trash$;
  readonly createdAt$ = this.record.createdAt$;
  readonly updatedAt$ = this.record.updatedAt$;
  readonly createdBy$ = this.record.createdBy$;
  readonly updatedBy$ = this.record.updatedBy$;

  // ===== 以下 setter 都只是转发给 DocRecord =====
  // 注意两类数据落在不同地方：
  // - createdAt / updatedAt / title / trash / tags → root Y.Doc 的 meta（随工作区同步）
  // - properties（primaryMode、createdBy 等）      → workspace DB（底层也是 Y.Doc）

  setCreatedAt(createdAt: number) {
    this.record.setMeta({ createDate: createdAt });
  }

  setUpdatedAt(updatedAt: number) {
    this.record.setMeta({ updatedDate: updatedAt });
  }

  setCreatedBy(createdBy: string) {
    this.setProperty('createdBy', createdBy);
  }

  setUpdatedBy(updatedBy: string) {
    this.setProperty('updatedBy', updatedBy);
  }

  // 自定义属性统一使用 `custom:<id>` 的键
  // AFFiNE 的文档属性是动态、可扩展的，不是写死在代码里的固定字段。属性分为两类：
  // 内置属性：如 title、createdBy、pageWidth、primaryMode，有固定语义。
  // 自定义属性：用户在工作区里自行创建的属性，比如“优先级”“状态”“截止日期”。
  customProperty$(propertyId: string) {
    return this.record.customProperty$(propertyId);
  }

  setProperty(propertyId: string, value: string) {
    return this.record.setProperty(propertyId, value);
  }

  updateProperties(properties: Partial<DocProperties>) {
    return this.record.updateProperties(properties);
  }

  getProperties() {
    return this.record.getProperties();
  }

  setCustomProperty(propertyId: string, value: string) {
    return this.record.setCustomProperty(propertyId, value);
  }

  // 文档主模式：page（文档视图）/ edgeless（白板视图）
  setPrimaryMode(mode: DocMode) {
    return this.record.setPrimaryMode(mode);
  }

  getPrimaryMode() {
    return this.record.getPrimaryMode();
  }

  togglePrimaryMode() {
    this.setPrimaryMode(
      (this.getPrimaryMode() === 'edgeless' ? 'page' : 'edgeless') as DocMode
    );
  }

  // 生命周期操作最终都走 DocsStore.applyDocLifecycle：
  // 云端工作区由服务端执行并回传 root Y.Doc 更新；本地工作区直接改本地数据
  moveToTrash() {
    return this.record.moveToTrash();
  }

  restoreFromTrash() {
    return this.record.restoreFromTrash();
  }

  deletePermanently() {
    return this.record.deletePermanently();
  }

  // 等待本篇文档完成同步加载（nbstore 的 doc sync），返回 Promise
  waitForSyncReady() {
    return this.store.waitForDocLoadReady(this.id);
  }

  // 临时提高本篇文档的同步优先级，返回释放函数
  addPriorityLoad(priority: number) {
    return this.store.addPriorityLoad(this.id, priority);
  }

  /**
   * 修改标题，同时更新两处数据：
   * 1. BlockSuite 的 `affine:page` 块上的 title（Y.Text，编辑器里可见）
   * 2. workspace 元信息里的 title（列表、搜索使用）
   *
   * 用 transact 包裹 CRDT 修改，保证一次性提交为一个 Yjs 事务。
   * 如果文档里没有 page 块，则什么也不做。
   */
  changeDocTitle(newTitle: string) {
    const pageBlock = this.blockSuiteDoc.getBlocksByFlavour('affine:page').at(0)
      ?.model as RootBlockModel | undefined;
    if (pageBlock) {
      this.blockSuiteDoc.transact(() => {
        pageBlock.props.title.delete(0, pageBlock.props.title.length);
        pageBlock.props.title.insert(newTitle, 0);
      });
      this.record.setMeta({ title: newTitle });
    }
  }
}
