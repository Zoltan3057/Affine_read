/**
 * 文档详情页（Document Detail Page）
 *
 * 工作区里打开某个文档/页面时渲染的主界面，整体结构大致为：
 *   ViewHeader   —— 文档头部（标题、面包屑、工具栏、封面等）
 *   ViewBody
 *     └─ Scrollable        —— 滚动容器（视口 + 滚动条）
 *         └─ PageDetailEditor —— 真正的 BlockSuite 编辑器
 *   若干 ViewSidebarTab（AI 对话 / 属性 / 日志 / 大纲 / 画框 / 导出 / 评论 / 数据分析）
 *
 * 本组件还负责：
 * - 同步编辑器模式（page / edgeless）与侧边栏状态
 * - 把当前文档信息写入 GlobalContext，供快捷键、命令面板、AI 等模块读取
 * - 编辑器加载后的绑定与事件订阅（文档内链接跳转、日志页自动聚焦等）
 * - 权限校验与回收站状态下的只读控制
 */

// ===== 通用组件：滚动容器、加载骨架、错误边界等 =====
import { Scrollable } from '@affine/component';
import { PageDetailLoading } from '@affine/component/page-detail-skeleton';

// ===== 业务组件：编辑器、侧边栏、头部、历史记录、AI 面板等 =====
import { AIAppEvents, type AIChatParams } from '@affine/core/blocksuite/ai';
import type { AffineEditorContainer } from '@affine/core/blocksuite/block-suite-editor';
import { EditorOutlineViewer } from '@affine/core/blocksuite/outline-viewer';
import { AffineErrorBoundary } from '@affine/core/components/affine/affine-error-boundary';
// import { PageAIOnboarding } from '@affine/core/components/affine/ai-onboarding';
import { GlobalPageHistoryModal } from '@affine/core/components/affine/page-history-modal';
import { CommentSidebar } from '@affine/core/components/comment/sidebar';
import { useGuard } from '@affine/core/components/guard';
import { useAppSettingHelper } from '@affine/core/components/hooks/affine/use-app-setting-helper';
import { useEnableAI } from '@affine/core/components/hooks/affine/use-enable-ai';
import { useRegisterBlocksuiteEditorCommands } from '@affine/core/components/hooks/affine/use-register-blocksuite-editor-commands';
import { useActiveBlocksuiteEditor } from '@affine/core/components/hooks/use-block-suite-editor';
import { PageDetailEditor } from '@affine/core/components/page-detail-editor';
import { WorkspacePropertySidebar } from '@affine/core/components/properties/sidebar';
import { TrashPageFooter } from '@affine/core/components/pure/trash-page-footer';
import { TopTip } from '@affine/core/components/top-tip';

// ===== 服务：通过依赖注入（@toeverything/infra）获取的各类 Service =====
import { ServerService } from '@affine/core/modules/cloud';
import { DocService } from '@affine/core/modules/doc';
import { EditorService } from '@affine/core/modules/editor';
import { FeatureFlagService } from '@affine/core/modules/feature-flag';
import { GlobalContextService } from '@affine/core/modules/global-context';
import { JournalService } from '@affine/core/modules/journal';
import { PeekViewService } from '@affine/core/modules/peek-view';
import { RecentDocsService } from '@affine/core/modules/quicksearch';
import {
  useIsActiveView,
  ViewBody,
  ViewHeader,
  ViewService,
  ViewSidebarTab,
  WorkbenchService,
} from '@affine/core/modules/workbench';
import { WorkspaceService } from '@affine/core/modules/workspace';

// ===== 工具函数、埋点、BlockSuite 底层能力 =====
import { isNewTabTrigger } from '@affine/core/utils';
import { ServerFeature } from '@affine/graphql';
import track from '@affine/track';
import { DisposableGroup } from '@blocksuite/affine/global/disposable';
import { RefNodeSlotsProvider } from '@blocksuite/affine/inlines/reference';
import { focusBlockEnd } from '@blocksuite/affine/shared/commands';
import { getLastNoteBlock } from '@blocksuite/affine/shared/utils';
import {
  AiIcon,
  ChartPanelIcon,
  CommentIcon,
  ExportIcon,
  FrameIcon,
  PropertyIcon,
  TocIcon,
  TodayIcon,
} from '@blocksuite/icons/rc';
import {
  FrameworkScope,
  useLiveData,
  useService,
  useServices,
} from '@toeverything/infra';

