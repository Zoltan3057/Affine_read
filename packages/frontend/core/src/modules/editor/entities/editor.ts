/**
 * 编辑器实体（Editor Entity）
 *
 * 一篇已打开的文档对应一个 Editor 实例（在 DocScope 里通过 EditorsService 创建），
 * 它本身不是 BlockSuite 的编辑器，而是包在编辑器外面的一层业务状态，负责粘合：
 * - 编辑模式：mode$（page 文档视图 / edgeless 白板视图）
 * - 定位选择器：selector$（要聚焦的 block / element / 评论）
 * - 路由视图：bindWorkbenchView，让 URL query 与编辑器状态双向同步
 * - 编辑器容器：bindEditorContainer，管理滚动位置、初始焦点、演示模式
 *
 * 生命周期与 Doc 一致：容器卸载时调用 bind 返回的清理函数即可。
 */
import type { AffineEditorContainer } from '@affine/core/blocksuite/block-suite-editor';
import type { DefaultOpenProperty } from '@affine/core/components/properties';
import { PresentTool } from '@blocksuite/affine/blocks/frame';
import { DefaultTool } from '@blocksuite/affine/blocks/surface';
import type { DocTitle } from '@blocksuite/affine/fragments/doc-title';
import { findCommentedTexts } from '@blocksuite/affine/inlines/comment';
import type { DocMode, ReferenceParams } from '@blocksuite/affine/model';
import { HighlightSelection } from '@blocksuite/affine/shared/selection';
import {
  DocModeProvider,
  findCommentedBlocks,
  findCommentedElements,
} from '@blocksuite/affine/shared/services';
import { GfxControllerIdentifier } from '@blocksuite/affine/std/gfx';
import type { InlineEditor } from '@blocksuite/std/inline';
import { effect } from '@preact/signals-core';
import { Entity, LiveData } from '@toeverything/infra';
import { defaults, isEqual, omit } from 'lodash-es';
import { skip } from 'rxjs';

import { CommentPanelService } from '../../comment/services/comment-panel-service';
import { DocCommentManagerService } from '../../comment/services/doc-comment-manager';
import type { DocService } from '../../doc';
import { paramsParseOptions, preprocessParams } from '../../navigation/utils';
import type { WorkbenchView } from '../../workbench';
import type { WorkspaceService } from '../../workspace';
import { EditorScope } from '../scopes/editor';
import type { EditorSelector } from '../types';

export class Editor extends Entity {
  // Editor 自己的 DI 作用域，子组件可以在这里注入 Editor 相关服务
  readonly scope = this.framework.createScope(EditorScope, {
    editor: this as Editor,
  });

  // 当前编辑模式：page（文档）/ edgeless（白板）
  readonly mode$ = new LiveData<DocMode>('page');
  // 当前定位选择器：要跳转/高亮的 block、element 或评论
  readonly selector$ = new LiveData<EditorSelector | undefined>(undefined);
  // 快捷访问当前文档实体
  readonly doc = this.docService.doc;
  // 共享页（公开分享）模式：不绑定 workbench view，也不会同步 URL
  readonly isSharedMode =
    this.workspaceService.workspace.openOptions.isSharedMode;
  // 真正的编辑器 DOM 容器，由 bindEditorContainer 注入
  readonly editorContainer$ = new LiveData<AffineEditorContainer | null>(null);
  // 属性侧边栏默认展开的属性
  readonly defaultOpenProperty$ = new LiveData<DefaultOpenProperty | undefined>(
    undefined
  );
  // 当前绑定的工作区视图（每个标签页/历史记录对应一个 view）
  workbenchView: WorkbenchView | null = null;
  // 缓存的滚动位置：
  // - page 模式：外层滚动容器的 scrollTop
  // - edgeless 模式：画布视口中心与缩放
  scrollPosition: {
    page: number | null;
    edgeless: {
      centerX: number;
      centerY: number;
      zoom: number;
    } | null;
  } = {
    page: null,
    edgeless: null,
  };

  /**
   * 由 selector$ + mode$ 推导出「最终要聚焦的目标」。
   *
   * - page 模式：取第一个 blockId
   * - edgeless 模式：优先取第一个 elementId，没有则退回 blockId
   * - 只有 commentId、没有具体 id 时也保留，交给 handleFocusAt 去反查位置
   * - id 和 commentId 都没有时返回 null
   *
   * 用 computed 是为了让多个订阅者共享同一份推导结果，
   * 后面还会配合 distinctUntilChanged 避免重复聚焦。
   */
  private readonly focusAt$ = LiveData.computed(get => {
    const selector = get(this.selector$);
    const mode = get(this.mode$);
    let id = selector?.blockIds?.[0];
    let commentId = selector?.commentId;
    let key: 'blockIds' | 'elementIds' = 'blockIds';

    if (mode === 'edgeless') {
      const elementId = selector?.elementIds?.[0];
      if (elementId) {
        id = elementId;
        key = 'elementIds';
      }
    }

    if (!id && !commentId) return null;

    return {
      id,
      key,
      mode,
      refreshKey: selector?.refreshKey,
      commentId: commentId,
    };
  });

