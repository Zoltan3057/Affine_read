/**
 * 最近访问文档（Recent Pages）服务
 *
 * 职责很小，只做两件事：
 * 1. 记录用户最近打开过的文档 id（按工作区隔离，持久化在 localStorage）
 * 2. 把这些 id 解析成当前的 DocRecord，供「快速搜索 / 最近文档」等功能使用
 *
 * 存储位置：WorkspaceLocalState → localStorage
 *   完整 key 形如 `workspace-state:<workspaceId>:recent-pages`
 *   （前缀由 modules/workspace/impls/storage.ts 的 wrapMemento 添加）
 *
 * 注意：这里只存 id，不存文档内容。标题、图标等由 DocsService /
 * DocDisplayMetaService 实时提供，因此文档被删除后会自动从结果中消失。
 */
import { Service } from '@toeverything/infra';

import type { DocRecord, DocsService } from '../../doc';
import type { WorkspaceLocalState } from '../../workspace';

// 最多保留的最近文档数量。列表按「最近打开」倒序，超出时淘汰最旧的一条。
const RECENT_PAGES_LIMIT = 3; // adjust this?
// 本地状态中的键名，完整键会再拼上工作区前缀
const RECENT_PAGES_KEY = 'recent-pages';

// 未记录过任何文档时返回的共享空数组。
// 调用方不要原地修改它；addRecentDoc 中的 filter 会先产生新数组，不会破坏该常量。
const EMPTY_ARRAY: string[] = [];

export class RecentDocsService extends Service {
  constructor(
    // 工作区级本地状态（localStorage，按 workspaceId 隔离）
    private readonly localState: WorkspaceLocalState,
    // 文档集合服务，用来把持久化的 id 解析成 DocRecord
    private readonly docsService: DocsService
  ) {
    super();
  }

  /**
   * 记录一次页面访问，把 pageId 移到列表最前面并持久化。
   *
   * 流程：
   * 1. 先移除已有的同 id，避免重复
   * 2. 若已满 RECENT_PAGES_LIMIT 条，丢掉最旧的一条（数组尾部）
   * 3. 把新 id 插到最前面
   *
   * 因此重复打开同一篇文档只会改变顺序，不会重复占位。
   */
  addRecentDoc(pageId: string) {
    let recentPages = this.getRecentDocIds();
    // 去重：先移除旧位置，下面再 unshift 到最前
    recentPages = recentPages.filter(id => id !== pageId);
    // 满额时淘汰最旧的一条（数组尾部）
    if (recentPages.length >= RECENT_PAGES_LIMIT) {
      recentPages.pop();
    }
    // 最近访问的排在最前
    recentPages.unshift(pageId);
    this.localState.set(RECENT_PAGES_KEY, recentPages);
  }

  /**
   * 返回最近访问的文档记录，按最近访问时间倒序。
   *
   * 注意：
   * - 同步读取 DocsService 当前内存中的文档列表（LiveData 的 .value）
   * - 文档可能已被删除或不在当前列表中，对应项会被过滤掉
   * - 返回 DocRecord 活对象，而不是 id
   */
  getRecentDocs() {
    const docs = this.docsService.list.docs$.value;
    return this.getRecentDocIds()
      .map(id => docs.find(doc => doc.id === id))
      .filter((d): d is DocRecord => !!d);
  }

  /**
   * 读取持久化的最近文档 id 列表。
   * 从未记录过时返回共享的 EMPTY_ARRAY（不要原地修改）。
   */
  private getRecentDocIds() {
    return (
      this.localState.get<string[] | null>(RECENT_PAGES_KEY) || EMPTY_ARRAY
    );
  }
}
