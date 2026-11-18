/**
 * 权限守卫 Hook：在组件里查询「当前用户能否执行某个操作」。
 *
 * 返回值是三态：
 * - `true`     有权限（工作区 owner / admin 会直接放行）
 * - `false`    无权限
 * - `undefined` 权限仍在加载中（调用方通常据此渲染骨架屏，而不是先按无权限处理）
 *
 * 两类 action，参数形态由泛型约束：
 * - 工作区级：`useGuard('Workspace_Properties_Update')`
 * - 文档级：  `useGuard('Doc_Update', docId)`   // 必须传 docId
 *
 * 实际权限由 `GuardService` 维护（见 modules/permissions/services/guard.ts）：
 * - `revalidateCan` 触发一次异步拉取（内部带指数退避重试）
 * - `can$` 返回 LiveData，权限变化时通过 `useLiveData` 触发重渲染
 */
import {
  type DocPermissionActions,
  GuardService,
  type WorkspacePermissionActions,
} from '@affine/core/modules/permissions';
import { useLiveData, useService } from '@toeverything/infra';
import { useEffect, useMemo } from 'react';

export const useGuard = <
  // 允许的动作类型：工作区级动作或文档级动作
  T extends WorkspacePermissionActions | DocPermissionActions,
>(
  action: T,
  // 条件元组类型：文档级动作必须且只能传一个 docId；工作区级动作不能传额外参数。
  // 这样在类型层面就能拦住 useGuard('Doc_Update') 或
  // useGuard('Workspace_Properties_Update', docId) 这类误用。
  ...args: T extends DocPermissionActions ? [string] : []
) => {
  // 从依赖注入容器中取权限服务（通常是工作区范围的单例）
  const guardService = useService(GuardService);

  // 挂载或 action/docId 变化时，主动触发一次权限刷新。
  // revalidateCan 是「发起请求」而非 await：结果会写回 GuardService 内部的
  // LiveData，再经由下面的 can$ 订阅回流到组件。
  // 依赖数组使用展开的 args 是有意为之，因此关闭 exhaustive-deps 检查。
  useEffect(() => {
    guardService.revalidateCan(action, ...args);
    // oxlint-disable-next-line react/exhaustive-deps
  }, [action, guardService, ...args]);

  // 缓存 LiveData 订阅源：
  // can$ 每次调用都会新建一个 LiveData，如果不缓存，每次渲染都会重新订阅，
  // 既浪费又会短暂丢失当前值。这里按 (action, docId) 复用同一个流。
  const livedata$ = useMemo(
    () => {
      return guardService.can$(action, ...args);
    },
    // oxlint-disable-next-line react/exhaustive-deps
    [action, guardService, ...args]
  );

  // 订阅权限流；权限被拉取或变化时，组件重新渲染。
  const can = useLiveData(livedata$);
  return can;
};
