/**
 * 前端通用模块的统一注册入口
 *
 * 每个 `configureXxxModule(framework)` 只做一件事：向 DI 容器登记「工厂」，
 * 包括 service / store / entity / scope / impl。实例是懒加载的，因此这里的
 * 调用顺序通常不影响行为（只有重复注册或 override 时才有先后之分），
 * 下面的分组注释主要用于理解模块边界。
 *
 * 这里注册的是平台无关的通用模块。以下与运行形态相关的模块由各 app 入口单独配置：
 * - workbench：configureBrowserWorkbenchModule / configureDesktopWorkbenchModule
 * - workspace-engine：configureBrowserWorkspaceFlavours
 * - desktop-api / app-tabs-header / find-in-page：electron-renderer 入口
 *
 * 调用方：web / electron-renderer / mobile / ios / android 的 app.tsx，
 * 在 `new Framework()` 之后调用。
 */

  // modules/<name>/
  // ├─ index.ts        configureXxxModule(framework) —— DI 注册入口
  // ├─ services/       extends Service，业务编排/门面，用 framework.service() 注册，Scope 内单例
  // ├─ stores/         extends Store，数据访问层（Yjs、本地 DB、GraphQL），有 __injectable
  // ├─ entities/       extends Entity,有生命周期和状态的对象，createEntity() 每次新建
  // ├─ scopes/         extends Scope, 5 │ WorkspaceScope / DocScope / EditorScope / ViewScope / ServerScope │
  // ├─ providers/      接口/令牌定义（createIdentifier）
  // ├─ impls/          接口的具体实现（多态、平台差异）. 接口实现，用 framework.impl() 注册，可同接口多实现
  // ├─ events/         createEvent 定义
  // ├─ view/ components/  React 组件（不注册进 DI）
  // └─ types.ts utils.ts

import { configureQuotaModule } from '@affine/core/modules/quota';
import { type Framework } from '@toeverything/infra';

import {
  configureAIButtonModule,
  configureAIDraftModule,
  configureAIModelModule,
  configureAIPlaygroundModule,
  configureAIReasoningModule,
  configureAIToolsConfigModule,
} from './ai-button';
import { configureAppSidebarModule } from './app-sidebar';
import { configAtMenuConfigModule } from './at-menu-config';
import { configureBlobManagementModule } from './blob-management';
import { configureCloudModule } from './cloud';
import { configureCodeBlockPreviewRendererModule } from './code-block-preview-renderer';
import { configureCollectionModule } from './collection';
import { configureCollectionRulesModule } from './collection-rules';
import { configureCommentModule } from './comment';
import { configureWorkspaceDBModule } from './db';
import { configureDialogModule } from './dialogs';
import { configureDndModule } from './dnd';
import { configureDocModule } from './doc';
import { configureDocDisplayMetaModule } from './doc-display-meta';
import { configureDocInfoModule } from './doc-info';
import { configureDocLinksModule } from './doc-link';
import { configureDocSummaryModule } from './doc-summary';
import { configureDocsSearchModule } from './docs-search';
import { configureEditorModule } from './editor';
import { configureEditorSettingModule } from './editor-setting';
import { configureExplorerIconModule } from './explorer-icon';
import { configureFavoriteModule } from './favorite';
import { configureFeatureFlagModule } from './feature-flag';
import { configureGlobalContextModule } from './global-context';
import { configureI18nModule } from './i18n';
import { configureIconPickerModule } from './icon-picker';
import { configureImportModule } from './import';
import { configureImportClipperModule } from './import-clipper';
import { configureImportTemplateModule } from './import-template';
import { configureIntegrationModule } from './integration';
import { configureJournalModule } from './journal';
import { configureLifecycleModule } from './lifecycle';
import { configureMediaModule } from './media';
import { configureNavigationModule } from './navigation';
import { configureNavigationPanelModule } from './navigation-panel';
import { configureNotificationModule } from './notification';
import { configureOpenInApp } from './open-in-app';
import { configureOrganizeModule } from './organize';
import { configurePaywallModule } from './paywall';
import { configurePDFModule } from './pdf';
import { configurePeekViewModule } from './peek-view';
import { configurePermissionsModule } from './permissions';
import { configureQuickSearchModule } from './quicksearch';
import { configSearchMenuModule } from './search-menu';
import { configureShareDocsModule } from './share-doc';
import { configureShareSettingModule } from './share-setting';
import {
  configureCommonGlobalStorageImpls,
  configureStorageModule,
} from './storage';
import { configureSystemFontFamilyModule } from './system-font-family';
import { configureTagModule } from './tag';
import { configureTelemetryModule } from './telemetry';
import { configureTemplateDocModule } from './template-doc';
import { configureAppThemeModule } from './theme';
import { configureThemeEditorModule } from './theme-editor';
import { configureUrlModule } from './url';
import { configureUserspaceModule } from './userspace';
import { configureWorkspaceModule } from './workspace';
import { configureIndexerEmbeddingModule } from './workspace-indexer-embedding';
import { configureWorkspacePropertyModule } from './workspace-property';