// ===== 第三方库与 React API =====
import clsx from 'clsx';
import { nanoid } from 'nanoid';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Subscription } from 'rxjs';

// ===== 页面内部模块：404、样式、头部、外层包装、各个侧边栏 Tab =====
import { PageNotFound } from '../../404';
import * as styles from './detail-page.css';
import { DetailPageHeader } from './detail-page-header';
import { DetailPageWrapper } from './detail-page-wrapper';
import { EditorAdapterPanel } from './tabs/adapter';
import { EditorAnalyticsPanel } from './tabs/analytics';
import { EditorChatPanel } from './tabs/chat';
import { EditorFramePanel } from './tabs/frame';
import { EditorJournalPanel } from './tabs/journal';
import { EditorOutlinePanel } from './tabs/outline';

// memo 不是"避免渲染"，而是"避免因父组件重渲染而连带重渲染"，它做的是浅比较 props。
const DetailPageImpl = memo(function DetailPageImpl() {
  const {
    // 工作台服务：管理多 tab、侧边栏开关、打开/切换文档等
    // 本页用到：workbench.sidebarOpen$（侧边栏是否展开）、workbench.openDoc()、workbench.openSidebar()
    workbenchService,
    // 视图服务：管理当前视图的侧边栏 tab、视图状态
    // 本页用到：view.activeSidebarTab$（当前激活的 tab）、view.activeSidebarTab('chat'/'outline' 等)
    viewService,
    // 编辑器服务：管理编辑器实例、模式、与编辑器容器的绑定
    // 本页用到：editor.mode$（page/edgeless）、editor.editorContainer$（编辑器容器实例）、editor.bindEditorContainer()
    editorService,
    // 文档服务：当前文档的元信息与 BlockSuite 文档对象
    // 本页用到：doc.id、doc.meta$（含 trash 回收站状态）、doc.blockSuiteDoc（传给头部和 AI 面板）
    docService,
    // 工作区服务：当前工作区实例
    // 本页用到：workspace.flavour（local / affine-cloud 等）、workspace.id
    workspaceService,
    // 全局上下文服务：跨模块共享的全局状态（当前 docId、是否文档、编辑器模式、是否回收站文档等）
    // .docId / isDoc / docMode / isTrashDoc 的写入，供快捷键、命令面板、AI 等模块读取
    globalContextService,
  } = useServices({
    WorkbenchService,
    ViewService,
    EditorService,
    DocService,
    WorkspaceService,
    GlobalContextService,
  });
  // 从 Service 上取出真正要用的实例，简化后续代码
  const workbench = workbenchService.workbench;
  const editor = editorService.editor;
  const view = viewService.view;
  const workspace = workspaceService.workspace;
  const globalContext = globalContextService.globalContext;
  const doc = docService.doc;

  // mode：编辑器模式（page / edgeless）。edgeless 指的是无限画布（白板）模式
  const mode = useLiveData(editor.mode$);
  // 当前侧边栏 tab。
  const activeSidebarTab = useLiveData(view.activeSidebarTab$);

  // 当前文档是否已被移入回收站；回收站中的文档强制只读
  const isInTrash = useLiveData(doc.meta$.map(meta => meta.trash));
  // 当前编辑器容器实例（由编辑器内部创建，页面通过它访问 host/std 等能力）
  const editorContainer = useLiveData(editor.editorContainer$);

  // 侧边栏是否展开。
  const isSideBarOpen = useLiveData(workbench.sidebarOpen$);
  // 应用设置（本页用到 clientBorder，用于决定滚动条的样式）
  const { appSettings } = useAppSettingHelper();

  // 预览（Peek）视图服务：在不离开当前页面的情况下以浮层方式打开文档
  const peekView = useService(PeekViewService).peekView;

  // 当前视图是否处于激活状态（工作台可能有多个 tab，只有激活的 tab 才写入全局上下文）
  const isActiveView = useIsActiveView();
  // TODO(@eyhn): remove jotai here
  // 把当前编辑器注册到全局 active editor，供命令、快捷键等模块使用（这里只用到 setter）
  const [_, setActiveBlockSuiteEditor] = useActiveBlocksuiteEditor();

  // 当前环境是否启用 AI 能力
  const enableAI = useEnableAI();

  // 功能开关：决定是否显示「导出」与「数据分析」侧边栏
  const featureFlagService = useService(FeatureFlagService);
  const enableAdapterPanel = useLiveData(
    featureFlagService.flags.enable_adapter_panel.$
  );
  const enableViewAnalyticsPanel = useLiveData(
    featureFlagService.flags.enable_view_analytics_panel.$
  );

  // 服务端配置，用于判断后端是否支持评论等能力
  const serverService = useService(ServerService);
  const serverConfig = useLiveData(serverService.server.config$);

  // comment may not be supported by the server
  // 评论功能：本地工作区没有服务端，因此不启用；同时还要求服务端声明支持 Comment
  const enableComment =
    workspace.flavour !== 'local' &&
    serverConfig.features.includes(ServerFeature.Comment);

  // 当前视图激活时，把编辑器容器同步到全局 active editor
  useEffect(() => {
    if (isActiveView) {
      setActiveBlockSuiteEditor(editorContainer);
    }
  }, [editorContainer, isActiveView, setActiveBlockSuiteEditor]);

  // 监听 AI 侧发起的「打开对话」/「带着问题发起对话」请求：
  // 收到后展开侧边栏并切换到 chat tab（具体内容由 EditorChatPanel 处理）
  useEffect(() => {
    const disposables: Subscription[] = [];
    const openHandler = (params: AIChatParams | null) => {
      if (!params) {
        return;
      }
      workbench.openSidebar();
      view.activeSidebarTab('chat');
    };
    disposables.push(AIAppEvents.requestOpenWithChat.subscribe(openHandler));
    disposables.push(AIAppEvents.requestSendWithChat.subscribe(openHandler));
    return () => disposables.forEach(d => d.unsubscribe());
  }, [activeSidebarTab, view, workbench]);

  // 当前视图激活时写入 docId / isDoc，离开或切换视图时清空。
  // 这样快捷键、命令面板等模块总能拿到「当前正在看的文档」。
  useEffect(() => {
    if (isActiveView) {
      globalContext.docId.set(doc.id);
      globalContext.isDoc.set(true);

      return () => {
        globalContext.docId.set(null);
        globalContext.isDoc.set(false);
      };
    }
    return;
  }, [doc, globalContext, isActiveView]);

  // 同步当前编辑器模式（page / edgeless）到全局上下文
  useEffect(() => {
    if (isActiveView) {
      globalContext.docMode.set(mode);

      return () => {
        globalContext.docMode.set(null);
      };
    }
    return;
  }, [doc, globalContext, isActiveView, mode]);

  // 同步「当前文档是否在回收站」到全局上下文
  useEffect(() => {
    if (isActiveView) {
      globalContext.isTrashDoc.set(!!isInTrash);

      return () => {
        globalContext.isTrashDoc.set(null);
      };
    }
    return;
  }, [globalContext, isActiveView, isInTrash]);

  // 注册 BlockSuite 编辑器相关命令（如快捷键触发的命令），仅在当前视图激活时生效
  useRegisterBlocksuiteEditorCommands(editor, isActiveView);

  // 判断当前文档是否是「日志（Journal）」页面：日志页加载后需要自动聚焦到正文输入区
  const journalService = useService(JournalService);
  const isJournal = !!useLiveData(journalService.journalDate$(doc.id));

  /**
   * 编辑器加载完成后的回调（传给 PageDetailEditor 的 onLoad）。
   *
   * 做两件事：
   * 1. 订阅编辑器内部的「文档链接点击」事件，决定是当前视图打开、新标签页打开，
   *    还是以 Peek 浮层方式打开；
   * 2. 把编辑器容器绑定到 EditorService，并返回清理函数，在卸载/切换文档时解除绑定。
   */
  const onLoad = useCallback(
    (editorContainer: AffineEditorContainer) => {
      const std = editorContainer.std;
      const disposable = new DisposableGroup();

      // Check if journal and handle accordingly to set focus on input block.
      // 日志页：等下一帧（确保编辑器已挂载）后，把光标放到最后一个 note 块的末尾
      if (isJournal) {
        const rafId = requestAnimationFrame(() => {
          try {
            if (!editorContainer.isConnected) return;
            const page = editorContainer.page;
            const note = getLastNoteBlock(page);
            const std = editorContainer.std;
            if (note) {
              const lastBlock = note.lastChild();
              if (lastBlock) {
                const focusBlock = std.view.getBlock(lastBlock.id) ?? undefined;
                std.command.exec(focusBlockEnd, { focusBlock, force: true });
                return;
              }
            }
            std.command.exec(focusBlockEnd, { force: true });
          } catch (error) {
            console.error('Failed to focus journal body', error);
          }
        });
        disposable.add(() => cancelAnimationFrame(rafId));
      }
      if (std) {
        // 订阅文档内引用链接（AffineReference 等）的点击事件
        const refNodeSlots = std.getOptional(RefNodeSlotsProvider);
        if (refNodeSlots) {
          disposable.add(
            // the event should not be emitted by AffineReference
            refNodeSlots.docLinkClicked.subscribe(
              ({ pageId, params, openMode, event, host }) => {
                // 只处理由当前编辑器实例发出的点击，避免重复响应
                if (host !== editorContainer.host) {
                  return;
                }
                // 未显式指定打开方式时：按住 Cmd/Ctrl 等新标签页触发键则新标签页打开，否则在当前视图打开
                openMode ??=
                  event && isNewTabTrigger(event)
                    ? 'open-in-new-tab'
                    : 'open-in-active-view';

                // 埋点：记录用户使用哪种方式打开链接
                if (openMode === 'open-in-new-view') {
                  track.doc.editor.toolbar.openInSplitView();
                } else if (openMode === 'open-in-center-peek') {
                  track.doc.editor.toolbar.openInPeekView();
                } else if (openMode === 'open-in-new-tab') {
                  track.doc.editor.toolbar.openInNewTab();
                }

                if (openMode !== 'open-in-center-peek') {
                  // 计算新文档在工作台中的打开位置：
                  // active = 替换当前 tab；tail = 追加到末尾（分屏，仅 Electron 支持）；new-tab = 新标签页
                  const at = (() => {
                    if (openMode === 'open-in-active-view') {
                      return 'active';
                    }
                    // split view is only supported on electron
                    if (openMode === 'open-in-new-view') {
                      return BUILD_CONFIG.isElectron ? 'tail' : 'new-tab';
                    }
                    if (openMode === 'open-in-new-tab') {
                      return 'new-tab';
                    }
                    return 'active';
                  })();
                  workbench.openDoc(
                    {
                      docId: pageId,
                      // 透传引用位置信息，打开后可直接定位到对应块/画布元素
                      mode: params?.mode,
                      blockIds: params?.blockIds,
                      elementIds: params?.elementIds,
                      // refreshKey 强制产生一次新的打开请求，避免相同参数被去重
                      refreshKey: nanoid(),
                    },
                    {
                      at: at,
                      show: true,
                    }
                  );
                } else {
                  // Peek 模式：在当前页面上以浮层预览目标文档，不离开当前文档
                  peekView
                    .open({
                      docRef: {
                        docId: pageId,
                      },
                      ...params,
                    })
                    .catch(console.error);
                }
              }
            )
          );
        }
      }

      // 把编辑器容器绑定到 EditorService（第二个参数是编辑器标题元素，第三个是滚动视口）
      const unbind = editor.bindEditorContainer(
        editorContainer,
        (editorContainer as any).docTitle, // set from proxy
        scrollViewportRef.current
      );

      // 返回清理函数：组件卸载或文档切换时解除绑定并释放所有订阅
      return () => {
        unbind();
        disposable.dispose();
      };
    },
    [editor, workbench, peekView, isJournal]
  );

  // 编辑器视口是否已经向下滚动（用于给顶栏加阴影/边框等视觉反馈）
  const [hasScrollTop, setHasScrollTop] = useState(false);

  // 打开侧边栏并切换到「大纲」tab
  const openOutlinePanel = useCallback(() => {
    workbench.openSidebar();
    view.activeSidebarTab('outline');
  }, [workbench, view]);

  // 滚动视口 DOM 引用：既用于滚动事件，也交给编辑器做滚动定位/绑定
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);

  // 监听编辑器视口滚动，记录是否已经滚离顶部
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const scrollTop = e.currentTarget.scrollTop;

    const hasScrollTop = scrollTop > 0;
    setHasScrollTop(hasScrollTop);
  }, []);

  // 头部是否处于拖拽状态（拖动文档图标等），用于让编辑器内容暂时不响应 hover/选区
  const [dragging, setDragging] = useState(false);

  // 权限校验：当前用户是否有权更新该文档
  const canEdit = useGuard('Doc_Update', doc.id);

  // 只读条件：没有编辑权限，或文档已在回收站中
  const readonly = !canEdit || isInTrash;

  return (
    // 为整棵编辑器组件树提供依赖注入作用域
    <FrameworkScope scope={editor.scope}>
      {/* 文档头部：标题、图标、封面、工具栏等 */}
      <ViewHeader>
        <DetailPageHeader
          page={doc.blockSuiteDoc}
          workspace={workspace}
          onDragging={setDragging}
        />
      </ViewHeader>
      <ViewBody>
        <div
          className={styles.mainContainer}
          // Electron 下需要动态的顶部边框；滚动后顶栏样式也会变化
          data-dynamic-top-border={BUILD_CONFIG.isElectron}
          data-has-scroll-top={hasScrollTop}
        >
          {/* Add a key to force rerender when page changed, to avoid error boundary persisting. */}
          {/* 用 doc.id 作为 key：切换文档时强制重建错误边界，避免上一个文档的错误状态残留 */}
          <AffineErrorBoundary key={doc.id}>
            {/* 页面顶部提示（如只读、无权限、离线等） */}
            <TopTip pageId={doc.id} workspace={workspace} />
            <Scrollable.Root>
              {/* 编辑器滚动视口：PageDetailEditor 渲染在这里，滚动位置也由它承载 */}
              <Scrollable.Viewport
                onScroll={handleScroll}
                ref={scrollViewportRef}
                data-dragging={dragging}
                className={clsx(
                  'affine-page-viewport',
                  styles.affineDocViewport,
                  styles.editorContainer,
                  { [styles.pageModeViewportContentBox]: mode === 'page' }
                )}
              >
                <PageDetailEditor onLoad={onLoad} readonly={readonly} />
              </Scrollable.Viewport>
              <Scrollable.Scrollbar
                className={clsx({
                  [styles.scrollbar]: !appSettings.clientBorder,
                })}
              />
            </Scrollable.Root>
            {/* 页面模式下、且侧边栏收起时，在右侧显示悬浮的大纲导航 */}
            <EditorOutlineViewer
              editor={editorContainer?.host ?? null}
              show={mode === 'page' && !isSideBarOpen}
              openOutlinePanel={openOutlinePanel}
            />
          </AffineErrorBoundary>
          {/* 文档在回收站中时，页面底部显示恢复/彻底删除操作栏 */}
          {isInTrash ? <TrashPageFooter /> : null}
        </div>
      </ViewBody>

      {/* ===== 侧边栏 Tab ===== */}
      {/* AI 对话面板：仅启用 AI 时显示；unmountOnInactive=false 让切走后仍保留对话状态 */}
      {enableAI && (
        <ViewSidebarTab
          tabId="chat"
          icon={<AiIcon />}
          unmountOnInactive={false}
        >
          <EditorChatPanel editor={editorContainer} doc={doc.blockSuiteDoc} />
        </ViewSidebarTab>
      )}

      {/* 文档属性面板 */}
      <ViewSidebarTab tabId="properties" icon={<PropertyIcon />}>
        <Scrollable.Root className={styles.sidebarScrollArea}>
          <Scrollable.Viewport>
            <WorkspacePropertySidebar />
          </Scrollable.Viewport>
          <Scrollable.Scrollbar />
        </Scrollable.Root>
      </ViewSidebarTab>

      {/* 日志面板：列出当前文档所属日期前后的日志 */}
      <ViewSidebarTab tabId="journal" icon={<TodayIcon />}>
        <Scrollable.Root className={styles.sidebarScrollArea}>
          <Scrollable.Viewport>
            <EditorJournalPanel />
          </Scrollable.Viewport>
          <Scrollable.Scrollbar />
        </Scrollable.Root>
      </ViewSidebarTab>

      {/* 大纲面板：按标题层级展示当前文档结构 */}
      <ViewSidebarTab tabId="outline" icon={<TocIcon />}>
        <Scrollable.Root className={styles.sidebarScrollArea}>
          <Scrollable.Viewport>
            <EditorOutlinePanel editor={editorContainer?.host ?? null} />
          </Scrollable.Viewport>
          <Scrollable.Scrollbar />
        </Scrollable.Root>
      </ViewSidebarTab>

      {/* 画框（Frame）面板：白板模式下的画框列表 */}
      <ViewSidebarTab tabId="frame" icon={<FrameIcon />}>
        <Scrollable.Root className={styles.sidebarScrollArea}>
          <Scrollable.Viewport>
            <EditorFramePanel editor={editorContainer?.host ?? null} />
          </Scrollable.Viewport>
          <Scrollable.Scrollbar />
        </Scrollable.Root>
      </ViewSidebarTab>

      {/* 导出面板：受功能开关控制 */}
      {enableAdapterPanel && (
        <ViewSidebarTab tabId="adapter" icon={<ExportIcon />}>
          <Scrollable.Root className={styles.sidebarScrollArea}>
            <Scrollable.Viewport>
              <EditorAdapterPanel host={editorContainer?.host ?? null} />
            </Scrollable.Viewport>
          </Scrollable.Root>
        </ViewSidebarTab>
      )}

      {/* 评论面板：本地工作区或服务端不支持评论时不显示 */}
      {workspace.flavour !== 'local' && enableComment && (
        <ViewSidebarTab tabId="comment" icon={<CommentIcon />}>
          <Scrollable.Root className={styles.sidebarScrollArea}>
            <Scrollable.Viewport>
              <CommentSidebar />
            </Scrollable.Viewport>
            <Scrollable.Scrollbar />
          </Scrollable.Root>
        </ViewSidebarTab>
      )}

      {/* 数据分析面板：仅云端工作区且开启功能开关时显示 */}
      {workspace.flavour === 'affine-cloud' && enableViewAnalyticsPanel && (
        <ViewSidebarTab tabId="analytics" icon={<ChartPanelIcon />}>
          <Scrollable.Root className={styles.sidebarScrollArea}>
            <Scrollable.Viewport>
              <EditorAnalyticsPanel workspaceId={workspace.id} docId={doc.id} />
            </Scrollable.Viewport>
            <Scrollable.Scrollbar />
          </Scrollable.Root>
        </ViewSidebarTab>
      )}

      {/* 页面历史记录弹窗（全局单例，由服务触发打开） */}
      <GlobalPageHistoryModal />
      {/* FIXME: wait for better ai, <PageAIOnboarding /> */}
    </FrameworkScope>
  );
});

