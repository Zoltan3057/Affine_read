import { EditorLoading } from '@affine/component/page-detail-skeleton';
import type {
  EdgelessEditor,
  PageEditor,
} from '@affine/core/blocksuite/editors';
import { ServerService } from '@affine/core/modules/cloud';
import {
  EditorSettingService,
  fontStyleOptions,
} from '@affine/core/modules/editor-setting';
import { FeatureFlagService } from '@affine/core/modules/feature-flag';
import { WorkspaceService } from '@affine/core/modules/workspace';
import track from '@affine/track';
import { appendParagraphCommand } from '@blocksuite/affine/blocks/paragraph';
import type { DocTitle } from '@blocksuite/affine/fragments/doc-title';
import { DisposableGroup } from '@blocksuite/affine/global/disposable';
import { IS_LINUX } from '@blocksuite/affine/global/env';
import type { DocMode, RootBlockModel } from '@blocksuite/affine/model';
import {
  customImageProxyMiddleware,
  ImageProxyService,
} from '@blocksuite/affine/shared/adapters';
import { focusBlockEnd } from '@blocksuite/affine/shared/commands';
import { getLastNoteBlock } from '@blocksuite/affine/shared/utils';
import type { BlockStdScope, EditorHost } from '@blocksuite/affine/std';
import type { Store } from '@blocksuite/affine/store';
import { Slot } from '@radix-ui/react-slot';
import { useLiveData, useService } from '@toeverything/infra';
import { cssVar } from '@toeverything/theme';
import clsx from 'clsx';
import type { CSSProperties, HTMLAttributes } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DefaultOpenProperty } from '../../components/properties';
import { BlocksuiteDocEditor, BlocksuiteEdgelessEditor } from './lit-adaper';
import * as styles from './styles.css';

/**
 * BlockSuite 编辑器自定义元素（<affine-editor-container>）暴露的对外接口。
 * 这里用接口描述它的形状，以便上层（如 doc 模块）以统一方式访问编辑器实例。
 */
export interface AffineEditorContainer extends HTMLElement {
  /** 当前文档的 BlockSuite store */
  page: Store;
  /** 等价于 page，保留旧命名以兼容历史调用方 */
  doc: Store;
  /** 文档标题组件实例 */
  docTitle: DocTitle;
  /** 编辑器宿主，提供 std / view / command 等能力 */
  host?: EditorHost;
  /** 文档根 block 模型 */
  model: RootBlockModel | null;
  /** lit 组件的渲染完成 Promise */
  updateComplete: Promise<boolean>;
  /** 编辑器当前模式：页面模式或白板模式 */
  mode: DocMode;
  /** 编辑器挂载的 DOM 容器 */
  origin: HTMLDivElement;
  /** BlockSuite 标准作用域，命令、视图等入口都在这里 */
  std: BlockStdScope;
}

/**
 * BlockSuiteEditor 对外暴露的 props。
 */
export interface EditorProps extends HTMLAttributes<HTMLDivElement> {
  /** 要渲染的文档 store */
  page: Store;
  /** 页面 / 白板模式 */
  mode: DocMode;
  /** 是否为分享场景（会影响部分交互行为） */
  shared?: boolean;
  /** 只读模式 */
  readonly?: boolean;
  /** 新建文章时默认展开的属性面板 */
  defaultOpenProperty?: DefaultOpenProperty;
  // on Editor ready：编辑器渲染完成后回调，返回的函数会在销毁时被调用（用于清理副作用）
  onEditorReady?: (editor: AffineEditorContainer) => (() => void) | void;
}

/**
 * 编辑器核心实现：根据 mode 渲染页面编辑器或白板编辑器，
 * 并用一个 Proxy 伪装成 AffineEditorContainer，供上层以统一接口访问。
 * 注意：该组件只在文档加载完成后才会挂载（见下方 BlockSuiteEditor）。
 */