export function configureCommonModules(framework: Framework) {
  // ===== 基础设施与核心数据 =====
  // i18n、工作区、文档、工作区数据库、本地存储、全局上下文、生命周期、功能开关
  configureI18nModule(framework);
  configureWorkspaceModule(framework);
  configureDocModule(framework);
  configureWorkspaceDBModule(framework);
  configureStorageModule(framework);
  configureGlobalContextModule(framework);
  configureLifecycleModule(framework);
  configureFeatureFlagModule(framework);

  // ===== 内容、协作与权限 =====
  // 代码块预览、集合、导航、标签、云端服务（认证/订阅/配额）、权限、分享
  configureCodeBlockPreviewRendererModule(framework);
  configureCollectionModule(framework);
  configureNavigationModule(framework);
  configureTagModule(framework);
  configureCloudModule(framework);
  configureQuotaModule(framework);
  configurePermissionsModule(framework);
  configureShareDocsModule(framework);
  configureShareSettingModule(framework);
  configureTelemetryModule(framework);
  configurePDFModule(framework);

  // ===== 浏览与检索 =====
  // 预览视图、侧边栏图标、文档展示元信息、快速搜索、文档搜索、
  // 文档链接/反向链接、整理（文件夹）、收藏、导航面板
  configurePeekViewModule(framework);
  configureExplorerIconModule(framework);
  configureDocDisplayMetaModule(framework);
  configureQuickSearchModule(framework);
  configureDocsSearchModule(framework);
  configureDocLinksModule(framework);
  configureOrganizeModule(framework);
  configureFavoriteModule(framework);
  configureNavigationPanelModule(framework);

  // ===== 编辑器与外观基础 =====
  // 主题编辑器、编辑器（DocScope / EditorScope）、系统字体、编辑器偏好设置
  configureThemeEditorModule(framework);
  configureEditorModule(framework);
  configureSystemFontFamilyModule(framework);
  configureEditorSettingModule(framework);

  // ===== 导入、用户与界面外壳 =====
  // 模板导入、通用导入、用户空间、侧边栏、日记、URL 服务、应用主题、
  // 全局对话框、文档信息、外部打开、右键菜单、搜索菜单、拖拽
  configureImportTemplateModule(framework);
  configureImportModule(framework);
  configureUserspaceModule(framework);
  configureAppSidebarModule(framework);
  configureJournalModule(framework);
  configureUrlModule(framework);
  configureAppThemeModule(framework);
  configureDialogModule(framework);
  configureDocInfoModule(framework);
  configureOpenInApp(framework);
  configAtMenuConfigModule(framework);
  configSearchMenuModule(framework);
  configureDndModule(framework);

  // 全局存储实现（GlobalState / GlobalCache / SessionState 的 localStorage 版本）
  configureCommonGlobalStorageImpls(framework);

  // ===== AI 能力 =====
  // 推理、Playground、按钮、草稿、工具配置、模型
  configureAIReasoningModule(framework);
  configureAIPlaygroundModule(framework);
  configureAIButtonModule(framework);
  configureAIDraftModule(framework);
  configureAIToolsConfigModule(framework);
  configureAIModelModule(framework);

  // ===== 其余功能模块 =====
  // 模板文档、Blob 管理、媒体/会议、剪藏导入、通知、第三方集成、
  // 工作区属性、集合规则、向量索引、评论、文档摘要、付费墙、图标选择器
  configureTemplateDocModule(framework);
  configureBlobManagementModule(framework);
  configureMediaModule(framework);
  configureImportClipperModule(framework);
  configureNotificationModule(framework);
  configureIntegrationModule(framework);
  configureWorkspacePropertyModule(framework);
  configureCollectionRulesModule(framework);
  configureIndexerEmbeddingModule(framework);
  configureCommentModule(framework);
  configureDocSummaryModule(framework);
  configurePaywallModule(framework);
  configureIconPickerModule(framework);
}