  // 是否处于演示模式（全屏播放白板）
  isPresenting$ = new LiveData<boolean>(false);

  /**
   * 切换演示模式：切换 gfx 工具为「演示」或「默认选择」。
   * isPresenting$ 本身不在这里改，而是由 bindEditorContainer 里
   * 订阅 gfx.tool.currentToolName$ 自动同步。
   */
  togglePresentation() {
    const gfx = this.editorContainer$.value?.host?.std.get(
      GfxControllerIdentifier
    );
    if (!gfx) return;
    if (!this.isPresenting$.value) {
      gfx.tool.setTool(PresentTool);
    } else {
      gfx.tool.setTool(DefaultTool);
    }
  }

  // 设置定位选择器（通常由路由 query 或文档内链接触发）
  setSelector(selector: EditorSelector | undefined) {
    this.selector$.next(selector);
  }

  // 在 page / edgeless 之间切换
  toggleMode() {
    this.mode$.next(this.mode$.value === 'edgeless' ? 'page' : 'edgeless');
  }

  setMode(mode: DocMode) {
    this.mode$.next(mode);
  }

  setDefaultOpenProperty(defaultOpenProperty: DefaultOpenProperty | undefined) {
    this.defaultOpenProperty$.next(defaultOpenProperty);
  }

  /**
   * sync editor params with view query string
   *
   * this function will be called when editor is initialized with in a workbench view
   *
   * this won't be called in shared page.
   *
   * 把编辑器状态和 URL query 双向绑定：
   * - URL 变化（点击带 blockIds 的链接、前进后退）→ 更新 mode / selector
   * - 编辑器状态变化（切换模式、聚焦某块）→ 写回 URL query
   *
   * 返回解绑函数。
   */
  bindWorkbenchView(view: WorkbenchView) {
    // 一个 Editor 只绑定一个 view
    if (this.workbenchView) {
      throw new Error('already bound');
    }
    this.workbenchView = view;
    // 恢复该 view 上次记录的滚动位置（按 history location 存储）
    const savedScrollPosition = view.getScrollPosition() ?? null;
    if (typeof savedScrollPosition === 'number') {
      this.scrollPosition.page = savedScrollPosition;
    } else if (typeof savedScrollPosition === 'object') {
      this.scrollPosition.edgeless = savedScrollPosition;
    }

    // 文档自身的默认模式（用户上次使用 page 还是 edgeless）
    const stablePrimaryMode = this.doc.getPrimaryMode();

    // URL query → 规范化后的编辑器参数
    const viewParams$ = view
      .queryString$<ReferenceParams & { refreshKey?: string }>(
        paramsParseOptions
      )
      .map(preprocessParams)
      .map(params =>
        defaults(params, {
          mode: stablePrimaryMode || ('page' as DocMode),
        })
      );

    // 编辑器状态 → 参数对象（与 viewParams$ 同构，便于比较）
    const editorParams$ = LiveData.computed(get => {
      return {
        mode: get(this.mode$),
        ...get(this.selector$),
      };
    });

    // prevent infinite loop
    // 两个方向都会修改对方的来源，用 updating 标记避免互相触发形成死循环
    let updating = false;

    const unsubscribeViewParams = viewParams$.subscribe(params => {
      if (updating) return;
      updating = true;
      // when view params changed, sync to editor
      try {
        const editorParams = editorParams$.value;
        if (params.mode !== editorParams.mode) {
          this.setMode(params.mode);
        }

        const selector = omit(params, ['mode']);
        if (!isEqual(selector, omit(editorParams, ['mode']))) {
          this.setSelector(selector);
        }
      } finally {
        updating = false;
      }
    });

    const unsubscribeEditorParams = editorParams$.subscribe(params => {
      if (updating) return;
      updating = true;
      try {
        // when editor params changed, sync to view
        if (!isEqual(params, viewParams$.value)) {
          const newQueryString: Record<string, string> = {};

          // 数组参数（blockIds / elementIds）序列化成逗号分隔
          Object.entries(params).forEach(([k, v]) => {
            newQueryString[k] = Array.isArray(v) ? v.join(',') : v;
          });

          // replace: true，避免每次切换都往浏览器历史里塞一条记录
          view.updateQueryString(newQueryString, { replace: true });
        }
      } finally {
        updating = false;
      }
    });

    return () => {
      this.workbenchView = null;
      unsubscribeEditorParams.unsubscribe();
      unsubscribeViewParams.unsubscribe();
    };
  }