const BlockSuiteEditorImpl = ({
  mode,
  page,
  className,
  shared,
  readonly,
  style,
  onEditorReady,
  defaultOpenProperty,
  ...props
}: EditorProps) => {
  // 外层容器引用，同时也是 Proxy 兜底的属性转发目标
  const rootRef = useRef<HTMLDivElement>(null);
  // 两种模式各自持有自己的 lit 编辑器引用，只有当前模式的 ref 有值
  const docRef = useRef<PageEditor>(null);
  const docTitleRef = useRef<DocTitle>(null);
  const edgelessRef = useRef<EdgelessEditor>(null);
  const featureFlags = useService(FeatureFlagService).flags;
  // 是否开启从右到左编辑（RTL）支持
  const enableEditorRTL = useLiveData(featureFlags.enable_editor_rtl.$);
  const editorSetting = useService(EditorSettingService).editorSetting;
  const server = useService(ServerService).server;

  // 是否允许鼠标中键粘贴（Linux 下中键默认用于粘贴选中内容，需要特殊处理）
  const { enableMiddleClickPaste } = useLiveData(
    editorSetting.settings$.selector(s => ({
      enableMiddleClickPaste: s.enableMiddleClickPaste,
    }))
  );

  /**
   * mimic an AffineEditorContainer using proxy
   *
   * 用一个普通对象提供 AffineEditorContainer 的核心属性，再用 Proxy 包装：
   * - `has`：让 `'xxx' in editor` 同时命中 api 和外层容器 DOM 的属性和方法；
   * - `get`：优先读取 api；否则从 rootRef（DOM 元素）上取，函数会自动绑定到该元素，
   *   以兼容旧版自定义元素上暴露的方法（如 focus、scrollTo 等）。
   * 当底层 lit 组件尚未挂载时，相关 getter 会返回 undefined / null。
   */
  const affineEditorContainerProxy = useMemo(() => {
    const api = {
      get page() {
        return page;
      },
      get doc() {
        return page;
      },
      get docTitle() {
        return docTitleRef.current;
      },
      get host() {
        return (
          (mode === 'page'
            ? docRef.current?.host
            : edgelessRef.current?.host) ?? null
        );
      },
      get model() {
        return page.root as any;
      },
      get updateComplete() {
        return mode === 'page'
          ? docRef.current?.updateComplete
          : edgelessRef.current?.updateComplete;
      },
      get mode() {
        return mode;
      },
      get origin() {
        return rootRef.current;
      },
      get std() {
        return mode === 'page' ? docRef.current?.std : edgelessRef.current?.std;
      },
    };

    const proxy = new Proxy(api, {
      has(_, prop) {
        return (
          Reflect.has(api, prop) ||
          (rootRef.current ? Reflect.has(rootRef.current, prop) : false)
        );
      },
      get(_, prop) {
        if (Reflect.has(api, prop)) {
          return api[prop as keyof typeof api];
        }
        if (rootRef.current && Reflect.has(rootRef.current, prop)) {
          const maybeFn = Reflect.get(rootRef.current, prop);
          if (typeof maybeFn === 'function') {
            return maybeFn.bind(rootRef.current);
          } else {
            return maybeFn;
          }
        }
        return undefined;
      },
    }) as AffineEditorContainer;

    return proxy;
  }, [mode, page]);

  /**
   * 页面模式下点击空白区域的处理：
   * - 只读 / 分享 / 文档只读时不响应；
   * - 若最后一个 note 的最后一段是空段落，则把光标聚焦到它末尾，避免产生多余空行；
   * - 否则在文档末尾追加一个新段落。
   */
  const handleClickPageModeBlank = useCallback(() => {
    if (shared || readonly || page.readonly) return;
    const std = affineEditorContainerProxy.host?.std;
    if (!std) {
      return;
    }
    const note = getLastNoteBlock(page);
    if (note) {
      const lastBlock = note.lastChild();
      if (
        lastBlock &&
        lastBlock.flavour === 'affine:paragraph' &&
        lastBlock.text?.length === 0
      ) {
        // 已有空段落，直接聚焦其末尾即可
        const focusBlock = std.view.getBlock(lastBlock.id) ?? undefined;
        std.command.exec(focusBlockEnd, {
          focusBlock,
          force: true,
        });
        return;
      }
    }

    // 没有可复用的空段落时，追加一个新段落
    std.command.exec(appendParagraphCommand);
  }, [affineEditorContainerProxy.host?.std, page, readonly, shared]);

  // 处理 Linux 下的鼠标中键行为：
  // Linux 默认用中键粘贴选中内容，在编辑器里容易误触，因此在未开启「中键粘贴」时拦截；
  // 但点击链接 / 引用块时放行，以保留中键打开链接等原生行为。
  useEffect(() => {
    const editorContainer = rootRef.current;
    if (editorContainer) {
      const handleMiddleClick = (e: MouseEvent) => {
        if (
          e.target instanceof HTMLElement &&
          (e.target.closest('affine-reference') ||
            e.target.closest('affine-link'))
        ) {
          return;
        }
        if (!enableMiddleClickPaste && IS_LINUX && e.button === 1) {
          e.preventDefault();
        }
      };
      editorContainer.addEventListener('pointerup', handleMiddleClick, {
        capture: true,
      });
      editorContainer.addEventListener('auxclick', handleMiddleClick, {
        capture: true,
      });
      return () => {
        editorContainer?.removeEventListener('pointerup', handleMiddleClick, {
          capture: true,
        });
        editorContainer?.removeEventListener('auxclick', handleMiddleClick, {
          capture: true,
        });
      };
    }
    return;
  }, [enableMiddleClickPaste]);

  // 编辑器生命周期副作用：
  // 1. 把当前编辑器实例挂到 globalThis，便于调试 / 兼容旧代码访问；
  // 2. 向 BlockSuite 注册图片代理，用于跨域图片的加载与导出；
  // 3. 等编辑器渲染完成后触发 onEditorReady，并收集其返回的清理函数，卸载时统一释放。
  useEffect(() => {
    const editor = affineEditorContainerProxy;
    globalThis.currentEditor = editor;
    const disposableGroup = new DisposableGroup();
    // 组件可能在此之前就被卸载，用该标记避免触发已失效的回调
    let canceled = false;

    // provide image proxy endpoint to blocksuite
    const imageProxyUrl = new URL(
      BUILD_CONFIG.imageProxyUrl,
      server.baseUrl
    ).toString();

    editor.std.clipboard.use(customImageProxyMiddleware(imageProxyUrl));
    page.get(ImageProxyService).setImageProxyURL(imageProxyUrl);

    editor.updateComplete
      .then(() => {
        if (onEditorReady && !canceled) {
          const dispose = onEditorReady(editor);
          if (dispose) {
            disposableGroup.add(dispose);
          }
        }
      })
      .catch(error => {
        console.error('Error updating editor', error);
      });

    return () => {
      canceled = true;
      disposableGroup.dispose();
    };
  }, [affineEditorContainerProxy, onEditorReady, page, server]);

  return (
    <div
      {...props}
      data-testid={`editor-${page.id}`}
      // 由特性开关决定是否启用 RTL 排版
      dir={enableEditorRTL ? 'rtl' : 'ltr'}
      className={clsx(
        `editor-wrapper ${mode}-mode`,
        styles.docEditorRoot,
        className
      )}
      style={style}
      data-affine-editor-container
      ref={rootRef}
    >
      {/* 页面 / 白板模式二选一渲染，同一时刻只有一个编辑器实例存在 */}
      {mode === 'page' ? (
        <BlocksuiteDocEditor
          shared={shared}
          page={page}
          ref={docRef}
          readonly={readonly}
          titleRef={docTitleRef}
          onClickBlank={handleClickPageModeBlank}
          defaultOpenProperty={defaultOpenProperty}
        />
      ) : (
        <BlocksuiteEdgelessEditor
          shared={shared}
          page={page}
          ref={edgelessRef}
        />
      )}
    </div>
  );
};

