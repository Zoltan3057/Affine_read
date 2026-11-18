/**
 * 文档详情页的编辑器组件
 *
 * 职责很薄：把 Editor / Doc / EditorSetting 三个服务里的状态取出来，
 * 算好布局参数，然后交给底层的 BlockSuiteEditor 渲染。
 *
 * 上层关系：
 *   DetailPageWrapper（加载 Doc / Editor、注入作用域）
 *     → DetailPageImpl
 *       → PageDetailEditor（本组件）
 *         → BlockSuiteEditor（真正的 BlockSuite 编辑器，page / edgeless 两种模式）
 */
import './page-detail-editor.css';

import { useLiveData, useService } from '@toeverything/infra';
import clsx from 'clsx';
import { useEffect } from 'react';

import type { AffineEditorContainer } from '../blocksuite/block-suite-editor';
import { BlockSuiteEditor } from '../blocksuite/block-suite-editor';
import { DocService } from '../modules/doc';
import { EditorService } from '../modules/editor';
import { EditorSettingService } from '../modules/editor-setting';
import * as styles from './page-detail-editor.css';

declare global {
  // 调试用全局变量：BlockSuiteEditor 挂载后会写入当前编辑器实例，
  // 方便在控制台或 e2e 测试里访问。
  // oxlint-disable-next-line no-var
  var currentEditor: AffineEditorContainer | undefined;
}

/**
 * 编辑器就绪回调。
 * 可以返回一个清理函数，BlockSuiteEditor 会把它加入 DisposableGroup，
 * 在编辑器卸载或重建时自动调用。
 */
export type OnLoadEditor = (
  editor: AffineEditorContainer
) => (() => void) | void;

export interface PageDetailEditorProps {
  // 编辑器就绪后的回调（订阅事件、绑定命令等）
  onLoad?: OnLoadEditor;
  // 只读模式（例如回收站文档、无编辑权限、历史版本预览）
  readonly?: boolean;
}

// meta 的类型是宽松的 Partial<DocMeta>，这里补上封面图字段
type DocMetaWithHeaderImage = {
  headerImage?: string;
};

export const PageDetailEditor = ({
  onLoad,
  readonly,
}: PageDetailEditorProps) => {
  // 当前文档对应的 Editor 实体（模式和定位选择器都保存在这里）
  // useService(EditorService).editor 拿到的是 AFFiNE 应用层的一个状态管理实体（Entity），而 BlockSuiteEditor 是一个 React UI 组件。前者负责管理编辑器的逻辑状态，后者负责把编辑器界面渲染出来。
  const editor = useService(EditorService).editor;
  // page（文档）/ edgeless（白板），与 URL query 中的 mode 双向同步
  // 组件就订阅了 editor.mode$ 这个流。一旦 mode$ 内部的值发生改变（比如用户切换了编辑模式），useLiveData 会感知到变化，并自动让当前组件重新渲染，从而拿到最新的 mode 值。
  const mode = useLiveData(editor.mode$);
  // 属性侧边栏默认展开哪个属性
  const defaultOpenProperty = useLiveData(editor.defaultOpenProperty$);

  // 当前文档实体
  // DocService：管理文档的元数据与生命周期。它负责打开文档、提供标题、封面图（headerImage）、页面宽度（pageWidth）等属性，以及文档级别的状态管理
  const doc = useService(DocService).doc;
  // 文档元信息；headerImage 是用户设置的封面图
  const docMeta = useLiveData(doc.meta$) as DocMetaWithHeaderImage | null;
  // 文档级页面宽度设置：'fullWidth' / 'standard'，未设置时为 undefined
  const pageWidth = useLiveData(doc.properties$.selector(p => p.pageWidth));

  // 公开分享页：布局和交互与普通工作区不同
  const isSharedMode = editor.isSharedMode;
  const editorSetting = useService(EditorSettingService).editorSetting;
  // 这里实际只用到 fullWidthLayout；字体设置由 BlockSuiteEditor 内部自行订阅
  const settings = useLiveData(
    editorSetting.settings$.selector(s => ({
      fontFamily: s.fontFamily,
      customFontFamily: s.customFontFamily,
      fullWidthLayout: s.fullWidthLayout,
    }))
  );
  // 页面宽度优先级：文档自身属性 > 工作区全局设置
  const fullWidthLayout = pageWidth
    ? pageWidth === 'fullWidth'
    : settings.fullWidthLayout;

  // 把只读状态写到 BlockSuite Store 上，阻止编辑器内部修改文档。
  // 注意 readonly 同时也会作为 prop 传给 BlockSuiteEditor，用于 UI 层面的禁用。
  useEffect(() => {
    editor.doc.blockSuiteDoc.readonly = readonly ?? false;
  }, [editor, readonly]);

  return (
    <>
      {/* 文档封面：直接用 meta 里的 headerImage 渲染，占满宽度并裁切 */}
      {docMeta?.headerImage && (
        <img
          src={docMeta.headerImage}
          alt="Document header"
          style={{
            width: '100%',
            maxHeight: 240,
            objectFit: 'cover',
            borderRadius: 8,
            marginBottom: 12,
          }}
        />
      )}

      <BlockSuiteEditor
        className={clsx(styles.editor, {
          // 全宽布局只在普通工作区生效，分享页使用自己的布局
          'full-screen': !isSharedMode && fullWidthLayout,
          // 分享页的样式钩子
          'is-public': isSharedMode,
        })}
        mode={mode}
        defaultOpenProperty={defaultOpenProperty}
        // 注意这里传的是 BlockSuite 的 Store（块模型），不是 Doc 实体
        page={editor.doc.blockSuiteDoc}
        shared={isSharedMode}
        readonly={readonly}
        onEditorReady={onLoad}
      />
    </>
  );
};