  /**
   * 聚焦并高亮某个目标。
   *
   * 处理两种情况：
   * 1. 已知 blockId / elementId：直接构造 HighlightSelection
   * 2. 只有 commentId：依次查找
   *    行内评论文本 → 块级评论 → 白板元素评论，反推出所在 block/element
   *
   * 注意只有在目标 mode 与当前 mode 一致时才应用选区；
   * 模式不一致时通常由 bindWorkbenchView 先完成模式切换。
   */
  handleFocusAt(focusAt: {
    key: 'blockIds' | 'elementIds';
    mode: DocMode;
    id?: string;
    commentId?: string;
  }) {
    const editorContainer = this.editorContainer$.value;
    if (!editorContainer) return;

    const selection = editorContainer.host?.std.selection;
    const { id, key, mode, commentId } = focusAt;

    let finalId = id;
    let finalKey = key;
    let highlight = true;

    // If we have commentId but no blockId, find the block from the comment
    if (commentId && !id && editorContainer.host?.std) {
      const std = editorContainer.host.std;

      // First try to find inline commented texts
      // 1. 行内评论：定位到文本所在的 block
      const inlineCommentedSelections = findCommentedTexts(
        std.store,
        commentId
      );
      if (inlineCommentedSelections.length > 0) {
        const firstSelection = inlineCommentedSelections[0];
        finalId = firstSelection.from.blockId;
        finalKey = 'blockIds';
      } else {
        // Then try to find block comments
        // 2. 块级评论
        const blockCommentedBlocks = findCommentedBlocks(std.store, commentId);
        if (blockCommentedBlocks.length > 0) {
          finalId = blockCommentedBlocks[0].id;
          finalKey = 'blockIds';
        } else {
          // 3. 白板元素评论
          const commentedElements = findCommentedElements(std.store, commentId);
          if (commentedElements.length > 0) {
            finalId = commentedElements[0].id;
            finalKey = 'elementIds';
          }
        }
      }
      // Workaround: clear selection to avoid comment editor flickering
      selection?.clear();

      // highlight comment
      // 延迟到下一个事件循环：等评论面板和评论实体就绪后再高亮
      setTimeout(() => {
        const commentManager = this.framework.get(DocCommentManagerService);
        const commentPanelService = this.framework.get(CommentPanelService);
        const commentEntity = commentManager.get(this.doc.id);
        commentPanelService.openCommentPanel();
        commentEntity.obj.highlightComment(commentId);
        // 对象池引用，用完必须释放
        commentEntity.release();
      }, 0);

      // do not highlight block
      // 评论本身已经有高亮，避免再高亮整个块造成视觉干扰
      highlight = false;
    }

    // 只处理与当前模式匹配的目标
    if (mode === this.mode$.value && finalId) {
      selection?.setGroup('scene', [
        selection?.create(HighlightSelection, {
          mode,
          [finalKey]: [finalId],
          highlight,
        } as const),
      ]);
    }
  }