/**
 * 编辑器入口组件：负责加载态与字体设置，等文档根 block 就绪后再挂载真正的编辑器实现。
 */
export const BlockSuiteEditor = (props: EditorProps) => {
  // 文档根 block 是否已就绪；未就绪时展示骨架屏
  const [isLoading, setIsLoading] = useState(true);
  // 加载超过一定时间后，骨架屏切换为「加载较久」的提示样式
  const [longerLoading, setLongerLoading] = useState(false);
  // 记录加载开始时间，用于统计文档加载耗时；只在首次渲染时取值
  // oxlint-disable-next-line react-hooks-js/purity
  const [loadStartTime] = useState(Date.now());
  const workspaceService = useService(WorkspaceService);

  const editorSetting = useService(EditorSettingService).editorSetting;
  const settings = useLiveData(
    editorSetting.settings$.selector(s => ({
      fontFamily: s.fontFamily,
      customFontFamily: s.customFontFamily,
      fullWidthLayout: s.fullWidthLayout,
    }))
  );
  // 计算最终生效的字体：自定义字体时拼接「自定义字体, 预设字体」，
  // 找不到预设项则回退到主题的默认无衬线字体。
  const fontFamily = useMemo(() => {
    const fontStyle = fontStyleOptions.find(
      option => option.key === settings.fontFamily
    );
    if (!fontStyle) {
      return cssVar('fontSansFamily');
    }
    const customFontFamily = settings.customFontFamily;

    return customFontFamily && fontStyle.key === 'Custom'
      ? `${customFontFamily}, ${fontStyle.value}`
      : fontStyle.value;
  }, [settings.customFontFamily, settings.fontFamily]);

  // 等待文档根 block 加载完成：已有 root 则直接结束加载；
  // 否则订阅 rootAdded 事件，root 加入后取消订阅并结束加载。
  useEffect(() => {
    if (props.page.root) {
      setIsLoading(false);
      return;
    }

    const disposable = props.page.slots.rootAdded.subscribe(() => {
      disposable.unsubscribe();
      setIsLoading(false);
      setLongerLoading(false);
    });
    return () => {
      disposable.unsubscribe();
    };
  }, [loadStartTime, props.page]);

  // 加载超时兜底：20s 仍未加载完成则提示「加载较久」，60s 仍未完成则上报一次加载失败埋点。
  useEffect(() => {
    const timer = setTimeout(() => {
      if (isLoading) {
        setLongerLoading(true);
      }
    }, 20 * 1000);
    const reportErrorTimer = setTimeout(() => {
      if (isLoading) {
        track.doc.$.$.loadDoc({
          workspaceId: props.page.workspace.id,
          docId: props.page.id,
          time: Date.now() - loadStartTime,
          success: false,
        });
      }
    }, 60 * 1000);
    return () => {
      clearTimeout(timer);
      clearTimeout(reportErrorTimer);
    };
  }, [isLoading, loadStartTime, props.page]);

  // 无论骨架屏是否结束，都等待底层 doc engine 的加载结果，并上报成功 / 失败埋点，
  // 用于衡量文档加载成功率与耗时。
  useEffect(() => {
    workspaceService.workspace.engine.doc
      .waitForDocLoaded(props.page.id)
      .then(() => {
        track.doc.$.$.loadDoc({
          workspaceId: props.page.workspace.id,
          docId: props.page.id,
          time: Date.now() - loadStartTime,
          success: true,
        });
      })
      .catch(() => {
        track.doc.$.$.loadDoc({
          workspaceId: props.page.workspace.id,
          docId: props.page.id,
          time: Date.now() - loadStartTime,
          success: false,
        });
      });
  }, [loadStartTime, props.page, workspaceService]);

  return (
    // 通过 CSS 变量把字体下发给编辑器内部；页面切换时用 key 强制重建组件实例
    <Slot style={{ '--affine-font-family': fontFamily } as CSSProperties}>
      {isLoading ? (
        <EditorLoading longerLoading={longerLoading} />
      ) : (
        <BlockSuiteEditorImpl key={props.page.id} {...props} />
      )}
    </Slot>
  );
};
