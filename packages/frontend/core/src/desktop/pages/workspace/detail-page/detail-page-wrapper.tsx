/**
 * 文档详情页的外壳（Detail Page Wrapper）
 *
 * 负责「打开一篇文档」所需的全部准备工作，但不渲染具体页面内容：
 * 1. 等文档列表就绪，并根据 pageId 拿到对应的 DocRecord
 * 2. 从对象池打开 Doc、创建 Editor，并绑定到当前 Workbench View
 * 3. 提高该文档在同步 / 索引引擎中的优先级
 * 4. 根据加载状态和权限状态，决定渲染 skeleton、notFound 还是 children
 * 5. 通过嵌套 FrameworkScope 把 Doc / Editor 的依赖注入作用域提供给子组件
 *
 * pageId 的来源由调用方决定（桌面路由、移动端路由都会复用它）。
 */
import { type Doc, DocsService } from '@affine/core/modules/doc';
import type { Editor } from '@affine/core/modules/editor';
import { EditorsService } from '@affine/core/modules/editor';
import { ViewService } from '@affine/core/modules/workbench/services/view';
import { WorkspaceService } from '@affine/core/modules/workspace';
import { FrameworkScope, useLiveData, useService } from '@toeverything/infra';
import {
  type PropsWithChildren,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';

/**
 * 从 DocsService 的内存列表加载 pageId 对应的 Doc 和 Editor，并返回文档列表的就绪状态。
 *
 * 注意两个「未就绪」的区别：
 * - docListReady 为 false：文档 id 列表还没从本地存储 / 同步引擎加载完，
 *   此时 docRecord 为 undefined 不代表文档不存在
 * - docListReady 为 true 但 docRecord 仍为空：才是真的找不到这篇文档
 */
const useLoadDoc = (pageId: string) => {
  const currentWorkspace = useService(WorkspaceService).workspace;
  const docsService = useService(DocsService);
  const docRecordList = docsService.list;
  // 文档 id 列表是否已经加载完成
  const docListReady = useLiveData(docRecordList.isReady$);
  // 订阅单篇文档的记录（DocRecord），列表变化时会自动更新。
  // 这里只拿到元信息，还没打开真正的 BlockSuite 文档。
  const docRecord = useLiveData(docRecordList.doc$(pageId));
  const viewService = useService(ViewService);

  // 真正打开的 Doc / Editor 实体，等 docRecord 就绪后在 effect 里创建
  const [doc, setDoc] = useState<Doc | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);

  // 用 useLayoutEffect 而不是 useEffect：在浏览器绘制前完成打开和绑定，
  // 避免切换文档时先闪一帧骨架屏或上一篇文档的内容。
  // useLayoutEffect特征： 浏览器绘制之前，同步执行，阻塞浏览器绘制，需要在用户看到画面之前读取/修改布局的副作用
  useLayoutEffect(() => {
    if (!docRecord) {
      return;
    }
    // 从对象池打开文档：如果已打开则复用同一个 Doc，release 用于归还引用计数
    const { doc, release } = docsService.open(pageId);
    setDoc(doc);
    // 在 Doc 的 DI 作用域内创建编辑器，并绑定到当前工作区视图
    // doc.scope: 每个 Doc 对象自带一个依赖注入作用域（scope）。AFFiNE 的 DI 是分层的（FrameworkScope → WorkspaceScope → DocScope → EditorScope…），doc.scope 就是"这一篇文档专属的作用域"，里面注册了与这篇文档相关的服务。
    // 它和 React Hook 版的 useService(EditorsService) 目的一样（拿服务实例），区别是 .get() 可以在非组件代码里用（比如这里的 useLayoutEffect 里），而 useService 只能在组件渲染中用。
    // useService 本质是 React Hook，内部依赖 React 的 hooks 调度机制（dispatcher）。React 规定 Hook 只能在两种地方调用：函数组件的函数体顶层；自定义 Hook 的顶层。
    // .get() 是 DI 容器/作用域对象上的普通同步方法，不依赖 React 的 hooks 机制。它做的事情很直接：
    const editor = doc.scope.get(EditorsService).createEditor();
    // 告诉编辑器"你现在属于这个 View"，让编辑器的状态（模式 page/edgeless、滚动位置、当前激活的块等）与视图关联。
    const unbind = editor.bindWorkbenchView(viewService.view);
    setEditor(editor);
    // 切换文档或组件卸载时清理：解绑视图、销毁编辑器、释放文档引用
    // 注册一个清理函数，在"这次 effect 失效"时执行，用来把这次 effect 里申请的资源全部释放掉。
    // 组件卸载时：这个组件从 DOM 移除，清理函数执行一次。
    // 依赖变化导致 effect 重新执行前：React 先调用上一次的清理函数，再执行新的 effect。
    // React 把返回的这个函数记下来，作为本次 effect 的清理函数。注册动作瞬间完成，清理函数此刻不执行。
    return () => {
      unbind();
      editor.dispose();
      release();
    };
  }, [docRecord, docsService, pageId, viewService.view]);

  // set sync engine priority target
  // 把当前文档加入 doc 同步引擎的高优先级队列；多个来源的优先级会累加，
  // 返回值用于在离开页面时扣减。优先级从 0 变为正数时会触发该文档的连接/同步。
  useEffect(() => {
    return currentWorkspace.engine.doc.addPriority(pageId, 10);
  }, [currentWorkspace, pageId]);

  // 回收站中的文档需要以只读方式打开
  const isInTrash = useLiveData(doc?.meta$.map(meta => meta.trash));

  useEffect(() => {
    if (doc && isInTrash) {
      doc.blockSuiteDoc.readonly = true;
    }
  }, [doc, isInTrash]);

  return {
    doc,
    editor,
    docListReady,
  };
};

/**
 * A common wrapper for detail page for both mobile and desktop page.
 * It only contains the logic for page loading, context setup, but not the page content.
 *
 * 渲染优先级：
 * 1. 文档列表已就绪但找不到该文档 → notFound（文档不存在）
 * 2. 权限还在加载，或 Doc/Editor 还没创建好 → skeleton
 * 3. 明确无权限 → notFound
 * 4. 否则渲染 children，并注入 Doc / Editor 的 DI 作用域
 */
export const DetailPageWrapper = ({
  pageId,
  children,
  skeleton,
  notFound,
  canAccess,
}: PropsWithChildren<{
  pageId: string;
  skeleton: ReactNode;
  notFound: ReactNode;
  // 权限三态：undefined 表示加载中，false 表示无权限
  canAccess?: boolean;
}>) => {
  const { doc, editor, docListReady } = useLoadDoc(pageId);
  // if sync engine has been synced and the page is null, show 404 page.
  // 列表已就绪但记录不存在：文档确实不存在（或已被彻底删除）
  if (docListReady && !doc) {
    return notFound;
  }

  // 权限未确定或 Doc/Editor 未创建完成时，先展示骨架屏
  if (canAccess === undefined || !doc || !editor) {
    return skeleton;
  } else if (!canAccess) {
    // 权限已明确为 false
    return notFound;
  }

  // 嵌套作用域：子组件可以直接 useService(DocService/EditorService) 拿到当前文档与编辑器
  return (
    <FrameworkScope scope={doc.scope}>
      <FrameworkScope scope={editor.scope}>{children}</FrameworkScope>
    </FrameworkScope>
  );
};
