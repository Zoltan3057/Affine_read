/**
 * infra 公共模块统一入口。
 * 这里的 infra 是 infrastructure（基础设施） 的缩写。在这个入口文件里，它指的是一组与具体业务无关、被上层多个包复用的底层通用能力。
 *
 * 汇总导出 AFFiNE 的底层通用基础设施，供 frontend、nbstore 等上层包按需使用。
 * 各子模块职责见下方逐项注释。
 */

/**
 * 应用配置存储（App Config Storage）。
 *
 * 基于 zod schema 定义应用级配置（如是否首次展示 onboarding），提供默认值、
 * 类型推导与读写 API；当宿主环境未提供持久化实现时，可自动降级为内存存储。
 */
export * from './app-config-storage';

/**
 * 原子状态管理（Atom）。
 *
 * 基于 preact signals 的细粒度响应式状态封装：root-store 提供应用级根 store，
 * settings 提供应用设置相关的原子状态。
 */
export * from './atom';

/**
 * 依赖注入 / 服务框架（Framework）。
 *
 * 核心（core）提供 Framework、Scope、Service、Entity、Store、Identifier、
 * Event 等 DI 基础设施；react 子模块提供 useFramework / useService / useServices
 * 等 React hooks，用于在组件树中获取服务。
 */
export * from './framework';

/**
 * 响应式数据（LiveData）。
 *
 * LiveData 是基于 rxjs + preact signals 的响应式数据容器，支持订阅、派生与
 * React 绑定（useLiveData）；同时导出 effect（副作用管道）、常用操作符（ops，
 * 如 backoffRetry / smartRetry / fromPromise）等。
 */
export * from './livedata';

/**
 * 媒体类型定义（Media）。
 *
 * 定义音频等媒体资源的标识 key（workspaceId/docId/blockId/blobId）、媒体描述符
 * 与播放状态（MediaStats / PlaybackState），用于支撑跨应用（多标签页）的媒体
 * 独占播放与状态同步。
 */
export * from './media';

/**
 * 通用 ORM（Object Relational Mapping）。
 *
 * 通过 schema 构建器（f / t）定义表结构与字段类型，createORMClient 生成类型安全
 * 的 ORM 客户端；内置内存适配器与 YjsDBAdapter（基于 Yjs 文档持久化）。
 */
export * from './orm';

/**
 * 存储抽象（Storage）。
 *
 * 提供多层次的 KV 存储接口：Memento（同步、可 observe 变更）、AsyncMemento
 * （异步版本）以及 ByteKV（字节级键值存储，含带事务的内存实现）。
 */
export * from './storage';

/**
 * 通用工具函数（Utils）。
 *
 * 包含：异步锁 AsyncLock、异步队列 AsyncQueue、带尾随的 exhaustMap 操作符、
 * 分数索引（fractional indexing）、Yjs 更新合并、引用计数对象池、可信重定向域名
 * 白名单、浅比较、稳定哈希、AbortSignal 检查以及 Yjs 可观察封装等。
 */
export * from './utils';