  /**
   * 绑定真正的编辑器容器，并接管：
   * - 恢复上次的滚动位置 / 初始焦点
   * - 监听滚动，把位置写回滚动缓存和 workbench view
   * - 订阅 focusAt$，响应定位请求
   * - 同步演示模式状态
   *
   * 返回解绑函数；一个 Editor 只能绑定一个容器。
   */
  bindEditorContainer(
    editorContainer: AffineEditorContainer,
    docTitle?: DocTitle | null,
    scrollViewport?: HTMLElement | null
  ) {
    if (this.editorContainer$.value) {
      throw new Error('already bound');
    }

    this.editorContainer$.next(editorContainer);
    const unsubs: (() => void)[] = [];

    // gfx 控制器用于白板视口和工具状态操作；page 模式下可能不存在
    const gfx = editorContainer.host?.std.get(GfxControllerIdentifier);

    // ----- Scroll Position and Selection -----
    // if we have default scroll position, we should restore it
    if (this.mode$.value === 'page' && this.scrollPosition.page !== null) {
      // 恢复文档模式的滚动位置
      scrollViewport?.scrollTo(0, this.scrollPosition.page);
    } else if (
      this.mode$.value === 'edgeless' &&
      this.scrollPosition.edgeless &&
      gfx
    ) {
      // 恢复白板模式的视口中心和缩放
      gfx.viewport.setViewport(this.scrollPosition.edgeless.zoom, [
        this.scrollPosition.edgeless.centerX,
        this.scrollPosition.edgeless.centerY,
      ]);
    } else {
      // if we don't have default scroll position, we should focus on the title
      // 没有可恢复的位置时，把光标放到标题末尾，方便直接开始输入
      const initialFocusAt = this.focusAt$.value;

      if (initialFocusAt === null) {
        const title = docTitle?.querySelector<
          HTMLElement & { inlineEditor: InlineEditor | null }
        >('rich-text');
        // Only focus on the title when it's empty on mobile edition.
        // 移动端只在标题为空时自动聚焦，避免弹出键盘打扰阅读
        if (BUILD_CONFIG.isMobileEdition) {
          const titleText = this.doc.title$.value;
          if (!titleText?.length) {
            title?.inlineEditor?.focusEnd();
          }
        } else {
          title?.inlineEditor?.focusEnd();
        }
      } else {
        // 有明确的定位目标（如带 blockId 的链接）时，优先处理定位
        this.handleFocusAt(initialFocusAt);
      }
    }

    // update scroll position when scrollViewport scroll
    let edgelessWriteTimer: ReturnType<typeof setTimeout> | null = null;

    // 白板滚动较频繁，写 view 前先合并；离开时再 flush 一次
    const flushEdgelessScrollPosition = () => {
      if (edgelessWriteTimer) {
        clearTimeout(edgelessWriteTimer);
        edgelessWriteTimer = null;
      }

      const pos = this.scrollPosition.edgeless;
      if (!pos) {
        return;
      }

      this.workbenchView?.setScrollPosition(pos);
    };

    const savePageScrollPosition = () => {
      if (!scrollViewport || this.mode$.value !== 'page') {
        return;
      }

      // 同时更新本地缓存和 workbench view（用于前进/后退时恢复）
      this.scrollPosition.page = scrollViewport.scrollTop;
      this.workbenchView?.setScrollPosition(scrollViewport.scrollTop);
    };

    const saveEdgelessScrollPosition = () => {
      if (!gfx || this.mode$.value !== 'edgeless') {
        return;
      }

      // 记录白板视口中心与缩放
      this.scrollPosition.edgeless = {
        centerX: gfx.viewport.centerX,
        centerY: gfx.viewport.centerY,
        zoom: gfx.viewport.zoom,
      };

      // 防抖 160ms，避免视口每次变化都写一次 history
      if (edgelessWriteTimer) {
        clearTimeout(edgelessWriteTimer);
      }
      edgelessWriteTimer = setTimeout(() => {
        flushEdgelessScrollPosition();
      }, 160);
    };

    const handleViewportScroll = () => {
      // 白板模式由 gfx.viewportUpdated 负责，这里只处理 page 模式的外层滚动
      if (this.mode$.value === 'edgeless' && scrollViewport) {
        return;
      }

      savePageScrollPosition();
    };

    scrollViewport?.addEventListener('scroll', handleViewportScroll);
    unsubs.push(() => {
      scrollViewport?.removeEventListener('scroll', handleViewportScroll);
    });
    if (gfx) {
      const subscription = gfx.viewport.viewportUpdated.subscribe(() => {
        saveEdgelessScrollPosition();
      });
      unsubs.push(subscription.unsubscribe.bind(subscription));
    }
    // 解绑前把防抖中的白板位置写出去
    unsubs.push(() => {
      flushEdgelessScrollPosition();
    });

    // update selection when focusAt$ changed
    // skip(1) 跳过订阅时的当前值（初始定位上面已经处理过）；
    // 只在目标 id / 类型 / refreshKey 变化时才重新聚焦
    const subscription = this.focusAt$
      .distinctUntilChanged(
        (a, b) =>
          a?.id === b?.id &&
          a?.key === b?.key &&
          a?.refreshKey === b?.refreshKey
      )
      .pipe(skip(1))
      .subscribe(anchor => {
        if (!anchor) return;
        this.handleFocusAt(anchor);
      });
    unsubs.push(subscription.unsubscribe.bind(subscription));

    // ----- Presenting -----
    // 只有 edgeless 模式且存在 gfx 时才可能进入演示模式；
    // isPresenting$ 直接跟随当前工具是否为 frameNavigator。
    const std = editorContainer.host?.std;
    const editorMode = std?.get(DocModeProvider)?.getEditorMode();
    if (!editorMode || editorMode !== 'edgeless' || !gfx) {
      this.isPresenting$.next(false);
    } else {
      this.isPresenting$.next(
        gfx.tool.currentToolName$.peek() === 'frameNavigator'
      );

      // BlockSuite 使用 signals，这里用 effect 订阅工具名变化
      const disposable = effect(() => {
        this.isPresenting$.next(
          gfx.tool.currentToolName$.value === 'frameNavigator'
        );
      });
      unsubs.push(disposable);
    }

    return () => {
      this.editorContainer$.next(null);
      for (const unsub of unsubs) {
        unsub();
      }
    };
  }

  constructor(
    private readonly docService: DocService,
    private readonly workspaceService: WorkspaceService
  ) {
    super();
  }
}
