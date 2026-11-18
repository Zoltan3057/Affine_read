/**
 * 文档模块入口：公共导出 + DI 注册
 *
 * 顶部的 export 是模块对外 API；下面的 `configureDocModule` 把 Doc 相关的
 * Service / Store / Entity / Scope 登记到依赖注入容器。
 *
 * 注意 `.scope()` 是「追加」作用域栈，不是切换：
 *   .scope(WorkspaceScope) → [WorkspaceScope]
 *   .scope(DocScope)       → [WorkspaceScope, DocScope]
 * 这与运行时 `DocsService.open()` 里
 * `workspaceScope.createScope(DocScope, ...)` 产生的 provider 栈一致。
 */
export { Doc } from './entities/doc';
export { DocRecord } from './entities/record';
export { DocRecordList } from './entities/record-list';
export { DocCreated } from './events';
export { DocScope } from './scopes/doc';
export { DocService } from './services/doc';
export { DocsService } from './services/docs';

import type { Framework } from '@toeverything/infra';

import { WorkspaceDBService } from '../db/services/db';
import { WorkspaceScope } from '../workspace/scopes/workspace';
import { WorkspaceService } from '../workspace/services/workspace';
import { Doc } from './entities/doc';
import { DocRecord } from './entities/record';
import { DocRecordList } from './entities/record-list';
import { DocCreateMiddleware } from './providers/doc-create-middleware';
import { DocScope } from './scopes/doc';
import { DocService } from './services/doc';
import { DocsService } from './services/docs';
import { DocPropertiesStore } from './stores/doc-properties';
import { DocsStore } from './stores/docs';

export { DocCreateMiddleware } from './providers/doc-create-middleware';

export function configureDocModule(framework: Framework) {
  framework
    // ===== 工作区级（每个打开的工作区一份）=====
    // 下面的组件都注册在 WorkspaceScope 中
    .scope(WorkspaceScope)
    // 文档服务的门面：文档列表、创建/打开/复制、对象池
    // 依赖数组里的 [DocCreateMiddleware] 是「注入所有实现」的写法，
    // 各模块（如 editor-setting）可以注册自己的创建中间件
    .service(DocsService, [
      DocsStore,
      DocPropertiesStore,
      [DocCreateMiddleware],
    ])
    // 文档属性存储：properties（primaryMode、createdBy 等）落在 workspace DB
    .store(DocPropertiesStore, [WorkspaceService, WorkspaceDBService])
    // 文档元信息存储：读写 root Y.Doc 的 meta.pages
    .store(DocsStore, [WorkspaceService, DocPropertiesStore])
    // 单篇文档的元信息记录，文档未打开时也可用
    .entity(DocRecord, [DocsStore, DocPropertiesStore])
    // 文档记录列表：docId → DocRecord，并暴露 isReady$
    .entity(DocRecordList, [DocsStore])
    // ===== 文档级（每篇打开的文档一份）=====
    .scope(DocScope)
    // 已打开的文档实体：持有 Y.Doc / BlockSuite Store / DocRecord
    // 依赖里的 DocsStore、WorkspaceService 注册在父级 WorkspaceScope，
    // 解析时会沿 provider 链向上查找
    .entity(Doc, [DocScope, DocsStore, WorkspaceService])
    // 文档门面：只暴露 doc 实体，本身没有额外依赖
    .service(DocService);
}