/**
 * 路由层组件：读取 URL 中的 pageId，做权限校验并包一层 DetailPageWrapper。
 * - DetailPageWrapper 负责文档加载、错误兜底、加载骨架屏
 * - 这里只在 pageId 存在时渲染，否则返回 null
 * React Router 识别的固定导出名。
 */
export const Component = () => {
  const params = useParams();
  // 通过依赖注入拿到"最近文档"服务，用来更新最近访问列表。
  const recentPages = useService(RecentDocsService);

  // 记录最近访问的文档：写入 localStorage（供下次启动恢复），并更新「最近文档」列表
  useEffect(() => {
    if (params.pageId) {
      const pageId = params.pageId;
      localStorage.setItem('last_page_id', pageId);

      recentPages.addRecentDoc(pageId);
    }
  }, [params, recentPages]);

  const pageId = params.pageId;
  // 读取权限校验：无权限时展示 404/无权限页而不是文档内容
  // 检查当前用户有没有权限读取这个文档
  const canAccess = useGuard('Doc_Read', pageId ?? '');

  return pageId ? (
    <DetailPageWrapper
      pageId={pageId}
      canAccess={canAccess}
      skeleton={<PageDetailLoading />}
      notFound={<PageNotFound noPermission />}
    >
      <DetailPageImpl />
    </DetailPageWrapper>
  ) : null;
};


// React Router 约定的导出名称：detail-page.tsx 模块的导出
// export const Component = () => { ... }   // 路由要渲染的组件
// export const ErrorBoundary = () => { ... } // 出错时渲染的组件
// export async function loader() { ... }     // 加载数据
// export async function action() { ... }     // 处理表单提交
